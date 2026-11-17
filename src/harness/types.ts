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

export interface TurnNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  createdAt: number;
  summarySnapshot: PlotSummarySnapshot;
}

export interface Story {
  id: string;
  title: string;
  rawScript: string;
  blueprint: StoryBlueprint;
  nodes: Record<string, TurnNode>;
  rootNodeIds: string[];
  activeLeafNodeId: string | null;
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
