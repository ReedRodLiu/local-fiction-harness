import { getTextDecoderCtor, type TextDecoderLike } from './encoding.ts';
import { isOfficialDeepSeekUrl, normalizeReasoningEffort } from './keyConfig.ts';
import type {
  DeepSeekThinkingParam,
  FetchLike,
  FetchResponseLike,
  LlmStreamDelta,
  LlmStreamRequest,
  LlmTransport,
  LlmUsage,
  ProviderPrefixProtocol,
  ProviderThinkingProtocol,
  ReasoningEffort,
} from './types.ts';

function createUtf8Decoder(): TextDecoderLike {
  const DecoderCtor = getTextDecoderCtor();
  return new DecoderCtor('utf-8');
}

function toAsyncChunks(
  body: NonNullable<FetchResponseLike['body']>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    return body;
  }
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function isCompleteSsePayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (!trimmed) return false;
  if (trimmed === '[DONE]') return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function parseSseEventData(dataText: string): { done: boolean; delta?: LlmStreamDelta } {
  const trimmed = dataText.trim();
  if (!trimmed) {
    return { done: false };
  }
  if (trimmed === '[DONE]') {
    return { done: true };
  }

  let parsed: {
    error?: { message?: string };
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      prompt_cache_hit_tokens?: unknown;
      prompt_cache_miss_tokens?: unknown;
      prompt_tokens_details?: {
        cached_tokens?: unknown;
      };
      completion_tokens_details?: {
        reasoning_tokens?: unknown;
      };
    };
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { done: false };
  }

  if (parsed.error) {
    throw new Error(parsed.error.message || 'Model provider returned an SSE error payload.');
  }

  const usage = parseUsage(parsed.usage);

  const choice = parsed.choices?.[0];
  if (!choice) {
    return usage ? { done: false, delta: { usage } } : { done: false };
  }

  const deltaObj = choice.delta ?? {};
  const contentDelta = typeof deltaObj.content === 'string' ? deltaObj.content : undefined;
  const reasoningRaw =
    typeof deltaObj.reasoning_content === 'string'
      ? deltaObj.reasoning_content
      : typeof deltaObj.reasoning === 'string'
        ? deltaObj.reasoning
        : undefined;

  if (
    contentDelta === undefined &&
    reasoningRaw === undefined &&
    choice.finish_reason === undefined &&
    !usage
  ) {
    return { done: false };
  }

  return {
    done: false,
    delta: {
      contentDelta,
      reasoningDelta: reasoningRaw,
      finishReason: choice.finish_reason,
      ...(usage ? { usage } : {}),
    },
  };
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseUsage(raw: {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  prompt_tokens_details?: {
    cached_tokens?: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: unknown;
  };
} | undefined): LlmUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = optionalTokenCount(raw.prompt_tokens);
  const explicitCacheHit = optionalTokenCount(raw.prompt_cache_hit_tokens);
  const explicitCacheMiss = optionalTokenCount(raw.prompt_cache_miss_tokens);
  const openAiCached = optionalTokenCount(raw.prompt_tokens_details?.cached_tokens);
  const hasExplicitCacheHit =
    raw.prompt_cache_hit_tokens !== undefined && raw.prompt_cache_hit_tokens !== null;
  const promptCacheHitTokens = hasExplicitCacheHit ? explicitCacheHit : openAiCached;
  const promptCacheMissTokens =
    explicitCacheMiss !== undefined
      ? explicitCacheMiss
      : !hasExplicitCacheHit && openAiCached !== undefined && promptTokens !== undefined
        ? Math.max(0, promptTokens - openAiCached)
        : undefined;
  const reasoningTokens = optionalTokenCount(raw.completion_tokens_details?.reasoning_tokens);
  const usage: LlmUsage = {
    promptTokens,
    completionTokens: optionalTokenCount(raw.completion_tokens),
    totalTokens: optionalTokenCount(raw.total_tokens),
    promptCacheHitTokens,
    promptCacheMissTokens,
    ...(reasoningTokens === undefined
      ? {}
      : { completionTokensDetails: { reasoningTokens } }),
  };
  return usage.promptTokens !== undefined ||
    usage.completionTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.promptCacheHitTokens !== undefined ||
    usage.promptCacheMissTokens !== undefined ||
    usage.completionTokensDetails !== undefined
    ? usage
    : undefined;
}

/**
 * Parses an OpenAI-compatible Server-Sent Events stream into typed deltas,
 * decoding UTF-8 across chunk boundaries, assembling multi-line data: events,
 * and separating reasoning from content.
 */
export async function* parseOpenAiSseStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  const decoder = createUtf8Decoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flushEvent = function* (): Generator<LlmStreamDelta, boolean> {
    if (dataLines.length === 0) {
      return false;
    }
    const payload = dataLines.join('\n');
    dataLines = [];
    const parsed = parseSseEventData(payload);
    if (parsed.done) {
      return true;
    }
    if (parsed.delta) {
      yield parsed.delta;
    }
    return false;
  };

  const processLines = function* (flushRemaining: boolean): Generator<LlmStreamDelta, boolean> {
    const lines = buffer.split(/\r?\n/);
    buffer = flushRemaining ? '' : (lines.pop() ?? '');

    for (const line of lines) {
      if (line === '') {
        const ended = yield* flushEvent();
        if (ended) return true;
        continue;
      }
      if (!line.startsWith('data:')) {
        continue;
      }
      if (dataLines.length > 0 && isCompleteSsePayload(dataLines.join('\n'))) {
        const ended = yield* flushEvent();
        if (ended) return true;
      }
      const value = line[5] === ' ' ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }

    if (flushRemaining) {
      return yield* flushEvent();
    }
    return false;
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const ended = yield* processLines(false);
    if (ended) {
      return;
    }
  }

  buffer += decoder.decode(undefined, { stream: false });
  if (buffer.length > 0 || dataLines.length > 0) {
    yield* processLines(true);
  }
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error('Model Base URL cannot be empty.');
  }
  if (cleaned.endsWith('/chat/completions')) {
    return cleaned;
  }
  return `${cleaned}/chat/completions`;
}

export function resolveBetaChatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error('Model Base URL cannot be empty.');
  }
  if (cleaned.endsWith('/beta/chat/completions')) {
    return cleaned;
  }
  if (cleaned.endsWith('/beta')) {
    return `${cleaned}/chat/completions`;
  }

  let base = cleaned;
  if (base.endsWith('/v1/chat/completions')) {
    base = base.slice(0, -'/v1/chat/completions'.length);
  } else if (base.endsWith('/chat/completions')) {
    base = base.slice(0, -'/chat/completions'.length);
  } else if (base.endsWith('/v1')) {
    base = base.slice(0, -'/v1'.length);
  }
  return `${base}/beta/chat/completions`;
}

/**
 * Normalizes the two provider behaviors for Chat Prefix Completion: a provider
 * may echo the assistant prefix before continuing, or may start directly with
 * new content. Until the prefix is either confirmed or contradicted, content
 * is held so a partial match is never silently discarded. If the stream ends or
 * fails while that match is still unconfirmed, the held bytes are emitted and
 * the stream fails explicitly instead of pretending success or blindly cutting.
 */
export async function* applyPrefixEchoCursor(
  deltas: AsyncIterable<LlmStreamDelta>,
  prefillContent: string,
): AsyncIterable<LlmStreamDelta> {
  if (!prefillContent) {
    yield* deltas;
    return;
  }

  type EchoState = 'pending' | 'echoed' | 'diverged';
  let state: EchoState = 'pending';
  let heldContent = '';
  let emittedPrefill = false;

  const takePrefillDelta = (): LlmStreamDelta | undefined => {
    if (emittedPrefill) return undefined;
    emittedPrefill = true;
    return { contentDelta: prefillContent };
  };

  const canSynthesizePrefill = (): boolean => state !== 'pending';

  const flushHeldContent = function* (): Generator<LlmStreamDelta> {
    if (!heldContent) return;
    const content = heldContent;
    heldContent = '';
    yield { contentDelta: content };
  };

  const failUnconfirmedPrefixEcho = function* (): Generator<LlmStreamDelta> {
    // A partial prefix match cannot prove whether the provider echoed the
    // prefill. Preserve the received bytes, but fail explicitly rather than
    // pretending the stream succeeded or silently cutting the text.
    yield* flushHeldContent();
    throw new Error('Prefix echo could not be confirmed before the stream ended.');
  };

  const emitNonContentParts = (delta: LlmStreamDelta): LlmStreamDelta | undefined => {
    if (delta.reasoningDelta === undefined && delta.finishReason === undefined) {
      return undefined;
    }
    return {
      ...(delta.reasoningDelta !== undefined
        ? { reasoningDelta: delta.reasoningDelta }
        : {}),
      ...(delta.finishReason !== undefined ? { finishReason: delta.finishReason } : {}),
    };
  };

  const flushConfirmedPrefill = function* (): Generator<LlmStreamDelta> {
    if (canSynthesizePrefill()) {
      const prefixDelta = takePrefillDelta();
      if (prefixDelta) yield prefixDelta;
    }
  };

  try {
    for await (const delta of deltas) {
      const hasContent = typeof delta.contentDelta === 'string';
      const isTerminal = typeof delta.finishReason === 'string';
      let outputContent: string | undefined;

      if (hasContent) {
        const content = delta.contentDelta!;
        if (state === 'pending') {
          const candidate = heldContent + content;
          if (prefillContent.startsWith(candidate)) {
            heldContent = candidate;
            if (candidate === prefillContent) {
              state = 'echoed';
            }
          } else if (candidate.startsWith(prefillContent)) {
            state = 'echoed';
            heldContent = '';
            outputContent = candidate.slice(prefillContent.length);
          } else {
            state = 'diverged';
            heldContent = '';
            outputContent = candidate;
          }
        } else {
          outputContent = content;
        }
      }

      if (isTerminal && state === 'pending' && heldContent) {
        yield* failUnconfirmedPrefixEcho();
      }

      if (outputContent !== undefined && outputContent.length > 0) {
        const prefixDelta = takePrefillDelta();
        if (prefixDelta) yield prefixDelta;
        yield { ...delta, contentDelta: outputContent };
        continue;
      }

      if (hasContent) {
        const nonContentParts = emitNonContentParts(delta);
        if (nonContentParts) {
          if (isTerminal && canSynthesizePrefill()) {
            const prefixDelta = takePrefillDelta();
            if (prefixDelta) yield prefixDelta;
          }
          yield nonContentParts;
        } else if (delta.contentDelta === '' && state !== 'pending') {
          const prefixDelta = takePrefillDelta();
          if (prefixDelta) yield prefixDelta;
          yield { ...delta, contentDelta: '' };
        }
        continue;
      }

      if (isTerminal) {
        if (canSynthesizePrefill()) {
          const prefixDelta = takePrefillDelta();
          if (prefixDelta) yield prefixDelta;
        }
      }
      yield delta;
    }
  } catch (error) {
    // An upstream error or abort cannot confirm whether held text is an echo.
    // Preserve those exact bytes and propagate the original failure; only an
    // already-confirmed echo may synthesize the complete prefill.
    if (state === 'pending') {
      yield* flushHeldContent();
    } else {
      yield* flushConfirmedPrefill();
    }
    throw error;
  }

  if (state === 'pending' && heldContent) {
    yield* failUnconfirmedPrefixEcho();
  }
  yield* flushConfirmedPrefill();
}

function resolveEffectiveThinkingProtocol(req: LlmStreamRequest): ProviderThinkingProtocol {
  return (
    req.capabilities?.thinkingProtocol ??
    (isOfficialDeepSeekUrl(req.baseUrl) ? 'deepseek' : 'openai_reasoning_effort')
  );
}

function resolveEffectivePrefixProtocol(req: LlmStreamRequest): ProviderPrefixProtocol {
  return (
    req.capabilities?.prefixProtocol ??
    (isOfficialDeepSeekUrl(req.baseUrl) ? 'deepseek_beta' : 'none')
  );
}

export function mapReasoningEffortToDeepSeekParams(effort: ReasoningEffort = 'none'): {
  thinking: DeepSeekThinkingParam;
  reasoning_effort: ReasoningEffort;
} {
  const normalized = normalizeReasoningEffort(effort, 'none');
  const reasoning_effort: ReasoningEffort = normalized === 'medium' ? 'high' : normalized;
  return {
    thinking: { type: reasoning_effort === 'none' ? 'disabled' : 'enabled' },
    reasoning_effort,
  };
}

export function buildOpenAiChatRequest(req: LlmStreamRequest): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (req.apiKey.trim()) {
    headers.Authorization = `Bearer ${req.apiKey.trim()}`;
  }

  const thinkingProtocol = resolveEffectiveThinkingProtocol(req);
  let thinking: DeepSeekThinkingParam | undefined;
  let reasoning_effort: ReasoningEffort | undefined;
  let allowReasoning = false;

  if (thinkingProtocol === 'deepseek') {
    const rawEffort =
      req.reasoningEffort ??
      req.reasoning_effort ??
      (req.thinking?.type === 'disabled' ? 'none' : 'none');
    const mapped = mapReasoningEffortToDeepSeekParams(
      normalizeReasoningEffort(rawEffort, 'none'),
    );
    thinking = req.thinking ?? mapped.thinking;
    reasoning_effort = mapped.reasoning_effort;
    allowReasoning = thinking.type !== 'disabled' && reasoning_effort !== 'none';
  } else {
    const effort = normalizeReasoningEffort(req.reasoningEffort ?? req.reasoning_effort, 'none');
    if (effort !== 'none') {
      reasoning_effort = effort === 'max' ? 'high' : effort;
      allowReasoning = true;
    }
  }

  const prefixProtocol = resolveEffectivePrefixProtocol(req);
  const usePrefix = Boolean(req.prefixCompletion) && prefixProtocol !== 'none';
  if (usePrefix && req.messages.length === 0) {
    throw new Error(
      'Cannot use prefix completion with an empty message history. The final original message must be user or system.',
    );
  }
  if (usePrefix && req.messages.at(-1)?.role === 'assistant') {
    throw new Error(
      'Cannot append an assistant prefix after an assistant message. The final original message must be user or system.',
    );
  }

  const messages =
    usePrefix && req.prefixCompletion
      ? [
          ...req.messages,
          prefixProtocol === 'deepseek_beta'
            ? {
                role: 'assistant' as const,
                content: req.prefixCompletion.content,
                prefix: true as const,
                ...(allowReasoning && req.prefixCompletion.reasoningContent !== undefined
                  ? { reasoning_content: req.prefixCompletion.reasoningContent }
                  : {}),
              }
            : {
                role: 'assistant' as const,
                content: req.prefixCompletion.content,
              },
        ]
      : req.messages;

  const url =
    usePrefix && prefixProtocol === 'deepseek_beta'
      ? resolveBetaChatCompletionsUrl(req.baseUrl)
      : resolveChatCompletionsUrl(req.baseUrl);

  return {
    url,
    headers,
    body: JSON.stringify({
      model: req.model,
      messages,
      stream: true,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
      ...(req.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(req.maxOutputTokens && req.maxOutputTokens > 0
        ? { max_tokens: Math.max(1, Math.floor(req.maxOutputTokens)) }
        : {}),
    }),
  };
}

/**
 * Creates an OpenAI-compatible streaming transport backed by an injected Fetch-like client.
 */
export function createOpenAiTransport(fetchImpl?: FetchLike): LlmTransport {
  const fetcher: FetchLike =
    fetchImpl ??
    ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);

  if (typeof fetcher !== 'function') {
    throw new Error('No fetch implementation available for OpenAI transport.');
  }

  return {
    async *streamChat(req: LlmStreamRequest): AsyncIterable<LlmStreamDelta> {
      const { url, headers, body } = buildOpenAiChatRequest(req);

      const response = await fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: req.signal,
      });

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          detail = '';
        }
        throw new Error(
          `Model request failed with HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
        );
      }

      if (!response.body) {
        throw new Error('Model response body is empty.');
      }

      const prefixProtocol = resolveEffectivePrefixProtocol(req);
      const prefillContent =
        prefixProtocol !== 'none' ? (req.prefixCompletion?.content ?? '') : '';
      yield* applyPrefixEchoCursor(
        parseOpenAiSseStream(toAsyncChunks(response.body)),
        prefillContent,
      );
    },
  };
}
