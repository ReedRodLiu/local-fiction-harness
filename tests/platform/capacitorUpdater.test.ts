import { describe, expect, it, vi } from 'vitest';
import type { PluginListenerHandle } from '@capacitor/core';
import type { AppUpdateReleaseInfo } from '../../src/harness/index.ts';
import {
  AppUpdateCodedError,
  createCapacitorAppUpdater,
  type NativeUpdaterEventMap,
  type NativeUpdaterPluginLike,
} from '../../src/platform/capacitorUpdater.ts';

function createMockUpdaterPlugin() {
  const listeners = new Map<
    keyof NativeUpdaterEventMap,
    Set<(event: NativeUpdaterEventMap[keyof NativeUpdaterEventMap]) => void>
  >();

  const emit = <K extends keyof NativeUpdaterEventMap>(
    eventName: K,
    payload: NativeUpdaterEventMap[K],
  ) => {
    const set = listeners.get(eventName);
    if (!set) return;
    for (const fn of set) {
      fn(payload);
    }
  };

  const plugin: NativeUpdaterPluginLike = {
    async addListener<K extends keyof NativeUpdaterEventMap>(
      eventName: K,
      listenerFunc: (event: NativeUpdaterEventMap[K]) => void,
    ): Promise<PluginListenerHandle> {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      const wrapped = listenerFunc as (event: NativeUpdaterEventMap[keyof NativeUpdaterEventMap]) => void;
      set.add(wrapped);
      return {
        remove: async () => {
          set?.delete(wrapped);
        },
      };
    },
    fetchReleasesJson: vi.fn(async () => ({ json: '[]' })),
    downloadAndVerifyApk: vi.fn(async () => {}),
    abortDownload: vi.fn(async () => {}),
    canRequestPackageInstalls: vi.fn(async () => ({ allowed: true })),
    openInstallPermissionSettings: vi.fn(async () => {}),
    installDownloadedApk: vi.fn(async () => {}),
    cleanupStaleApks: vi.fn(async () => {}),
    openExternalUrl: vi.fn(async () => {}),
  };

  return { plugin, emit };
}

const SAMPLE_RELEASE: AppUpdateReleaseInfo = {
  version: '0.3.1',
  tagName: 'v0.3.1',
  title: 'Folio V0.3.1',
  notes: 'Release notes',
  releasePageUrl: 'https://gitee.com/liu-reed-rod/folio-android/releases/tag/v0.3.1',
  apkName: 'Folio-v0.3.1-release.apk',
  apkUrl: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-release.apk',
  expectedSha256: 'a'.repeat(64),
};

describe('Capacitor NativeUpdater adapter', () => {
  it('fetches and parses latest stable Gitee release and wraps HTTP 403/429 into AppUpdateCodedError', async () => {
    const { plugin } = createMockUpdaterPlugin();
    const updater = createCapacitorAppUpdater(plugin, () => 'req-1');

    (plugin.fetchReleasesJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: JSON.stringify([
        {
          tag_name: 'v0.3.1',
          prerelease: false,
          name: 'Folio V0.3.1',
          body: `SHA-256: ${'b'.repeat(64)}`,
          assets: [
            {
              name: 'Folio-v0.3.1-release.apk',
              browser_download_url: SAMPLE_RELEASE.apkUrl,
            },
          ],
        },
      ]),
    });

    const latest = await updater.checkLatestRelease();
    expect(latest?.version).toBe('0.3.1');
    expect(latest?.expectedSha256).toBe('b'.repeat(64));

    (plugin.fetchReleasesJson as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP 403: Rate-limited'), { code: 'HTTP_403' }),
    );
    await expect(updater.checkLatestRelease()).rejects.toMatchObject({
      name: 'AppUpdateCodedError',
      code: 'HTTP_403',
      statusCode: 403,
    });
  });

  it('streams download progress, supports cache reuse, maps verification errors, and aborts cleanly', async () => {
    const { plugin, emit } = createMockUpdaterPlugin();
    const updater = createCapacitorAppUpdater(plugin, () => 'req-dl');

    (plugin.downloadAndVerifyApk as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      emit('updateProgress', { requestId: 'req-dl', downloadedBytes: 1024, totalBytes: 2048 });
      emit('updateComplete', {
        requestId: 'req-dl',
        fileName: 'Folio-v0.3.1-release.apk',
        version: '0.3.1',
        sha256: 'a'.repeat(64),
        sizeBytes: 2048,
        reusedCache: true,
      });
    });

    const progressSpy = vi.fn();
    const result = await updater.downloadAndVerifyApk(SAMPLE_RELEASE, progressSpy);
    expect(progressSpy).toHaveBeenCalledWith({ downloadedBytes: 1024, totalBytes: 2048 });
    expect(result.reusedCache).toBe(true);

    (plugin.downloadAndVerifyApk as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      emit('updateError', {
        requestId: 'req-dl',
        code: 'SIGNATURE_MISMATCH',
        message: 'Signature mismatch',
        aborted: false,
      });
    });

    try {
      await updater.downloadAndVerifyApk(SAMPLE_RELEASE);
      expect.unreachable('should reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AppUpdateCodedError);
      expect((err as AppUpdateCodedError).code).toBe('SIGNATURE_MISMATCH');
    }

    const controller = new AbortController();
    (plugin.downloadAndVerifyApk as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      updater.downloadAndVerifyApk(SAMPLE_RELEASE, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(plugin.abortDownload).toHaveBeenCalledWith({ requestId: 'req-dl' });
  });

  it('enforces HTTPS on openExternalUrl and forwards appResumed subscriptions', async () => {
    const { plugin, emit } = createMockUpdaterPlugin();
    const updater = createCapacitorAppUpdater(plugin);

    await expect(updater.openExternalUrl('http://gitee.com')).rejects.toThrow(/HTTPS/);
    await updater.openExternalUrl('https://gitee.com/liu-reed-rod/folio-android/releases');
    expect(plugin.openExternalUrl).toHaveBeenCalled();

    const resumeSpy = vi.fn();
    const unsub = updater.subscribeAppResumed?.(resumeSpy);
    await new Promise((r) => setTimeout(r, 0));
    emit('appResumed', {});
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    unsub?.();
    emit('appResumed', {});
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });
});
