import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  parseOpenAiSseStream,
  resolveChatCompletionsUrl,
  type AbortSignalLike,
  type LlmStreamDelta,
  type LlmStreamRequest,
  type LlmTransport,
} from '../harness/index.ts';

export interface NativeSseEventMap {
  sseChunk: { requestId: string; chunkBase64: string };
  sseComplete: { requestId: string };
  sseError: { requestId: string; message: string; status?: number; aborted?: boolean };
}

export interface NativeSsePluginLike {
  addListener<K extends keyof NativeSseEventMap>(
    eventName: K,
    listenerFunc: (event: NativeSseEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  startStream(options: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
  abortStream(options: { requestId: string }): Promise<void>;
}

const NativeSse = registerPlugin<NativeSsePluginLike>('NativeSse');

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createAbortError(message = '操作已中止。'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function createDefaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface AbortEventTargetLike {
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Adapts the Capacitor NativeSse chunked streaming plugin into the shared LlmTransport contract,
 * preserving cross-chunk UTF-8 decoding, reasoning_content separation, requestId isolation, and abort.
 */
export function createCapacitorSseTransport(
  plugin: NativeSsePluginLike = NativeSse,
  createRequestId: () => string = createDefaultRequestId,
): LlmTransport {
  return {
    async *streamChat(req: LlmStreamRequest): AsyncIterable<LlmStreamDelta> {
      if (req.signal?.aborted) {
        throw createAbortError();
      }

      const requestId = createRequestId();
      const url = resolveChatCompletionsUrl(req.baseUrl);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (req.apiKey.trim()) {
        headers.Authorization = `Bearer ${req.apiKey.trim()}`;
      }

      const queue: Uint8Array[] = [];
      let waiter: (() => void) | null = null;
      let streamDone = false;
      let streamError: Error | null = null;
      let started = false;

      const wake = () => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve();
        }
      };

      const onAbort = () => {
        if (!streamDone && !streamError) {
          streamError = createAbortError();
          wake();
          if (started) {
            void plugin.abortStream({ requestId }).catch(() => {});
          }
        }
      };

      const signalTarget = req.signal as (AbortSignalLike & AbortEventTargetLike) | undefined;
      signalTarget?.addEventListener?.('abort', onAbort, { once: true });

      const handles: PluginListenerHandle[] = [];
      try {
        const [chunkHandle, completeHandle, errorHandle] = await Promise.all([
          plugin.addListener('sseChunk', (ev) => {
            if (ev.requestId !== requestId || streamDone || streamError) return;
            queue.push(decodeBase64ToBytes(ev.chunkBase64));
            wake();
          }),
          plugin.addListener('sseComplete', (ev) => {
            if (ev.requestId !== requestId || streamDone || streamError) return;
            streamDone = true;
            wake();
          }),
          plugin.addListener('sseError', (ev) => {
            if (ev.requestId !== requestId || streamDone || streamError) return;
            streamError = ev.aborted
              ? createAbortError(ev.message || '操作已中止。')
              : new Error(ev.message || 'Android 原生 SSE 请求失败。');
            wake();
          }),
        ]);
        handles.push(chunkHandle, completeHandle, errorHandle);

        if (req.signal?.aborted) {
          throw createAbortError();
        }

        started = true;
        await plugin.startStream({
          requestId,
          url,
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: true,
          }),
        });

        async function* rawByteChunks(): AsyncIterable<Uint8Array> {
          while (true) {
            if (req.signal?.aborted) {
              throw createAbortError();
            }
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (streamError) {
              throw streamError;
            }
            if (streamDone) {
              return;
            }
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
          }
        }

        yield* parseOpenAiSseStream(rawByteChunks());
      } finally {
        signalTarget?.removeEventListener?.('abort', onAbort);
        if (started && !streamDone && !streamError) {
          void plugin.abortStream({ requestId }).catch(() => {});
        }
        await Promise.allSettled(handles.map((h) => h.remove()));
      }
    },
  };
}
