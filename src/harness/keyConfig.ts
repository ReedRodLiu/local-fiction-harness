import type { KeyValueStorage, ModelConfig } from './types.ts';

const CONFIG_META_KEY = 'lfh.model_config.meta';
const CONFIG_API_KEY = 'lfh.model_config.api_key';

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  memoryOnly: false,
};

export interface ModelConfigStore {
  load(): ModelConfig;
  save(config: ModelConfig): void;
}

/**
 * Manages BYOK model configuration with explicit localStorage vs session-memory-only policy.
 * Switching memoryOnly to true immediately purges any persisted API key from persistent storage.
 */
export function createModelConfigStore(persistentStorage: KeyValueStorage): ModelConfigStore {
  let memoryApiKey = '';

  return {
    load(): ModelConfig {
      let meta: Partial<Omit<ModelConfig, 'apiKey'>> = {};
      const rawMeta = persistentStorage.getItem(CONFIG_META_KEY);
      if (rawMeta) {
        try {
          meta = JSON.parse(rawMeta) as Partial<Omit<ModelConfig, 'apiKey'>>;
        } catch {
          meta = {};
        }
      }

      const memoryOnly = Boolean(meta.memoryOnly);
      const persistedKey = memoryOnly ? '' : (persistentStorage.getItem(CONFIG_API_KEY) ?? '');

      return {
        baseUrl: typeof meta.baseUrl === 'string' && meta.baseUrl ? meta.baseUrl : DEFAULT_MODEL_CONFIG.baseUrl,
        model: typeof meta.model === 'string' && meta.model ? meta.model : DEFAULT_MODEL_CONFIG.model,
        memoryOnly,
        apiKey: memoryOnly ? memoryApiKey : persistedKey,
      };
    },

    save(config: ModelConfig): void {
      const meta = {
        baseUrl: config.baseUrl,
        model: config.model,
        memoryOnly: config.memoryOnly,
      };
      persistentStorage.setItem(CONFIG_META_KEY, JSON.stringify(meta));

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
