import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REASONING_EFFORT,
  PROVIDER_PRESETS,
  createAsyncProviderLibraryStore,
  createDefaultProviderLibrary,
  createKeyValueSecretStore,
  createProviderProfileFromPreset,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  projectActiveModelConfig,
  type KeyValueStorage,
  type ProviderLibrary,
} from '../../src/harness/index.ts';

function createMemoryKv(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe('Provider presets, default library, and multi-secret envelope', () => {
  it('exposes all 6 provider presets with exact ADR-0018 metadata and capabilities', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('none');

    expect(PROVIDER_PRESETS.deepseek).toMatchObject({
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-flash', label: '日常轻量' },
        { id: 'deepseek-v4-pro', label: '旗舰深度' },
      ],
      defaultModel: 'deepseek-flash',
      backgroundModel: 'deepseek-flash',
      capabilities: {
        apiProtocol: 'openai_chat',
        thinkingProtocol: 'deepseek',
        prefixProtocol: 'deepseek_beta',
        supportsBalanceQuery: true,
        supportsBuiltinSearch: true,
        supportsBuiltinPricing: true,
      },
    });

    expect(PROVIDER_PRESETS.openai).toMatchObject({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4.1' },
        { id: 'gpt-4o' },
        { id: 'gpt-4o-mini' },
        { id: 'o4-mini' },
      ],
      defaultModel: 'gpt-4.1',
      backgroundModel: 'gpt-4o-mini',
      capabilities: {
        apiProtocol: 'openai_responses',
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'none',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
    });

    expect(PROVIDER_PRESETS.anthropic).toMatchObject({
      presetId: 'anthropic',
      name: 'Anthropic (Claude)',
      baseUrl: 'https://api.anthropic.com/v1',
      models: [
        { id: 'claude-sonnet-4-5' },
        { id: 'claude-opus-4-1' },
        { id: 'claude-haiku-4-5' },
      ],
      defaultModel: 'claude-sonnet-4-5',
      backgroundModel: 'claude-haiku-4-5',
      capabilities: {
        apiProtocol: 'anthropic_messages',
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'standard_assistant_prefill',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
    });

    expect(PROVIDER_PRESETS.openrouter).toMatchObject({
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'openai/gpt-4o-mini' }],
      defaultModel: 'openai/gpt-4o-mini',
    });

    expect(PROVIDER_PRESETS.siliconflow).toMatchObject({
      name: '硅基流动',
      baseUrl: 'https://api.siliconflow.cn/v1',
      models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
      defaultModel: 'deepseek-ai/DeepSeek-V3',
    });

    expect(PROVIDER_PRESETS.local).toMatchObject({
      name: '本地服务（Ollama / LM Studio）',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'llama3.2' }],
      defaultModel: 'llama3.2',
    });

    expect(PROVIDER_PRESETS.custom).toMatchObject({
      name: '自定义服务商',
      baseUrl: '',
      models: [],
      defaultModel: '',
    });

    const p1 = createProviderProfileFromPreset('openai', { id: 'p-openai', apiKey: 'sk-1' });
    p1.models.push({ id: 'o3-mini' });
    expect(PROVIDER_PRESETS.openai.models).toHaveLength(4);

    const defLib = createDefaultProviderLibrary();
    expect(defLib.version).toBe(2);
    expect(defLib.reasoningEffort).toBe('none');
    expect(defLib.profiles).toHaveLength(1);
    expect(defLib.activeProviderId).toBe(defLib.profiles[0]!.id);
    expect(defLib.profiles[0]!.presetId).toBe('deepseek');
  });

  it('encodes and decodes lfh-secrets-v2 envelopes and legacy raw keys', () => {
    const encoded = encodeSecretEnvelope({
      providers: {
        p1: 'sk-provider-1',
        empty: '',
      },
      searchApiKey: 'tvly-search-key',
    });

    expect(encoded.startsWith('lfh-secrets-v2:')).toBe(true);
    expect(decodeSecretEnvelope(encoded)).toEqual({
      providers: { p1: 'sk-provider-1' },
      searchApiKey: 'tvly-search-key',
    });

    expect(decodeSecretEnvelope('sk-legacy-raw-key')).toEqual({
      legacyKey: 'sk-legacy-raw-key',
    });

    expect(decodeSecretEnvelope('')).toEqual({
      providers: {},
    });
  });
});

describe('AsyncProviderLibraryStore persistence, memoryOnly purge, and legacy migration', () => {
  it('persists multi-provider library metadata without apiKey leaks and purges storage when all persisted keys are empty', async () => {
    const kv = createMemoryKv();
    const secretStore = createKeyValueSecretStore(kv);
    const clearSpy = vi.spyOn(secretStore, 'clearApiKey');
    const store = createAsyncProviderLibraryStore(secretStore);

    const initial = await store.load();
    expect(initial.version).toBe(2);
    expect(initial.reasoningEffort).toBe('none');
    expect(initial.profiles[0]?.presetId).toBe('deepseek');

    const library: ProviderLibrary = {
      version: 2,
      activeProviderId: 'openai-1',
      reasoningEffort: 'medium',
      publicResearch: {
        provider: 'tavily',
        apiKey: 'tvly-secret-999',
      },
      profiles: [
        createProviderProfileFromPreset('deepseek', {
          id: 'ds-1',
          apiKey: 'sk-ds-secret',
        }),
        createProviderProfileFromPreset('openai', {
          id: 'openai-1',
          apiKey: 'sk-openai-secret',
          defaultModel: 'gpt-4o',
          defaultPricing: {
            currency: 'USD',
            inputPerMillion: 2.5,
            outputPerMillion: 10,
          },
          models: [
            { id: 'gpt-4o' },
            {
              id: 'gpt-4o-mini',
              pricing: {
                currency: 'USD',
                inputPerMillion: 0.15,
                cacheHitInputPerMillion: 0.075,
                outputPerMillion: 0.6,
              },
            },
          ],
        }),
        createProviderProfileFromPreset('local', {
          id: 'local-mem',
          apiKey: 'sk-mem-only',
          memoryOnly: true,
        }),
      ],
    };

    await store.save(library);

    // Meta must contain legacy projection + providerLibrary strictly stripped of all apiKey fields
    const rawMeta = kv.getItem('lfh.model_config.meta') ?? '';
    expect(rawMeta).not.toContain('sk-ds-secret');
    expect(rawMeta).not.toContain('sk-openai-secret');
    expect(rawMeta).not.toContain('sk-mem-only');
    expect(rawMeta).not.toContain('tvly-secret-999');

    const savedMeta = await secretStore.loadMeta();
    expect(savedMeta).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      reasoningEffort: 'medium',
      memoryOnly: false,
      providerId: 'openai-1',
      providerPresetId: 'openai',
    });
    expect(savedMeta?.providerLibrary?.profiles).toHaveLength(3);
    for (const metaProfile of savedMeta?.providerLibrary?.profiles ?? []) {
      expect(Object.hasOwn(metaProfile, 'apiKey')).toBe(false);
    }
    expect(Object.hasOwn(savedMeta?.providerLibrary?.publicResearch ?? {}, 'apiKey')).toBe(false);

    // Secret payload must NOT include memoryOnly key
    const rawSecret = kv.getItem('lfh.model_config.api_key') ?? '';
    expect(rawSecret.startsWith('lfh-secrets-v2:')).toBe(true);
    expect(rawSecret).not.toContain('sk-mem-only');

    // Same-session load retains memoryOnly key
    const sameSession = await store.load();
    expect(sameSession.profiles.find((p) => p.id === 'local-mem')?.apiKey).toBe('sk-mem-only');

    // Cold restart hydrates persisted keys + search key, but drops memoryOnly key
    const restarted = createAsyncProviderLibraryStore(createKeyValueSecretStore(kv));
    const reloaded = await restarted.load();
    expect(reloaded.activeProviderId).toBe('openai-1');
    expect(reloaded.reasoningEffort).toBe('medium');
    expect(reloaded.publicResearch).toEqual({
      provider: 'tavily',
      apiKey: 'tvly-secret-999',
    });
    expect(reloaded.profiles.find((p) => p.id === 'ds-1')?.apiKey).toBe('sk-ds-secret');
    expect(reloaded.profiles.find((p) => p.id === 'openai-1')?.apiKey).toBe('sk-openai-secret');
    expect(reloaded.profiles.find((p) => p.id === 'local-mem')?.apiKey).toBe('');

    // When all persisted keys are cleared (only memoryOnly profile has a key), clearApiKey() must run
    await store.save({
      version: 2,
      activeProviderId: 'local-mem',
      reasoningEffort: 'none',
      profiles: [
        createProviderProfileFromPreset('local', {
          id: 'local-mem',
          apiKey: 'sk-only-in-ram',
          memoryOnly: true,
        }),
      ],
    });
    expect(clearSpy).toHaveBeenCalled();
    expect(kv.getItem('lfh.model_config.api_key')).toBeNull();
  });

  it('migrates legacy official DeepSeek single-slot config without losing key or Pro model', async () => {
    const kv = createMemoryKv();
    kv.setItem(
      'lfh.model_config.meta',
      JSON.stringify({
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
        memoryOnly: false,
      }),
    );
    kv.setItem('lfh.model_config.api_key', 'sk-legacy-ds-123');

    const store = createAsyncProviderLibraryStore(createKeyValueSecretStore(kv));
    const migrated = await store.load();

    expect(migrated.version).toBe(2);
    expect(migrated.reasoningEffort).toBe('high');
    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.profiles[0]).toMatchObject({
      presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-pro',
      backgroundModel: 'deepseek-flash',
      apiKey: 'sk-legacy-ds-123',
      memoryOnly: false,
    });
  });

  it('migrates legacy non-DeepSeek single-slot config preserving exact baseUrl, model, and apiKey', async () => {
    const kv = createMemoryKv();
    kv.setItem(
      'lfh.model_config.meta',
      JSON.stringify({
        baseUrl: 'https://relay.example.com/v1',
        model: 'claude-3-7-sonnet',
        reasoningEffort: 'low',
        memoryOnly: false,
      }),
    );
    kv.setItem('lfh.model_config.api_key', 'sk-relay-999');

    const store = createAsyncProviderLibraryStore(createKeyValueSecretStore(kv));
    const migrated = await store.load();

    expect(migrated.version).toBe(2);
    expect(migrated.reasoningEffort).toBe('low');
    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.profiles[0]).toMatchObject({
      presetId: 'custom',
      baseUrl: 'https://relay.example.com/v1',
      defaultModel: 'claude-3-7-sonnet',
      models: [{ id: 'claude-3-7-sonnet' }],
      apiKey: 'sk-relay-999',
      memoryOnly: false,
      capabilities: {
        apiProtocol: 'openai_chat',
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'none',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
    });
  });

  it('defaults omitted capabilities.apiProtocol to openai_chat when loading legacy stored profiles', async () => {
    const kv = createMemoryKv();
    kv.setItem(
      'lfh.model_config.meta',
      JSON.stringify({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        providerId: 'openai-legacy',
        providerPresetId: 'openai',
        providerLibrary: {
          version: 2,
          activeProviderId: 'openai-legacy',
          reasoningEffort: 'none',
          profiles: [
            {
              id: 'openai-legacy',
              name: 'OpenAI',
              presetId: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              models: [{ id: 'gpt-4o' }],
              defaultModel: 'gpt-4o',
              capabilities: {
                thinkingProtocol: 'openai_reasoning_effort',
                prefixProtocol: 'none',
                supportsBalanceQuery: false,
                supportsBuiltinSearch: false,
                supportsBuiltinPricing: false,
              },
            },
          ],
        },
      }),
    );

    const store = createAsyncProviderLibraryStore(createKeyValueSecretStore(kv));
    const loaded = await store.load();
    expect(loaded.profiles[0]?.capabilities.apiProtocol).toBe('openai_chat');
    expect(projectActiveModelConfig(loaded).capabilities?.apiProtocol).toBe('openai_chat');
  });
});

describe('projectActiveModelConfig', () => {
  it('projects active profile, respects provider/model/reasoning overrides, and resolves model-specific vs default pricing', () => {
    const library: ProviderLibrary = {
      version: 2,
      activeProviderId: 'ds-1',
      reasoningEffort: 'none',
      publicResearch: {
        provider: 'tavily',
        apiKey: 'tvly-123',
      },
      profiles: [
        createProviderProfileFromPreset('deepseek', {
          id: 'ds-1',
          apiKey: 'sk-ds',
        }),
        createProviderProfileFromPreset('openai', {
          id: 'openai-1',
          apiKey: 'sk-openai',
          defaultModel: 'gpt-4o',
          backgroundModel: 'gpt-4o-mini',
          defaultPricing: {
            currency: 'USD',
            inputPerMillion: 2.5,
            outputPerMillion: 10,
          },
          models: [
            { id: 'gpt-4o' },
            {
              id: 'gpt-4o-mini',
              pricing: {
                currency: 'USD',
                inputPerMillion: 0.15,
                cacheHitInputPerMillion: 0.075,
                outputPerMillion: 0.6,
              },
            },
          ],
        }),
      ],
    };

    const activeProjected = projectActiveModelConfig(library);
    expect(activeProjected).toMatchObject({
      providerId: 'ds-1',
      providerPresetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      backgroundModel: 'deepseek-flash',
      reasoningEffort: 'none',
      apiKey: 'sk-ds',
      publicResearch: { provider: 'tavily', apiKey: 'tvly-123' },
    });

    // Override to openai-1 defaultModel -> inherits defaultPricing
    const openaiDefault = projectActiveModelConfig(library, { providerId: 'openai-1' });
    expect(openaiDefault).toMatchObject({
      providerId: 'openai-1',
      providerPresetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backgroundModel: 'gpt-4o-mini',
      reasoningEffort: 'none',
      apiKey: 'sk-openai',
      pricing: { currency: 'USD', inputPerMillion: 2.5, outputPerMillion: 10 },
    });

    // Override to gpt-4o-mini + medium reasoning -> uses model entry pricing
    const openaiMini = projectActiveModelConfig(library, {
      providerId: 'openai-1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
    });
    expect(openaiMini).toMatchObject({
      providerId: 'openai-1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
      pricing: {
        currency: 'USD',
        inputPerMillion: 0.15,
        cacheHitInputPerMillion: 0.075,
        outputPerMillion: 0.6,
      },
    });
  });
});
