import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CONFIG, type AppUpdateReleaseInfo } from '../../src/harness/index.ts';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';
import type { AppUpdaterController } from '../../src/ui/useAppUpdater.ts';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    history: { state: null },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const { AppUpdateModal } = await import('../../src/ui/AppUpdateModal.tsx');

function makeController(overrides: Partial<AppUpdaterController> = {}): AppUpdaterController {
  return {
    enabled: true,
    currentVersion: '0.3.0',
    autoCheckEnabled: true,
    checkStatus: 'idle',
    checkError: null,
    availableRelease: null,
    displayNotes: '',
    modalOpen: false,
    installStage: 'idle',
    downloadProgress: null,
    downloadedApk: null,
    installError: null,
    installErrorCode: null,
    setAutoCheckEnabled: vi.fn(),
    checkForUpdatesManual: vi.fn(async () => {}),
    openUpdateModal: vi.fn(),
    closeModalRemindLater: vi.fn(),
    skipAvailableVersion: vi.fn(),
    startDownloadAndInstall: vi.fn(async () => {}),
    cancelDownload: vi.fn(),
    openInstallPermissionSettings: vi.fn(async () => {}),
    retryInstallAfterPermission: vi.fn(async () => {}),
    openReleaseInBrowser: vi.fn(async () => {}),
    ...overrides,
  };
}

const SAMPLE_RELEASE: AppUpdateReleaseInfo = {
  version: '0.3.1',
  tagName: 'v0.3.1',
  title: 'Folio V0.3.1',
  notes: '修复若干问题。\nSHA-256: ' + 'a'.repeat(64),
  releasePageUrl: 'https://gitee.com/liu-reed-rod/folio-android/releases/tag/v0.3.1',
  apkName: 'Folio-v0.3.1-release.apk',
  apkUrl: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-release.apk',
  expectedSha256: 'a'.repeat(64),
};

function renderSettingsWithUpdater(appUpdater?: AppUpdaterController) {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      appVersion: '0.3.0',
      hasCredentials: false,
      config: { ...DEFAULT_MODEL_CONFIG },
      useDevEnvKey: false,
      showDevTestProxy: false,
      themePreference: 'system',
      fontSize: 16,
      canExportCurrentStory: false,
      currentStoryTitle: '',
      onBack: vi.fn(),
      onOpenSetupWizard: vi.fn(),
      onClearSavedKey: vi.fn(),
      onApplyDevTestConfig: vi.fn(),
      onOpenDiagnostics: vi.fn(),
      onOpenPublicMemory: vi.fn(),
      onExportCurrentStory: vi.fn(),
      onImportBackupFile: vi.fn(),
      onThemePreferenceChange: vi.fn(),
      onFontSizeChange: vi.fn(),
      appUpdater,
    }),
  );
}

describe('App updater Settings & Modal UI contracts', () => {
  it('hides the update group on Web and renders full controls on Android', () => {
    const webHtml = renderSettingsWithUpdater(makeController({ enabled: false }));
    expect(webHtml).not.toContain('settings-update-group');
    expect(webHtml).not.toContain('check-app-update-btn');

    const androidHtml = renderSettingsWithUpdater(
      makeController({
        enabled: true,
        checkStatus: 'available',
        availableRelease: SAMPLE_RELEASE,
      }),
    );
    expect(androidHtml).toContain('settings-update-group');
    expect(androidHtml).toContain('check-app-update-btn');
    expect(androidHtml).toContain('open-available-update-btn');
    expect(androidHtml).toContain('auto-check-update-toggle');
    expect(androidHtml).toContain('发现新版本 v0.3.1');
  });

  it('renders AppUpdateModal states: release info + backup action, progress, permission prompt, and signature fallback', () => {
    const availableHtml = renderToStaticMarkup(
      createElement(AppUpdateModal, {
        updater: makeController({
          modalOpen: true,
          availableRelease: SAMPLE_RELEASE,
          displayNotes: '修复若干问题。',
        }),
        canExportBackup: true,
        onExportBackup: vi.fn(),
      }),
    );
    expect(availableHtml).toContain('app-update-modal');
    expect(availableHtml).toContain('app-update-backup-btn');
    expect(availableHtml).toContain('app-update-skip-btn');
    expect(availableHtml).toContain('app-update-install-btn');
    expect(availableHtml).toContain('修复若干问题。');

    const downloadingHtml = renderToStaticMarkup(
      createElement(AppUpdateModal, {
        updater: makeController({
          modalOpen: true,
          availableRelease: SAMPLE_RELEASE,
          installStage: 'downloading',
          downloadProgress: { downloadedBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 },
        }),
        canExportBackup: true,
        onExportBackup: vi.fn(),
      }),
    );
    expect(downloadingHtml).toContain('app-update-progress');
    expect(downloadingHtml).toContain('50%');
    expect(downloadingHtml).toContain('app-update-cancel-download-btn');

    const permissionHtml = renderToStaticMarkup(
      createElement(AppUpdateModal, {
        updater: makeController({
          modalOpen: true,
          availableRelease: SAMPLE_RELEASE,
          installStage: 'permission_needed',
        }),
        canExportBackup: true,
        onExportBackup: vi.fn(),
      }),
    );
    expect(permissionHtml).toContain('app-update-permission-banner');
    expect(permissionHtml).toContain('app-update-open-permission-btn');
    expect(permissionHtml).toContain('app-update-retry-install-btn');

    const errorHtml = renderToStaticMarkup(
      createElement(AppUpdateModal, {
        updater: makeController({
          modalOpen: true,
          availableRelease: SAMPLE_RELEASE,
          installStage: 'error',
          installErrorCode: 'SIGNATURE_MISMATCH',
          installError: '签名不一致',
        }),
        canExportBackup: true,
        onExportBackup: vi.fn(),
      }),
    );
    expect(errorHtml).toContain('app-update-error-banner');
    expect(errorHtml).toContain('签名校验未通过');
    expect(errorHtml).toContain('app-update-browser-fallback-btn');
  });
});
