import { normalizeReasoningEffort } from './keyConfig.ts';
import {
  buildModePrefill,
  type PrefillMode,
} from './prefillTemplates.ts';
import {
  resolvePromptPackContext,
  type EffectivePromptPack,
  type PromptPackContextOptions,
  type PromptPackSlotChars,
} from './promptPack.ts';
import { judgeHardRefusal, judgeRefusal, type RefusalVerdict } from './refusalPatterns.ts';
import { routeRefusal, type DeliveryMode, type RefusalRoute } from './thinDelivery.ts';
import type {
  AbortSignalLike,
  LlmMessage,
  LlmStreamDelta,
  LlmStreamRequest,
  LlmTransport,
  ModelConfig,
  NodeDiagnostics,
  TurnCallbacks,
} from './types.ts';

export const REFUSAL_OBSERVATION_CHARS = 120;
export const REFUSAL_RETRY_TAIL = '请直接续写当前场景，用具体动作、对白与感官细节自然推进。';
export const REFUSAL_EXHAUSTED_MESSAGE =
  '（本轮生成未通过模型的安全策略，已自动隔离，不计入后续上下文。你可以换个切入点重试，或调整提示词包与前缀续写设置。）';

export type RefusalDiagnosticAction =
  | 'refusal_detected'
  | 'refusal_retry_recovered'
  | 'refusal_retry_exhausted'
  | 'refusal_partial_delivered'
  | 'refusal_original_restored';

export interface RefusalDiagnosticMetrics {
  packEnabled: boolean;
  slotChars: PromptPackSlotChars;
  prefixMode: 'off' | 'on_retry' | 'always';
  refusalRoute?: RefusalRoute | 'refused_exhausted';
  matchedRuleId?: string;
  retryCount: number;
}

export interface RefusalDiagnosticEvent {
  action: RefusalDiagnosticAction;
  metrics: RefusalDiagnosticMetrics;
}

export type RefusalStreamIntegrationOptions = Omit<
  RefusalHandlingOptions,
  'transport' | 'config' | 'messages' | 'callbacks' | 'toVisibleContent'
>;

export interface RefusalHandlingOptions {
  transport: LlmTransport;
  config: ModelConfig;
  messages: LlmMessage[];
  mode: DeliveryMode;
  promptPackOptions?: PromptPackContextOptions;
  callbacks?: TurnCallbacks;
  /** Transforms the raw accumulated text into user-visible text (fence stripping, etc.). */
  toVisibleContent?: (raw: string) => string;
  /** Optional mode prefill override, used by the welcome router to preserve lfh-route first. */
  prefixContent?: string;
  characterName?: string;
  onDiagnostic?: (event: RefusalDiagnosticEvent) => void;
}

export interface RefusalHandlingResult {
  content: string;
  reasoningContent: string;
  finishReason?: string | null;
  diagnostics?: NodeDiagnostics;
  prefillContent?: string;
}

type AttemptRefusal = {
  kind: 'refusal';
  route: 'retry' | 'retry-skeleton';
  raw: string;
  reasoningContent: string;
  matchedRuleId: string;
};

type AttemptResult = {
  kind: 'result';
  raw: string;
  reasoningContent: string;
  finishReason?: string | null;
  diagnostics?: NodeDiagnostics;
  prefillContent?: string;
};

type AttemptOutcome = AttemptRefusal | AttemptResult;

const PROTOCOL_FENCE_OPEN_RE =
  /^[ \t]{0,3}`{3,}[ \t]*(lfh-(?:summary|proposal|change|choices|hud|route|manuscript-intent))\b/;

/**
 * Removes complete or still-open lfh protocol fences before refusal detection.
 * The caller's protocol evidence is returned separately so a short contract-only
 * reply is never mistaken for an empty refusal.
 */
export function splitRefusalProtocolContent(raw: string): {
  body: string;
  hasProtocolArtifacts: boolean;
} {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  let hasProtocolArtifacts = false;
  let fenceTicks = 0;

  for (const line of lines) {
    if (fenceTicks === 0) {
      const open = PROTOCOL_FENCE_OPEN_RE.exec(line);
      if (open) {
        hasProtocolArtifacts = true;
        fenceTicks = open[1].length;
        continue;
      }
      body.push(line);
      continue;
    }

    const close = /^[ \t]{0,3}(`{3,})[ \t]*$/.exec(line);
    if (close && close[1].length >= fenceTicks) {
      fenceTicks = 0;
    }
  }

  return {
    body: body.join('\n').trim(),
    hasProtocolArtifacts,
  };
}

function createInternalAbort(): { signal: AbortSignalLike; abort: () => void } {
  const Controller = (globalThis as {
    AbortController?: new () => {
      signal: AbortSignalLike;
      abort: () => void;
    };
  }).AbortController;
  if (Controller) {
    const controller = new Controller();
    return { signal: controller.signal, abort: () => controller.abort() };
  }
  let aborted = false;
  return {
    signal: {
      get aborted() {
        return aborted;
      },
    },
    abort: () => {
      aborted = true;
    },
  };
}

function bindExternalAbort(
  signal: AbortSignalLike | undefined,
  abort: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    abort();
    return () => {};
  }
  const target = signal as AbortSignalLike & {
    addEventListener?: (type: 'abort', listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener?: (type: 'abort', listener: () => void) => void;
  };
  if (!target.addEventListener) return () => {};
  target.addEventListener('abort', abort, { once: true });
  return () => target.removeEventListener?.('abort', abort);
}

function createAbortError(): Error {
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(options: RefusalHandlingOptions): void {
  if (options.callbacks?.signal?.aborted) throw createAbortError();
}

function deliveryOptions(mode: DeliveryMode, hasProtocolArtifacts: boolean) {
  return { mode, hasProtocolArtifacts };
}

function ruleIdFor(verdict: RefusalVerdict | null): string | undefined {
  return verdict?.ruleId;
}

function prefillFor(options: RefusalHandlingOptions): string {
  return options.prefixContent ??
    buildModePrefill(options.mode as PrefillMode, {
      ...(options.characterName?.trim() ? { characterName: options.characterName.trim() } : {}),
    });
}

function withRetryTail(messages: LlmMessage[], tail: string): LlmMessage[] {
  const normalizedTail = tail.trim();
  if (
    messages.some(
      (message) => message.role === 'system' && message.content.trim() === normalizedTail,
    )
  ) {
    return [...messages];
  }
  const next = [...messages];
  const tailMessage: LlmMessage = { role: 'system', content: normalizedTail };
  const last = next.at(-1);
  if (last?.role === 'user') {
    next.splice(next.length - 1, 0, tailMessage);
  } else {
    next.push(tailMessage);
  }
  return next;
}

function diagnosticMetrics(
  effective: EffectivePromptPack,
  actionRoute: RefusalDiagnosticMetrics['refusalRoute'],
  retryCount: number,
  matchedRuleId?: string,
): RefusalDiagnosticMetrics {
  return {
    packEnabled: effective.enabled,
    slotChars: {
      head: effective.slots.head.length,
      mid: effective.slots.mid.length,
      tail: effective.slots.tail.length,
    },
    prefixMode: effective.prefixCompletion,
    ...(actionRoute ? { refusalRoute: actionRoute } : {}),
    ...(matchedRuleId ? { matchedRuleId } : {}),
    retryCount,
  };
}

function emitDiagnostic(
  options: RefusalHandlingOptions,
  effective: EffectivePromptPack,
  action: RefusalDiagnosticAction,
  refusalRoute: RefusalDiagnosticMetrics['refusalRoute'],
  retryCount: number,
  matchedRuleId?: string,
): void {
  try {
    options.onDiagnostic?.({
      action,
      metrics: diagnosticMetrics(effective, refusalRoute, retryCount, matchedRuleId),
    });
  } catch {
    // Diagnostics must never alter generation behavior.
  }
}

function isStop(finishReason: string | null | undefined): boolean {
  return finishReason === 'stop';
}

async function streamPassThrough(
  options: RefusalHandlingOptions,
): Promise<RefusalHandlingResult> {
  let raw = '';
  let reasoningContent = '';
  let finishReason: string | null | undefined;
  let shown = '';
  const toVisible = options.toVisibleContent ?? ((text: string) => text);
  const reasoningEffort = normalizeReasoningEffort(options.config.reasoningEffort);

  for await (const delta of options.transport.streamChat({
    baseUrl: options.config.baseUrl,
    apiKey: options.config.apiKey,
    model: options.config.model,
    reasoningEffort,
    messages: options.messages,
    signal: options.callbacks?.signal,
  })) {
    if (options.callbacks?.signal?.aborted) throw createAbortError();
    if (delta.finishReason != null) finishReason = delta.finishReason;
    if (delta.reasoningDelta && reasoningEffort !== 'none') {
      reasoningContent += delta.reasoningDelta;
      options.callbacks?.onReasoningDelta?.(delta.reasoningDelta);
    }
    if (!delta.contentDelta) continue;
    raw += delta.contentDelta;
    const visible = toVisible(raw);
    if (visible.length > shown.length) {
      options.callbacks?.onContentDelta?.(visible.slice(shown.length));
      shown = visible;
    }
  }

  throwIfAborted(options);
  return { content: raw, reasoningContent, finishReason };
}

async function runAttempt(
  options: RefusalHandlingOptions,
  effective: EffectivePromptPack,
  attempt: 'first' | 'retry',
): Promise<AttemptOutcome> {
  if (options.callbacks?.signal?.aborted) throw createAbortError();
  const reasoningEffort = normalizeReasoningEffort(options.config.reasoningEffort);
  const toVisible = options.toVisibleContent ?? ((text: string) => text);
  const shouldPrefix =
    effective.prefixCompletion === 'always' ||
    (attempt === 'retry' && effective.prefixCompletion === 'on_retry');
  const prefixContent = shouldPrefix ? prefillFor(options) : undefined;
  const retryTail = effective.slots.tail.trim() || REFUSAL_RETRY_TAIL;
  const messages = attempt === 'retry' ? withRetryTail(options.messages, retryTail) : options.messages;
  const internalAbort = createInternalAbort();
  const unbindExternalAbort = bindExternalAbort(options.callbacks?.signal, internalAbort.abort);
  const request: LlmStreamRequest = {
    baseUrl: options.config.baseUrl,
    apiKey: options.config.apiKey,
    model: options.config.model,
    reasoningEffort,
    messages,
    signal: internalAbort.signal,
    ...(prefixContent !== undefined ? { prefixCompletion: { content: prefixContent } } : {}),
  };

  let raw = '';
  let reasoningContent = '';
  let finishReason: string | null | undefined;
  let shown = '';
  let gateOpen = false;
  let earlyRefusal: AttemptRefusal | null = null;
  // Delivery-confirmation window: L1 can be followed by a scene or protocol
  // artifact in the same stream. Keep the hard verdict pending until the next
  // content delta confirms the reply is still a thin refusal; this protects
  // short partial deliveries from early abort. The existing single-retry
  // contract is unchanged once the confirmation still routes to retry.
  let pendingHardRefusal: RefusalVerdict | null = null;

  const emitVisible = (): void => {
    const visible = toVisible(raw);
    if (visible.length > shown.length) {
      options.callbacks?.onContentDelta?.(visible.slice(shown.length));
      shown = visible;
    }
  };

  const evaluateFull = (): {
    route: RefusalRoute;
    matchedRuleId?: string;
  } => {
    const { body, hasProtocolArtifacts } = splitRefusalProtocolContent(raw);
    const verdict = judgeRefusal(body);
    return {
      route: routeRefusal(body, Boolean(verdict), deliveryOptions(options.mode, hasProtocolArtifacts)),
      ...(ruleIdFor(verdict) ? { matchedRuleId: ruleIdFor(verdict)! } : {}),
    };
  };

  try {
    for await (const delta of options.transport.streamChat(request)) {
      if (options.callbacks?.signal?.aborted) throw createAbortError();
      if (delta.finishReason != null) finishReason = delta.finishReason;
      if (delta.reasoningDelta && reasoningEffort !== 'none') {
        reasoningContent += delta.reasoningDelta;
        options.callbacks?.onReasoningDelta?.(delta.reasoningDelta);
      }
      if (delta.contentDelta) {
        raw += delta.contentDelta;
        if (gateOpen) {
          emitVisible();
        } else {
          if (!isStop(finishReason)) {
            const { body, hasProtocolArtifacts } = splitRefusalProtocolContent(raw);
            if (pendingHardRefusal) {
              const route = routeRefusal(
                body,
                true,
                deliveryOptions(options.mode, hasProtocolArtifacts),
              );
              if (route === 'retry') {
                earlyRefusal = {
                  kind: 'refusal',
                  route: 'retry',
                  raw,
                  reasoningContent,
                  matchedRuleId: pendingHardRefusal.ruleId,
                };
                internalAbort.abort();
                break;
              }
              // A partial delivery has been confirmed: open the gate now and
              // preserve the body/protocol while waiting for the terminal stop.
              gateOpen = true;
              emitVisible();
            } else if (raw.length <= REFUSAL_OBSERVATION_CHARS) {
              const hardVerdict = judgeHardRefusal(body);
              if (hardVerdict) pendingHardRefusal = hardVerdict;
            }
          }
          if (raw.length > REFUSAL_OBSERVATION_CHARS) {
            gateOpen = true;
            emitVisible();
          }
        }
      }

      if (isStop(finishReason) && !gateOpen) {
        const evaluated = evaluateFull();
        if (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton') {
          return {
            kind: 'refusal',
            route: evaluated.route,
            raw,
            reasoningContent,
            matchedRuleId: evaluated.matchedRuleId ?? 'skeleton-01',
          };
        }
        emitVisible();
        return {
          kind: 'result',
          raw,
          reasoningContent,
          finishReason,
          ...(evaluated.route === 'partial_refused'
            ? {
                diagnostics: {
                  refusalRoute: 'partial_refused',
                  ...(evaluated.matchedRuleId ? { matchedRuleId: evaluated.matchedRuleId } : {}),
                } satisfies NodeDiagnostics,
              }
            : {}),
          ...(prefixContent !== undefined ? { prefillContent: prefixContent } : {}),
        };
      }

      if (isStop(finishReason) && gateOpen) {
        const evaluated = evaluateFull();
        return {
          kind: 'result',
          raw,
          reasoningContent,
          finishReason,
          ...(evaluated.route === 'partial_refused'
            ? {
                diagnostics: {
                  refusalRoute: 'partial_refused',
                  ...(evaluated.matchedRuleId ? { matchedRuleId: evaluated.matchedRuleId } : {}),
                } satisfies NodeDiagnostics,
              }
            : {}),
          ...(prefixContent !== undefined ? { prefillContent: prefixContent } : {}),
        };
      }
    }

    if (earlyRefusal) return earlyRefusal;
    if (pendingHardRefusal) {
      const { body, hasProtocolArtifacts } = splitRefusalProtocolContent(raw);
      const route = routeRefusal(body, true, deliveryOptions(options.mode, hasProtocolArtifacts));
      if (route === 'retry') {
        return {
          kind: 'refusal',
          route: 'retry',
          raw,
          reasoningContent,
          matchedRuleId: pendingHardRefusal.ruleId,
        };
      }
      gateOpen = true;
      emitVisible();
    }
    emitVisible();
    return {
      kind: 'result',
      raw,
      reasoningContent,
      finishReason,
      ...(prefixContent !== undefined ? { prefillContent: prefixContent } : {}),
    };
  } catch (error) {
    if (options.callbacks?.signal?.aborted) {
      emitVisible();
      throw createAbortError();
    }
    if (earlyRefusal) return earlyRefusal;
    emitVisible();
    throw error;
  } finally {
    unbindExternalAbort();
  }
}

/**
 * Wraps one foreground generation stream with the 120-character refusal observation
 * window and at most one silent retry. Background summary/import streams must not use it.
 */
export async function streamWithRefusalHandling(
  options: RefusalHandlingOptions,
): Promise<RefusalHandlingResult> {
  const effective = resolvePromptPackContext(options.promptPackOptions);
  if (!effective.enabled) return streamPassThrough(options);

  const first = await runAttempt(options, effective, 'first');
  if (first.kind === 'result') {
    if (first.diagnostics?.refusalRoute === 'partial_refused') {
      emitDiagnostic(
        options,
        effective,
        'refusal_partial_delivered',
        'partial_refused',
        0,
        first.diagnostics.matchedRuleId,
      );
    }
    throwIfAborted(options);
    return {
      content: first.raw,
      reasoningContent: first.reasoningContent,
      finishReason: first.finishReason,
      ...(first.diagnostics ? { diagnostics: first.diagnostics } : {}),
      ...(first.prefillContent !== undefined ? { prefillContent: first.prefillContent } : {}),
    };
  }

  if (options.callbacks?.signal?.aborted) throw createAbortError();
  options.callbacks?.onRefusalRetry?.();
  if (options.callbacks?.signal?.aborted) throw createAbortError();
  emitDiagnostic(
    options,
    effective,
    'refusal_detected',
    first.route,
    0,
    first.matchedRuleId,
  );

  const retriedWithPrefix =
    effective.prefixCompletion === 'on_retry' || effective.prefixCompletion === 'always';
  const retry = await runAttempt(options, effective, 'retry');
  if (retry.kind === 'result' && isStop(retry.finishReason) && !retry.diagnostics) {
    const diagnostics: NodeDiagnostics = {
      refusalRoute: first.route,
      recoveredFromText: first.raw,
      retriedWithPrefix,
      matchedRuleId: first.matchedRuleId,
    };
    emitDiagnostic(
      options,
      effective,
      'refusal_retry_recovered',
      first.route,
      1,
      first.matchedRuleId,
    );
    throwIfAborted(options);
    return {
      content: retry.raw,
      reasoningContent: retry.reasoningContent,
      finishReason: retry.finishReason,
      diagnostics,
      ...(retry.prefillContent !== undefined ? { prefillContent: retry.prefillContent } : {}),
    };
  }

  if (retry.kind === 'result' && retry.diagnostics?.refusalRoute === 'partial_refused') {
    const diagnostics: NodeDiagnostics = {
      refusalRoute: 'partial_refused',
      recoveredFromText: first.raw,
      retriedWithPrefix,
      matchedRuleId: first.matchedRuleId,
    };
    emitDiagnostic(
      options,
      effective,
      'refusal_partial_delivered',
      'partial_refused',
      1,
      first.matchedRuleId,
    );
    throwIfAborted(options);
    return {
      content: retry.raw,
      reasoningContent: retry.reasoningContent,
      finishReason: retry.finishReason,
      diagnostics,
      ...(retry.prefillContent !== undefined ? { prefillContent: retry.prefillContent } : {}),
    };
  }

  if (retry.kind === 'result' && retry.finishReason !== 'stop') {
    throwIfAborted(options);
    return {
      content: retry.raw,
      reasoningContent: retry.reasoningContent,
      finishReason: retry.finishReason,
      ...(retry.prefillContent !== undefined ? { prefillContent: retry.prefillContent } : {}),
    };
  }

  const diagnostics: NodeDiagnostics = {
    sourceStatus: 'REFUSAL',
    refusalRoute: 'refused_exhausted',
    recoveredFromText: first.raw,
    retriedWithPrefix,
    matchedRuleId: first.matchedRuleId,
  };
  emitDiagnostic(
    options,
    effective,
    'refusal_retry_exhausted',
    'refused_exhausted',
    1,
    first.matchedRuleId,
  );
  throwIfAborted(options);
  return {
    content: REFUSAL_EXHAUSTED_MESSAGE,
    reasoningContent: '',
    finishReason: 'stop',
    diagnostics,
  };
}
