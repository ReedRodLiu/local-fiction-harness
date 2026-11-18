import type {
  KeyValueStorage,
  ModelConfig,
  ModelConfigMeta,
  SecretStore,
} from './types.ts';

const CONFIG_META_KEY = 'lfh.model_config.meta';
const CONFIG_API_KEY = 'lfh.model_config.api_key';

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  memoryOnly: false,
};

/**
 * Forces non-dev-proxy model configurations to the official DeepSeek endpoint and
 * deepseek-flash model, migrating legacy cached values (e.g. deepseek-chat).
 */
export function normalizeOfficialModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    baseUrl: DEFAULT_MODEL_CONFIG.baseUrl,
    model: DEFAULT_MODEL_CONFIG.model,
    memoryOnly: false,
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
  return {
    baseUrl:
      typeof meta?.baseUrl === 'string' && meta.baseUrl
        ? meta.baseUrl
        : DEFAULT_MODEL_CONFIG.baseUrl,
    model:
      typeof meta?.model === 'string' && meta.model ? meta.model : DEFAULT_MODEL_CONFIG.model,
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
