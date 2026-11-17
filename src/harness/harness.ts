import { createDefaultId } from './id.ts';
import { DEFAULT_STORY_TITLE } from './scriptParser.ts';
import {
  buildBlueprintExtractionMessages,
  createDefaultBlueprint,
  parseBlueprintResponse,
} from './blueprint.ts';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  assembleThreeZoneContext,
  buildFallbackSummary,
  buildSummaryCompressionMessages,
  getActiveBranchNodes,
  getUncoveredNodes,
  selectNodesToSummarize,
  type ContextBudgetConfig,
} from './context.ts';
import type {
  AbortSignalLike,
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
    const abortError = new Error('Operation aborted.');
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
      for await (const delta of deps.transport.streamChat({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: buildSummaryCompressionMessages(parentSnapshot.content, toSummarize),
        signal,
      })) {
        if (signal?.aborted) break;
        if (delta.contentDelta) {
          compressed += delta.contentDelta;
        }
      }
    } catch {
      compressed = '';
    }

    const finalContent = compressed.trim() || buildFallbackSummary(parentSnapshot.content, toSummarize);
    return {
      content: finalContent,
      coveredUpToNodeId: toSummarize[toSummarize.length - 1].id,
      summarizedTurnCount: parentSnapshot.summarizedTurnCount + toSummarize.length,
    };
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

      throwIfAborted(signal);
      let rawResponse = '';

      try {
        for await (const delta of deps.transport.streamChat({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages: buildBlueprintExtractionMessages(trimmed),
          signal,
        })) {
          throwIfAborted(signal);
          if (delta.contentDelta) {
            rawResponse += delta.contentDelta;
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          throw err;
        }
        return createDefaultBlueprint(fallbackTitle);
      }

      return parseBlueprintResponse(rawResponse, fallbackTitle);
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
      const initialAssistantNode: TurnNode = {
        id: createId(),
        parentId: userNode.id,
        role: 'assistant',
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        createdAt: assistantCreatedAt,
        summarySnapshot: parentSnapshot,
      };

      const provisionalStory: Story = {
        ...story,
        nodes: {
          ...story.nodes,
          [userNode.id]: userNode,
          [initialAssistantNode.id]: initialAssistantNode,
        },
        rootNodeIds: parentId === null ? [...story.rootNodeIds, userNode.id] : story.rootNodeIds,
        activeLeafNodeId: initialAssistantNode.id,
        updatedAt: assistantCreatedAt,
      };

      const updatedSnapshot = await summarizeOverflowTurns(
        provisionalStory,
        parentSnapshot,
        config,
        callbacks?.signal,
      );

      const finalAssistantNode: TurnNode =
        updatedSnapshot === parentSnapshot
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
        userNode,
        assistantNode: finalAssistantNode,
        story: updatedStory,
      };
    },
  };
}
