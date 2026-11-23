import type { MarkdownProposal, MarkdownProposalStatus, StoryDocumentState, StoryDocuments } from './markdownDocuments.ts';
import type { CreativeStorage } from './creative.ts';
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

export interface DocumentRead {
  scope: 'public' | 'container' | 'local';
  name: string;
  versionId: string;
  readAt: number;
}

export interface StoryAttachment {
  fileName: string;
  base64: string;
}

export type TurnProposalStatus = 'pending' | 'applied' | 'dismissed' | 'reverted' | 'needs_review';

export type TurnProposalTarget =
  | 'setting'
  | 'memory'
  | 'note'
  | 'character'
  | 'draft'
  | 'manuscript'
  | 'container'
  | 'public'
  | 'local';

export type TurnProposalOp = 'patch' | 'append' | 'section' | 'full';

export interface TurnProposalRecord {
  id: string;
  target: TurnProposalTarget;
  op: TurnProposalOp;
  summary: string;
  status: TurnProposalStatus;
  body: string;
  heading?: string;
  name?: string;
  baseVersionId?: string;
  appliedVersionId?: string;
  previousVersionId?: string;
  raw?: string;
  reason?: string;
  createdAt?: number;
  updatedAt?: number;
}

export type OfficialDeepSeekModel = 'deepseek-flash' | 'deepseek-v4-pro';

export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

export interface GenerationPreference {
  model?: OfficialDeepSeekModel;
  reasoningEffort?: ReasoningEffort;
}

export interface DeepSeekThinkingParam {
  type: 'enabled' | 'disabled';
}

export interface TurnNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  turnSummary?: string;
  reasoningContent?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  diagnostics?: NodeDiagnostics;
  createdAt: number;
  summarySnapshot: PlotSummarySnapshot;
  documents?: StoryDocumentState;
  documentReads?: DocumentRead[];
  attachmentIds?: string[];
  proposals?: TurnProposalRecord[];
}

export interface Story {
  id: string;
  title: string;
  sourceKind?: StorySourceKind;
  sourceSessionId?: string;
  v2Migrated?: boolean;
  generationPreference?: GenerationPreference;
  documents?: StoryDocuments;
  importCandidate?: string;
  attachments?: Record<string, StoryAttachment>;
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
  usage?: LlmUsage;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  completionTokensDetails?: {
    reasoningTokens?: number;
  };
}

export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface LlmStreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  reasoningEffort?: ReasoningEffort;
  thinking?: DeepSeekThinkingParam;
  reasoning_effort?: ReasoningEffort;
  includeUsage?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignalLike;
}

export interface LlmTransport {
  streamChat(req: LlmStreamRequest): AsyncIterable<LlmStreamDelta>;
  recordMarkdownProposal?(status: MarkdownProposalStatus | 'incomplete'): void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ActiveStorySelection =
  | { status: 'missing' }
  | { status: 'present'; id: string | null };

export interface StoryStorage {
  listStories(): Promise<Story[]>;
  getStory(id: string): Promise<Story | null>;
  saveStory(story: Story, expectedUpdatedAt?: number): Promise<void>;
  deleteStory(id: string): Promise<void>;
  getActiveStorySelection(): Promise<ActiveStorySelection>;
  setActiveStoryId(id: string | null): Promise<void>;
  compareAndSetActiveStoryId(expected: string | null, next: string | null): Promise<boolean>;
}

export interface StoryBackupEnvelope {
  schemaVersion: 1 | 2;
  exportedAt: number;
  story: Story;
}

export interface ModelConfig {
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
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
  exportMarkdown?(fileName: string, markdown: string): Promise<void>;
  exportAttachment?(fileName: string, base64: string): Promise<void>;
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
  creativeStorage?: CreativeStorage;
}

export interface TurnCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
  signal?: AbortSignalLike;
}

export interface TurnExecutionResult {
  userNode: TurnNode;
  assistantNode: TurnNode;
  proposal?: MarkdownProposal;
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
