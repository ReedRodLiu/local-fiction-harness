import type {
  FetchLike,
  FetchResponseLike,
  LlmStreamDelta,
  LlmStreamRequest,
  LlmTransport,
} from './types.ts';

interface StreamingTextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

function createUtf8Decoder(): StreamingTextDecoder {
  const DecoderCtor = (
    globalThis as { TextDecoder?: new (label?: string) => StreamingTextDecoder }
  ).TextDecoder;
  if (!DecoderCtor) {
    throw new Error('TextDecoder is not available in this JavaScript runtime.');
  }
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

function parseSseDataLine(dataText: string): { done: boolean; delta?: LlmStreamDelta } {
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
 * decoding UTF-8 across chunk boundaries and separating reasoning from content.
 */
export async function* parseOpenAiSseStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<LlmStreamDelta> {
  const decoder = createUtf8Decoder();
  let buffer = '';

  const processLines = function* (flushRemaining: boolean): Generator<LlmStreamDelta, boolean> {
    const lines = buffer.split(/\r?\n/);
    buffer = flushRemaining ? '' : (lines.pop() ?? '');

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5);
      const parsed = parseSseDataLine(payload);
      if (parsed.done) {
        return true;
      }
      if (parsed.delta) {
        yield parsed.delta;
      }
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
  if (buffer.trim()) {
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
      const url = resolveChatCompletionsUrl(req.baseUrl);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (req.apiKey.trim()) {
        headers.Authorization = `Bearer ${req.apiKey.trim()}`;
      }

      const response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
        }),
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
