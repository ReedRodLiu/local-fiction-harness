import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  createDefaultId,
  validateDownloadedZipBytes,
  validateHttpsZipUrl,
  type AbortSignalLike,
  type BinaryDownloader,
  type BinaryDownloadResult,
} from '../harness/index.ts';
import {
  bindAbortSignal,
  createAbortError,
  decodeBase64ToBytes,
} from './nativeBridgeHelpers.ts';

export interface NativeBinaryEventMap {
  binaryChunk: { requestId: string; chunkBase64: string };
  binaryComplete: { requestId: string; contentType?: string };
  binaryError: { requestId: string; message: string; status?: number; aborted?: boolean };
}

export interface NativeBinaryPluginLike {
  addListener<K extends keyof NativeBinaryEventMap>(
    eventName: K,
    listenerFunc: (event: NativeBinaryEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  startDownload(options: { requestId: string; url: string; maxBytes: number }): Promise<void>;
  abortDownload(options: { requestId: string }): Promise<void>;
}

const NativeBinary = registerPlugin<NativeBinaryPluginLike>('NativeBinary');

/**
 * Adapts the Capacitor NativeBinary plugin into the shared BinaryDownloader contract.
 * Bypasses Android WebView CORS while preserving strict HTTPS, maxBytes limits, PK magic checks, and abort.
 */
export function createCapacitorBinaryDownloader(
  plugin: NativeBinaryPluginLike = NativeBinary,
  createRequestId: () => string = createDefaultId,
): BinaryDownloader {
  return {
    async downloadZipBytes(
      rawUrl: string,
      maxBytes: number,
      signal?: AbortSignalLike,
    ): Promise<BinaryDownloadResult> {
      const url = validateHttpsZipUrl(rawUrl);
      if (signal?.aborted) {
        throw createAbortError('已取消拉取导出压缩包。');
      }

      const requestId = createRequestId();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let contentType: string | undefined;
      let started = false;
      let settled = false;

      return new Promise<BinaryDownloadResult>((resolve, reject) => {
        const handles: PluginListenerHandle[] = [];
        let unbindAbort: (() => void) | undefined;

        const cleanup = () => {
          unbindAbort?.();
          void Promise.allSettled(handles.map((h) => h.remove()));
        };

        const finishWithError = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        const finishSuccess = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const merged = new Uint8Array(totalBytes);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          try {
            validateDownloadedZipBytes(merged, maxBytes, contentType);
            resolve({ bytes: merged, contentType });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        const triggerAbort = () => {
          if (settled) return;
          if (started) {
            void plugin.abortDownload({ requestId }).catch(() => {});
          }
          finishWithError(createAbortError('已取消拉取导出压缩包。'));
        };

        unbindAbort = bindAbortSignal(signal, triggerAbort);

        void Promise.all([
          plugin.addListener('binaryChunk', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            try {
              const bytes = decodeBase64ToBytes(ev.chunkBase64, '原生下载分块数据');
              totalBytes += bytes.byteLength;
              if (totalBytes > maxBytes) {
                void plugin.abortDownload({ requestId }).catch(() => {});
                finishWithError(new Error('导出压缩包体积超出安全大小上限，已中止下载。'));
                return;
              }
              chunks.push(bytes);
            } catch (err) {
              finishWithError(err instanceof Error ? err : new Error(String(err)));
            }
          }),
          plugin.addListener('binaryComplete', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            contentType = ev.contentType;
            finishSuccess();
          }),
          plugin.addListener('binaryError', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            const err = ev.aborted
              ? createAbortError(ev.message || '已取消拉取导出压缩包。')
              : new Error(ev.message || 'Android 原生下载导出包失败。');
            finishWithError(err);
          }),
        ])
          .then((attached) => {
            handles.push(...attached);
            if (signal?.aborted) {
              triggerAbort();
              return;
            }
            started = true;
            return plugin.startDownload({ requestId, url, maxBytes });
          })
          .catch((err) => {
            finishWithError(err instanceof Error ? err : new Error(String(err)));
          });
      });
    },
  };
}
