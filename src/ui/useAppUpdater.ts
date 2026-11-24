import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FOLIO_ANDROID_RELEASES_PAGE_URL,
  formatReleaseNotesForDisplay,
  isAbortError,
  isNewerVersion,
  readUpdatePreferences,
  shouldPromptUpdateModal,
  shouldRunAutoUpdateCheck,
  writeUpdatePreferences,
  type AppUpdateDownloadProgress,
  type AppUpdateDownloadedApk,
  type AppUpdatePreferences,
  type AppUpdateReleaseInfo,
  type KeyValueStorage,
  type PlatformRuntime,
} from '../harness/index.ts';
import { AppUpdateCodedError } from '../platform/capacitorUpdater.ts';
import { toErrorMessage } from './textHelpers.ts';

export type AppUpdateCheckStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'error';

export type AppUpdateInstallStage =
  | 'idle'
  | 'downloading'
  | 'ready'
  | 'permission_needed'
  | 'installing'
  | 'error';

export interface UseAppUpdaterOptions {
  runtime: PlatformRuntime;
  currentVersion: string;
  preferencesStorage?: KeyValueStorage;
  now?: () => number;
}

export interface AppUpdaterController {
  enabled: boolean;
  currentVersion: string;
  autoCheckEnabled: boolean;
  lastCheckedAtMs?: number;
  checkStatus: AppUpdateCheckStatus;
  checkError: string | null;
  availableRelease: AppUpdateReleaseInfo | null;
  displayNotes: string;
  modalOpen: boolean;
  installStage: AppUpdateInstallStage;
  downloadProgress: AppUpdateDownloadProgress | null;
  downloadedApk: AppUpdateDownloadedApk | null;
  installError: string | null;
  installErrorCode: string | null;
  setAutoCheckEnabled: (enabled: boolean) => void;
  checkForUpdatesManual: () => Promise<void>;
  openUpdateModal: () => void;
  closeModalRemindLater: () => void;
  skipAvailableVersion: () => void;
  startDownloadAndInstall: () => Promise<void>;
  cancelDownload: () => void;
  openInstallPermissionSettings: () => Promise<void>;
  retryInstallAfterPermission: () => Promise<void>;
  openReleaseInBrowser: () => Promise<void>;
}

function resolveBrowserLocalStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function resolveSafeReasonCode(err: unknown): string {
  if (err instanceof AppUpdateCodedError) {
    if (err.code === 'SHA256_MISMATCH') return 'SHA256_MISMATCH';
    if (err.code === 'SIGNATURE_MISMATCH') return 'SIGNATURE_MISMATCH';
    if (err.code === 'PACKAGE_MISMATCH') return 'PACKAGE_MISMATCH';
    if (err.code === 'PERMISSION_DENIED') return 'PERMISSION_DENIED';
    if (err.statusCode === 403 || err.statusCode === 429) return 'RATE_LIMITED';
  }
  if (isAbortError(err)) return 'ABORTED';
  return 'NETWORK_ERROR';
}

function formatFriendlyUpdateError(err: unknown): { message: string; code: string | null } {
  if (err instanceof AppUpdateCodedError) {
    if (err.code === 'SIGNATURE_MISMATCH') {
      return {
        code: err.code,
        message:
          '检测到安装包签名与当前安装版本不一致，直接覆盖安装会失败。请先导出全量备份，再前往发布页手动核对下载。',
      };
    }
    if (err.code === 'PACKAGE_MISMATCH') {
      return {
        code: err.code,
        message: '下载的安装包包名与 Folio 不一致，已阻止安装。请前往 Gitee 发布页手动下载。',
      };
    }
    if (err.code === 'SHA256_MISMATCH') {
      return {
        code: err.code,
        message: '安装包 SHA-256 校验未通过，文件可能已损坏或未同步完成，请重试或前往发布页下载。',
      };
    }
    if (err.statusCode === 403 || err.statusCode === 429) {
      return {
        code: 'RATE_LIMITED',
        message: 'Gitee 暂时限制了请求频率，请稍后再试或直接在浏览器中打开发布页下载。',
      };
    }
  }
  return {
    code: err instanceof AppUpdateCodedError && err.code ? err.code : null,
    message: toErrorMessage(err, '更新过程出现异常，请重试或前往发布页下载。'),
  };
}

export function useAppUpdater({
  runtime,
  currentVersion,
  preferencesStorage,
  now = Date.now,
}: UseAppUpdaterOptions): AppUpdaterController {
  const appUpdater = runtime.platform === 'android' ? runtime.appUpdater : undefined;
  const enabled = Boolean(appUpdater);
  const storage = preferencesStorage ?? resolveBrowserLocalStorage();

  const [prefs, setPrefs] = useState<AppUpdatePreferences>(() => readUpdatePreferences(storage));
  const [checkStatus, setCheckStatus] = useState<AppUpdateCheckStatus>('idle');
  const [checkError, setCheckError] = useState<string | null>(null);
  const [availableRelease, setAvailableRelease] = useState<AppUpdateReleaseInfo | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [installStage, setInstallStage] = useState<AppUpdateInstallStage>('idle');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [downloadedApk, setDownloadedApk] = useState<AppUpdateDownloadedApk | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installErrorCode, setInstallErrorCode] = useState<string | null>(null);

  const checkInFlightRef = useRef(false);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const awaitingPermissionReturnRef = useRef(false);
  const startupCheckedRef = useRef(false);

  const recordDiag = useCallback(
    (
      level: 'info' | 'warn' | 'error',
      action: string,
      opts?: {
        err?: unknown;
        reasonCode?: string;
        updateOutcome?: string;
        updateBytes?: number;
      },
    ) => {
      try {
        const meta: Record<string, string | number> = {};
        if (opts?.updateOutcome) meta.updateOutcome = opts.updateOutcome;
        if (typeof opts?.updateBytes === 'number') meta.updateBytes = opts.updateBytes;
        if (opts?.reasonCode) meta.reasonCode = opts.reasonCode;
        if (level === 'error') {
          runtime.diagnostics.recordError({
            category: 'ui',
            action,
            error: opts?.err ?? opts?.reasonCode ?? action,
            errorCode: opts?.reasonCode,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          });
        } else {
          runtime.diagnostics.recordEvent({
            level,
            category: 'ui',
            action,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          });
        }
      } catch {
        // Diagnostics must never break update flows
      }
    },
    [runtime.diagnostics],
  );

  const updatePrefs = useCallback(
    (updater: (prev: AppUpdatePreferences) => AppUpdatePreferences) => {
      setPrefs((prev) => writeUpdatePreferences(storage, updater(prev)));
    },
    [storage],
  );

  const runCheck = useCallback(
    async (mode: 'auto' | 'manual') => {
      if (!appUpdater || checkInFlightRef.current) return;
      checkInFlightRef.current = true;
      setCheckStatus('checking');
      setCheckError(null);
      try {
        const release = await appUpdater.checkLatestRelease();
        const checkedAt = now();
        updatePrefs((prev) => ({ ...prev, lastCheckedAtMs: checkedAt }));

        if (!release || !isNewerVersion(release.version, currentVersion)) {
          setAvailableRelease(null);
          setCheckStatus('up_to_date');
          recordDiag('info', 'update_check_done', { updateOutcome: 'up_to_date' });
          void appUpdater.cleanupStaleApks().catch(() => {});
          return;
        }

        setAvailableRelease(release);
        setCheckStatus('available');
        void appUpdater.cleanupStaleApks(release.version).catch(() => {});

        if (mode === 'manual') {
          setInstallStage((prev) => (prev === 'error' ? 'idle' : prev));
          setInstallError(null);
          setInstallErrorCode(null);
          setModalOpen(true);
          recordDiag('info', 'update_check_done', { updateOutcome: 'available' });
          return;
        }

        const currentPrefs = readUpdatePreferences(storage);
        if (shouldPromptUpdateModal(currentPrefs, release.version, currentVersion)) {
          setModalOpen(true);
          recordDiag('info', 'update_check_done', { updateOutcome: 'available' });
        } else {
          recordDiag('info', 'update_check_done', { updateOutcome: 'skipped' });
        }
      } catch (err) {
        const friendly = formatFriendlyUpdateError(err);
        setCheckStatus('error');
        setCheckError(friendly.message);
        recordDiag('error', 'update_check_failed', {
          err,
          reasonCode: resolveSafeReasonCode(err),
        });
      } finally {
        checkInFlightRef.current = false;
      }
    },
    [appUpdater, currentVersion, now, recordDiag, storage, updatePrefs],
  );

  useEffect(() => {
    if (!appUpdater || startupCheckedRef.current) return;
    startupCheckedRef.current = true;
    const initialPrefs = readUpdatePreferences(storage);
    if (shouldRunAutoUpdateCheck(initialPrefs, now())) {
      void runCheck('auto');
    }
  }, [appUpdater, now, runCheck, storage]);

  const launchInstaller = useCallback(
    async (apk: AppUpdateDownloadedApk) => {
      if (!appUpdater) return;
      try {
        const allowed = await appUpdater.canRequestPackageInstalls();
        if (!allowed) {
          setInstallStage('permission_needed');
          setInstallError(null);
          setInstallErrorCode(null);
          recordDiag('warn', 'update_install_permission_needed', {
            reasonCode: 'PERMISSION_DENIED',
          });
          return;
        }
        setInstallStage('installing');
        setInstallError(null);
        setInstallErrorCode(null);
        await appUpdater.installDownloadedApk(apk.version);
        setInstallStage('ready');
        recordDiag('info', 'update_install_launched', { updateOutcome: 'installed' });
      } catch (err) {
        const friendly = formatFriendlyUpdateError(err);
        setInstallStage('error');
        setInstallError(friendly.message);
        setInstallErrorCode(friendly.code);
        recordDiag('error', 'update_install_failed', {
          err,
          reasonCode: resolveSafeReasonCode(err),
        });
      }
    },
    [appUpdater, recordDiag],
  );

  useEffect(() => {
    if (!appUpdater) return;
    const handleResume = () => {
      if (!awaitingPermissionReturnRef.current || !downloadedApk) return;
      awaitingPermissionReturnRef.current = false;
      void (async () => {
        const allowed = await appUpdater.canRequestPackageInstalls().catch(() => false);
        if (allowed) {
          await launchInstaller(downloadedApk);
        } else {
          setInstallStage('permission_needed');
          setInstallError('尚未开启「安装未知应用」权限，请在系统设置中允许后继续安装。');
          setInstallErrorCode('PERMISSION_DENIED');
        }
      })();
    };

    const unsubscribeNative = appUpdater.subscribeAppResumed?.(handleResume);
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        handleResume();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      unsubscribeNative?.();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [appUpdater, downloadedApk, launchInstaller]);

  useEffect(() => {
    return () => {
      downloadAbortRef.current?.abort();
    };
  }, []);

  const setAutoCheckEnabled = useCallback(
    (nextEnabled: boolean) => {
      updatePrefs((prev) => ({ ...prev, autoCheckEnabled: nextEnabled }));
    },
    [updatePrefs],
  );

  const checkForUpdatesManual = useCallback(async () => {
    await runCheck('manual');
  }, [runCheck]);

  const openUpdateModal = useCallback(() => {
    if (!availableRelease) return;
    setModalOpen(true);
  }, [availableRelease]);

  const closeModalRemindLater = useCallback(() => {
    setModalOpen(false);
  }, []);

  const skipAvailableVersion = useCallback(() => {
    if (availableRelease) {
      updatePrefs((prev) => ({ ...prev, skippedVersion: availableRelease.version }));
      recordDiag('info', 'update_check_done', { updateOutcome: 'skipped' });
    }
    setModalOpen(false);
  }, [availableRelease, recordDiag, updatePrefs]);

  const startDownloadAndInstall = useCallback(async () => {
    if (!appUpdater || !availableRelease) return;
    if (downloadedApk && downloadedApk.version === availableRelease.version) {
      await launchInstaller(downloadedApk);
      return;
    }

    downloadAbortRef.current?.abort();
    const controller = new AbortController();
    downloadAbortRef.current = controller;

    setInstallStage('downloading');
    setDownloadProgress({ downloadedBytes: 0 });
    setInstallError(null);
    setInstallErrorCode(null);

    try {
      const result = await appUpdater.downloadAndVerifyApk(
        availableRelease,
        (progress) => {
          setDownloadProgress(progress);
        },
        controller.signal,
      );
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
      setDownloadedApk(result);
      setInstallStage('ready');
      recordDiag('info', 'update_download_done', {
        updateOutcome: result.reusedCache ? 'cached' : 'downloaded',
        updateBytes: result.sizeBytes,
      });
      await launchInstaller(result);
    } catch (err) {
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
      if (isAbortError(err)) {
        setInstallStage('idle');
        setDownloadProgress(null);
        return;
      }
      const reasonCode = resolveSafeReasonCode(err);
      const isVerifyError =
        reasonCode === 'SHA256_MISMATCH' ||
        reasonCode === 'SIGNATURE_MISMATCH' ||
        reasonCode === 'PACKAGE_MISMATCH';
      const friendly = formatFriendlyUpdateError(err);
      setInstallStage('error');
      setInstallError(friendly.message);
      setInstallErrorCode(friendly.code);
      recordDiag('error', isVerifyError ? 'update_verify_failed' : 'update_download_failed', {
        err,
        reasonCode,
      });
    }
  }, [appUpdater, availableRelease, downloadedApk, launchInstaller, recordDiag]);

  const cancelDownload = useCallback(() => {
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setInstallStage('idle');
    setDownloadProgress(null);
  }, []);

  const openInstallPermissionSettings = useCallback(async () => {
    if (!appUpdater) return;
    awaitingPermissionReturnRef.current = true;
    setInstallError(null);
    setInstallErrorCode(null);
    try {
      await appUpdater.openInstallPermissionSettings();
    } catch (err) {
      awaitingPermissionReturnRef.current = false;
      const friendly = formatFriendlyUpdateError(err);
      setInstallError(friendly.message);
      setInstallErrorCode(friendly.code);
    }
  }, [appUpdater]);

  const retryInstallAfterPermission = useCallback(async () => {
    if (!downloadedApk) {
      await startDownloadAndInstall();
      return;
    }
    await launchInstaller(downloadedApk);
  }, [downloadedApk, launchInstaller, startDownloadAndInstall]);

  const openReleaseInBrowser = useCallback(async () => {
    if (!appUpdater) return;
    const url = availableRelease?.releasePageUrl || FOLIO_ANDROID_RELEASES_PAGE_URL;
    recordDiag('info', 'update_check_done', { updateOutcome: 'browser_fallback' });
    await appUpdater.openExternalUrl(url);
  }, [appUpdater, availableRelease, recordDiag]);

  return {
    enabled,
    currentVersion,
    autoCheckEnabled: prefs.autoCheckEnabled,
    lastCheckedAtMs: prefs.lastCheckedAtMs,
    checkStatus,
    checkError,
    availableRelease,
    displayNotes: availableRelease ? formatReleaseNotesForDisplay(availableRelease.notes) : '',
    modalOpen,
    installStage,
    downloadProgress,
    downloadedApk,
    installError,
    installErrorCode,
    setAutoCheckEnabled,
    checkForUpdatesManual,
    openUpdateModal,
    closeModalRemindLater,
    skipAvailableVersion,
    startDownloadAndInstall,
    cancelDownload,
    openInstallPermissionSettings,
    retryInstallAfterPermission,
    openReleaseInBrowser,
  };
}
