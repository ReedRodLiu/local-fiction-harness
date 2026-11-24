import {
  createDiagnosticCollector,
  createDiagnosticStoryStorage,
  createDiagnosticTransport,
  createDeepSeekPublicResearchProvider,
  createKeyValueSecretStore,
  createOpenAiTransport,
  createWebBinaryDownloader,
  type BackupExporter,
  type CreativeStorage,
  type BinaryDownloader,
  type BinaryFetchLike,
  type FetchLike,
  type KeyValueStorage,
  type PlatformRuntime,
  type PublicResearchProvider,
  type StoryStorage,
} from '../harness/index.ts';
import { createIndexedDbStoryStorage } from '../ui/indexedDbStorage.ts';
import { isDevProxyBaseUrl, readDevSessionProxy } from './devProxy.ts';

export interface WebRuntimeOptions {
  keyValueStorage?: KeyValueStorage;
  diagnosticsStorage?: KeyValueStorage;
  storyStorage?: StoryStorage;
  creativeStorage?: CreativeStorage;
  fetchImpl?: FetchLike;
  publicResearch?: PublicResearchProvider;
  binaryFetchImpl?: BinaryFetchLike;
  binaryDownloader?: BinaryDownloader;
  exportJsonFile?: (fileName: string, jsonContent: string) => Promise<void>;
  devUseEnvKey?: () => boolean;
  isDev?: boolean;
}

function createDomBackupExporter(): BackupExporter {
  async function download(fileName: string, content: BlobPart, type: string): Promise<void> {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
  return {
    exportJsonFile: (name, content) => download(name, content, 'application/json;charset=utf-8'),
    exportMarkdown: (name, content) => download(name, content, 'text/markdown;charset=utf-8'),
    exportAttachment: (name, base64) => download(name, Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)), 'application/octet-stream'),
  };
}

/**
 * Creates the Web PlatformRuntime adapter preserving browser fetch (plus dev-only proxy header),
 * localStorage-backed SecretStore, IndexedDB StoryStorage, and Blob download BackupExporter.
 */
export function createWebPlatformRuntime(options: WebRuntimeOptions = {}): PlatformRuntime {
  const isDev = import.meta.env.DEV && (options.isDev ?? true);
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
    const shouldAttachDevKey =
      isDev &&
      isDevProxyBaseUrl(url) &&
      (options.devUseEnvKey ? options.devUseEnvKey() : Boolean(readDevSessionProxy(true)?.hasEnvKey));
    if (shouldAttachDevKey) {
      headers['x-use-dev-env-key'] = '1';
    }
    return baseFetch(url, { ...init, headers });
  };

  const binaryFetch: BinaryFetchLike =
    options.binaryFetchImpl ??
    ((url, init) =>
      fetch(url, {
        method: init.method,
        signal: init.signal as AbortSignal | undefined,
      }));

  const diagnostics = createDiagnosticCollector({
    platform: 'web',
    storage: options.diagnosticsStorage ?? kvStorage,
  });

  const indexedDb = createIndexedDbStoryStorage();
  const exporter = createDomBackupExporter();
  const transport = createDiagnosticTransport(createOpenAiTransport(devAwareFetch), diagnostics);
  return {
    platform: 'web',
    diagnostics,
    promptPackStorage: kvStorage,
    transport,
    publicResearch: options.publicResearch ?? createDeepSeekPublicResearchProvider({
      fetcher: devAwareFetch,
      transport,
    }),
    binaryDownloader: options.binaryDownloader ?? createWebBinaryDownloader(binaryFetch),
    storyStorage: createDiagnosticStoryStorage(
      options.storyStorage ?? indexedDb,
      diagnostics,
    ),
    secretStore: createKeyValueSecretStore(kvStorage),
    creativeStorage: options.creativeStorage ?? indexedDb.creativeStorage,
    backupExporter: { ...exporter, exportJsonFile: options.exportJsonFile ?? exporter.exportJsonFile },
    supportsMemoryOnlySession: true,
  };
}
