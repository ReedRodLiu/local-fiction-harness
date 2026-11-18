import {
  createDiagnosticCollector,
  createDiagnosticStoryStorage,
  createDiagnosticTransport,
  type BackupExporter,
  type BinaryDownloader,
  type KeyValueStorage,
  type LlmTransport,
  type PlatformRuntime,
  type SecretStore,
  type StoryStorage,
} from '../harness/index.ts';
import { createCapacitorBinaryDownloader } from './capacitorBinaryDownloader.ts';
import { createCapacitorSseTransport } from './capacitorSseTransport.ts';
import {
  createAndroidBackupExporter,
  createAndroidSecretStore,
  createAndroidStoryStorage,
} from './capacitorVaultAdapters.ts';

export interface AndroidRuntimeOptions {
  transport?: LlmTransport;
  binaryDownloader?: BinaryDownloader;
  storyStorage?: StoryStorage;
  secretStore?: SecretStore;
  backupExporter?: BackupExporter;
  diagnosticsStorage?: KeyValueStorage;
}

function resolveBrowserLocalStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the Android PlatformRuntime adapter wired exclusively to native Capacitor bridges:
 * chunked SSE streaming, native HTTPS ZIP download, Keystore-encrypted SecretStore, app-private StoryStorage, and native BackupExporter.
 */
export function createAndroidPlatformRuntime(
  options: AndroidRuntimeOptions = {},
): PlatformRuntime {
  const diagnostics = createDiagnosticCollector({
    platform: 'android',
    storage: options.diagnosticsStorage ?? resolveBrowserLocalStorage(),
  });
  return {
    platform: 'android',
    diagnostics,
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
    backupExporter: options.backupExporter ?? createAndroidBackupExporter(),
    supportsMemoryOnlySession: true,
  };
}
