import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_PRESETS,
  PUBLIC_RESEARCH_PRESETS,
  createProviderProfileFromPreset,
} from '../../src/harness/index.ts';
import { DeepSeekSetupWizard } from '../../src/ui/DeepSeekSetupWizard.tsx';
import {
  PROVIDER_PRESET_CATEGORIES,
  ProviderSetupWizard,
  buildProviderSaveResultFromDraft,
  createWizardDraftFromPreset,
  createWizardDraftFromProfile,
  filterProviderPresetGroups,
  resolveInitialPresetPickerOpen,
  validateWizardFallbackSave,
  verifyWizardDraftConnection,
} from '../../src/ui/ProviderSetupWizard.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readUiSource = (fileName: string) => readFileSync(join(repoRoot, 'src', 'ui', fileName), 'utf8');

describe('Ticket #164 T5 & Ticket #181: ProviderSetupWizard & DeepSeekSetupWizard', () => {
  it('renders single-row collapsed preset picker in onboarding mode, ultra-simple DeepSeek first-class flow, 3-line summary, and collapsed advanced details', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        verifyUrlBase: 'https://api.deepseek.com',
        onComplete: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="deepseek-setup-wizard"');
    expect(markup).toContain('aria-label="连接模型服务"');
    expect(markup).toContain('连接模型服务');
    expect(markup).toContain('连接 DeepSeek');
    expect(markup).toContain('API Key 只保存在本机');
    expect(markup).toContain('data-testid="wizard-open-platform-btn"');
    expect(markup).toContain('打开 DeepSeek 开放平台');
    expect(markup).toContain('id="byok-api-key"');
    expect(markup).toContain('data-testid="wizard-verify-save-btn"');

    expect(markup).toContain('data-testid="provider-preset-picker-trigger"');
    expect(markup).toMatch(/data-testid="provider-preset-picker-trigger"[^>]*aria-expanded="false"/);
    expect(markup).toContain('DeepSeek 官方');
    expect(markup).toContain('官方推荐');
    expect(markup).toContain('切换服务商（21 项）');
    expect(markup).not.toContain('data-testid="provider-preset-picker-panel"');
    expect(markup).not.toContain('data-testid="provider-preset-search-input"');
    expect(markup).not.toContain('data-testid="provider-preset-deepseek"');

    // DeepSeek first-class view hides third-party Base URL / model / public research clutter
    expect(markup).not.toContain('data-testid="provider-base-url-input"');
    expect(markup).not.toContain('data-testid="provider-model-input"');
    expect(markup).not.toContain('data-testid="provider-public-research-section"');
    expect(markup).not.toContain('data-testid="provider-probe-prefill-btn"');
    expect(markup).not.toContain('data-testid="provider-protocol-select"');

    // 3-line plain-language capability summary
    expect(markup).toContain('data-testid="provider-capability-summary"');
    expect(markup).toContain('聊天、文游与叙事预设：始终可用');
    expect(markup).toContain('已随账号自带，免配');
    expect(markup).toContain('自动查余额与省费');

    // Collapsed advanced details (no open attribute)
    expect(markup).toContain('data-testid="provider-advanced-settings"');
    expect(markup).not.toMatch(/data-testid="provider-advanced-settings"[^>]* open=/);
    expect(markup).toContain('data-testid="provider-background-model-input"');

    // Legacy forbidden strings & clipboard rules
    expect(markup).not.toContain('钥匙');
    expect(markup).not.toContain('wizard-paste-btn');
    expect(readUiSource('DeepSeekSetupWizard.tsx')).not.toContain('navigator.clipboard.readText');
    expect(readUiSource('ProviderSetupWizard.tsx')).not.toContain('navigator.clipboard.readText');
  });

  it('forwards DeepSeekSetupWizard cleanly to ProviderSetupWizard while preserving all legacy props', () => {
    const markup = renderToStaticMarkup(
      createElement(DeepSeekSetupWizard, {
        open: true,
        initialKey: 'sk-123456',
        pendingLabel: '继续生成剧情',
        verifyUrlBase: 'https://api.deepseek.com',
        onComplete: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="deepseek-setup-wizard"');
    expect(markup).toContain('继续生成剧情');
    expect(markup).toContain('连接 DeepSeek');
    expect(markup).toContain('value="sk-123456"');
  });

  it('supports expandable 4-category 21-preset picker, search filtering, and mode-sensitive initial expansion', () => {
    expect(resolveInitialPresetPickerOpen('add')).toBe(true);
    expect(resolveInitialPresetPickerOpen('onboarding')).toBe(false);
    expect(resolveInitialPresetPickerOpen('edit')).toBe(false);

    expect(PROVIDER_PRESET_CATEGORIES.map((group) => group.label)).toEqual([
      '推荐与内置',
      '国内大模型',
      '海外大模型',
      '聚合・本地・自定义',
    ]);
    const flattenedIds = PROVIDER_PRESET_CATEGORIES.flatMap((group) => group.presetIds);
    expect(flattenedIds).toHaveLength(21);
    expect(new Set(flattenedIds)).toEqual(new Set(Object.keys(PROVIDER_PRESETS)));

    expect(
      filterProviderPresetGroups('Kimi').flatMap((g) => g.presetIds),
    ).toEqual(['moonshot']);
    expect(
      filterProviderPresetGroups('百炼').flatMap((g) => g.presetIds),
    ).toEqual(['dashscope']);
    expect(
      filterProviderPresetGroups('googleapis.com').flatMap((g) => g.presetIds),
    ).toEqual(['gemini']);
    expect(
      filterProviderPresetGroups('volcengine').flatMap((g) => g.presetIds),
    ).toEqual(['volcengine']);
    expect(filterProviderPresetGroups('nonexistent-provider-xyz')).toEqual([]);

    const addMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        mode: 'add',
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(addMarkup).toMatch(
      /data-testid="provider-preset-picker-trigger"[^>]*aria-expanded="true"/,
    );
    expect(addMarkup).toContain('data-testid="provider-preset-picker-panel"');
    expect(addMarkup).toContain('data-testid="provider-preset-search-input"');
    for (const label of ['推荐与内置', '国内大模型', '海外大模型', '聚合・本地・自定义']) {
      expect(addMarkup).toContain(label);
    }
    for (const presetId of Object.keys(PROVIDER_PRESETS)) {
      expect(addMarkup).toContain(`data-testid="provider-preset-${presetId}"`);
    }
    expect(addMarkup).toMatch(/data-testid="provider-preset-deepseek"[^>]*aria-pressed="true"/);
  });

  it('renders third-party fields, optional public research presets, 3-line capability summary, and prefill probe controls', () => {
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-1',
      apiKey: 'oa-key-001',
      defaultPricing: { currency: 'USD', inputPerMillion: 2.5, outputPerMillion: 10 },
      prefillProbeStatus: 'unsupported',
    });

    const tavilyMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: openaiProfile,
        initialPublicResearch: { provider: 'tavily', apiKey: 'tvly-1234' },
        mode: 'edit',
        hasDeepSeekProfileInLibrary: true,
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(tavilyMarkup).toMatch(
      /data-testid="provider-preset-picker-trigger"[^>]*aria-expanded="false"/,
    );
    expect(tavilyMarkup).toContain('OpenAI');
    expect(tavilyMarkup).not.toContain('data-testid="provider-preset-picker-panel"');
    expect(tavilyMarkup).toContain('data-testid="provider-name-input"');
    expect(tavilyMarkup).toContain('data-testid="provider-base-url-input"');
    expect(tavilyMarkup).toContain('https://api.openai.com/v1');
    expect(tavilyMarkup).toContain('API Key（本地服务可留空）');
    expect(tavilyMarkup).toContain('data-testid="provider-model-input"');
    expect(tavilyMarkup).toContain('data-testid="provider-fetch-models-btn"');
    expect(tavilyMarkup).toContain('拉取模型列表');

    // Public research section with Tavily selected
    expect(tavilyMarkup).toContain('data-testid="provider-public-research-section"');
    expect(tavilyMarkup).toMatch(/data-testid="provider-search-preset-tavily"[^>]*aria-pressed="true"/);
    expect(tavilyMarkup).toContain(PUBLIC_RESEARCH_PRESETS.tavily.quotaHint);
    expect(tavilyMarkup).toContain(PUBLIC_RESEARCH_PRESETS.tavily.docsUrl!);
    expect(tavilyMarkup).toContain('data-testid="provider-search-key-input"');
    expect(tavilyMarkup).toContain('value="tvly-1234"');

    // Third-party 3-line capability summary
    expect(tavilyMarkup).toContain('聊天、文游与叙事预设：始终可用');
    expect(tavilyMarkup).toContain('Tavily 搜索（已配置）');
    expect(tavilyMarkup).toContain('已填写自定义单价');

    // Third-party advanced controls
    expect(tavilyMarkup).toContain('data-testid="provider-protocol-select"');
    expect(tavilyMarkup).toContain('data-testid="provider-pricing-currency"');
    expect(tavilyMarkup).toContain('data-testid="provider-pricing-input"');
    expect(tavilyMarkup).toContain('data-testid="provider-pricing-cache-input"');
    expect(tavilyMarkup).toContain('data-testid="provider-pricing-output"');
    expect(tavilyMarkup).toContain('data-testid="provider-prefill-toggle"');
    expect(tavilyMarkup).toContain('data-testid="provider-probe-prefill-btn"');
    expect(tavilyMarkup).toContain('暂不支持，已保持通用稳定模式');

    // When search preset is 'none', search API key input is hidden and summary shows disabled state
    const noneMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: createProviderProfileFromPreset('local', { id: 'local-1' }),
        initialPublicResearch: { provider: 'none' },
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );
    expect(noneMarkup).toContain('data-testid="provider-search-preset-auto"');
    expect(noneMarkup).toMatch(/data-testid="provider-search-preset-none"[^>]*aria-pressed="true"/);
    expect(noneMarkup).not.toContain('data-testid="provider-search-key-input"');
    expect(noneMarkup).toContain('已关闭联网查证');
    expect(noneMarkup).toContain('默认统计节省 Token，选填单价后可算花费');

    // When search preset is omitted (defaults to 'auto'), Web and Android show distinct plain-language copy
    const autoWebMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: createProviderProfileFromPreset('local', { id: 'local-auto-web' }),
        isWebPlatform: true,
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );
    expect(autoWebMarkup).toMatch(/data-testid="provider-search-preset-auto"[^>]*aria-pressed="true"/);
    expect(autoWebMarkup).not.toContain('data-testid="provider-search-key-input"');
    expect(autoWebMarkup).toContain(
      '不配搜索也能正常玩；安卓端会自动尝试免费查原作，网页端如需查证可在此选配免费搜索',
    );

    const autoAndroidMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: createProviderProfileFromPreset('local', { id: 'local-auto-android' }),
        isWebPlatform: false,
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );
    expect(autoAndroidMarkup).toMatch(/data-testid="provider-search-preset-auto"[^>]*aria-pressed="true"/);
    expect(autoAndroidMarkup).toContain('默认自动（安卓端免密钥免费查公开网页）');

    // DeepSeek with explicit 'none' displays disabled research summary
    const dsNoneMarkup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: createProviderProfileFromPreset('deepseek', { id: 'ds-none' }),
        initialPublicResearch: { provider: 'none' },
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );
    expect(dsNoneMarkup).toContain('已关闭联网查证');
  });

  it('blocks fallback save on 401/format errors and enables fallback save on network_error or models_unsupported', async () => {
    const dsDraft = createWizardDraftFromPreset('deepseek', { apiKey: 'sk-invalid-401' });
    const ds401 = await verifyWizardDraftConnection({
      draft: dsDraft,
      verifyDeepSeekImpl: async () => ({
        status: 'invalid_key',
        message: '401 invalid',
      }),
    });
    expect(ds401.ok).toBe(false);
    expect(ds401.allowFallbackSave).toBe(false);

    const dsNet = await verifyWizardDraftConnection({
      draft: dsDraft,
      verifyDeepSeekImpl: async () => ({
        status: 'network_error',
        message: 'timeout',
      }),
    });
    expect(dsNet.ok).toBe(false);
    expect(dsNet.allowFallbackSave).toBe(true);

    const thirdPartyDraft = createWizardDraftFromPreset('custom', {
      apiKey: 'custom-token',
      publicResearch: { provider: 'bocha', apiKey: 'bocha-key-99' },
    });
    thirdPartyDraft.name = '我的中转';
    thirdPartyDraft.baseUrl = 'https://relay.example.com/v1/';
    thirdPartyDraft.defaultModel = 'claude-3-7-sonnet';
    thirdPartyDraft.backgroundModel = 'claude-3-5-haiku';
    thirdPartyDraft.pricingCurrency = 'USD';
    thirdPartyDraft.inputPriceText = '3';
    thirdPartyDraft.cacheHitPriceText = '0.3';
    thirdPartyDraft.outputPriceText = '15';

    const third401 = await verifyWizardDraftConnection({
      draft: thirdPartyDraft,
      verifyProviderImpl: async () => ({
        status: 'invalid_key',
        message: 'API Key 无效',
      }),
    });
    expect(third401.ok).toBe(false);
    expect(third401.allowFallbackSave).toBe(false);

    const thirdFormat = await verifyWizardDraftConnection({
      draft: { ...thirdPartyDraft, baseUrl: 'not-a-url' },
      verifyProviderImpl: async () => ({
        status: 'format_error',
        message: '请填写有效的服务商接口地址',
      }),
    });
    expect(thirdFormat.ok).toBe(false);
    expect(thirdFormat.allowFallbackSave).toBe(false);

    const thirdUnsupported = await verifyWizardDraftConnection({
      draft: thirdPartyDraft,
      verifyProviderImpl: async () => ({
        status: 'models_unsupported',
        message: '未开放 /models',
      }),
    });
    expect(thirdUnsupported.ok).toBe(false);
    expect(thirdUnsupported.allowFallbackSave).toBe(true);

    const thirdValid = await verifyWizardDraftConnection({
      draft: thirdPartyDraft,
      verifyProviderImpl: async () => ({
        status: 'valid',
        key: 'custom-token',
        baseUrl: 'https://relay.example.com/v1',
        models: ['claude-3-7-sonnet', 'gpt-4o-mini'],
      }),
    });
    expect(thirdValid.ok).toBe(true);
    expect(thirdValid.saveResult?.profile.baseUrl).toBe('https://relay.example.com/v1');
    expect(thirdValid.saveResult?.profile.models.map((m) => m.id)).toEqual([
      'claude-3-7-sonnet',
      'gpt-4o-mini',
    ]);
    expect(thirdValid.saveResult?.profile.backgroundModel).toBe('claude-3-5-haiku');
    expect(thirdValid.saveResult?.profile.defaultPricing).toEqual({
      currency: 'USD',
      inputPerMillion: 3,
      cacheHitInputPerMillion: 0.3,
      outputPerMillion: 15,
    });
    expect(thirdValid.saveResult?.publicResearch).toEqual({
      provider: 'bocha',
      apiKey: 'bocha-key-99',
    });

    // Local service allows empty API key on fallback save
    const localDraft = createWizardDraftFromPreset('local');
    const localFallback = validateWizardFallbackSave(localDraft);
    expect(localFallback.ok).toBe(true);
    if (localFallback.ok) {
      expect(localFallback.saveResult.profile.apiKey).toBe('');
      expect(localFallback.saveResult.profile.baseUrl).toBe('http://localhost:11434/v1');
    }

    // Build preserves empty pricing when unset and emits publicResearch: { provider: 'auto' } by default
    const cleanSave = buildProviderSaveResultFromDraft(localDraft);
    expect(cleanSave.profile.defaultPricing).toBeUndefined();
    expect(localDraft.searchProvider).toBe('auto');
    expect(cleanSave.publicResearch).toEqual({ provider: 'auto' });

    // Explicit 'none' is preserved across draft and saveResult
    const noneDraft = createWizardDraftFromPreset('openai', {
      publicResearch: { provider: 'none' },
    });
    expect(noneDraft.searchProvider).toBe('none');
    expect(buildProviderSaveResultFromDraft(noneDraft).publicResearch).toEqual({ provider: 'none' });

    // Profile draft defaults to 'auto' when publicResearch is omitted and preserves explicit 'none'
    const oaProfile = createProviderProfileFromPreset('openai', { id: 'oa-default' });
    expect(createWizardDraftFromProfile(oaProfile).searchProvider).toBe('auto');
    expect(createWizardDraftFromProfile(oaProfile, { provider: 'none' }).searchProvider).toBe('none');

    // Editing a DeepSeek profile set to deepseek-v4-pro preserves deepseek-v4-pro as defaultModel
    const proDeepSeek = createProviderProfileFromPreset('deepseek', {
      id: 'deepseek-official',
      defaultModel: 'deepseek-v4-pro',
      apiKey: 'sk-ds-pro',
    });
    const editedDsDraft = createWizardDraftFromProfile(proDeepSeek);
    const editedDsSave = buildProviderSaveResultFromDraft(editedDsDraft, {
      hasDeepSeekProfileInLibrary: true,
    });
    expect(editedDsSave.profile.defaultModel).toBe('deepseek-v4-pro');
  });

  it('switches and persists apiProtocol on OpenAI and custom drafts while keeping DeepSeek locked to openai_chat', () => {
    const oaDraft = createWizardDraftFromPreset('openai', { apiKey: 'sk-oa' });
    expect(oaDraft.apiProtocol).toBe('openai_responses');
    expect(oaDraft.backgroundModel).toBe('gpt-4o-mini');
    expect(buildProviderSaveResultFromDraft(oaDraft).profile.capabilities.apiProtocol).toBe(
      'openai_responses',
    );

    const oaChatDraft = { ...oaDraft, apiProtocol: 'openai_chat' as const };
    expect(buildProviderSaveResultFromDraft(oaChatDraft).profile.capabilities.apiProtocol).toBe(
      'openai_chat',
    );

    const customDraft = createWizardDraftFromPreset('custom', { apiKey: 'sk-c' });
    expect(customDraft.apiProtocol).toBe('openai_chat');
    const customResponses = buildProviderSaveResultFromDraft({
      ...customDraft,
      baseUrl: 'https://relay.example.com/v1',
      defaultModel: 'gpt-4.1',
      apiProtocol: 'openai_responses',
      prefixProtocol: 'standard_assistant_prefill',
    });
    expect(customResponses.profile.capabilities.apiProtocol).toBe('openai_responses');
    expect(customResponses.profile.capabilities.prefixProtocol).toBe('none');

    // Legacy profile without apiProtocol loads into draft as openai_chat
    const legacyDraft = createWizardDraftFromProfile({
      id: 'legacy-oa',
      name: 'Legacy OpenAI',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-legacy',
      models: [{ id: 'gpt-4o' }],
      defaultModel: 'gpt-4o',
      capabilities: {
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'none',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
    });
    expect(legacyDraft.apiProtocol).toBe('openai_chat');
  });

  it('renders Anthropic preset with subscription-vs-API-Key notice, console link, enabled anthropic_messages protocol, and forwards apiProtocol during verification', async () => {
    const anthropicProfile = createProviderProfileFromPreset('anthropic', {
      id: 'anthropic-1',
      apiKey: 'sk-ant-123',
    });
    const markup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: anthropicProfile,
        mode: 'edit',
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(markup).toMatch(
      /data-testid="provider-preset-picker-trigger"[^>]*aria-expanded="false"/,
    );
    expect(markup).toContain('Anthropic (Claude)');
    expect(markup).not.toContain('data-testid="provider-preset-picker-panel"');
    expect(markup).toContain('https://api.anthropic.com/v1');
    expect(markup).toContain('data-testid="anthropic-subscription-notice"');
    expect(markup).toMatch(/Claude Pro\s*\/\s*Max/);
    expect(markup.match(/https:\/\/console\.anthropic\.com\/settings\/keys/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="anthropic-console-keys-link"');
    expect(markup).toContain('value="anthropic_messages"');
    expect(markup).not.toMatch(/value="anthropic_messages"[^>]*disabled/);

    const draft = createWizardDraftFromPreset('anthropic', { apiKey: 'sk-ant-999' });
    expect(draft.apiProtocol).toBe('anthropic_messages');
    expect(draft.prefixProtocol).toBe('standard_assistant_prefill');
    expect(draft.backgroundModel).toBe('claude-haiku-4-5');

    let capturedProtocol: string | undefined;
    const outcome = await verifyWizardDraftConnection({
      draft,
      verifyProviderImpl: async (opts) => {
        capturedProtocol = opts.apiProtocol;
        return {
          status: 'valid',
          key: 'sk-ant-999',
          baseUrl: 'https://api.anthropic.com/v1',
          models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
        };
      },
    });
    expect(capturedProtocol).toBe('anthropic_messages');
    expect(outcome.ok).toBe(true);
    expect(outcome.saveResult?.profile.presetId).toBe('anthropic');
    expect(outcome.saveResult?.profile.capabilities.apiProtocol).toBe('anthropic_messages');
    expect(outcome.saveResult?.profile.capabilities.prefixProtocol).toBe(
      'standard_assistant_prefill',
    );
  });

  it('supports Gemini preset with Google AI Studio note/link, enabled gemini_native option, and apiProtocol forwarding', async () => {
    const geminiDraft = createWizardDraftFromPreset('gemini', { apiKey: 'AIza-gem-1' });
    expect(geminiDraft.apiProtocol).toBe('gemini_native');
    expect(geminiDraft.backgroundModel).toBe('gemini-2.5-flash-lite');
    expect(geminiDraft.prefixProtocol).toBe('none');

    const geminiProfile = createProviderProfileFromPreset('gemini', {
      id: 'gem-1',
      apiKey: 'AIza-gem-1',
    });
    const markup = renderToStaticMarkup(
      createElement(ProviderSetupWizard, {
        open: true,
        initialProfile: geminiProfile,
        mode: 'edit',
        onSaveProfile: vi.fn(),
        onCancel: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(markup).toMatch(
      /data-testid="provider-preset-picker-trigger"[^>]*aria-expanded="false"/,
    );
    expect(markup).toContain('Google (Gemini)');
    expect(markup).not.toContain('data-testid="provider-preset-picker-panel"');
    expect(markup.match(/data-testid="provider-gemini-billing-note"/g)).toHaveLength(1);
    expect(markup.match(/https:\/\/aistudio\.google\.com\/apikey/g)).toHaveLength(1);
    expect(markup).toContain('Google AI Studio');
    expect(markup).toContain('免费');
    expect(markup).toContain('Gemini AI Pro');
    expect(markup).not.toMatch(/<option[^>]*value="gemini_native"[^>]*disabled/);

    let seenProtocol: string | undefined;
    const verified = await verifyWizardDraftConnection({
      draft: geminiDraft,
      verifyProviderImpl: async (opts) => {
        seenProtocol = opts.apiProtocol;
        return {
          status: 'valid',
          key: 'AIza-gem-1',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        };
      },
    });
    expect(seenProtocol).toBe('gemini_native');
    expect(verified.ok).toBe(true);
    expect(verified.saveResult?.profile.presetId).toBe('gemini');
    expect(verified.saveResult?.profile.capabilities.apiProtocol).toBe('gemini_native');
    expect(verified.saveResult?.profile.capabilities.prefixProtocol).toBe('none');
  });

  it('displays preset console link and setupHint for presets with special guidance and preserves thinkingDialect on save', () => {
    for (const presetId of ['volcengine', 'spark', 'dashscope', 'openai'] as const) {
      const profile = createProviderProfileFromPreset(presetId, { id: `p-${presetId}` });
      const markup = renderToStaticMarkup(
        createElement(ProviderSetupWizard, {
          open: true,
          initialProfile: profile,
          mode: 'edit',
          onSaveProfile: vi.fn(),
          onCancel: vi.fn(),
          onExitComplete: vi.fn(),
        }),
      );

      expect(markup).toContain('data-testid="provider-console-link"');
      expect(markup).toContain(PROVIDER_PRESETS[presetId].consoleUrl!);
      expect(markup).toContain('data-testid="provider-setup-hint"');
      expect(markup).toContain(PROVIDER_PRESETS[presetId].setupHint!);
      if (presetId === 'openai') {
        expect(markup.match(/data-testid="openai-subscription-notice"/g)).toHaveLength(1);
        expect(markup.match(/https:\/\/platform\.openai\.com\/api-keys/g)).toHaveLength(1);
      }
    }

    const dashDraft = createWizardDraftFromPreset('dashscope', { apiKey: 'sk-dash' });
    const dashSave = buildProviderSaveResultFromDraft(dashDraft);
    expect(dashSave.profile.capabilities.thinkingDialect).toBe('enable_thinking');

    const arkProfile = createProviderProfileFromPreset('volcengine', {
      id: 'ark-1',
      apiKey: 'ark-key',
    });
    const arkDraft = createWizardDraftFromProfile(arkProfile);
    const arkSave = buildProviderSaveResultFromDraft(arkDraft);
    expect(arkSave.profile.capabilities.thinkingDialect).toBe('thinking_type_enabled');
  });

  it('never contains jailbreak or bypass prompt text in wizard source', () => {
    const wizardSource = readUiSource('ProviderSetupWizard.tsx');
    for (const pattern of [/破甲/, /越狱/, /防拒答/, /jailbreak/i, /\bDAN\b/]) {
      expect(wizardSource).not.toMatch(pattern);
    }
  });
});
