import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  createDefaultProviderLibrary,
  createProviderProfileFromPreset,
  type ProviderLibrary,
} from '../../src/harness/index.ts';
import {
  SettingsPage,
  resolveNextThinkingToggleEffort,
} from '../../src/ui/SettingsPage.tsx';

function renderSettings(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      appVersion: '0.4.5',
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

describe('Ticket #164 T5: SettingsPage multi-profile, global default model & unified thinking switch', () => {
  it('renders DeepSeek dual-model selector with thinking OFF by default (stops hidden) and profile list', () => {
    const markup = renderSettings();

    expect(markup).toContain('data-testid="provider-profile-list"');
    expect(markup).toContain('data-testid="add-provider-profile-btn"');
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

    // Unified thinking switch defaults to OFF ('none') and hides stops cleanly
    expect(markup).toContain('data-testid="settings-default-reasoning-block"');
    expect(markup).toContain('data-testid="settings-thinking-toggle"');
    expect(markup).not.toMatch(/data-testid="settings-thinking-toggle"[^>]*checked/);
    expect(markup).toContain('关闭');
    expect(markup).not.toContain('data-testid="settings-reasoning-option-low"');
    expect(markup).not.toContain('data-testid="settings-reasoning-option-high"');
    expect(markup).not.toContain('data-testid="settings-reasoning-option-max"');
  });

  it('shows DeepSeek 3-stop thinking (低 / 高 / 极限) when ON and Pro cost hint for deepseek-v4-pro', () => {
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
    expect(proMaxMarkup).toMatch(/data-testid="settings-thinking-toggle"[^>]*checked/);
    expect(proMaxMarkup).toContain('data-testid="settings-reasoning-option-low"');
    expect(proMaxMarkup).toContain('data-testid="settings-reasoning-option-high"');
    expect(proMaxMarkup).toContain('data-testid="settings-reasoning-option-max"');
    expect(proMaxMarkup).not.toContain('data-testid="settings-reasoning-option-medium"');
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
    expect(legacyMarkup).not.toMatch(/data-testid="settings-thinking-toggle"[^>]*checked/);
  });

  it('renders multi-profile management, custom model list/add input, and third-party (low/medium/high) thinking stops', () => {
    const dsProfile = createProviderProfileFromPreset('deepseek', {
      id: 'deepseek-official',
      apiKey: 'sk-ds-1234',
    });
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-main',
      name: '我的 OpenAI',
      apiKey: 'sk-oa-9999',
      models: [{ id: 'gpt-4o' }, { id: 'o3-mini' }],
      defaultModel: 'o3-mini',
    });
    const library: ProviderLibrary = {
      version: 2,
      activeProviderId: openaiProfile.id,
      profiles: [dsProfile, openaiProfile],
      reasoningEffort: 'medium',
      publicResearch: { provider: 'tavily', apiKey: 'tvly-123' },
    };

    const markup = renderSettings({
      providerLibrary: library,
      config: {
        baseUrl: openaiProfile.baseUrl,
        model: 'o3-mini',
        reasoningEffort: 'medium',
        apiKey: openaiProfile.apiKey,
        memoryOnly: false,
        providerId: openaiProfile.id,
        providerPresetId: openaiProfile.presetId,
        capabilities: openaiProfile.capabilities,
        publicResearch: library.publicResearch,
      },
      onSelectProviderProfile: vi.fn(),
      onOpenAddProviderWizard: vi.fn(),
      onOpenEditProviderWizard: vi.fn(),
      onDeleteProviderProfile: vi.fn(),
      onAddCustomModel: vi.fn(),
    });

    // Multi-profile list shows both profiles with delete button (since profiles.length > 1)
    expect(markup).toContain('data-testid="provider-profile-list"');
    expect(markup).toContain('data-testid="provider-profile-switch-deepseek-official"');
    expect(markup).toContain('data-testid="provider-profile-switch-openai-main"');
    expect(markup).toContain('data-testid="provider-profile-edit-openai-main"');
    expect(markup).toContain('data-testid="provider-profile-delete-openai-main"');
    expect(markup).toContain('https://api.openai.com/v1');
    expect(markup).toContain('Tavily');

    // Custom model list + inline quick-add input
    expect(markup).toContain('data-testid="settings-model-option-gpt-4o"');
    expect(markup).toContain('data-testid="settings-model-option-o3-mini"');
    expect(markup).toMatch(/data-testid="settings-model-option-o3-mini"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="settings-custom-model-input"');
    expect(markup).toContain('data-testid="settings-add-model-btn"');

    // Third-party thinking stops: low / medium / high + friendly compatibility hint
    expect(markup).toMatch(/data-testid="settings-thinking-toggle"[^>]*checked/);
    expect(markup).toContain('data-testid="settings-reasoning-option-low"');
    expect(markup).toContain('data-testid="settings-reasoning-option-medium"');
    expect(markup).toContain('data-testid="settings-reasoning-option-high"');
    expect(markup).not.toContain('data-testid="settings-reasoning-option-max"');
    expect(markup).toMatch(/data-testid="settings-reasoning-option-medium"[^>]*aria-pressed="true"/);
    expect(markup).toContain('中');
    expect(markup).toContain('仅支持深度思考的模型可开启，若发送报错请关闭');
  });

  it('hides delete button when only one profile exists and toggles thinking defaults cleanly', () => {
    const singleLib = createDefaultProviderLibrary();
    const singleMarkup = renderSettings({
      providerLibrary: singleLib,
      onDeleteProviderProfile: vi.fn(),
    });
    expect(singleMarkup).not.toContain('data-testid="provider-profile-delete-deepseek-official"');

    expect(resolveNextThinkingToggleEffort('none', 'deepseek')).toBe('high');
    expect(resolveNextThinkingToggleEffort('none', 'openai_reasoning_effort')).toBe('medium');
    expect(resolveNextThinkingToggleEffort('high', 'deepseek')).toBe('none');
    expect(resolveNextThinkingToggleEffort('medium', 'openai_reasoning_effort')).toBe('none');
  });
});
