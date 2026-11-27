import type { MarkdownProposal, MarkdownProposalStatus, StoryDocumentState, StoryDocuments } from './markdownDocuments.ts';
import type { CreativeStorage } from './creative.ts';
import type { DiagnosticCollector } from './diagnostics.ts';
import type {
  PublicResearchFailure,
  PublicResearchProvider,
  PublicResearchReference,
} from './publicResearch.ts';

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

export type NodeDiagnosticStatus = 'CONTENT_FILTER' | 'TIMEOUT' | 'INCOMPLETE' | 'REFUSAL';

export type StorySourceKind = 'manual_script' | 'deepseek_import';

export type RefusalRouteDiagnostic =
  | 'pass'
  | 'retry'
  | 'retry-skeleton'
  | 'partial_refused'
  | 'refused_exhausted';

export interface NodeDiagnostics {
  readonly sourceStatus?: NodeDiagnosticStatus;
  readonly contentRisk?: boolean;
  readonly refusalRoute?: RefusalRouteDiagnostic;
  readonly recoveredFromText?: string;
  readonly retriedWithPrefix?: boolean;
  readonly matchedRuleId?: string;
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
  | 'story'
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

export type ProviderPresetId =
  | 'deepseek'
  | 'openai'
  | 'openrouter'
  | 'siliconflow'
  | 'local'
  | 'custom';

export type ProviderThinkingProtocol = 'deepseek' | 'openai_reasoning_effort';

export type ProviderPrefixProtocol = 'deepseek_beta' | 'standard_assistant_prefill' | 'none';

export interface ProviderCapabilities {
  thinkingProtocol: ProviderThinkingProtocol;
  prefixProtocol: ProviderPrefixProtocol;
  supportsBalanceQuery: boolean;
  supportsBuiltinSearch: boolean;
  supportsBuiltinPricing: boolean;
}

export interface CustomModelPricing {
  currency: 'CNY' | 'USD';
  inputPerMillion: number;
  cacheHitInputPerMillion?: number;
  outputPerMillion: number;
}

export interface ProviderModelEntry {
  id: string;
  label?: string;
  pricing?: CustomModelPricing;
}

export interface ProviderProfile {
  id: string;
  name: string;
  presetId: ProviderPresetId;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelEntry[];
  defaultModel: string;
  backgroundModel?: string;
  defaultPricing?: CustomModelPricing;
  capabilities: ProviderCapabilities;
  prefillProbeStatus?: 'untested' | 'supported' | 'unsupported';
  memoryOnly?: boolean;
}

export type ProviderProfileMeta = Omit<ProviderProfile, 'apiKey'>;

export type PublicResearchSearchPresetId = 'auto' | 'none' | 'deepseek_account' | 'tavily' | 'bocha';

export interface PublicResearchConfig {
  provider: PublicResearchSearchPresetId;
  apiKey?: string;
  deepseekProfileId?: string;
}

export type PublicResearchConfigMeta = Omit<PublicResearchConfig, 'apiKey'>;

export interface ProviderLibrary {
  version: 2;
  activeProviderId: string;
  profiles: ProviderProfile[];
  reasoningEffort?: ReasoningEffort;
  publicResearch?: PublicResearchConfig;
}

export interface ProviderLibraryMeta {
  version: 2;
  activeProviderId: string;
  profiles: ProviderProfileMeta[];
  reasoningEffort?: ReasoningEffort;
  publicResearch?: PublicResearchConfigMeta;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

export type PrefixCompletionMode = 'off' | 'on_retry' | 'always';

export interface GenerationPreference {
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  promptPackMode?: 'inherit' | 'off' | string;
  prefixCompletion?: PrefixCompletionMode;
}

export interface DeepSeekThinkingParam {
  type: 'enabled' | 'disabled';
}

export type UsageProviderKind = 'deepseek-official' | 'custom-priced' | 'other';

export interface TurnUsageTelemetry {
  providerKind: UsageProviderKind;
  model: string;
  generationUsage?: LlmUsage;
  summaryUsage?: LlmUsage;
  uncompressedPromptChars?: number;
  compressedPromptChars?: number;
  retrievedNodeCount?: number;
  pricingSnapshot?: CustomModelPricing;
}

export interface TurnNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  prefillContent?: string;
  turnSummary?: string;
  reasoningContent?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  diagnostics?: NodeDiagnostics;
  telemetry?: TurnUsageTelemetry;
  createdAt: number;
  summarySnapshot: PlotSummarySnapshot;
  documents?: StoryDocumentState;
  documentReads?: DocumentRead[];
  attachmentIds?: string[];
  proposals?: TurnProposalRecord[];
  publicResearch?: PublicResearchReference;
  publicResearchFailure?: PublicResearchFailure;
  publicResearchSettingKey?: string;
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
  prefixCompletion?: {
    content: string;
    reasoningContent?: string;
  };
  reasoningEffort?: ReasoningEffort;
  thinking?: DeepSeekThinkingParam;
  reasoning_effort?: ReasoningEffort;
  capabilities?: ProviderCapabilities;
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
  providerId?: string;
  providerPresetId?: ProviderPresetId;
  backgroundModel?: string;
  capabilities?: ProviderCapabilities;
  pricing?: CustomModelPricing;
  publicResearch?: PublicResearchConfig;
}

export type ModelConfigMeta = Omit<ModelConfig, 'apiKey'> & {
  providerLibrary?: ProviderLibraryMeta;
};

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

export interface AppUpdateReleaseInfo {
  version: string;
  tagName: string;
  title: string;
  notes: string;
  publishedAt?: string;
  releasePageUrl: string;
  apkName: string;
  apkUrl: string;
  expectedSha256?: string;
}

export interface AppUpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface AppUpdateDownloadedApk {
  fileName: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  reusedCache?: boolean;
}

export interface AppUpdater {
  checkLatestRelease(signal?: AbortSignalLike): Promise<AppUpdateReleaseInfo | null>;
  downloadAndVerifyApk(
    release: AppUpdateReleaseInfo,
    onProgress?: (progress: AppUpdateDownloadProgress) => void,
    signal?: AbortSignalLike,
  ): Promise<AppUpdateDownloadedApk>;
  canRequestPackageInstalls(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<void>;
  installDownloadedApk(version: string): Promise<void>;
  cleanupStaleApks(keepVersion?: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  subscribeAppResumed?(listener: () => void): () => void;
}

export interface PlatformRuntime {
  platform: 'web' | 'android';
  diagnostics: DiagnosticCollector;
  promptPackStorage: KeyValueStorage;
  transport: LlmTransport;
  publicResearch?: PublicResearchProvider;
  binaryDownloader: BinaryDownloader;
  storyStorage: StoryStorage;
  secretStore: SecretStore;
  backupExporter: BackupExporter;
  supportsMemoryOnlySession: boolean;
  creativeStorage?: CreativeStorage;
  appUpdater?: AppUpdater;
}

export interface TurnCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
  onRefusalRetry?: () => void;
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

export interface PublicTextFetchResult {
  ok: boolean;
  status: number;
  finalUrl?: string;
  text: string;
  truncated?: boolean;
}

export type PublicTextFetcher = (
  url: string,
  options?: {
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignalLike;
  },
) => Promise<PublicTextFetchResult>;
