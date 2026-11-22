import { getTextDecoderCtor, type TextDecoderLike } from './encoding.ts';
import { normalizeReasoningEffort } from './keyConfig.ts';
import type {
  DeepSeekThinkingParam,
  FetchLike,
  FetchResponseLike,
  LlmStreamDelta,
  LlmStreamRequest,
  LlmTransport,
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
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { done: false };
  }

  if (parsed.error) {
    throw new Error(parsed.error.message || 'Model provider returned an SSE error payload.');
  }

  const choice = parsed.choices?.[0];
  if (!choice) {
    return { done: false };
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
    choice.finish_reason === undefined
  ) {
    return { done: false };
  }

  return {
    done: false,
    delta: {
      contentDelta,
      reasoningDelta: reasoningRaw,
      finishReason: choice.finish_reason,
    },
  };
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

export function mapReasoningEffortToDeepSeekParams(effort: ReasoningEffort = 'high'): {
  thinking: DeepSeekThinkingParam;
  reasoning_effort: ReasoningEffort;
} {
  const normalized = normalizeReasoningEffort(effort);
  return {
    thinking: { type: normalized === 'none' ? 'disabled' : 'enabled' },
    reasoning_effort: normalized,
  };
}

export function buildOpenAiChatRequest(req: LlmStreamRequest): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const url = resolveChatCompletionsUrl(req.baseUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (req.apiKey.trim()) {
    headers.Authorization = `Bearer ${req.apiKey.trim()}`;
  }
  const effort =
    req.reasoningEffort ??
    req.reasoning_effort ??
    (req.thinking?.type === 'disabled' ? 'none' : 'high');
  const mapped = mapReasoningEffortToDeepSeekParams(effort);
  const thinking = req.thinking ?? mapped.thinking;
  const reasoning_effort = req.reasoning_effort ?? mapped.reasoning_effort;
  return {
    url,
    headers,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      thinking,
      reasoning_effort,
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

      yield* parseOpenAiSseStream(toAsyncChunks(response.body));
    },
  };
}
