import { createDefaultId } from './id.ts';
import { DEFAULT_STORY_TITLE } from './scriptParser.ts';
import {
  buildBlueprintExtractionMessages,
  createDefaultBlueprint,
  parseBlueprintResponse,
} from './blueprint.ts';
import { findLeafForBranchNode } from './branches.ts';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  assembleThreeZoneContext,
  buildFallbackSummary,
  buildSummaryCompressionMessages,
  getActiveBranchNodes,
  getUncoveredNodes,
  selectNodesToSummarize,
  type ContextBudgetConfig,
  type ThreeZoneContextResult,
} from './context.ts';
import type {
  AbortSignalLike,
  LlmMessage,
  LlmTransport,
  ModelConfig,
  PlotSummarySnapshot,
  Story,
  StoryBlueprint,
  StoryStorage,
  TurnCallbacks,
  TurnExecutionResult,
  TurnNode,
} from './types.ts';

export interface FictionHarnessDeps {
  transport: LlmTransport;
  storage?: StoryStorage;
  contextBudget?: Partial<ContextBudgetConfig>;
  now?: () => number;
  createId?: () => string;
}

export interface CreateStoryInput {
  title: string;
  rawScript?: string;
  blueprint?: StoryBlueprint;
}

function throwIfAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted) {
    const abortError = new Error('操作已中止。');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

export interface FictionHarness {
  createStory(input: CreateStoryInput): Story;
  createAndSaveStory(input: CreateStoryInput): Promise<Story>;
  saveStory(story: Story): Promise<Story>;
  listStories(): Promise<Story[]>;
  loadActiveStory(): Promise<Story | null>;
  setActiveStory(id: string | null): Promise<Story | null>;
  renameStory(id: string, title: string): Promise<Story | null>;
  updateStoryBlueprint(story: Story, blueprint: StoryBlueprint): Promise<Story>;
  deleteStory(id: string): Promise<void>;
  assembleContext(
    story: Story,
    targetParentId?: string | null,
    userInput?: string,
  ): ThreeZoneContextResult;
  extractStoryBlueprint(
    rawScript: string,
    config: ModelConfig,
    fallbackTitle?: string,
    signal?: AbortSignalLike,
  ): Promise<StoryBlueprint>;
  runTurn(
    story: Story,
    userInput: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult>;
  editAndBranch(
    story: Story,
    targetUserNodeId: string,
    newInput: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult>;
  regenerateNode(
    story: Story,
    targetAssistantNodeId: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult>;
  switchBranch(story: Story, targetNodeId: string): Promise<Story>;
  rewindToNode(story: Story, targetNodeId: string | null): Promise<Story>;
}

/**
 * Pure TypeScript Fiction Harness core engine with zero DOM or Node runtime dependencies.
 */
export function createFictionHarness(deps: FictionHarnessDeps): FictionHarness {
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId ?? createDefaultId;

  const createStoryRecord = (input: CreateStoryInput): Story => {
    const timestamp = now();
    const title = input.title.trim() || DEFAULT_STORY_TITLE;
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
  };

  const persistStory = async (story: Story, activate = false): Promise<Story> => {
    if (deps.storage) {
      await deps.storage.saveStory(story);
      if (activate) {
        await deps.storage.setActiveStoryId(story.id);
      }
    }
    return story;
  };

  const activateLeafNode = async (story: Story, leafId: string | null): Promise<Story> => {
    const updated: Story = {
      ...story,
      activeLeafNodeId: leafId,
      updatedAt: now(),
    };
    return persistStory(updated, true);
  };

  const streamText = async (
    config: ModelConfig,
    messages: LlmMessage[],
    callbacks?: TurnCallbacks,
  ): Promise<{ content: string; reasoningContent: string }> => {
    let content = '';
    let reasoningContent = '';

    throwIfAborted(callbacks?.signal);
    for await (const delta of deps.transport.streamChat({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      signal: callbacks?.signal,
    })) {
      throwIfAborted(callbacks?.signal);
      if (delta.reasoningDelta) {
        reasoningContent += delta.reasoningDelta;
        callbacks?.onReasoningDelta?.(delta.reasoningDelta);
      }
      if (delta.contentDelta) {
        content += delta.contentDelta;
        callbacks?.onContentDelta?.(delta.contentDelta);
      }
    }
    throwIfAborted(callbacks?.signal);
    return { content, reasoningContent };
  };

  const summarizeOverflowTurns = async (
    story: Story,
    parentSnapshot: PlotSummarySnapshot,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<PlotSummarySnapshot> => {
    const branchNodes = getActiveBranchNodes(story, story.activeLeafNodeId);
    const uncovered = getUncoveredNodes(branchNodes, parentSnapshot.coveredUpToNodeId);
    const toSummarize = selectNodesToSummarize(uncovered, deps.contextBudget);

    if (toSummarize.length === 0) {
      return parentSnapshot;
    }

    let compressed = '';
    try {
      const result = await streamText(
        config,
        buildSummaryCompressionMessages(parentSnapshot.content, toSummarize),
        { signal },
      );
      compressed = result.content;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw err;
      }
      compressed = '';
    }

    const finalContent =
      compressed.trim() || buildFallbackSummary(parentSnapshot.content, toSummarize);
    return {
      content: finalContent,
      coveredUpToNodeId: toSummarize[toSummarize.length - 1].id,
      summarizedTurnCount: parentSnapshot.summarizedTurnCount + toSummarize.length,
    };
  };

  const finalizeAssistantReply = async (opts: {
    baseStory: Story;
    userNode: TurnNode;
    baseSnapshot: PlotSummarySnapshot;
    content: string;
    reasoningContent: string;
    extraNodes: Record<string, TurnNode>;
    rootNodeIds: string[];
    config: ModelConfig;
    signal?: AbortSignalLike;
  }): Promise<TurnExecutionResult> => {
    const assistantCreatedAt = now();
    const initialAssistantNode: TurnNode = {
      id: createId(),
      parentId: opts.userNode.id,
      role: 'assistant',
      content: opts.content,
      ...(opts.reasoningContent ? { reasoningContent: opts.reasoningContent } : {}),
      createdAt: assistantCreatedAt,
      summarySnapshot: opts.baseSnapshot,
    };

    const provisionalStory: Story = {
      ...opts.baseStory,
      nodes: {
        ...opts.baseStory.nodes,
        ...opts.extraNodes,
        [initialAssistantNode.id]: initialAssistantNode,
      },
      rootNodeIds: opts.rootNodeIds,
      activeLeafNodeId: initialAssistantNode.id,
      updatedAt: assistantCreatedAt,
    };

    const updatedSnapshot = await summarizeOverflowTurns(
      provisionalStory,
      opts.baseSnapshot,
      opts.config,
      opts.signal,
    );

    const finalAssistantNode: TurnNode =
      updatedSnapshot === opts.baseSnapshot
        ? initialAssistantNode
        : { ...initialAssistantNode, summarySnapshot: updatedSnapshot };

    const updatedStory: Story =
      finalAssistantNode === initialAssistantNode
        ? provisionalStory
        : {
            ...provisionalStory,
            nodes: {
              ...provisionalStory.nodes,
              [finalAssistantNode.id]: finalAssistantNode,
            },
          };

    await persistStory(updatedStory, true);

    return {
      userNode: opts.userNode,
      assistantNode: finalAssistantNode,
      story: updatedStory,
    };
  };

  const executeTurnFromParent = async (
    story: Story,
    parentId: string | null,
    trimmedInput: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult> => {
    const parentSnapshot =
      parentId && story.nodes[parentId]
        ? story.nodes[parentId].summarySnapshot
        : EMPTY_SUMMARY_SNAPSHOT;

    const { messages } = assembleThreeZoneContext(
      story,
      parentId,
      trimmedInput,
      deps.contextBudget,
    );

    const { content, reasoningContent } = await streamText(config, messages, callbacks);

    const userNode: TurnNode = {
      id: createId(),
      parentId,
      role: 'user',
      content: trimmedInput,
      createdAt: now(),
      summarySnapshot: parentSnapshot,
    };

    return finalizeAssistantReply({
      baseStory: story,
      userNode,
      baseSnapshot: parentSnapshot,
      content,
      reasoningContent,
      extraNodes: { [userNode.id]: userNode },
      rootNodeIds: parentId === null ? [...story.rootNodeIds, userNode.id] : story.rootNodeIds,
      config,
      signal: callbacks?.signal,
    });
  };

  return {
    createStory: createStoryRecord,

    async createAndSaveStory(input: CreateStoryInput): Promise<Story> {
      const story = createStoryRecord(input);
      return persistStory(story, true);
    },

    async saveStory(story: Story): Promise<Story> {
      return persistStory(story, false);
    },

    async listStories(): Promise<Story[]> {
      if (!deps.storage) return [];
      return deps.storage.listStories();
    },

    async loadActiveStory(): Promise<Story | null> {
      if (!deps.storage) return null;
      const activeId = await deps.storage.getActiveStoryId();
      if (activeId) {
        const found = await deps.storage.getStory(activeId);
        if (found) return found;
      }
      const all = await deps.storage.listStories();
      return all[0] ?? null;
    },

    async setActiveStory(id: string | null): Promise<Story | null> {
      if (!deps.storage) return null;
      await deps.storage.setActiveStoryId(id);
      return id ? deps.storage.getStory(id) : null;
    },

    async renameStory(id: string, title: string): Promise<Story | null> {
      if (!deps.storage) return null;
      const existing = await deps.storage.getStory(id);
      if (!existing) return null;
      const trimmedTitle = title.trim() || DEFAULT_STORY_TITLE;
      const updated: Story = {
        ...existing,
        title: trimmedTitle,
        blueprint: { ...existing.blueprint, title: trimmedTitle },
        updatedAt: now(),
      };
      await deps.storage.saveStory(updated);
      return updated;
    },

    async updateStoryBlueprint(story: Story, blueprint: StoryBlueprint): Promise<Story> {
      const trimmedTitle = blueprint.title.trim() || story.title;
      const updated: Story = {
        ...story,
        title: trimmedTitle,
        blueprint: { ...blueprint, title: trimmedTitle },
        updatedAt: now(),
      };
      return persistStory(updated, false);
    },

    async deleteStory(id: string): Promise<void> {
      if (!deps.storage) return;
      await deps.storage.deleteStory(id);
    },

    assembleContext(
      story: Story,
      targetParentId = story.activeLeafNodeId,
      userInput?: string,
    ): ThreeZoneContextResult {
      return assembleThreeZoneContext(story, targetParentId, userInput, deps.contextBudget);
    },

    async extractStoryBlueprint(
      rawScript: string,
      config: ModelConfig,
      fallbackTitle = DEFAULT_STORY_TITLE,
      signal?: AbortSignalLike,
    ): Promise<StoryBlueprint> {
      const trimmed = rawScript.trim();
      if (!trimmed) {
        return createDefaultBlueprint(fallbackTitle);
      }

      try {
        const { content } = await streamText(
          config,
          buildBlueprintExtractionMessages(trimmed),
          { signal },
        );
        return parseBlueprintResponse(content, fallbackTitle);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          throw err;
        }
        return createDefaultBlueprint(fallbackTitle);
      }
    },

    async runTurn(
      story: Story,
      userInput: string,
      config: ModelConfig,
      callbacks?: TurnCallbacks,
    ): Promise<TurnExecutionResult> {
      const trimmedInput = userInput.trim();
      if (!trimmedInput) {
        throw new Error('玩家输入不能为空。');
      }
      return executeTurnFromParent(story, story.activeLeafNodeId, trimmedInput, config, callbacks);
    },

    async editAndBranch(
      story: Story,
      targetUserNodeId: string,
      newInput: string,
      config: ModelConfig,
      callbacks?: TurnCallbacks,
    ): Promise<TurnExecutionResult> {
      const targetNode = story.nodes[targetUserNodeId];
      if (!targetNode || targetNode.role !== 'user') {
        throw new Error('只能从玩家节点发起编辑重发分支。');
      }
      const trimmedInput = newInput.trim();
      if (!trimmedInput) {
        throw new Error('玩家输入不能为空。');
      }
      return executeTurnFromParent(story, targetNode.parentId, trimmedInput, config, callbacks);
    },

    async regenerateNode(
      story: Story,
      targetAssistantNodeId: string,
      config: ModelConfig,
      callbacks?: TurnCallbacks,
    ): Promise<TurnExecutionResult> {
      const targetNode = story.nodes[targetAssistantNodeId];
      if (!targetNode || targetNode.role !== 'assistant' || !targetNode.parentId) {
        throw new Error('只能针对有效的 AI 回复节点重新生成分支。');
      }
      const userNode = story.nodes[targetNode.parentId];
      if (!userNode || userNode.role !== 'user') {
        throw new Error('AI 节点缺少关联的玩家输入父节点。');
      }

      const { messages } = assembleThreeZoneContext(
        story,
        userNode.id,
        undefined,
        deps.contextBudget,
      );
      const { content, reasoningContent } = await streamText(config, messages, callbacks);

      return finalizeAssistantReply({
        baseStory: story,
        userNode,
        baseSnapshot: userNode.summarySnapshot,
        content,
        reasoningContent,
        extraNodes: {},
        rootNodeIds: story.rootNodeIds,
        config,
        signal: callbacks?.signal,
      });
    },

    async switchBranch(story: Story, targetNodeId: string): Promise<Story> {
      const leafId = findLeafForBranchNode(story, targetNodeId);
      if (!leafId) {
        throw new Error(`目标分支节点 ${targetNodeId} 不存在。`);
      }
      return activateLeafNode(story, leafId);
    },

    async rewindToNode(story: Story, targetNodeId: string | null): Promise<Story> {
      if (targetNodeId !== null && !story.nodes[targetNodeId]) {
        throw new Error(`目标回溯节点 ${targetNodeId} 不存在。`);
      }
      return activateLeafNode(story, targetNodeId);
    },
  };
}
