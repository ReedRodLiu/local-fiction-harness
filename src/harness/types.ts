import type { DiagnosticCollector } from './diagnostics.ts';

export interface StoryBlueprint {
  title: string;
  worldRules: string[];
  protagonist: string;
  npcs: Array<{ name: string; role: string; traits: string }>;
  taboos: string[];
  openingHook: string;
  extractionStatus: 'complete' | 'partial_fallback';
}

export interface PlotSummarySnapshot {
  content: string;
  coveredUpToNodeId: string | null;
  summarizedTurnCount: number;
}

export type NodeDiagnosticStatus = 'CONTENT_FILTER' | 'TIMEOUT' | 'INCOMPLETE';

export type StorySourceKind = 'manual_script' | 'deepseek_import';

export interface NodeDiagnostics {
  readonly sourceStatus?: NodeDiagnosticStatus;
  readonly contentRisk?: boolean;
}

export interface TurnNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  diagnostics?: NodeDiagnostics;
  createdAt: number;
  summarySnapshot: PlotSummarySnapshot;
}

export interface Story {
  id: string;
  title: string;
  sourceKind?: StorySourceKind;
  rawScript: string;
  blueprint: StoryBlueprint;
  nodes: Record<string, TurnNode>;
  rootNodeIds: string[];
  activeLeafNodeId: string | null;
  setupNodeIds?: string[];
  branchNames?: Record<string, string>;
  branchSummaries?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmStreamDelta {
  contentDelta?: string;
  reasoningDelta?: string;
  finishReason?: string | null;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface LlmStreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  signal?: AbortSignalLike;
}

export interface LlmTransport {
  streamChat(req: LlmStreamRequest): AsyncIterable<LlmStreamDelta>;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoryStorage {
  listStories(): Promise<Story[]>;
  getStory(id: string): Promise<Story | null>;
  saveStory(story: Story): Promise<void>;
  deleteStory(id: string): Promise<void>;
  getActiveStoryId(): Promise<string | null>;
  setActiveStoryId(id: string | null): Promise<void>;
}

export interface StoryBackupEnvelope {
  schemaVersion: 1;
  exportedAt: number;
  story: Story;
}

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  memoryOnly: boolean;
}

export type ModelConfigMeta = Omit<ModelConfig, 'apiKey'>;

export interface SecretStore {
  loadMeta(): Promise<ModelConfigMeta | null>;
  saveMeta(meta: ModelConfigMeta): Promise<void>;
  loadApiKey(): Promise<string>;
  saveApiKey(apiKey: string): Promise<void>;
  clearApiKey(): Promise<void>;
}

export interface BackupExporter {
  exportJsonFile(fileName: string, jsonContent: string): Promise<void>;
}

export interface BinaryDownloadResult {
  bytes: Uint8Array;
  contentType?: string;
}

export interface BinaryDownloader {
  downloadZipBytes(
    url: string,
    maxBytes: number,
    signal?: AbortSignalLike,
  ): Promise<BinaryDownloadResult>;
}

export interface PlatformRuntime {
  platform: 'web' | 'android';
  diagnostics: DiagnosticCollector;
  transport: LlmTransport;
  binaryDownloader: BinaryDownloader;
  storyStorage: StoryStorage;
  secretStore: SecretStore;
  backupExporter: BackupExporter;
  supportsMemoryOnlySession: boolean;
}

export interface TurnCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
  signal?: AbortSignalLike;
}

export interface TurnExecutionResult {
  userNode: TurnNode;
  assistantNode: TurnNode;
  story: Story;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  body:
    | AsyncIterable<Uint8Array>
    | {
        getReader(): {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          releaseLock(): void;
        };
      }
    | null;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignalLike;
  },
) => Promise<FetchResponseLike>;

export interface BinaryFetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  body:
    | AsyncIterable<Uint8Array>
    | {
        getReader(): {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          releaseLock(): void;
        };
      }
    | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BinaryFetchLike = (
  url: string,
  init: {
    method: 'GET';
    signal?: AbortSignalLike;
  },
) => Promise<BinaryFetchResponseLike>;
