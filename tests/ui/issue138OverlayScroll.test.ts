import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '../../src/harness/index.ts';
import { ImportPanel } from '../../src/ui/ImportPanel.tsx';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const shellCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'shell.css'), 'utf8');
const importWizardCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'import-wizard.css'), 'utf8');
const overlayShellSource = readFileSync(
  join(repoRoot, 'src', 'ui', 'primitives', 'OverlayPageShell.tsx'),
  'utf8',
);

describe('Issue #138: overlay scroll container, sticky header safe-area, and focus preventScroll', () => {
  it('bounds .app-root, .app-workspace, and .app-workspace.is-overlay .main-stage with vh/dvh fallbacks', () => {
    expect(shellCss).toMatch(
      /\.app-root\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;[^}]*min-height:\s*0;/s,
    );
    expect(shellCss).toMatch(
      /\.app-workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(shellCss).toMatch(
      /\.app-workspace\.is-overlay\s+\.main-stage\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;[^}]*min-height:\s*0;[^}]*padding-top:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scroll-padding-top:\s*calc\([^;]*var\(--safe-area-top\)[^;]*\);/s,
    );
    expect(shellCss).toMatch(
      /\.overlay-page-shell\s*\{[^}]*flex:\s*0\s+0\s+auto;/s,
    );
  });

  it('pins .overlay-page-header at top: 0 below --safe-area-top across breakpoints', () => {
    expect(shellCss).toMatch(
      /\.overlay-page-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*min-height:\s*calc\(64px\s*\+\s*var\(--safe-area-top\)\);[^}]*margin:\s*0\s+calc\(clamp\(16px,\s*4vw,\s*40px\)\s*\*\s*-1\)\s+18px;[^}]*padding:\s*var\(--safe-area-top\)/s,
    );
    expect(shellCss).not.toMatch(/\.overlay-page-header\s*\{[^}]*top:\s*calc\(-/s);
    expect(shellCss).toMatch(
      /@media \(max-width: 959px\)\s*\{[\s\S]*?\.overlay-page-header\s*\{[^}]*margin-inline:\s*-16px;/s,
    );
    expect(shellCss).toMatch(
      /@media \(max-width: 560px\)\s*\{[\s\S]*?\.overlay-page-header\s*\{[^}]*margin-inline:\s*-12px;/s,
    );
    expect(importWizardCss).toMatch(/\.overlay-page-footer\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
  });

  it('uses focus({ preventScroll: true }) in OverlayPageShell so delayed focus does not jump scroll', () => {
    expect(overlayShellSource).toContain('titleRef.current?.focus({ preventScroll: true })');
    expect(overlayShellSource).not.toMatch(/titleRef\.current\?\.focus\(\s*\)/);
  });

  it('renders SettingsPage without footer and ImportPanel with footer inside OverlayPageShell', () => {
    const settingsMarkup = renderToStaticMarkup(
      createElement(SettingsPage, {
        appVersion: '0.4.1',
        hasCredentials: false,
        config: DEFAULT_MODEL_CONFIG,
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
      }),
    );
    expect(settingsMarkup).toContain('data-testid="settings-page"');
    expect(settingsMarkup).toContain('data-has-footer="false"');

    const importMarkup = renderToStaticMarkup(
      createElement(ImportPanel, {
        initialMode: 'script',
        config: DEFAULT_MODEL_CONFIG,
        transport: {} as never,
        binaryDownloader: {} as never,
        hasCredentials: false,
        byokOpen: false,
        onRequireByok: vi.fn(),
        onCreateSettingStory: vi.fn(async () => undefined),
        onImportDeepSeekBatch: vi.fn(async () => ({ imported: [], failed: [] }) as never),
        onDeepSeekImportBusyChange: vi.fn(),
        onContinueStory: vi.fn(),
        diagnostics: { recordEvent: vi.fn(), recordError: vi.fn() } as never,
        onPackageDiagnostics: vi.fn(),
        onCancel: vi.fn(),
        existingStories: [],
      }),
    );
    expect(importMarkup).toContain('data-testid="import-panel"');
    expect(importMarkup).toContain('data-has-footer="true"');
  });
});
