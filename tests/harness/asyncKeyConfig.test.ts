import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  createAsyncModelConfigStore,
  createKeyValueSecretStore,
  type KeyValueStorage,
  type SecretStore,
} from '../../src/harness/index.ts';

function createMemoryKeyValueStorage(): KeyValueStorage {
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

describe('AsyncModelConfigStore & SecretStore contract', () => {
  it('hydrates persisted config asynchronously and clears apiKey immediately on memoryOnly=true', async () => {
    const kv = createMemoryKeyValueStorage();
    const secretStore = createKeyValueSecretStore(kv);
    const clearSpy = vi.spyOn(secretStore, 'clearApiKey');

    const store = createAsyncModelConfigStore(secretStore);
    expect(await store.load()).toEqual(DEFAULT_MODEL_CONFIG);

    await store.save({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKey: 'sk-persist-abc',
      memoryOnly: false,
    });

    // Fresh store instance simulates app cold restart
    const restarted = createAsyncModelConfigStore(secretStore);
    expect(await restarted.load()).toEqual({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKey: 'sk-persist-abc',
      memoryOnly: false,
    });

    // Switching to memoryOnly immediately invokes clearApiKey() while keeping in-session memory
    await restarted.save({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKey: 'sk-persist-abc',
      memoryOnly: true,
    });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect((await restarted.load()).apiKey).toBe('sk-persist-abc');
    expect(await secretStore.loadApiKey()).toBe('');

    // New instance after restart does not recover cleared apiKey
    const afterRestart = createAsyncModelConfigStore(secretStore);
    expect(await afterRestart.load()).toEqual({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKey: '',
      memoryOnly: true,
    });
  });

  it('works against any async SecretStore implementation and clears when apiKey becomes empty', async () => {
    let savedMeta: { baseUrl: string; model: string; memoryOnly: boolean } | null = null;
    let savedKey = '';

    const asyncVault: SecretStore = {
      async loadMeta() {
        return savedMeta;
      },
      async saveMeta(meta) {
        savedMeta = { ...meta };
      },
      async loadApiKey() {
        return savedKey;
      },
      async saveApiKey(apiKey) {
        savedKey = apiKey;
      },
      async clearApiKey() {
        savedKey = '';
      },
    };

    const store = createAsyncModelConfigStore(asyncVault);
    await store.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-vault-1',
      memoryOnly: false,
    });
    expect(savedKey).toBe('sk-vault-1');

    await store.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: '',
      memoryOnly: false,
    });
    expect(savedKey).toBe('');
  });
});
