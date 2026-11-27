import { getTextDecoderCtor, type TextDecoderLike } from './encoding.ts';
import {
  isOfficialDeepSeekUrl,
  normalizeProviderApiProtocol,
  normalizeReasoningEffort,
} from './keyConfig.ts';
import type {
  DeepSeekThinkingParam,
  FetchLike,
  FetchResponseLike,
  LlmStreamDelta,
  LlmStreamRequest,
  LlmTransport,
  LlmUsage,
  ProviderApiProtocol,
  ProviderCapabilities,
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

function parseResponsesUsage(raw: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: {
    cached_tokens?: unknown;
  };
  output_tokens_details?: {
    reasoning_tokens?: unknown;
  };
} | undefined): LlmUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = optionalTokenCount(raw.input_tokens);
  const completionTokens = optionalTokenCount(raw.output_tokens);
  const totalTokens = optionalTokenCount(raw.total_tokens);
  const cachedTokens = optionalTokenCount(raw.input_tokens_details?.cached_tokens);
  const promptCacheHitTokens = cachedTokens;
  const promptCacheMissTokens =
    cachedTokens !== undefined && promptTokens !== undefined
      ? Math.max(0, promptTokens - cachedTokens)
      : undefined;
  const reasoningTokens = optionalTokenCount(raw.output_tokens_details?.reasoning_tokens);
  const usage: LlmUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
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

function parseGeminiUsage(raw: {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
  totalTokenCount?: unknown;
} | undefined): LlmUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = optionalTokenCount(raw.promptTokenCount);
  const candidatesTokens = optionalTokenCount(raw.candidatesTokenCount);
  const thoughtsTokens = optionalTokenCount(raw.thoughtsTokenCount);
  const completionTokens =
    candidatesTokens !== undefined
      ? candidatesTokens + (thoughtsTokens ?? 0)
      : thoughtsTokens;
  const totalTokens = optionalTokenCount(raw.totalTokenCount);
  const cachedTokens = optionalTokenCount(raw.cachedContentTokenCount);
  const promptCacheHitTokens = cachedTokens;
  const promptCacheMissTokens =
    cachedTokens !== undefined && promptTokens !== undefined
      ? Math.max(0, promptTokens - cachedTokens)
      : undefined;
  const usage: LlmUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    ...(thoughtsTokens === undefined
      ? {}
      : { completionTokensDetails: { reasoningTokens: thoughtsTokens } }),
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

function mapGeminiFinishReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  if (!upper) return undefined;
  if (upper === 'STOP') return 'stop';
  if (upper === 'MAX_TOKENS') return 'length';
  if (
    upper === 'SAFETY' ||
    upper === 'RECITATION' ||
    upper === 'BLOCKLIST' ||
    upper === 'PROHIBITED_CONTENT' ||
    upper === 'SPII' ||
    upper === 'IMAGE_SAFETY' ||
    upper === 'IMAGE_PROHIBITED_CONTENT'
  ) {
    return 'content_filter';
  }
  return upper.toLowerCase();
}

function parseGeminiEventData(dataText: string): {
  delta?: LlmStreamDelta;
  usage?: LlmUsage;
} {
  const trimmed = dataText.trim();
  if (!trimmed || trimmed === '[DONE]') {
    return {};
  }

  let parsed: {
    error?: { message?: string };
    promptFeedback?: { blockReason?: unknown };
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: unknown;
          thought?: unknown;
        }>;
      };
      finishReason?: unknown;
    }>;
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      thoughtsTokenCount?: unknown;
      cachedContentTokenCount?: unknown;
      totalTokenCount?: unknown;
    };
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  if (parsed.error) {
    throw new Error(parsed.error.message || 'Gemini API returned an SSE error payload.');
  }

  const usage = parseGeminiUsage(parsed.usageMetadata);
  const candidate = parsed.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const reasoningParts: string[] = [];
  const contentParts: string[] = [];

  for (const part of parts) {
    if (!part || typeof part.text !== 'string') continue;
    if (part.thought === true) {
      reasoningParts.push(part.text);
    } else {
      contentParts.push(part.text);
    }
  }

  const reasoningDelta = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;
  const contentDelta = contentParts.length > 0 ? contentParts.join('') : undefined;
  const finishReason =
    mapGeminiFinishReason(candidate?.finishReason) ??
    (!candidate && typeof parsed.promptFeedback?.blockReason === 'string'
      ? 'content_filter'
      : undefined);

  if (
    reasoningDelta === undefined &&
    contentDelta === undefined &&
    finishReason === undefined
  ) {
    return usage ? { usage } : {};
  }

  return {
    delta: {
      ...(reasoningDelta !== undefined ? { reasoningDelta } : {}),
      ...(contentDelta !== undefined ? { contentDelta } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
    ...(usage ? { usage } : {}),
  };
}

/**
 * Parses a Google Gemini :streamGenerateContent?alt=sse stream into normalized deltas,
 * separating thought parts from content parts and coalescing cumulative usageMetadata.
 */
export async function* parseGeminiSseStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  let pendingUsage: LlmUsage | undefined;
  for await (const frame of iterateSseFrames(chunks)) {
    const parsed = parseGeminiEventData(frame.data);
    if (parsed.usage) {
      pendingUsage = parsed.usage;
    }
    if (!parsed.delta) {
      continue;
    }
    if (parsed.delta.finishReason !== undefined && pendingUsage) {
      const usage = pendingUsage;
      pendingUsage = undefined;
      yield { ...parsed.delta, usage };
    } else {
      yield parsed.delta;
    }
  }
  if (pendingUsage) {
    yield { usage: pendingUsage };
  }
}

async function* iterateSseFrames(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<{ event?: string; data: string }> {
  const decoder = createUtf8Decoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flushEvent = function* (): Generator<{ event?: string; data: string }> {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return;
    }
    const payload = dataLines.join('\n');
    const event = currentEvent;
    dataLines = [];
    currentEvent = undefined;
    yield { ...(event ? { event } : {}), data: payload };
  };

  const processLines = function* (
    flushRemaining: boolean,
  ): Generator<{ event?: string; data: string }> {
    const lines = buffer.split(/\r?\n/);
    buffer = flushRemaining ? '' : (lines.pop() ?? '');

    for (const line of lines) {
      if (line === '') {
        yield* flushEvent();
        continue;
      }
      if (line.startsWith('event:')) {
        if (dataLines.length > 0 && isCompleteSsePayload(dataLines.join('\n'))) {
          yield* flushEvent();
        }
        currentEvent = (line[6] === ' ' ? line.slice(7) : line.slice(6)).trim() || undefined;
        continue;
      }
      if (!line.startsWith('data:')) {
        continue;
      }
      if (dataLines.length > 0 && isCompleteSsePayload(dataLines.join('\n'))) {
        yield* flushEvent();
      }
      const value = line[5] === ' ' ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }

    if (flushRemaining) {
      yield* flushEvent();
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* processLines(false);
  }

  buffer += decoder.decode(undefined, { stream: false });
  if (buffer.length > 0 || dataLines.length > 0) {
    yield* processLines(true);
  }
}

/**
 * Parses an OpenAI-compatible Server-Sent Events stream into typed deltas,
 * decoding UTF-8 across chunk boundaries, assembling multi-line data: events,
 * and separating reasoning from content.
 */
export async function* parseOpenAiSseStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  for await (const frame of iterateSseFrames(chunks)) {
    const parsed = parseSseEventData(frame.data);
    if (parsed.done) {
      return;
    }
    if (parsed.delta) {
      yield parsed.delta;
    }
  }
}

function parseResponsesEventData(
  dataText: string,
  frameEvent?: string,
): { done: boolean; delta?: LlmStreamDelta } {
  const trimmed = dataText.trim();
  if (!trimmed) {
    return { done: false };
  }
  if (trimmed === '[DONE]') {
    return { done: true };
  }

  let parsed: {
    type?: unknown;
    delta?: unknown;
    message?: unknown;
    error?: { message?: string };
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
    response?: {
      status?: unknown;
      error?: { message?: string };
      incomplete_details?: { reason?: unknown };
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown };
        output_tokens_details?: { reasoning_tokens?: unknown };
      };
    };
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { done: false };
  }

  const eventType = typeof parsed.type === 'string' ? parsed.type : frameEvent;
  if (parsed.error || eventType === 'error') {
    const msg =
      parsed.error?.message ||
      (typeof parsed.message === 'string' ? parsed.message : undefined) ||
      'OpenAI Responses API returned an SSE error payload.';
    throw new Error(msg);
  }
  if (eventType === 'response.failed') {
    const msg =
      parsed.response?.error?.message ||
      'OpenAI Responses API request failed.';
    throw new Error(msg);
  }

  if (
    eventType === 'response.reasoning_summary_text.delta' ||
    eventType === 'response.reasoning_text.delta'
  ) {
    if (typeof parsed.delta === 'string') {
      return { done: false, delta: { reasoningDelta: parsed.delta } };
    }
    return { done: false };
  }

  if (eventType === 'response.output_text.delta') {
    if (typeof parsed.delta === 'string') {
      return { done: false, delta: { contentDelta: parsed.delta } };
    }
    return { done: false };
  }

  if (
    eventType === 'response.completed' ||
    eventType === 'response.done' ||
    eventType === 'response.incomplete'
  ) {
    const responseObj = parsed.response;
    const usage = parseResponsesUsage(responseObj?.usage ?? parsed.usage);
    const isIncomplete =
      eventType === 'response.incomplete' || responseObj?.status === 'incomplete';
    const incompleteReason = responseObj?.incomplete_details?.reason;
    const finishReason = isIncomplete
      ? incompleteReason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : 'stop';
    return {
      done: false,
      delta: {
        finishReason,
        ...(usage ? { usage } : {}),
      },
    };
  }

  return { done: false };
}

/**
 * Parses an OpenAI Responses API Server-Sent Events stream into normalized deltas
 * and usage metrics, separating reasoning summary deltas from output text deltas.
 */
export async function* parseOpenAiResponsesSseStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  for await (const frame of iterateSseFrames(chunks)) {
    const parsed = parseResponsesEventData(frame.data, frame.event);
    if (parsed.done) {
      return;
    }
    if (parsed.delta) {
      yield parsed.delta;
    }
  }
}

export function resolveResponsesUrl(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error('Model Base URL cannot be empty.');
  }
  if (cleaned.endsWith('/responses')) {
    return cleaned;
  }
  if (cleaned.endsWith('/beta/chat/completions')) {
    return `${cleaned.slice(0, -'/beta/chat/completions'.length)}/responses`;
  }
  if (cleaned.endsWith('/chat/completions')) {
    return `${cleaned.slice(0, -'/chat/completions'.length)}/responses`;
  }
  return `${cleaned}/responses`;
}

export function stripGeminiActionSuffix(url: string): string {
  return url
    .replace(/\/models\/[^/?#]+:(?:streamGenerateContent|generateContent)(?:\?.*)?$/i, '')
    .replace(/\/[^/?#]+:(?:streamGenerateContent|generateContent)(?:\?.*)?$/i, '');
}

export function resolveGeminiStreamUrl(baseUrl: string, model: string): string {
  const cleaned = stripGeminiActionSuffix(baseUrl.trim().replace(/\/+$/, ''))
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error('Model Base URL cannot be empty.');
  }
  const strippedModel = model.trim().replace(/^models\//i, '');
  if (!strippedModel) {
    throw new Error('Model ID cannot be empty.');
  }
  return `${cleaned}/models/${encodeURIComponent(strippedModel)}:streamGenerateContent?alt=sse`;
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

export function resolveEffectiveApiProtocol(input: {
  capabilities?: ProviderCapabilities;
}): ProviderApiProtocol {
  return normalizeProviderApiProtocol(input.capabilities?.apiProtocol, 'openai_chat');
}

function resolveEffectiveThinkingProtocol(req: LlmStreamRequest): ProviderThinkingProtocol {
  return (
    req.capabilities?.thinkingProtocol ??
    (isOfficialDeepSeekUrl(req.baseUrl) ? 'deepseek' : 'openai_reasoning_effort')
  );
}

export function resolveEffectivePrefixProtocol(input: {
  baseUrl: string;
  capabilities?: ProviderCapabilities;
}): ProviderPrefixProtocol {
  const apiProtocol = resolveEffectiveApiProtocol(input);
  if (apiProtocol === 'openai_responses' || apiProtocol === 'gemini_native') {
    return 'none';
  }
  return (
    input.capabilities?.prefixProtocol ??
    (isOfficialDeepSeekUrl(input.baseUrl) ? 'deepseek_beta' : 'none')
  );
}

export function resolveStreamPrefillContent(req: LlmStreamRequest): string {
  return resolveEffectivePrefixProtocol(req) !== 'none'
    ? (req.prefixCompletion?.content ?? '')
    : '';
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

export function buildOpenAiResponsesRequest(req: LlmStreamRequest): {
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

  const systemParts: string[] = [];
  const input: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      if (msg.content.trim()) {
        systemParts.push(msg.content);
      }
    } else {
      input.push({ role: msg.role, content: msg.content });
    }
  }
  const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  const rawEffort = normalizeReasoningEffort(req.reasoningEffort ?? req.reasoning_effort, 'none');
  const reasoning =
    rawEffort !== 'none'
      ? {
          effort: (rawEffort === 'max' ? 'high' : rawEffort) as 'low' | 'medium' | 'high',
          summary: 'auto' as const,
        }
      : undefined;

  return {
    url: resolveResponsesUrl(req.baseUrl),
    headers,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      store: false,
      ...(instructions !== undefined ? { instructions } : {}),
      input,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(req.maxOutputTokens && req.maxOutputTokens > 0
        ? { max_output_tokens: Math.max(1, Math.floor(req.maxOutputTokens)) }
        : {}),
    }),
  };
}

function resolveGeminiThinkingConfig(
  model: string,
  effort: ReasoningEffort,
): Record<string, unknown> | undefined {
  const lower = model.trim().replace(/^models\//i, '').toLowerCase();
  if (lower.includes('gemini-3')) {
    if (effort === 'none') {
      return { thinkingLevel: lower.includes('pro') ? 'low' : 'minimal' };
    }
    return {
      includeThoughts: true,
      thinkingLevel: effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high',
    };
  }
  if (/^gemini-(?:1\.|2\.0-)/.test(lower) && !lower.includes('thinking')) {
    return undefined;
  }
  if (effort === 'none') {
    const requiresNonZeroBudget =
      lower.includes('2.5-pro') || (lower.includes('pro') && !lower.includes('flash'));
    return { thinkingBudget: requiresNonZeroBudget ? 128 : 0 };
  }
  const thinkingBudget = effort === 'low' ? 2048 : effort === 'medium' ? 8192 : 16384;
  return {
    includeThoughts: true,
    thinkingBudget,
  };
}

/**
 * Builds a Google Gemini native :streamGenerateContent?alt=sse request using
 * x-goog-api-key header authentication (never query params) and merged user/model turns.
 */
export function buildGeminiNativeRequest(req: LlmStreamRequest): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (req.apiKey.trim()) {
    headers['x-goog-api-key'] = req.apiKey.trim();
  }

  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      if (msg.content.trim()) {
        systemParts.push(msg.content);
      }
      continue;
    }
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
    const previous = contents.at(-1);
    if (previous && previous.role === role) {
      const prevText = previous.parts[0]?.text ?? '';
      previous.parts[0] = {
        text: prevText && msg.content ? `${prevText}\n\n${msg.content}` : prevText || msg.content,
      };
    } else {
      contents.push({ role, parts: [{ text: msg.content }] });
    }
  }

  const systemText = systemParts.join('\n\n');
  const effort = normalizeReasoningEffort(req.reasoningEffort ?? req.reasoning_effort, 'none');
  const thinkingConfig = resolveGeminiThinkingConfig(req.model, effort);
  const maxOutputTokens =
    req.maxOutputTokens && req.maxOutputTokens > 0
      ? Math.max(1, Math.floor(req.maxOutputTokens))
      : undefined;

  const generationConfig: Record<string, unknown> = {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(thinkingConfig !== undefined ? { thinkingConfig } : {}),
  };

  return {
    url: resolveGeminiStreamUrl(req.baseUrl, req.model),
    headers,
    body: JSON.stringify({
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents,
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    }),
  };
}

/**
 * Dispatches streaming request construction by the profile's apiProtocol so Web
 * and Android NativeSse transports share identical wire payloads.
 */
export function buildProviderStreamRequest(req: LlmStreamRequest): {
  protocol: ProviderApiProtocol;
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const protocol = resolveEffectiveApiProtocol(req);
  if (protocol === 'openai_responses') {
    return { protocol, ...buildOpenAiResponsesRequest(req) };
  }
  if (protocol === 'gemini_native') {
    return { protocol, ...buildGeminiNativeRequest(req) };
  }
  if (protocol === 'openai_chat') {
    return { protocol, ...buildOpenAiChatRequest(req) };
  }
  throw new Error(`Unsupported API protocol: ${protocol}`);
}

/**
 * Dispatches SSE byte/text stream parsing by ProviderApiProtocol into normalized
 * LlmStreamDelta events.
 */
export function parseProviderSseStream(
  protocol: ProviderApiProtocol,
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  if (protocol === 'openai_responses') {
    return parseOpenAiResponsesSseStream(chunks);
  }
  if (protocol === 'gemini_native') {
    return parseGeminiSseStream(chunks);
  }
  if (protocol === 'openai_chat') {
    return parseOpenAiSseStream(chunks);
  }
  throw new Error(`Unsupported API protocol: ${protocol}`);
}

/**
 * Creates a multi-protocol streaming transport backed by an injected Fetch-like client.
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
      const { protocol, url, headers, body } = buildProviderStreamRequest(req);

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

      yield* applyPrefixEchoCursor(
        parseProviderSseStream(protocol, toAsyncChunks(response.body)),
        resolveStreamPrefillContent(req),
      );
    },
  };
}
