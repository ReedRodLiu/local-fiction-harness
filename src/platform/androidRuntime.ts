import {
  createDiagnosticCollector,
  createDiagnosticStoryStorage,
  createDiagnosticTransport,
  type AppUpdater,
  type BackupExporter,
  type BinaryDownloader,
  type CreativeStorage,
  type KeyValueStorage,
  type LlmTransport,
  type PlatformRuntime,
  type SecretStore,
  type StoryStorage,
} from '../harness/index.ts';
import { createCapacitorBinaryDownloader } from './capacitorBinaryDownloader.ts';
import { createCapacitorSseTransport } from './capacitorSseTransport.ts';
import { createCapacitorAppUpdater } from './capacitorUpdater.ts';
import {
  createAndroidBackupExporter,
  createAndroidCreativeStorage,
  createAndroidSecretStore,
  createAndroidStoryStorage,
} from './capacitorVaultAdapters.ts';

export interface AndroidRuntimeOptions {
  transport?: LlmTransport;
  binaryDownloader?: BinaryDownloader;
  storyStorage?: StoryStorage;
  creativeStorage?: CreativeStorage;
  secretStore?: SecretStore;
  backupExporter?: BackupExporter;
  diagnosticsStorage?: KeyValueStorage;
  promptPackStorage?: KeyValueStorage;
  appUpdater?: AppUpdater;
}

function resolveBrowserLocalStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function createMemoryKeyValueStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/**
 * Creates the Android PlatformRuntime adapter wired exclusively to native Capacitor bridges:
 * chunked SSE streaming, native HTTPS ZIP download, Keystore-encrypted SecretStore, app-private StoryStorage, and native BackupExporter.
 */
export function createAndroidPlatformRuntime(
  options: AndroidRuntimeOptions = {},
): PlatformRuntime {
  const promptPackStorage =
    options.promptPackStorage ?? resolveBrowserLocalStorage() ?? createMemoryKeyValueStorage();
  const diagnostics = createDiagnosticCollector({
    platform: 'android',
    storage: options.diagnosticsStorage ?? resolveBrowserLocalStorage(),
  });
  return {
    platform: 'android',
    diagnostics,
    promptPackStorage,
    transport: createDiagnosticTransport(
      options.transport ?? createCapacitorSseTransport(),
      diagnostics,
    ),
    binaryDownloader: options.binaryDownloader ?? createCapacitorBinaryDownloader(),
    storyStorage: createDiagnosticStoryStorage(
      options.storyStorage ?? createAndroidStoryStorage(),
      diagnostics,
    ),
    secretStore: options.secretStore ?? createAndroidSecretStore(),
    creativeStorage: options.creativeStorage ?? createAndroidCreativeStorage(),
    backupExporter: options.backupExporter ?? createAndroidBackupExporter(),
    supportsMemoryOnlySession: true,
    appUpdater: options.appUpdater ?? createCapacitorAppUpdater(),
  };
}
