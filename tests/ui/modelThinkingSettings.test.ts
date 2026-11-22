import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '../../src/harness/index.ts';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';

function renderSettings(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      appVersion: '0.2.0',
      hasCredentials: true,
      config: { ...DEFAULT_MODEL_CONFIG, apiKey: 'sk-1234567890abcd' },
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
      ...overrides,
    }),
  );
}

describe('Issue #108 Slice 5: SettingsPage global default model & 4-tier reasoning effort controls', () => {
  it('renders official dual-model selector and 4-tier reasoning slider inside 连接 DeepSeek with Flash + 高 as default', () => {
    const markup = renderSettings();

    expect(markup).toContain('data-testid="settings-default-model-block"');
    expect(markup).toContain('data-testid="settings-model-option-deepseek-flash"');
    expect(markup).toContain('data-testid="settings-model-option-deepseek-v4-pro"');
    expect(markup).toContain('日常轻量');
    expect(markup).toContain('deepseek-flash');
    expect(markup).toContain('旗舰深度');
    expect(markup).toContain('deepseek-v4-pro');
    expect(markup).toMatch(/data-testid="settings-model-option-deepseek-flash"[^>]*aria-pressed="true"/);
    expect(markup).toMatch(/data-testid="settings-model-option-deepseek-v4-pro"[^>]*aria-pressed="false"/);
    expect(markup).not.toContain('data-testid="settings-pro-cost-hint"');

    expect(markup).toContain('data-testid="settings-default-reasoning-block"');
    expect(markup).toContain('data-testid="settings-reasoning-slider"');
    expect(markup).toContain('data-testid="settings-reasoning-option-none"');
    expect(markup).toContain('data-testid="settings-reasoning-option-low"');
    expect(markup).toContain('data-testid="settings-reasoning-option-high"');
    expect(markup).toContain('data-testid="settings-reasoning-option-max"');
    expect(markup).toMatch(/data-testid="settings-reasoning-option-high"[^>]*aria-pressed="true"/);

    // Must never expose custom Base URL, memoryOnly, or arbitrary model name inputs
    expect(markup).not.toContain('Base URL');
    expect(markup).not.toContain('memoryOnly');
    expect(markup).not.toContain('自定义模型');
  });

  it('shows Pro cost hint when deepseek-v4-pro is selected and reflects selected reasoning effort', () => {
    const proMaxMarkup = renderSettings({
      config: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        apiKey: 'sk-1234567890abcd',
        memoryOnly: false,
      },
    });

    expect(proMaxMarkup).toMatch(/data-testid="settings-model-option-deepseek-v4-pro"[^>]*aria-pressed="true"/);
    expect(proMaxMarkup).toContain('data-testid="settings-pro-cost-hint"');
    expect(proMaxMarkup).toContain('3–4 倍');
    expect(proMaxMarkup).toMatch(/data-testid="settings-reasoning-option-max"[^>]*aria-pressed="true"/);
    expect(proMaxMarkup).toContain('极限');

    const legacyMarkup = renderSettings({
      config: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: 'sk-1234567890abcd',
        memoryOnly: false,
      },
    });
    expect(legacyMarkup).toMatch(/data-testid="settings-model-option-deepseek-flash"[^>]*aria-pressed="true"/);
    expect(legacyMarkup).toMatch(/data-testid="settings-reasoning-option-high"[^>]*aria-pressed="true"/);
  });
});
