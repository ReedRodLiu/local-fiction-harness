import {
  createDeepSeekPublicResearchProvider,
  createDiagnosticCollector,
  createDiagnosticStoryStorage,
  createDiagnosticTransport,
  type BackupExporter,
  type BinaryDownloader,
  type CreativeStorage,
  type KeyValueStorage,
  type FetchLike,
  type LlmTransport,
  type PlatformRuntime,
  type PublicResearchProvider,
  type SecretStore,
  type StoryStorage,
} from '../harness/index.ts';
import { createCapacitorBinaryDownloader } from './capacitorBinaryDownloader.ts';
import { createCapacitorSseTransport } from './capacitorSseTransport.ts';
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
  publicResearch?: PublicResearchProvider;
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
  const transport = createDiagnosticTransport(
    options.transport ?? createCapacitorSseTransport(),
    diagnostics,
  );
  const webFetch = (globalThis as { fetch?: FetchLike }).fetch;
  return {
    platform: 'android',
    diagnostics,
    transport,
    publicResearch: options.publicResearch ?? (webFetch ? createDeepSeekPublicResearchProvider({
      fetcher: webFetch,
      transport,
    }) : undefined),
    binaryDownloader: options.binaryDownloader ?? createCapacitorBinaryDownloader(),
    storyStorage: createDiagnosticStoryStorage(
      options.storyStorage ?? createAndroidStoryStorage(),
      diagnostics,
    ),
    secretStore: options.secretStore ?? createAndroidSecretStore(),
    creativeStorage: options.creativeStorage ?? createAndroidCreativeStorage(),
    backupExporter: options.backupExporter ?? createAndroidBackupExporter(),
    supportsMemoryOnlySession: true,
  };
}
