import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  buildOpenAiChatRequest,
  createDefaultId,
  parseOpenAiSseStream,
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
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
  abortStream(options: { requestId: string }): Promise<void>;
}

const NativeSse = registerPlugin<NativeSsePluginLike>('NativeSse');

function decodeBase64ToBytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    throw new Error(
      `无法解码原生 SSE 分块数据: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function createAbortError(message = '操作已中止。'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
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
  createRequestId: () => string = createDefaultId,
): LlmTransport {
  return {
    async *streamChat(req: LlmStreamRequest): AsyncIterable<LlmStreamDelta> {
      if (req.signal?.aborted) {
        throw createAbortError();
      }

      const requestId = createRequestId();
      const { url, headers, body } = buildOpenAiChatRequest(req);

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
      const hasEventTargetAbort = typeof signalTarget?.addEventListener === 'function';
      if (hasEventTargetAbort) {
        signalTarget!.addEventListener!('abort', onAbort, { once: true });
      }

      const handles: PluginListenerHandle[] = [];
      try {
        const [chunkHandle, completeHandle, errorHandle] = await Promise.all([
          plugin.addListener('sseChunk', (ev) => {
            if (ev.requestId !== requestId || streamDone || streamError) return;
            try {
              queue.push(decodeBase64ToBytes(ev.chunkBase64));
            } catch (err) {
              streamError = err instanceof Error ? err : new Error(String(err));
            }
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
          headers,
          body,
        });

        async function* rawByteChunks(): AsyncIterable<Uint8Array> {
          while (true) {
            if (req.signal?.aborted) {
              onAbort();
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
              let pollTimer: ReturnType<typeof setInterval> | undefined;
              const finishWait = () => {
                if (pollTimer !== undefined) {
                  clearInterval(pollTimer);
                }
                resolve();
              };
              waiter = finishWait;
              if (req.signal && !hasEventTargetAbort) {
                pollTimer = setInterval(() => {
                  if (req.signal?.aborted) {
                    onAbort();
                  }
                }, 20);
              }
            });
          }
        }

        yield* parseOpenAiSseStream(rawByteChunks());
      } finally {
        if (hasEventTargetAbort) {
          signalTarget?.removeEventListener?.('abort', onAbort);
        }
        if (started && !streamDone && !streamError) {
          void plugin.abortStream({ requestId }).catch(() => {});
        }
        await Promise.allSettled(handles.map((h) => h.remove()));
      }
    },
  };
}
