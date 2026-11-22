import type {
  GenerationPreference,
  KeyValueStorage,
  ModelConfig,
  ModelConfigMeta,
  OfficialDeepSeekModel,
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

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

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
  return value === 'none' || value === 'low' || value === 'high' || value === 'max';
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

/**
 * Forces non-dev-proxy model configurations to the official DeepSeek endpoint and
 * whitelisted official models (preserving deepseek-v4-pro, migrating legacy values
 * like deepseek-chat to deepseek-flash, and defaulting reasoningEffort to high).
 */
export function normalizeOfficialModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    apiKey: /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/i.test(config.baseUrl.trim()) ? config.apiKey : '',
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
  const model = override?.model ? normalizeOfficialDeepSeekModel(override.model) : baseModel;
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
 * Pins background and structured extraction tasks (rolling summary compression,
 * DeepSeek import boundary detection/filtering, branch gist/blueprint extraction)
 * to deepseek-flash with thinking disabled while preserving endpoint/proxy credentials.
 */
export function createBackgroundModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    model: DEFAULT_MODEL_CONFIG.model,
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

function normalizeMeta(meta: Partial<ModelConfigMeta> | null | undefined): ModelConfigMeta {
  const isInitialDefault = !meta || (typeof meta.baseUrl !== 'string' && typeof meta.model !== 'string' && meta.reasoningEffort === undefined && meta.memoryOnly === undefined);
  const reasoningEffort = isReasoningEffort(meta?.reasoningEffort)
    ? meta.reasoningEffort
    : isInitialDefault
      ? DEFAULT_REASONING_EFFORT
      : undefined;
  return {
    baseUrl:
      typeof meta?.baseUrl === 'string' && meta.baseUrl
        ? meta.baseUrl
        : DEFAULT_MODEL_CONFIG.baseUrl,
    model:
      typeof meta?.model === 'string' && meta.model ? meta.model : DEFAULT_MODEL_CONFIG.model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    memoryOnly: Boolean(meta?.memoryOnly),
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
