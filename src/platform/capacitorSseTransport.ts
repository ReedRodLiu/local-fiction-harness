import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  buildOpenAiChatRequest,
  applyPrefixEchoCursor,
  createDefaultId,
  parseOpenAiSseStream,
  type LlmStreamDelta,
  type LlmStreamRequest,
  type LlmTransport,
} from '../harness/index.ts';
import {
  bindAbortSignal,
  createAbortError,
  decodeBase64ToBytes,
} from './nativeBridgeHelpers.ts';

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

      const unbind = bindAbortSignal(req.signal, onAbort);

      const handles: PluginListenerHandle[] = [];
      try {
        const [chunkHandle, completeHandle, errorHandle] = await Promise.all([
          plugin.addListener('sseChunk', (ev) => {
            if (ev.requestId !== requestId || streamDone || streamError) return;
            try {
              queue.push(decodeBase64ToBytes(ev.chunkBase64, '原生 SSE 分块数据'));
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
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (req.signal?.aborted) {
              onAbort();
              throw createAbortError();
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

        yield* applyPrefixEchoCursor(
          parseOpenAiSseStream(rawByteChunks()),
          req.prefixCompletion?.content ?? '',
        );
      } finally {
        unbind();
        if (started && !streamDone && !streamError) {
          void plugin.abortStream({ requestId }).catch(() => {});
        }
        await Promise.allSettled(handles.map((h) => h.remove()));
      }
    },
  };
}
