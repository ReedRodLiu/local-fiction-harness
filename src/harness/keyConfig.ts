import { createDefaultId } from './id.ts';
import type {
  CustomModelPricing,
  GenerationPreference,
  KeyValueStorage,
  ModelConfig,
  ModelConfigMeta,
  OfficialDeepSeekModel,
  PrefixCompletionMode,
  ProviderCapabilities,
  ProviderLibrary,
  ProviderLibraryMeta,
  ProviderModelEntry,
  ProviderPresetId,
  ProviderProfile,
  ProviderProfileMeta,
  PublicResearchConfig,
  PublicResearchConfigMeta,
  ReasoningEffort,
  SecretStore,
} from './types.ts';

const CONFIG_META_KEY = 'lfh.model_config.meta';
const CONFIG_API_KEY = 'lfh.model_config.api_key';

export const OFFICIAL_DEEPSEEK_MODELS: readonly OfficialDeepSeekModel[] = [
  'deepseek-flash',
  'deepseek-v4-pro',
] as const;

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'high',
  'max',
] as const;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none';

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  apiKey: '',
  memoryOnly: false,
};

export function isOfficialDeepSeekModel(model: unknown): model is OfficialDeepSeekModel {
  return model === 'deepseek-flash' || model === 'deepseek-v4-pro';
}

export function normalizeOfficialDeepSeekModel(model: unknown): OfficialDeepSeekModel {
  return isOfficialDeepSeekModel(model) ? model : 'deepseek-flash';
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
  );
}

const OFFICIAL_DEEPSEEK_URL_REGEX = /^https:\/\/api\.deepseek\.com(?:\/v1|\/beta)?\/?$/i;

export function isOfficialDeepSeekUrl(baseUrl: string): boolean {
  return typeof baseUrl === 'string' && OFFICIAL_DEEPSEEK_URL_REGEX.test(baseUrl.trim());
}

export interface ProviderPresetSpec {
  presetId: ProviderPresetId;
  name: string;
  baseUrl: string;
  models: ProviderModelEntry[];
  defaultModel: string;
  backgroundModel?: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderPresetId, ProviderPresetSpec>> = {
  deepseek: {
    presetId: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', label: '日常轻量' },
      { id: 'deepseek-v4-pro', label: '旗舰深度' },
    ],
    defaultModel: 'deepseek-flash',
    backgroundModel: 'deepseek-flash',
    capabilities: {
      thinkingProtocol: 'deepseek',
      prefixProtocol: 'deepseek_beta',
      supportsBalanceQuery: true,
      supportsBuiltinSearch: true,
      supportsBuiltinPricing: true,
    },
  },
  openai: {
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
    defaultModel: 'gpt-4o',
    capabilities: {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    },
  },
  openrouter: {
    presetId: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'openai/gpt-4o-mini' }],
    defaultModel: 'openai/gpt-4o-mini',
    capabilities: {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    },
  },
  siliconflow: {
    presetId: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    capabilities: {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    },
  },
  local: {
    presetId: 'local',
    name: '本地服务（Ollama / LM Studio）',
    baseUrl: 'http://localhost:11434/v1',
    models: [{ id: 'llama3.2' }],
    defaultModel: 'llama3.2',
    capabilities: {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    },
  },
  custom: {
    presetId: 'custom',
    name: '自定义服务商',
    baseUrl: '',
    models: [],
    defaultModel: '',
    capabilities: {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    },
  },
};

function cloneModelEntry(entry: ProviderModelEntry): ProviderModelEntry {
  return {
    id: entry.id,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.pricing ? { pricing: { ...entry.pricing } } : {}),
  };
}

function cloneCapabilities(capabilities: ProviderCapabilities): ProviderCapabilities {
  return {
    thinkingProtocol: capabilities.thinkingProtocol,
    prefixProtocol: capabilities.prefixProtocol,
    supportsBalanceQuery: Boolean(capabilities.supportsBalanceQuery),
    supportsBuiltinSearch: Boolean(capabilities.supportsBuiltinSearch),
    supportsBuiltinPricing: Boolean(capabilities.supportsBuiltinPricing),
  };
}

/**
 * Instantiates a fresh ProviderProfile from the built-in preset catalog.
 */
export function createProviderProfileFromPreset(
  presetId: ProviderPresetId,
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  const preset = PROVIDER_PRESETS[presetId] ?? PROVIDER_PRESETS.custom;
  const id = overrides.id?.trim() || (preset.presetId === 'deepseek' ? 'deepseek-official' : createDefaultId());
  const models = (overrides.models ?? preset.models).map(cloneModelEntry);
  const capabilities = cloneCapabilities(
    overrides.capabilities
      ? { ...preset.capabilities, ...overrides.capabilities }
      : preset.capabilities,
  );
  const backgroundModel =
    overrides.backgroundModel !== undefined ? overrides.backgroundModel : preset.backgroundModel;
  const defaultPricing = overrides.defaultPricing ? { ...overrides.defaultPricing } : undefined;
  return {
    id,
    name: overrides.name ?? preset.name,
    presetId: overrides.presetId ?? preset.presetId,
    baseUrl: overrides.baseUrl ?? preset.baseUrl,
    apiKey: overrides.apiKey ?? '',
    models,
    defaultModel: overrides.defaultModel ?? preset.defaultModel,
    ...(backgroundModel !== undefined ? { backgroundModel } : {}),
    ...(defaultPricing ? { defaultPricing } : {}),
    capabilities,
    ...(overrides.prefillProbeStatus !== undefined
      ? { prefillProbeStatus: overrides.prefillProbeStatus }
      : {}),
    ...(overrides.memoryOnly !== undefined ? { memoryOnly: overrides.memoryOnly } : {}),
  };
}

/**
 * Creates the initial v2 ProviderLibrary with DeepSeek Official selected and thinking OFF.
 */
export function createDefaultProviderLibrary(): ProviderLibrary {
  const defaultProfile = createProviderProfileFromPreset('deepseek', { id: 'deepseek-official' });
  return {
    version: 2,
    activeProviderId: defaultProfile.id,
    profiles: [defaultProfile],
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  };
}

const SECRET_ENVELOPE_V2_PREFIX = 'lfh-secrets-v2:';

export interface SecretEnvelopePayload {
  providers: Record<string, string>;
  searchApiKey?: string;
}

export interface DecodedSecretEnvelope {
  providers?: Record<string, string>;
  searchApiKey?: string;
  legacyKey?: string;
}

export function encodeSecretEnvelope(payload: SecretEnvelopePayload): string {
  const providers: Record<string, string> = {};
  for (const [id, value] of Object.entries(payload.providers ?? {})) {
    if (id && typeof value === 'string' && value.length > 0) {
      providers[id] = value;
    }
  }
  const searchApiKey =
    typeof payload.searchApiKey === 'string' && payload.searchApiKey.length > 0
      ? payload.searchApiKey
      : undefined;
  const sanitized: SecretEnvelopePayload = {
    providers,
    ...(searchApiKey ? { searchApiKey } : {}),
  };
  return `${SECRET_ENVELOPE_V2_PREFIX}${JSON.stringify(sanitized)}`;
}

export function decodeSecretEnvelope(raw: string | null | undefined): DecodedSecretEnvelope {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { providers: {} };
  }
  if (!raw.startsWith(SECRET_ENVELOPE_V2_PREFIX)) {
    return { legacyKey: raw };
  }
  try {
    const parsed = JSON.parse(raw.slice(SECRET_ENVELOPE_V2_PREFIX.length)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { providers: {} };
    }
    const record = parsed as Record<string, unknown>;
    const providers: Record<string, string> = {};
    if (record.providers && typeof record.providers === 'object' && !Array.isArray(record.providers)) {
      for (const [id, value] of Object.entries(record.providers as Record<string, unknown>)) {
        if (id && typeof value === 'string' && value.length > 0) {
          providers[id] = value;
        }
      }
    }
    const searchApiKey =
      typeof record.searchApiKey === 'string' && record.searchApiKey.length > 0
        ? record.searchApiKey
        : undefined;
    return {
      providers,
      ...(searchApiKey ? { searchApiKey } : {}),
    };
  } catch {
    return { providers: {} };
  }
}

const SAFE_MODEL_IDENTIFIER_REGEX =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?(?:\/[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)?$/;
const MODEL_HOSTNAME_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const LOCAL_MODEL_ALIASES = new Set([
  'localhost',
  'localhost.localdomain',
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
]);

export function isModelHostAlias(value: string): boolean {
  const hostname = value.split(':', 1)[0] ?? '';
  return (
    LOCAL_MODEL_ALIASES.has(hostname) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
    MODEL_HOSTNAME_REGEX.test(hostname)
  );
}

/**
 * Validates a model identifier for safe diagnostic / skeleton logging,
 * stripping URLs, hostnames, and credential-like prefixes.
 */
export function sanitizeDiagnosticModelName(rawModel: unknown): string | undefined {
  if (typeof rawModel !== 'string') return undefined;
  const model = rawModel.trim();
  if (
    !model ||
    model.length > 128 ||
    /^(?:https?|ftp|file|data|blob|wss?):/i.test(model) ||
    !SAFE_MODEL_IDENTIFIER_REGEX.test(model)
  ) {
    return undefined;
  }
  const components = model.toLowerCase().split('/');
  if (
    components.some(isModelHostAlias) ||
    /(?:api[_-]?key|secret|token|password|authorization|bearer)/i.test(model) ||
    /^(?:sk|rk|pk|key|token|secret)[_-]/i.test(model)
  ) {
    return undefined;
  }
  return model;
}

export function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): ReasoningEffort {
  return isReasoningEffort(value) ? value : fallback;
}

export function isPrefixCompletionMode(value: unknown): value is PrefixCompletionMode {
  return value === 'off' || value === 'on_retry' || value === 'always';
}

/**
 * Normalizes the optional per-asset generation controls without inventing a
 * pack id or rejecting third-party provider/model selections.
 */
export function normalizeGenerationPreference(
  pref?: GenerationPreference | null,
): GenerationPreference | undefined {
  if (!pref || typeof pref !== 'object') return undefined;
  const out: GenerationPreference = {};
  if (typeof pref.providerId === 'string' && pref.providerId.trim()) {
    out.providerId = pref.providerId.trim();
  }
  if (typeof pref.model === 'string') {
    const trimmedModel = pref.model.trim();
    if (trimmedModel.length > 0 && trimmedModel.length <= 200) {
      out.model = trimmedModel;
    }
  }
  if (isReasoningEffort(pref.reasoningEffort)) out.reasoningEffort = pref.reasoningEffort;
  if (typeof pref.promptPackMode === 'string' && pref.promptPackMode.trim()) {
    out.promptPackMode = pref.promptPackMode.trim();
  }
  if (isPrefixCompletionMode(pref.prefixCompletion)) {
    out.prefixCompletion = pref.prefixCompletion;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Forces non-dev-proxy model configurations to the official DeepSeek endpoint and
 * whitelisted official models (preserving deepseek-v4-pro, migrating legacy values
 * like deepseek-chat to deepseek-flash).
 */
export function normalizeOfficialModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    apiKey: isOfficialDeepSeekUrl(config.baseUrl) ? config.apiKey : '',
    baseUrl: DEFAULT_MODEL_CONFIG.baseUrl,
    model: normalizeOfficialDeepSeekModel(config.model),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort, DEFAULT_REASONING_EFFORT),
    memoryOnly: false,
  };
}

/**
 * Resolves the effective foreground model configuration by applying optional
 * per-story/work/character overrides on top of the global default config.
 */
export function resolveEffectiveModelConfig(
  globalConfig: ModelConfig,
  override?: GenerationPreference,
): ModelConfig {
  const baseModel = globalConfig.model.trim() || DEFAULT_MODEL_CONFIG.model;
  const overrideModel = typeof override?.model === 'string' ? override.model.trim() : '';
  const model = overrideModel || baseModel;
  const reasoningEffort = normalizeReasoningEffort(
    override?.reasoningEffort ?? globalConfig.reasoningEffort,
    DEFAULT_REASONING_EFFORT,
  );
  return {
    ...globalConfig,
    model,
    reasoningEffort,
  };
}

/**
 * Resolves the model configuration for background and structured extraction tasks
 * (rolling summary compression, DeepSeek import boundary detection/filtering,
 * branch gist/blueprint extraction), preferring `backgroundModel` when set,
 * otherwise reusing the current foreground model with thinking disabled (`none`).
 */
export function createBackgroundModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    model: config.backgroundModel?.trim() || config.model.trim() || DEFAULT_MODEL_CONFIG.model,
    reasoningEffort: 'none',
  };
}

export interface ModelConfigStore {
  load(): ModelConfig;
  save(config: ModelConfig): void;
}

export interface AsyncModelConfigStore {
  load(): Promise<ModelConfig>;
  save(config: ModelConfig): Promise<void>;
}

function parseMetaJson(rawMeta: string | null): Partial<ModelConfigMeta> {
  if (!rawMeta) {
    return {};
  }
  try {
    return JSON.parse(rawMeta) as Partial<ModelConfigMeta>;
  } catch {
    return {};
  }
}

function stripPublicResearchSecret(
  config: PublicResearchConfig | PublicResearchConfigMeta | undefined,
): PublicResearchConfigMeta | undefined {
  if (!config || typeof config !== 'object') return undefined;
  return {
    provider: config.provider,
    ...(typeof config.deepseekProfileId === 'string' && config.deepseekProfileId.trim()
      ? { deepseekProfileId: config.deepseekProfileId.trim() }
      : {}),
  };
}

function stripProfileSecret(profile: ProviderProfile | ProviderProfileMeta): ProviderProfileMeta {
  const { apiKey: _ignored, ...rest } = profile as ProviderProfile;
  return {
    ...rest,
    models: Array.isArray(rest.models) ? rest.models.map(cloneModelEntry) : [],
    capabilities: cloneCapabilities(
      rest.capabilities ?? PROVIDER_PRESETS[rest.presetId]?.capabilities ?? PROVIDER_PRESETS.custom.capabilities,
    ),
    ...(rest.defaultPricing ? { defaultPricing: { ...rest.defaultPricing } } : {}),
  };
}

function sanitizeProviderLibraryMeta(raw: unknown): ProviderLibraryMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<ProviderLibraryMeta>;
  if (candidate.version !== 2 || !Array.isArray(candidate.profiles) || candidate.profiles.length === 0) {
    return undefined;
  }
  const profiles = candidate.profiles.map((p) => stripProfileSecret(p));
  const activeProviderId =
    typeof candidate.activeProviderId === 'string' &&
    profiles.some((p) => p.id === candidate.activeProviderId)
      ? candidate.activeProviderId
      : profiles[0]!.id;
  const publicResearch = stripPublicResearchSecret(candidate.publicResearch);
  return {
    version: 2,
    activeProviderId,
    profiles,
    ...(isReasoningEffort(candidate.reasoningEffort)
      ? { reasoningEffort: candidate.reasoningEffort }
      : {}),
    ...(publicResearch ? { publicResearch } : {}),
  };
}

function normalizeMeta(meta: Partial<ModelConfigMeta> | null | undefined): ModelConfigMeta {
  const isInitialDefault =
    !meta ||
    (typeof meta.baseUrl !== 'string' &&
      typeof meta.model !== 'string' &&
      meta.reasoningEffort === undefined &&
      meta.memoryOnly === undefined &&
      meta.providerLibrary === undefined);
  const reasoningEffort = isReasoningEffort(meta?.reasoningEffort)
    ? meta.reasoningEffort
    : isInitialDefault
      ? DEFAULT_REASONING_EFFORT
      : undefined;
  const providerLibrary = sanitizeProviderLibraryMeta(meta?.providerLibrary);
  const publicResearch = stripPublicResearchSecret(meta?.publicResearch);
  return {
    baseUrl:
      typeof meta?.baseUrl === 'string' && (meta.baseUrl || providerLibrary)
        ? meta.baseUrl
        : DEFAULT_MODEL_CONFIG.baseUrl,
    model:
      typeof meta?.model === 'string' && (meta.model || providerLibrary)
        ? meta.model
        : DEFAULT_MODEL_CONFIG.model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    memoryOnly: Boolean(meta?.memoryOnly),
    ...(typeof meta?.providerId === 'string' && meta.providerId ? { providerId: meta.providerId } : {}),
    ...(meta?.providerPresetId ? { providerPresetId: meta.providerPresetId } : {}),
    ...(typeof meta?.backgroundModel === 'string' && meta.backgroundModel
      ? { backgroundModel: meta.backgroundModel }
      : {}),
    ...(meta?.capabilities ? { capabilities: cloneCapabilities(meta.capabilities) } : {}),
    ...(meta?.pricing ? { pricing: { ...meta.pricing } as CustomModelPricing } : {}),
    ...(publicResearch ? { publicResearch } : {}),
    ...(providerLibrary ? { providerLibrary } : {}),
  };
}

function resolveModelConfig(
  meta: Partial<ModelConfigMeta> | null | undefined,
  persistedKey: string,
  memoryApiKey: string,
): ModelConfig {
  const normalized = normalizeMeta(meta);
  return {
    ...normalized,
    apiKey: normalized.memoryOnly ? memoryApiKey : persistedKey,
  };
}

function extractMeta(config: ModelConfig): ModelConfigMeta {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    ...(isReasoningEffort(config.reasoningEffort)
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    memoryOnly: config.memoryOnly,
  };
}

/**
 * Adapts a synchronous KeyValueStorage into the async SecretStore contract.
 */
export function createKeyValueSecretStore(persistentStorage: KeyValueStorage): SecretStore {
  return {
    async loadMeta(): Promise<ModelConfigMeta | null> {
      const rawMeta = persistentStorage.getItem(CONFIG_META_KEY);
      if (!rawMeta) return null;
      return normalizeMeta(parseMetaJson(rawMeta));
    },
    async saveMeta(meta: ModelConfigMeta): Promise<void> {
      persistentStorage.setItem(CONFIG_META_KEY, JSON.stringify(meta));
    },
    async loadApiKey(): Promise<string> {
      return persistentStorage.getItem(CONFIG_API_KEY) ?? '';
    },
    async saveApiKey(apiKey: string): Promise<void> {
      persistentStorage.setItem(CONFIG_API_KEY, apiKey);
    },
    async clearApiKey(): Promise<void> {
      persistentStorage.removeItem(CONFIG_API_KEY);
    },
  };
}

/**
 * Manages BYOK model configuration asynchronously via SecretStore with immediate
 * persistent key purge when memoryOnly is enabled.
 */
export function createAsyncModelConfigStore(secretStore: SecretStore): AsyncModelConfigStore {
  let memoryApiKey = '';

  return {
    async load(): Promise<ModelConfig> {
      const meta = await secretStore.loadMeta();
      const memoryOnly = Boolean(meta?.memoryOnly);
      const persistedKey = memoryOnly ? '' : await secretStore.loadApiKey();
      return resolveModelConfig(meta, persistedKey, memoryApiKey);
    },

    async save(config: ModelConfig): Promise<void> {
      const meta = extractMeta(config);
      let keyOp: Promise<void>;
      if (config.memoryOnly) {
        memoryApiKey = config.apiKey;
        keyOp = secretStore.clearApiKey();
      } else {
        memoryApiKey = '';
        keyOp = config.apiKey ? secretStore.saveApiKey(config.apiKey) : secretStore.clearApiKey();
      }
      await Promise.all([secretStore.saveMeta(meta), keyOp]);
    },
  };
}

/**
 * Manages BYOK model configuration synchronously (kept for pure KV storage callers).
 * Switching memoryOnly to true immediately purges any persisted API key from persistent storage.
 */
export function createModelConfigStore(persistentStorage: KeyValueStorage): ModelConfigStore {
  let memoryApiKey = '';

  return {
    load(): ModelConfig {
      const meta = parseMetaJson(persistentStorage.getItem(CONFIG_META_KEY));
      const memoryOnly = Boolean(meta.memoryOnly);
      const persistedKey = memoryOnly ? '' : (persistentStorage.getItem(CONFIG_API_KEY) ?? '');
      return resolveModelConfig(meta, persistedKey, memoryApiKey);
    },

    save(config: ModelConfig): void {
      persistentStorage.setItem(CONFIG_META_KEY, JSON.stringify(extractMeta(config)));

      if (config.memoryOnly) {
        memoryApiKey = config.apiKey;
        persistentStorage.removeItem(CONFIG_API_KEY);
      } else {
        memoryApiKey = '';
        if (config.apiKey) {
          persistentStorage.setItem(CONFIG_API_KEY, config.apiKey);
        } else {
          persistentStorage.removeItem(CONFIG_API_KEY);
        }
      }
    },
  };
}

export interface AsyncProviderLibraryStore {
  load(): Promise<ProviderLibrary>;
  save(library: ProviderLibrary): Promise<void>;
}

/**
 * Manages multi-provider profiles, per-profile memoryOnly semantics, public research
 * credentials, and legacy single-slot migration on top of SecretStore.
 */
export function createAsyncProviderLibraryStore(
  secretStore: SecretStore,
): AsyncProviderLibraryStore {
  const memoryKeys = new Map<string, string>();

  return {
    async load(): Promise<ProviderLibrary> {
      const meta = await secretStore.loadMeta();
      const shouldReadPersisted = Boolean(meta?.providerLibrary) || !meta?.memoryOnly;
      const rawSecret = shouldReadPersisted ? await secretStore.loadApiKey() : '';
      const decoded = decodeSecretEnvelope(rawSecret);

      if (meta === null) {
        const defaultLib = createDefaultProviderLibrary();
        if (decoded.legacyKey) {
          defaultLib.profiles[0]!.apiKey = decoded.legacyKey;
        }
        return defaultLib;
      }

      if (meta.providerLibrary && meta.providerLibrary.profiles.length > 0) {
        const libMeta = meta.providerLibrary;
        const profiles: ProviderProfile[] = libMeta.profiles.map((p) => {
          const metaProfile = stripProfileSecret(p);
          const apiKey = metaProfile.memoryOnly
            ? (memoryKeys.get(metaProfile.id) ?? '')
            : (decoded.providers?.[metaProfile.id] ??
              (metaProfile.id === libMeta.activeProviderId ? decoded.legacyKey : undefined) ??
              '');
          return {
            ...metaProfile,
            apiKey,
          };
        });
        const activeProviderId = profiles.some((p) => p.id === libMeta.activeProviderId)
          ? libMeta.activeProviderId
          : profiles[0]!.id;
        const reasoningEffort = normalizeReasoningEffort(
          libMeta.reasoningEffort,
          DEFAULT_REASONING_EFFORT,
        );
        const publicResearchMeta = stripPublicResearchSecret(libMeta.publicResearch);
        const publicResearch: PublicResearchConfig | undefined = publicResearchMeta
          ? {
              ...publicResearchMeta,
              ...(decoded.searchApiKey ? { apiKey: decoded.searchApiKey } : {}),
            }
          : undefined;
        return {
          version: 2,
          activeProviderId,
          profiles,
          reasoningEffort,
          ...(publicResearch ? { publicResearch } : {}),
        };
      }

      // Legacy single-slot migration (no providerLibrary present)
      const legacyKey = meta.memoryOnly
        ? ''
        : (decoded.legacyKey ?? decoded.providers?.['deepseek-official'] ?? '');
      const legacyBaseUrl = typeof meta.baseUrl === 'string' ? meta.baseUrl.trim() : '';
      const legacyModel = typeof meta.model === 'string' ? meta.model.trim() : '';
      const legacyEffort = normalizeReasoningEffort(meta.reasoningEffort, DEFAULT_REASONING_EFFORT);

      if (!legacyBaseUrl || isOfficialDeepSeekUrl(legacyBaseUrl)) {
        const profile = createProviderProfileFromPreset('deepseek', {
          id: 'deepseek-official',
          defaultModel: legacyModel ? normalizeOfficialDeepSeekModel(legacyModel) : 'deepseek-flash',
          apiKey: legacyKey,
          memoryOnly: Boolean(meta.memoryOnly),
        });
        return {
          version: 2,
          activeProviderId: profile.id,
          profiles: [profile],
          reasoningEffort: legacyEffort,
        };
      }

      const customProfile = createProviderProfileFromPreset('custom', {
        id: 'legacy-custom',
        baseUrl: legacyBaseUrl,
        models: legacyModel ? [{ id: legacyModel }] : [],
        defaultModel: legacyModel,
        apiKey: legacyKey,
        memoryOnly: Boolean(meta.memoryOnly),
      });
      return {
        version: 2,
        activeProviderId: customProfile.id,
        profiles: [customProfile],
        reasoningEffort: legacyEffort,
      };
    },

    async save(library: ProviderLibrary): Promise<void> {
      const profiles =
        library.profiles.length > 0
          ? library.profiles
          : [createProviderProfileFromPreset('deepseek', { id: 'deepseek-official' })];
      const activeProfile =
        profiles.find((p) => p.id === library.activeProviderId) ?? profiles[0]!;
      const reasoningEffort = normalizeReasoningEffort(
        library.reasoningEffort,
        DEFAULT_REASONING_EFFORT,
      );

      memoryKeys.clear();
      const persistedProviders: Record<string, string> = {};
      for (const profile of profiles) {
        if (profile.memoryOnly) {
          if (profile.apiKey) {
            memoryKeys.set(profile.id, profile.apiKey);
          }
        } else if (profile.apiKey) {
          persistedProviders[profile.id] = profile.apiKey;
        }
      }
      const searchApiKey =
        typeof library.publicResearch?.apiKey === 'string' && library.publicResearch.apiKey.length > 0
          ? library.publicResearch.apiKey
          : undefined;

      const publicResearchMeta = stripPublicResearchSecret(library.publicResearch);
      const providerLibraryMeta: ProviderLibraryMeta = {
        version: 2,
        activeProviderId: activeProfile.id,
        profiles: profiles.map(stripProfileSecret),
        reasoningEffort,
        ...(publicResearchMeta ? { publicResearch: publicResearchMeta } : {}),
      };

      const meta: ModelConfigMeta = {
        baseUrl: activeProfile.baseUrl,
        model: activeProfile.defaultModel,
        reasoningEffort,
        memoryOnly: Boolean(activeProfile.memoryOnly),
        providerId: activeProfile.id,
        providerPresetId: activeProfile.presetId,
        ...(activeProfile.backgroundModel ? { backgroundModel: activeProfile.backgroundModel } : {}),
        capabilities: cloneCapabilities(activeProfile.capabilities),
        ...(publicResearchMeta ? { publicResearch: publicResearchMeta } : {}),
        providerLibrary: providerLibraryMeta,
      };

      const hasPersistedSecrets =
        Object.keys(persistedProviders).length > 0 || Boolean(searchApiKey);

      await secretStore.saveMeta(meta);
      if (hasPersistedSecrets) {
        await secretStore.saveApiKey(
          encodeSecretEnvelope({
            providers: persistedProviders,
            ...(searchApiKey ? { searchApiKey } : {}),
          }),
        );
      } else {
        await secretStore.clearApiKey();
      }
    },
  };
}

/**
 * Projects a single effective ModelConfig from a ProviderLibrary and optional
 * per-story/work/character GenerationPreference override.
 */
export function projectActiveModelConfig(
  library: ProviderLibrary,
  override?: GenerationPreference,
): ModelConfig {
  const overrideProviderId =
    typeof override?.providerId === 'string' ? override.providerId.trim() : '';
  const profile =
    (overrideProviderId
      ? library.profiles.find((p) => p.id === overrideProviderId)
      : undefined) ??
    library.profiles.find((p) => p.id === library.activeProviderId) ??
    library.profiles[0] ??
    createProviderProfileFromPreset('deepseek', { id: 'deepseek-official' });

  const overrideModel = typeof override?.model === 'string' ? override.model.trim() : '';
  const model = overrideModel || profile.defaultModel.trim() || profile.models[0]?.id || '';
  const reasoningEffort = normalizeReasoningEffort(
    override?.reasoningEffort ?? library.reasoningEffort,
    DEFAULT_REASONING_EFFORT,
  );
  const modelEntry = profile.models.find((m) => m.id === model);
  const pricing = modelEntry?.pricing ?? profile.defaultPricing;
  const backgroundModel = profile.backgroundModel?.trim() || undefined;

  return {
    baseUrl: profile.baseUrl,
    model,
    reasoningEffort,
    apiKey: profile.apiKey,
    memoryOnly: Boolean(profile.memoryOnly),
    providerId: profile.id,
    providerPresetId: profile.presetId,
    ...(backgroundModel ? { backgroundModel } : {}),
    capabilities: cloneCapabilities(profile.capabilities),
    ...(pricing ? { pricing: { ...pricing } } : {}),
    ...(library.publicResearch ? { publicResearch: { ...library.publicResearch } } : {}),
  };
}
