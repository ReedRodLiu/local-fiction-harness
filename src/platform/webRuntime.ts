import {
  createKeyValueSecretStore,
  createOpenAiTransport,
  type BackupExporter,
  type FetchLike,
  type KeyValueStorage,
  type PlatformRuntime,
  type StoryStorage,
} from '../harness/index.ts';
import { createIndexedDbStoryStorage } from '../ui/indexedDbStorage.ts';

export const DEV_PROXY_BASE_URL = '/__dev_llm_proxy';

export function isDevProxyBaseUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === DEV_PROXY_BASE_URL || trimmed.startsWith(`${DEV_PROXY_BASE_URL}/`);
}

export interface WebRuntimeOptions {
  keyValueStorage?: KeyValueStorage;
  storyStorage?: StoryStorage;
  fetchImpl?: FetchLike;
  exportJsonFile?: (fileName: string, jsonContent: string) => Promise<void>;
  devUseEnvKey?: () => boolean;
  isDev?: boolean;
}

function createDomBackupExporter(): BackupExporter {
  return {
    async exportJsonFile(fileName: string, jsonContent: string): Promise<void> {
      const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * Creates the Web PlatformRuntime adapter preserving browser fetch (plus dev-only proxy header),
 * localStorage-backed SecretStore, IndexedDB StoryStorage, and Blob download BackupExporter.
 */
export function createWebPlatformRuntime(options: WebRuntimeOptions = {}): PlatformRuntime {
  const isDev = options.isDev ?? Boolean(import.meta.env?.DEV);
  const kvStorage = options.keyValueStorage ?? window.localStorage;
  const baseFetch: FetchLike =
    options.fetchImpl ??
    ((url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal as AbortSignal | undefined,
      }));

  const devAwareFetch: FetchLike = (url, init) => {
    const headers = { ...init.headers };
    if (isDev && options.devUseEnvKey?.() && isDevProxyBaseUrl(url)) {
      headers['x-use-dev-env-key'] = '1';
    }
    return baseFetch(url, { ...init, headers });
  };

  return {
    platform: 'web',
    transport: createOpenAiTransport(devAwareFetch),
    storyStorage: options.storyStorage ?? createIndexedDbStoryStorage(),
    secretStore: createKeyValueSecretStore(kvStorage),
    backupExporter: options.exportJsonFile
      ? { exportJsonFile: options.exportJsonFile }
      : createDomBackupExporter(),
    supportsMemoryOnlySession: true,
  };
}
