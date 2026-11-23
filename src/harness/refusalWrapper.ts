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
import { judgeRefusal, type RefusalVerdict } from './refusalPatterns.ts';
import {
  normalizeDeliveryBody,
  routeRefusal,
  type DeliveryMode,
  type RefusalRoute,
} from './thinDelivery.ts';
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

function stripSentPrefix(raw: string, prefixContent: string | undefined): string {
  if (!prefixContent || !raw.startsWith(prefixContent)) return raw;
  return raw.slice(prefixContent.length);
}

function hasPotentialProtocolFenceStart(text: string): boolean {
  const lastLine = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').at(-1) ?? '';
  // A protocol fence may arrive as `` + `lfh-`, `` + `lfh-s`, etc. Hold one
  // more delta instead of aborting before the complete lfh-* line is visible.
  return /^[ \t]{0,3}`+[ \t]*(?:l(?:f(?:h(?:-[a-z-]*)?)?)?)?$/i.test(lastLine);
}

const SCENE_DELIMITER_PAIRS: readonly (readonly [string, string])[] = [
  ['（', '）'],
  ['(', ')'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
];

const POTENTIAL_SCENE_ANCHOR_START_RE =
  /^(?:你(?:听|看|觉|感|闻|发(?:现)?|注(?:意)?|想|记|抬|回|伸|转|走|站|坐|握|接|推|拉)?|他|她)$/;
const PUNCTUATION_ONLY_RE = /^[\s。！？…~～.．!?,，、;；:：\-—–]*$/;

/**
 * Holds a pending L1 refusal when the text after it may still become a scene
 * anchor. Streaming can split `（` from its action, or `你` from an experience
 * verb; aborting on those partial chunks would discard real narrative content.
 */
function hasPotentialSceneAnchorStart(textSincePending: string): boolean {
  const text = String(textSincePending ?? '').trim();
  if (!text || PUNCTUATION_ONLY_RE.test(text)) return true;
  if (POTENTIAL_SCENE_ANCHOR_START_RE.test(text)) return true;
  return SCENE_DELIMITER_PAIRS.some(([open, close]) => {
    const openCount = text.split(open).length - 1;
    const closeCount = text.split(close).length - 1;
    if (open === close) return openCount % 2 === 1;
    return openCount > closeCount;
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
  throwIfAborted(options);
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
  let pendingL1 = false;
  let pendingDetectedChars = 0;

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
    layer?: RefusalVerdict['layer'];
    bodyChars: number;
    detectedContent: string;
  } => {
    const detectedContent = stripSentPrefix(raw, prefixContent);
    const { body, hasProtocolArtifacts } = splitRefusalProtocolContent(detectedContent);
    const verdict = judgeRefusal(body);
    return {
      route: routeRefusal(body, Boolean(verdict), deliveryOptions(options.mode, hasProtocolArtifacts)),
      ...(ruleIdFor(verdict) ? { matchedRuleId: ruleIdFor(verdict)! } : {}),
      ...(verdict ? { layer: verdict.layer } : {}),
      bodyChars: normalizeDeliveryBody(body).length,
      detectedContent,
    };
  };

  const resultFor = (
    evaluated: ReturnType<typeof evaluateFull>,
  ): AttemptResult => {
    const isNonStopRetryRoute =
      !isStop(finishReason) &&
      (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton');
    const diagnostics: NodeDiagnostics | undefined =
      evaluated.route === 'partial_refused'
        ? {
            refusalRoute: 'partial_refused',
            ...(evaluated.matchedRuleId ? { matchedRuleId: evaluated.matchedRuleId } : {}),
          }
        : isNonStopRetryRoute
          ? {
              sourceStatus: 'REFUSAL',
              refusalRoute: evaluated.route,
              recoveredFromText: raw,
              matchedRuleId: evaluated.matchedRuleId ?? 'skeleton-01',
            }
          : undefined;

    return {
      kind: 'result',
      raw,
      reasoningContent,
      finishReason,
      ...(diagnostics ? { diagnostics } : {}),
      ...(prefixContent !== undefined ? { prefillContent: prefixContent } : {}),
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
        } else if (!isStop(finishReason)) {
          const evaluated = evaluateFull();
          const wasPendingL1 = pendingL1;
          if (evaluated.route === 'partial_refused' || evaluated.bodyChars > REFUSAL_OBSERVATION_CHARS) {
            // Delivery evidence wins over an earlier L1 verdict. The 120-character
            // window is the final protection against chunk boundaries.
            gateOpen = true;
            emitVisible();
          } else if (wasPendingL1) {
            const textSincePending = evaluated.detectedContent.slice(pendingDetectedChars);
            const deltaHasContent = delta.contentDelta.trim().length > 0;
            if (
              deltaHasContent &&
              !hasPotentialProtocolFenceStart(evaluated.detectedContent) &&
              !hasPotentialSceneAnchorStart(textSincePending) &&
              (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton')
            ) {
              internalAbort.abort();
              return {
                kind: 'refusal',
                route: evaluated.route,
                raw,
                reasoningContent,
                matchedRuleId: evaluated.matchedRuleId ?? 'skeleton-01',
              };
            }
          } else if (evaluated.layer === 'L1') {
            pendingL1 = true;
            pendingDetectedChars = evaluated.detectedContent.length;
          }
        }
      }

      if (isStop(finishReason)) {
        const evaluated = evaluateFull();
        if (
          !gateOpen &&
          (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton')
        ) {
          return {
            kind: 'refusal',
            route: evaluated.route,
            raw,
            reasoningContent,
            matchedRuleId: evaluated.matchedRuleId ?? 'skeleton-01',
          };
        }
        emitVisible();
        return resultFor(evaluated);
      }
    }

    // A provider may close a normally completed stream without a finishReason.
    // A pending L1 refusal must still get its single retry; partial delivery is
    // preserved with diagnostics, and other non-stop thin results retain their
    // existing REFUSAL markers for context isolation.
    const evaluated = evaluateFull();
    if (
      !gateOpen &&
      pendingL1 &&
      (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton')
    ) {
      return {
        kind: 'refusal',
        route: evaluated.route,
        raw,
        reasoningContent,
        matchedRuleId: evaluated.matchedRuleId ?? 'skeleton-01',
      };
    }
    if (
      attempt === 'retry' &&
      !isStop(finishReason) &&
      (evaluated.route === 'retry' || evaluated.route === 'retry-skeleton')
    ) {
      return resultFor(evaluated);
    }
    emitVisible();
    return resultFor(evaluated);
  } catch (error) {
    if (options.callbacks?.signal?.aborted) {
      emitVisible();
      throw createAbortError();
    }
    emitVisible();
    throw error;
  } finally {
    unbindExternalAbort();
  }
}

/**
 * Wraps one foreground generation stream with the 120-character refusal observation
 * window and at most one silent retry. L1 is confirmed across chunk boundaries:
 * whitespace and possible protocol-fence prefixes keep the stream buffered, while a
 * later non-empty chunk that still has no delivery evidence aborts the first stream.
 * Background summary/import streams must not use it.
 */
export async function streamWithRefusalHandling(
  options: RefusalHandlingOptions,
): Promise<RefusalHandlingResult> {
  const effective = resolvePromptPackContext(options.promptPackOptions);
  if (!effective.enabled) return streamPassThrough(options);

  const first = await runAttempt(options, effective, 'first');
  if (first.kind === 'result') {
    if (
      first.diagnostics?.sourceStatus === 'REFUSAL' &&
      (first.diagnostics.refusalRoute === 'retry' ||
        first.diagnostics.refusalRoute === 'retry-skeleton')
    ) {
      emitDiagnostic(
        options,
        effective,
        'refusal_detected',
        first.diagnostics.refusalRoute,
        0,
        first.diagnostics.matchedRuleId,
      );
    }
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

  if (
    retry.kind === 'result' &&
    retry.finishReason !== 'stop' &&
    retry.diagnostics?.sourceStatus === 'REFUSAL'
  ) {
    const matchedRuleId = retry.diagnostics.matchedRuleId ?? first.matchedRuleId;
    const diagnostics: NodeDiagnostics = {
      sourceStatus: 'REFUSAL',
      refusalRoute: 'refused_exhausted',
      recoveredFromText: first.raw,
      retriedWithPrefix,
      ...(matchedRuleId ? { matchedRuleId } : {}),
    };
    emitDiagnostic(
      options,
      effective,
      'refusal_retry_exhausted',
      'refused_exhausted',
      1,
      matchedRuleId,
    );
    throwIfAborted(options);
    return {
      content: REFUSAL_EXHAUSTED_MESSAGE,
      reasoningContent: '',
      finishReason: 'stop',
      diagnostics,
    };
  }

  if (retry.kind === 'result' && retry.finishReason !== 'stop') {
    throwIfAborted(options);
    return {
      content: retry.raw,
      reasoningContent: retry.reasoningContent,
      finishReason: retry.finishReason,
      ...(retry.diagnostics ? { diagnostics: retry.diagnostics } : {}),
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
