import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  createDefaultProviderLibrary,
  createFictionHarness,
  createInMemoryStoryStorage,
  createProviderProfileFromPreset,
  createRoutedPublicResearchProvider,
  exportFolioBackupV3,
  mergeRestoredBackup,
  parseAndValidateFolioBackup,
  emptyWorkspace,
  type LlmTransport,
  type ProviderLibrary,
} from '../../src/harness/index.ts';
import {
  applyWizardSaveToLibrary,
  hasCredentialsForItem,
  hasModelCredentials,
  rehydrateProviderLibraryKeys,
} from '../../src/ui/App.tsx';
import {
  hydratePublicResearchKeyInMemory,
  resolveEffectiveLibraryModelConfig,
} from '../../src/ui/GenerationControls.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('Ticket #165: App multi-provider library integration, per-item overrides, backup, and telemetry', () => {
  it('checks credentials for API keys, dev proxy, local preset, and localhost/127.0.0.1 endpoints', () => {
    expect(hasModelCredentials({ ...DEFAULT_MODEL_CONFIG, apiKey: '' }, false)).toBe(false);
    expect(hasModelCredentials({ ...DEFAULT_MODEL_CONFIG, apiKey: 'sk-123' }, false)).toBe(true);
    expect(hasModelCredentials({ ...DEFAULT_MODEL_CONFIG, baseUrl: '/__dev_llm_proxy', apiKey: '' }, true)).toBe(true);

    const localPresetCfg = {
      ...DEFAULT_MODEL_CONFIG,
      baseUrl: 'http://192.168.1.50:11434/v1',
      providerPresetId: 'local' as const,
      apiKey: '',
    };
    expect(hasModelCredentials(localPresetCfg, false)).toBe(true);

    const localhostCustomCfg = {
      ...DEFAULT_MODEL_CONFIG,
      baseUrl: 'http://127.0.0.1:8080/v1',
      providerPresetId: 'custom' as const,
      apiKey: '',
    };
    expect(hasModelCredentials(localhostCustomCfg, false)).toBe(true);

    // Per-item override targeting an unconfigured third-party profile must NOT inherit dev env key from active DeepSeek
    const unconfiguredOpenAi = {
      ...DEFAULT_MODEL_CONFIG,
      baseUrl: 'https://api.openai.com/v1',
      providerId: 'openai-1',
      providerPresetId: 'openai' as const,
      apiKey: '',
    };
    expect(hasCredentialsForItem(unconfiguredOpenAi, 'deepseek-official', true)).toBe(false);
  });

  it('resolves effective config from ProviderLibrary and hydrates deepseek_account research key only in memory', async () => {
    const dsProfile = createProviderProfileFromPreset('deepseek', {
      id: 'deepseek-official',
      apiKey: 'sk-ds-borrowed-key',
    });
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-main',
      apiKey: 'sk-oa-secret',
      models: [{ id: 'gpt-4o' }, { id: 'o3-mini' }],
      defaultModel: 'gpt-4o',
      defaultPricing: { currency: 'USD', inputPerMillion: 2.5, outputPerMillion: 10 },
    });
    const library: ProviderLibrary = {
      version: 2,
      activeProviderId: 'openai-main',
      profiles: [dsProfile, openaiProfile],
      reasoningEffort: 'none',
      publicResearch: { provider: 'deepseek_account', deepseekProfileId: 'deepseek-official' },
    };

    const resolved = resolveEffectiveLibraryModelConfig({
      providerLibrary: library,
      preference: { providerId: 'openai-main', model: 'o3-mini', reasoningEffort: 'medium' },
    });

    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
    expect(resolved.model).toBe('o3-mini');
    expect(resolved.apiKey).toBe('sk-oa-secret');
    expect(resolved.reasoningEffort).toBe('medium');
    expect(resolved.pricing).toEqual({ currency: 'USD', inputPerMillion: 2.5, outputPerMillion: 10 });
    expect(resolved.publicResearch).toEqual({
      provider: 'deepseek_account',
      deepseekProfileId: 'deepseek-official',
      apiKey: 'sk-ds-borrowed-key',
    });
    // Library on state/disk remains untouched (no apiKey mutated onto library.publicResearch)
    expect(library.publicResearch?.apiKey).toBeUndefined();

    // Verify routed public research provider accepts the hydrated in-memory config cleanly
    const fetchedUrls: string[] = [];
    const provider = createRoutedPublicResearchProvider({
      fetcher: async (url) => {
        fetchedUrls.push(url);
        if (url.endsWith('/v1/tools/search')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            body: null,
            text: async () =>
              JSON.stringify({
                results: [
                  {
                    rerank_score: 2.6,
                    authority: 4,
                    title: '原作资料',
                    url: 'https://official.example/wiki',
                    snippet: '主角A背景设定',
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: null,
          text: async () =>
            JSON.stringify({
              title: '原作资料',
              content: '主角A 是一位来自某原作的角色背景设定详情。',
            }),
        };
      },
      transport: {
        async *streamChat() {
          yield { contentDelta: '检索摘要', finishReason: 'stop' };
        },
      },
    });
    const ref = await provider.resolve({
      identity: { work: '某原作', version: '原著', timeline: '主线', characters: ['主角A'] },
      config: hydratePublicResearchKeyInMemory(library, resolved),
    });
    expect(ref).not.toBeNull();
    expect(fetchedUrls.some((u) => u.startsWith('https://api.deepseek.com'))).toBe(true);
  });

  it('applies wizard saves across onboarding/add/edit and rehydrates local keys across .folio.json backup merge', () => {
    const initial = createDefaultProviderLibrary();
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-1',
      apiKey: 'sk-oa-1',
    });
    // Onboarding non-DeepSeek replaces empty unconfigured DeepSeek placeholder
    const onboarded = applyWizardSaveToLibrary(
      initial,
      { profile: openaiProfile, publicResearch: { provider: 'tavily', apiKey: 'tvly-1' } },
      'onboarding',
    );
    expect(onboarded.profiles.map((p) => p.id)).toEqual(['openai-1']);
    expect(onboarded.activeProviderId).toBe('openai-1');
    expect(onboarded.publicResearch).toEqual({ provider: 'tavily', apiKey: 'tvly-1' });

    // Adding DeepSeek sets it active while keeping OpenAI
    const dsProfile = createProviderProfileFromPreset('deepseek', {
      id: 'deepseek-official',
      apiKey: 'sk-ds-1',
    });
    const withDs = applyWizardSaveToLibrary(onboarded, { profile: dsProfile }, 'add');
    expect(withDs.profiles.map((p) => p.id)).toEqual(['openai-1', 'deepseek-official']);
    expect(withDs.activeProviderId).toBe('deepseek-official');

    // Editing a non-active profile keeps activeProviderId unchanged
    const updatedOpenAi = { ...openaiProfile, apiKey: 'sk-oa-updated' };
    const edited = applyWizardSaveToLibrary(withDs, { profile: updatedOpenAi }, 'edit');
    expect(edited.activeProviderId).toBe('deepseek-official');
    expect(edited.profiles.find((p) => p.id === 'openai-1')?.apiKey).toBe('sk-oa-updated');

    // Export backup (keyless) & merge incoming backup while preserving local keys
    const incomingLib = {
      ...createDefaultProviderLibrary(),
      activeProviderId: 'sf-imported',
      profiles: [
        createProviderProfileFromPreset('siliconflow', {
          id: 'sf-imported',
          name: '导入硅基',
          apiKey: 'sk-should-be-stripped',
        }),
      ],
    };
    const backupJson = exportFolioBackupV3({
      stories: [],
      workspace: emptyWorkspace(),
      providerLibrary: incomingLib,
    });
    expect(backupJson).not.toContain('sk-should-be-stripped');
    const parsedBackup = parseAndValidateFolioBackup(backupJson);
    const merged = mergeRestoredBackup(
      { stories: [], workspace: emptyWorkspace(), providerLibrary: edited },
      parsedBackup,
    );
    const rehydrated = rehydrateProviderLibraryKeys(merged.providerLibrary!, edited);
    expect(rehydrated.profiles.find((p) => p.id === 'openai-1')?.apiKey).toBe('sk-oa-updated');
    expect(rehydrated.profiles.find((p) => p.id === 'deepseek-official')?.apiKey).toBe('sk-ds-1');
    expect(rehydrated.profiles.find((p) => p.id === 'sf-imported')?.apiKey).toBe('');
    expect(rehydrated.publicResearch).toEqual({ provider: 'tavily', apiKey: 'tvly-1' });
  });

  it('forwards custom pricing and capabilities into TurnUsageTelemetry in harness.runTurn', async () => {
    const transport: LlmTransport = {
      async *streamChat() {
        yield {
          contentDelta: '第一幕展开。',
          finishReason: 'stop',
          usage: {
            promptTokens: 1000,
            completionTokens: 200,
            promptCacheHitTokens: 600,
            promptCacheMissTokens: 400,
          },
        };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage: createInMemoryStoryStorage(),
    });
    const story = harness.createStory({ title: '计费测试' });
    const openaiProfile = createProviderProfileFromPreset('openai', {
      id: 'openai-priced',
      apiKey: 'sk-oa',
      defaultPricing: {
        currency: 'USD',
        inputPerMillion: 2.5,
        cacheHitInputPerMillion: 1.25,
        outputPerMillion: 10,
      },
    });
    const cfg = resolveEffectiveLibraryModelConfig({
      providerLibrary: {
        version: 2,
        activeProviderId: openaiProfile.id,
        profiles: [openaiProfile],
        reasoningEffort: 'none',
      },
    });

    const result = await harness.runTurn(story, '走进车站', cfg);
    expect(result.assistantNode.telemetry?.providerKind).toBe('custom-priced');
    expect(result.assistantNode.telemetry?.pricingSnapshot).toEqual({
      currency: 'USD',
      inputPerMillion: 2.5,
      cacheHitInputPerMillion: 1.25,
      outputPerMillion: 10,
    });
  });

  it('wires ProviderLibraryStore, ProviderSetupWizard, SettingsPage multi-profile callbacks, supportsBalanceQuery, and v3 providerLibrary backup in App.tsx', () => {
    const appSource = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8');
    expect(appSource).toContain('createAsyncProviderLibraryStore');
    expect(appSource).toContain('ProviderSetupWizard');
    expect(appSource).toContain('onSelectProviderProfile=');
    expect(appSource).toContain('onOpenAddProviderWizard=');
    expect(appSource).toContain('onOpenEditProviderWizard=');
    expect(appSource).toContain('onDeleteProviderProfile=');
    expect(appSource).toContain('onAddCustomModel=');
    expect(appSource).toContain('onRemoveCustomModel=');
    expect(appSource).toContain('onUpdatePublicResearch=');
    expect(appSource).toContain('supportsBalanceQuery');
    expect(appSource).toContain('providerLibrary,');
  });
});
