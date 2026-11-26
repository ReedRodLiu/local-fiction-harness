import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  createDefaultProviderLibrary,
  createProviderProfileFromPreset,
  type ModelConfig,
  type ProviderLibrary,
} from '../../src/harness/index.ts';
import {
  GenerationControls,
  buildProviderModelMenuGroups,
  mergeGenerationPreference,
  resolveComposerThinkingToggleEffort,
} from '../../src/ui/GenerationControls.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readSource = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

describe('Ticket #165 & Issue #109: GenerationControls multi-provider switcher & unified thinking toggle', () => {
  it('renders Flash/Pro 2-way selector for single DeepSeek preset, unified thinking toggle ON with DeepSeek stops (低 / 高 / 极限), and slots', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        leadingSlot: createElement('button', { type: 'button', 'data-testid': 'welcome-plus-menu-trigger' }, '+'),
        trailingSlot: createElement('button', { type: 'submit', 'data-testid': 'send-btn' }, '发送'),
      }),
    );

    expect(markup).toContain('data-testid="composer-generation-controls"');
    expect(markup).toContain('data-testid="welcome-plus-menu-trigger"');
    expect(markup).toContain('data-testid="send-btn"');
    expect(markup).toContain('data-testid="composer-model-deepseek-flash"');
    expect(markup).toContain('data-testid="composer-model-deepseek-v4-pro"');
    expect(markup).not.toContain('data-testid="composer-provider-model-trigger"');
    expect(markup).not.toContain('data-testid="generation-pref-prompt-pack"');
    expect(markup).not.toContain('data-testid="generation-pref-prefix-mode"');
    expect(markup).not.toContain('composer-preference-row');
    expect(markup).toContain('日常轻量');
    expect(markup).toContain('Flash');
    expect(markup).toContain('旗舰深度');
    expect(markup).toContain('Pro');
    expect(markup).toMatch(/data-testid="composer-model-deepseek-flash"[^>]*aria-pressed="true"/);
    expect(markup).toMatch(/data-testid="composer-model-deepseek-v4-pro"[^>]*aria-pressed="false"/);
    expect(markup).not.toContain('data-testid="composer-pro-cost-hint"');

    expect(markup).toContain('data-testid="composer-reasoning-control"');
    expect(markup).toContain('data-testid="composer-thinking-toggle"');
    expect(markup).toMatch(/data-testid="composer-thinking-toggle"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="composer-reasoning-slider"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-low"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-high"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-max"');
    expect(markup).not.toContain('data-testid="composer-reasoning-stop-medium"');
    expect(markup).toContain('低');
    expect(markup).toContain('高');
    expect(markup).toContain('极限');
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-high"[^>]*aria-pressed="true"/);
  });

  it('defaults unified thinking toggle to OFF (none), hides stops, and maps toggle ON per protocol', () => {
    const offMarkup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'none',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );

    expect(offMarkup).toContain('data-testid="composer-reasoning-control"');
    expect(offMarkup).toContain('data-testid="composer-thinking-toggle"');
    expect(offMarkup).toMatch(/data-testid="composer-thinking-toggle"[^>]*aria-pressed="false"/);
    expect(offMarkup).toContain('关闭');
    expect(offMarkup).not.toContain('data-testid="composer-reasoning-stop-low"');
    expect(offMarkup).not.toContain('data-testid="composer-reasoning-stop-high"');
    expect(offMarkup).not.toContain('data-testid="composer-reasoning-stop-max"');

    expect(resolveComposerThinkingToggleEffort('none', 'deepseek')).toBe('high');
    expect(resolveComposerThinkingToggleEffort('none', 'openai_reasoning_effort')).toBe('medium');
    expect(resolveComposerThinkingToggleEffort('high', 'deepseek')).toBe('none');
    expect(resolveComposerThinkingToggleEffort('medium', 'openai_reasoning_effort')).toBe('none');
  });

  it('renders provider-model trigger and OpenAI thinking stops (low / medium / high) when multi-profile or third-party is active', () => {
    const dsProfile = createProviderProfileFromPreset('deepseek', { id: 'deepseek-official', apiKey: 'sk-ds' });
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-main',
      name: '我的 OpenAI',
      apiKey: 'sk-oa',
      models: [{ id: 'gpt-4o' }, { id: 'o3-mini', label: 'o3 Mini' }],
      defaultModel: 'o3-mini',
    });
    const multiLib: ProviderLibrary = {
      version: 2,
      activeProviderId: openaiProfile.id,
      profiles: [dsProfile, openaiProfile],
      reasoningEffort: 'medium',
    };

    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'o3-mini',
        reasoningEffort: 'medium',
        providerLibrary: multiLib,
        providerId: openaiProfile.id,
        capabilities: openaiProfile.capabilities,
        onModelChange: vi.fn(),
        onProviderModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="composer-provider-model-trigger"');
    expect(markup).toContain('我的 OpenAI');
    expect(markup).toContain('o3 Mini');
    expect(markup).not.toContain('data-testid="composer-model-deepseek-flash"');

    expect(markup).toMatch(/data-testid="composer-thinking-toggle"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="composer-reasoning-stop-low"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-medium"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-high"');
    expect(markup).not.toContain('data-testid="composer-reasoning-stop-max"');
    expect(markup).toContain('中');
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-medium"[^>]*aria-pressed="true"/);

    // Single third-party profile also uses provider-model trigger
    const singleThirdParty: ProviderLibrary = {
      version: 2,
      activeProviderId: openaiProfile.id,
      profiles: [openaiProfile],
      reasoningEffort: 'none',
    };
    const singleThirdPartyMarkup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'gpt-4o',
        reasoningEffort: 'none',
        providerLibrary: singleThirdParty,
        providerId: openaiProfile.id,
        capabilities: openaiProfile.capabilities,
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );
    expect(singleThirdPartyMarkup).toContain('data-testid="composer-provider-model-trigger"');
    expect(singleThirdPartyMarkup).not.toContain('data-testid="composer-model-deepseek-flash"');

    // Menu groups include all saved profiles & models
    const groups = buildProviderModelMenuGroups(multiLib, openaiProfile.id, 'o3-mini');
    expect(groups.map((g) => g.profileId)).toEqual(['deepseek-official', 'openai-main']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['gpt-4o', 'o3-mini']);

    // Single DeepSeek library without custom models keeps Flash/Pro quick buttons
    const singleDsLib = createDefaultProviderLibrary();
    const singleDsMarkup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'none',
        providerLibrary: singleDsLib,
        providerId: 'deepseek-official',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );
    expect(singleDsMarkup).toContain('data-testid="composer-model-deepseek-flash"');
    expect(singleDsMarkup).not.toContain('data-testid="composer-provider-model-trigger"');
  });

  it('shows inline non-blocking Pro cost hint when deepseek-v4-pro is selected on DeepSeek official', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );

    expect(markup).toMatch(/data-testid="composer-model-deepseek-v4-pro"[^>]*aria-pressed="true"/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-max"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="composer-pro-cost-hint"');
    expect(markup).toContain('3–4 倍');
  });

  it('disables model toggle, thinking toggle, and stops during streaming while leaving trailing stop slot enabled', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
        disabled: true,
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        trailingSlot: createElement('button', { type: 'button', 'aria-label': '停止生成' }, '停止'),
      }),
    );

    expect(markup).toMatch(/<button[^>]*data-testid="composer-model-deepseek-flash"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*data-testid="composer-model-deepseek-v4-pro"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*data-testid="composer-thinking-toggle"[^>]*disabled=""/);
    const sliderTag = /<input[^>]*data-testid="composer-reasoning-slider"[^>]*>/.exec(markup)?.[0];
    expect(sliderTag).toBeDefined();
    expect(sliderTag).toContain('disabled=""');
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-low"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-high"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-max"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="停止生成"[^>]*>停止<\/button>/);
    expect(markup).not.toMatch(/aria-label="停止生成"[^>]*disabled/);
  });

  it('merges partial generationPreference patches preserving arbitrary model and providerId without mutating global config', () => {
    const globalSnapshot: ModelConfig = { ...DEFAULT_MODEL_CONFIG };

    const afterProviderModel = mergeGenerationPreference(
      { promptPackMode: 'pack-a', prefixCompletion: 'always' },
      { providerId: 'openai-1', model: 'gpt-4o' },
    );
    expect(afterProviderModel).toEqual({
      providerId: 'openai-1',
      model: 'gpt-4o',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterEffort = mergeGenerationPreference(afterProviderModel, { reasoningEffort: 'medium' });
    expect(afterEffort).toEqual({
      providerId: 'openai-1',
      model: 'gpt-4o',
      reasoningEffort: 'medium',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterSwitchCustom = mergeGenerationPreference(afterEffort, { model: 'claude-3-7-sonnet' });
    expect(afterSwitchCustom).toEqual({
      providerId: 'openai-1',
      model: 'claude-3-7-sonnet',
      reasoningEffort: 'medium',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterClearingOverrides = mergeGenerationPreference(afterSwitchCustom, {
      providerId: null,
      promptPackMode: null,
      prefixCompletion: null,
    });
    expect(afterClearingOverrides).toEqual({
      model: 'claude-3-7-sonnet',
      reasoningEffort: 'medium',
    });

    const afterInvalidPatch = mergeGenerationPreference(afterSwitchCustom, {
      providerId: '   ',
      model: '   ',
      promptPackMode: '   ',
      prefixCompletion: 'invalid-mode' as never,
    });
    expect(afterInvalidPatch).toEqual({ reasoningEffort: 'medium' });

    expect(mergeGenerationPreference(undefined, {})).toBeUndefined();
    expect(globalSnapshot).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('wires double-row composer, GenerationControls, welcome ephemeral pref, and multi-provider resolution in App.tsx, Panes, and styles', () => {
    const appSource = readSource('src/ui/App.tsx');
    const draftSource = readSource('src/ui/DraftPane.tsx');
    const charSource = readSource('src/ui/CharacterPane.tsx');
    const workspaceSource = readSource('src/ui/CreativeWorkspace.tsx');
    const shellCss = readSource('src/ui/styles/shell.css');
    const playStageCss = readSource('src/ui/styles/play-stage.css');

    // App.tsx wires GenerationControls & multi-provider library resolution
    expect(appSource).toContain("from './GenerationControls.tsx'");
    expect(appSource).toContain('className="composer composer-double-row"');
    expect(appSource).toContain('<GenerationControls');
    expect(appSource).toContain('pendingWelcomePref');
    expect(appSource).toContain('projectActiveModelConfig');
    expect(appSource).toContain('generationPreference: prefAtSubmit');

    // Double-row column layout in both shell.css (welcome) and play-stage.css (story)
    expect(shellCss).toMatch(/\.composer\.composer-double-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s);
    expect(shellCss).toMatch(/\.composer\.composer-double-row textarea\s*\{[^}]*width:\s*100%;/s);
    expect(playStageCss).toMatch(/\.main-stage\.is-playing > \.composer\.composer-double-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s);
    expect(shellCss).toMatch(/@media \(max-width: 560px\)[\s\S]*\.composer-model-tier\s*\{[^}]*display:\s*none;/s);

    expect(workspaceSource).toContain('defaultConfig?: ModelConfig');
    expect(workspaceSource).toContain('providerLibrary?: ProviderLibrary');
    expect(draftSource).toContain("from './GenerationControls.tsx'");
    expect(draftSource).toContain('className="composer composer-double-row"');
    expect(draftSource).toContain('className="composer writing-composer composer-double-row"');
    expect(draftSource).toContain('resolveEffectiveModelConfig(config, live.generationPreference)');

    expect(charSource).toContain("from './GenerationControls.tsx'");
    expect(charSource).toContain('className="composer composer-double-row"');
    expect(charSource).toContain('resolveEffectiveModelConfig(config, current.generationPreference)');
    expect(appSource).toContain('onManageNarrativePresets={openNarrativePresetSettings}');
    expect(workspaceSource).toContain('onOpenNarrativePresets?: () => void');
    expect(draftSource).toContain('onManageNarrativePresets={props.onOpenNarrativePresets}');
    expect(charSource).toContain('onManageNarrativePresets={props.onOpenNarrativePresets}');
  });

  it('renders a single 44x44 narrative preset icon button with active override indicator and no <select> rows', () => {
    const defaultMarkup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        promptPackMode: 'inherit',
        prefixCompletion: 'inherit',
        onPromptPackModeChange: vi.fn(),
        onPrefixCompletionChange: vi.fn(),
      }),
    );

    expect(defaultMarkup).toContain('data-testid="composer-narrative-preset-trigger"');
    expect(defaultMarkup).toContain('aria-label="叙事预设"');
    expect(defaultMarkup).toContain('data-overridden="false"');
    expect(defaultMarkup).not.toContain('data-testid="composer-narrative-preset-dot"');
    expect(defaultMarkup).not.toContain('<select');
    expect(defaultMarkup).not.toContain('composer-preference-row');

    const overriddenMarkup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        promptPackMode: 'off',
        prefixCompletion: 'inherit',
        onPromptPackModeChange: vi.fn(),
        onPrefixCompletionChange: vi.fn(),
      }),
    );
    expect(overriddenMarkup).toContain('data-overridden="true"');
    expect(overriddenMarkup).toContain('data-testid="composer-narrative-preset-dot"');
  });
});
