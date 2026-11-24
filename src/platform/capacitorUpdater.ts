import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  APP_UPDATE_MAX_APK_BYTES,
  FOLIO_ANDROID_RELEASES_API_URL,
  selectLatestStableGiteeRelease,
  type AbortSignalLike,
  type AppUpdateDownloadProgress,
  type AppUpdateDownloadedApk,
  type AppUpdateReleaseInfo,
  type AppUpdater,
} from '../harness/index.ts';
import { bindAbortSignal, createAbortError } from './nativeBridgeHelpers.ts';

export interface NativeUpdaterEventMap {
  updateProgress: {
    requestId: string;
    downloadedBytes: number;
    totalBytes?: number;
  };
  updateComplete: {
    requestId: string;
    fileName: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    reusedCache?: boolean;
  };
  updateError: {
    requestId: string;
    message: string;
    code?: string;
    status?: number;
    aborted?: boolean;
  };
  appResumed: Record<string, never>;
}

export interface NativeUpdaterPluginLike {
  addListener<K extends keyof NativeUpdaterEventMap>(
    eventName: K,
    listenerFunc: (event: NativeUpdaterEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  fetchReleasesJson(options: { url: string; maxBytes?: number }): Promise<{ json: string }>;
  downloadAndVerifyApk(options: {
    requestId: string;
    url: string;
    version: string;
    expectedSha256?: string;
    maxBytes?: number;
  }): Promise<void>;
  abortDownload(options: { requestId: string }): Promise<void>;
  canRequestPackageInstalls(): Promise<{ allowed: boolean }>;
  openInstallPermissionSettings(): Promise<void>;
  installDownloadedApk(options: { version: string }): Promise<void>;
  cleanupStaleApks(options: { keepVersion?: string }): Promise<void>;
  openExternalUrl(options: { url: string }): Promise<void>;
}

const NativeUpdater = registerPlugin<NativeUpdaterPluginLike>('NativeUpdater');

export class AppUpdateCodedError extends Error {
  readonly code?: string;
  readonly statusCode?: number;

  constructor(message: string, code?: string, statusCode?: number) {
    super(message);
    this.name = 'AppUpdateCodedError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `upd-${Date.now()}-${requestCounter}`;
}

export function createCapacitorAppUpdater(
  plugin: NativeUpdaterPluginLike = NativeUpdater,
  createRequestId: () => string = defaultRequestId,
): AppUpdater {
  return {
    async checkLatestRelease(signal?: AbortSignalLike): Promise<AppUpdateReleaseInfo | null> {
      if (signal?.aborted) {
        throw createAbortError('已取消检查更新。');
      }
      let json: string;
      try {
        const response = await plugin.fetchReleasesJson({
          url: FOLIO_ANDROID_RELEASES_API_URL,
          maxBytes: 1024 * 1024,
        });
        json = response.json;
      } catch (err) {
        const rawCode =
          err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        const statusMatch = /^(?:HTTP_)?(\d{3})$/.exec(rawCode ?? '') ?? /\bHTTP\s+(\d{3})\b/i.exec(msg);
        const status = statusMatch ? Number(statusMatch[1]) : undefined;
        throw new AppUpdateCodedError(
          msg || '检查更新失败。',
          rawCode ?? (status ? `HTTP_${status}` : 'NETWORK_ERROR'),
          status,
        );
      }
      if (signal?.aborted) {
        throw createAbortError('已取消检查更新。');
      }
      const parsed = JSON.parse(json) as unknown;
      return selectLatestStableGiteeRelease(parsed);
    },

    async downloadAndVerifyApk(
      release: AppUpdateReleaseInfo,
      onProgress?: (progress: AppUpdateDownloadProgress) => void,
      signal?: AbortSignalLike,
    ): Promise<AppUpdateDownloadedApk> {
      if (signal?.aborted) {
        throw createAbortError('已取消下载更新包。');
      }
      if (!/^https:\/\//i.test(release.apkUrl)) {
        throw new AppUpdateCodedError('仅支持通过 HTTPS 下载安装包。', 'NETWORK_ERROR');
      }

      const requestId = createRequestId();
      let started = false;
      let settled = false;

      return new Promise<AppUpdateDownloadedApk>((resolve, reject) => {
        const handles: PluginListenerHandle[] = [];
        let unbindAbort: (() => void) | undefined;

        const cleanup = () => {
          unbindAbort?.();
          void Promise.allSettled(handles.map((handle) => handle.remove()));
        };

        const finishError = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        const finishSuccess = (result: AppUpdateDownloadedApk) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const triggerAbort = () => {
          if (settled) return;
          if (started) {
            void plugin.abortDownload({ requestId }).catch(() => {});
          }
          finishError(createAbortError('已取消下载更新包。'));
        };

        unbindAbort = bindAbortSignal(signal, triggerAbort);

        void Promise.all([
          plugin.addListener('updateProgress', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            onProgress?.({
              downloadedBytes: ev.downloadedBytes,
              ...(typeof ev.totalBytes === 'number' && ev.totalBytes > 0
                ? { totalBytes: ev.totalBytes }
                : {}),
            });
          }),
          plugin.addListener('updateComplete', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            finishSuccess({
              fileName: ev.fileName,
              version: ev.version,
              sha256: ev.sha256,
              sizeBytes: ev.sizeBytes,
              reusedCache: ev.reusedCache,
            });
          }),
          plugin.addListener('updateError', (ev) => {
            if (ev.requestId !== requestId || settled) return;
            if (ev.aborted) {
              finishError(createAbortError(ev.message || '已取消下载更新包。'));
              return;
            }
            finishError(
              new AppUpdateCodedError(
                ev.message || '下载或校验安装包失败。',
                ev.code,
                ev.status,
              ),
            );
          }),
        ])
          .then((attached) => {
            handles.push(...attached);
            if (signal?.aborted) {
              triggerAbort();
              return;
            }
            started = true;
            return plugin.downloadAndVerifyApk({
              requestId,
              url: release.apkUrl,
              version: release.version,
              ...(release.expectedSha256 ? { expectedSha256: release.expectedSha256 } : {}),
              maxBytes: APP_UPDATE_MAX_APK_BYTES,
            });
          })
          .catch((err) => {
            finishError(err instanceof Error ? err : new Error(String(err)));
          });
      });
    },

    async canRequestPackageInstalls(): Promise<boolean> {
      const res = await plugin.canRequestPackageInstalls();
      return Boolean(res?.allowed);
    },

    async openInstallPermissionSettings(): Promise<void> {
      await plugin.openInstallPermissionSettings();
    },

    async installDownloadedApk(version: string): Promise<void> {
      await plugin.installDownloadedApk({ version });
    },

    async cleanupStaleApks(keepVersion?: string): Promise<void> {
      await plugin.cleanupStaleApks(keepVersion ? { keepVersion } : {});
    },

    async openExternalUrl(url: string): Promise<void> {
      if (!/^https:\/\//i.test(url)) {
        throw new Error('仅支持打开安全的 HTTPS 链接。');
      }
      await plugin.openExternalUrl({ url });
    },

    subscribeAppResumed(listener: () => void): () => void {
      let handle: PluginListenerHandle | undefined;
      let disposed = false;
      void plugin
        .addListener('appResumed', () => {
          if (!disposed) listener();
        })
        .then((attached) => {
          if (disposed) {
            void attached.remove();
            return;
          }
          handle = attached;
        })
        .catch(() => {});
      return () => {
        disposed = true;
        if (handle) {
          void handle.remove();
        }
      };
    },
  };
}
