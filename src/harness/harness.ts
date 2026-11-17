import type {
  LlmMessage,
  LlmTransport,
  ModelConfig,
  PlotSummarySnapshot,
  Story,
  StoryBlueprint,
  TurnCallbacks,
  TurnExecutionResult,
  TurnNode,
} from './types.ts';

export interface FictionHarnessDeps {
  transport: LlmTransport;
  now?: () => number;
  createId?: () => string;
}

export interface CreateStoryInput {
  title: string;
  rawScript?: string;
  blueprint?: StoryBlueprint;
}

const EMPTY_SUMMARY: PlotSummarySnapshot = {
  content: '',
  coveredUpToNodeId: null,
  summarizedTurnCount: 0,
};

function defaultCreateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultBlueprint(title: string): StoryBlueprint {
  return {
    title,
    worldRules: [],
    protagonist: '',
    npcs: [],
    taboos: [],
    openingHook: '',
    extractionStatus: 'partial_fallback',
  };
}

/**
 * Walks from the target leaf node back to the root to reconstruct the linear active branch.
 */
export function getActiveBranchNodes(story: Story, leafId: string | null = story.activeLeafNodeId): TurnNode[] {
  const path: TurnNode[] = [];
  const visited = new Set<string>();
  let cursor = leafId;

  while (cursor) {
    if (visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    const node = story.nodes[cursor];
    if (!node) {
      break;
    }
    path.push(node);
    cursor = node.parentId;
  }

  return path.reverse();
}

function buildSystemAnchorPrompt(story: Story): string {
  const sections: string[] = [
    '你正在运行一个本地优先交互式文游播放器，请严格遵循以下剧本设定与交互原则：',
    '- 始终保持角色一致性与设定约束，不要替玩家代操抉择。',
  ];

  if (story.rawScript.trim()) {
    sections.push(`## 原始剧本全文（最高权威锚定）\n${story.rawScript.trim()}`);
  }

  return sections.join('\n\n');
}

export interface FictionHarness {
  createStory(input: CreateStoryInput): Story;
  runTurn(
    story: Story,
    userInput: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult>;
}

/**
 * Pure TypeScript Fiction Harness core engine with zero DOM or Node runtime dependencies.
 */
export function createFictionHarness(deps: FictionHarnessDeps): FictionHarness {
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId ?? defaultCreateId;

  return {
    createStory(input: CreateStoryInput): Story {
      const timestamp = now();
      const title = input.title.trim() || '未命名故事';
      return {
        id: createId(),
        title,
        rawScript: input.rawScript ?? '',
        blueprint: input.blueprint ?? createDefaultBlueprint(title),
        nodes: {},
        rootNodeIds: [],
        activeLeafNodeId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },

    async runTurn(
      story: Story,
      userInput: string,
      config: ModelConfig,
      callbacks?: TurnCallbacks,
    ): Promise<TurnExecutionResult> {
      const trimmedInput = userInput.trim();
      if (!trimmedInput) {
        throw new Error('Player input cannot be empty.');
      }

      const parentId = story.activeLeafNodeId;
      const parentSnapshot = parentId && story.nodes[parentId]
        ? story.nodes[parentId].summarySnapshot
        : EMPTY_SUMMARY;

      const historyNodes = getActiveBranchNodes(story, parentId);
      const messages: LlmMessage[] = [
        { role: 'system', content: buildSystemAnchorPrompt(story) },
        ...historyNodes.map((node) => ({
          role: node.role,
          content: node.content,
        })),
        { role: 'user', content: trimmedInput },
      ];

      let content = '';
      let reasoningContent = '';

      const throwIfAborted = () => {
        if (callbacks?.signal?.aborted) {
          const abortError = new Error('Turn generation aborted.');
          abortError.name = 'AbortError';
          throw abortError;
        }
      };

      throwIfAborted();

      for await (const delta of deps.transport.streamChat({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        signal: callbacks?.signal,
      })) {
        throwIfAborted();
        if (delta.reasoningDelta) {
          reasoningContent += delta.reasoningDelta;
          callbacks?.onReasoningDelta?.(delta.reasoningDelta);
        }
        if (delta.contentDelta) {
          content += delta.contentDelta;
          callbacks?.onContentDelta?.(delta.contentDelta);
        }
      }

      throwIfAborted();

      const userCreatedAt = now();
      const userNode: TurnNode = {
        id: createId(),
        parentId,
        role: 'user',
        content: trimmedInput,
        createdAt: userCreatedAt,
        summarySnapshot: parentSnapshot,
      };

      const assistantCreatedAt = now();
      const assistantNode: TurnNode = {
        id: createId(),
        parentId: userNode.id,
        role: 'assistant',
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        createdAt: assistantCreatedAt,
        summarySnapshot: parentSnapshot,
      };

      const updatedStory: Story = {
        ...story,
        nodes: {
          ...story.nodes,
          [userNode.id]: userNode,
          [assistantNode.id]: assistantNode,
        },
        rootNodeIds: parentId === null ? [...story.rootNodeIds, userNode.id] : story.rootNodeIds,
        activeLeafNodeId: assistantNode.id,
        updatedAt: assistantCreatedAt,
      };

      return {
        userNode,
        assistantNode,
        story: updatedStory,
      };
    },
  };
}
