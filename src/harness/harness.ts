import { createDefaultId } from './id.ts';
import {
  documentProgress, documentVersion, editStoryDocument, migrateStoryDocuments, referenceDocument,
  replaceDocumentProgress, splitMarkdownReply, storyDocumentState, syncConfirmedBlueprintMarkdown,
  visibleReplyPrefix, writeDocument,
  type MarkdownDocument, type StoryDocuments, type StoryDocumentState,
} from './markdownDocuments.ts';
import { DEFAULT_STORY_TITLE } from './scriptParser.ts';
import {
  buildBlueprintExtractionMessages,
  createDefaultBlueprint,
  parseBlueprintResponse,
} from './blueprint.ts';
import { findLeafForBranchNode } from './branches.ts';
import {
  buildBranchGistMessages,
  computeActiveReviewState,
  type ActiveReviewState,
} from './storyTree.ts';
import {
  DEFAULT_CONTEXT_BUDGET,
  EMPTY_SUMMARY_SNAPSHOT,
  assembleThreeZoneContext,
  buildSummaryCompressionMessages,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getEffectiveNodeContent,
  getSetupNodeFilter,
  getUncoveredNodes,
  selectNodesToSummarize,
  type ContextBudgetConfig,
  type SetupNodeFilter,
  type ThreeZoneContextResult,
} from './context.ts';
import type {
  AbortSignalLike,
  DocumentRead,
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
  loadPublicDocument?: () => Promise<MarkdownDocument | undefined>;
  now?: () => number;
  createId?: () => string;
}

export interface CreateStoryInput {
  title: string;
  sourceKind?: Story['sourceKind'];
  rawScript?: string;
  blueprint?: StoryBlueprint;
}

/**
 * Returns true when an error represents an aborted async request.
 */
export function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError');
}

function throwIfAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted) {
    const abortError = new Error('操作已中止。');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

export interface FictionHarness {
  readonly transport: LlmTransport;
  createStory(input: CreateStoryInput): Story;
  createAndSaveStory(input: CreateStoryInput): Promise<Story>;
  saveStory(story: Story, expectedUpdatedAt?: number): Promise<Story>;
  listStories(): Promise<Story[]>;
  loadActiveStory(): Promise<Story | null>;
  setActiveStory(id: string | null): Promise<Story | null>;
  renameStory(id: string, title: string): Promise<Story | null>;
  calculateBranchRename(story: Story, branchEntryNodeId: string, name: string): Story;
  renameBranch(story: Story, branchEntryNodeId: string, name: string): Promise<Story>;
  extractBranchGist(
    story: Story,
    branchEntryNodeId: string,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<Story>;
  ensureActiveBranchSummary(
    story: Story,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<Story>;
  calculateActiveBranchSummary(
    story: Story,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<Story>;
  getReviewState(story: Story): ActiveReviewState;
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

function takeSummaryBatch(
  toSummarize: TurnNode[],
  maxNodes: number,
  maxChars: number,
  filter?: SetupNodeFilter,
): TurnNode[] {
  let end = 0;
  let batchChars = 0;
  for (const node of toSummarize) {
    if (end >= maxNodes) break;
    const nodeChars = getEffectiveNodeContent(node, filter).length;
    if (batchChars + nodeChars > maxChars) {
      if (end === 0) return [node];
      break;
    }
    batchChars += nodeChars;
    end += 1;
  }
  if (end === 0) return [];
  if (end < toSummarize.length && end > 1 && toSummarize[end - 1]?.role === 'user') {
    end -= 1;
  }
  return toSummarize.slice(0, end);
}

function splitSummaryText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk && chunk.length + character.length > maxChars) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
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
      ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
      rawScript: input.rawScript ?? '',
      blueprint: input.blueprint ?? createDefaultBlueprint(title),
      nodes: {},
      rootNodeIds: [],
      activeLeafNodeId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  };

  const persistStory = async (story: Story, activate = false, expectedUpdatedAt?: number): Promise<Story> => {
    story = migrateStoryDocuments(story);
    if (deps.storage) {
      await deps.storage.saveStory(story, expectedUpdatedAt);
      if (activate) {
        await deps.storage.setActiveStoryId(story.id);
      }
    }
    return story;
  };

  const calculateBranchRename = (
    story: Story,
    branchEntryNodeId: string,
    name: string,
  ): Story => {
    if (!story.nodes[branchEntryNodeId]) {
      throw new Error(`目标分支节点 ${branchEntryNodeId} 不存在。`);
    }
    const trimmed = name.trim();
    const nextNames = { ...(story.branchNames ?? {}) };
    if (trimmed) {
      nextNames[branchEntryNodeId] = trimmed;
    } else {
      delete nextNames[branchEntryNodeId];
    }
    return {
      ...story,
      branchNames: Object.keys(nextNames).length > 0 ? nextNames : undefined,
      updatedAt: now(),
    };
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
    markdownReply = false,
  ): Promise<{ content: string; reasoningContent: string; finishReason?: string | null }> => {
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null | undefined;
    let shownChars = 0;

    throwIfAborted(callbacks?.signal);
    for await (const delta of deps.transport.streamChat({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      signal: callbacks?.signal,
    })) {
      throwIfAborted(callbacks?.signal);
      if (delta.finishReason != null) finishReason = delta.finishReason;
      if (delta.reasoningDelta) {
        reasoningContent += delta.reasoningDelta;
        callbacks?.onReasoningDelta?.(delta.reasoningDelta);
      }
      if (delta.contentDelta) {
        content += delta.contentDelta;
        const visible = markdownReply ? visibleReplyPrefix(content) : content;
        if (visible.length > shownChars) callbacks?.onContentDelta?.(visible.slice(shownChars));
        shownChars = visible.length;
      }
    }
    throwIfAborted(callbacks?.signal);
    return { content, reasoningContent, finishReason };
  };

  const summarizeOverflowTurns = async (
    story: Story,
    targetLeafId: string | null,
    parentSnapshot: PlotSummarySnapshot,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<PlotSummarySnapshot> => {
    if (!targetLeafId) return parentSnapshot;
    const branchNodes = getActiveBranchNodes(story, targetLeafId);
    const setupFilter = getSetupNodeFilter(story, targetLeafId);
    let currentSnapshot = parentSnapshot;

    while (true) {
      const uncovered = getUncoveredNodes(branchNodes, currentSnapshot.coveredUpToNodeId);
      const toSummarize = selectNodesToSummarize(uncovered, deps.contextBudget, setupFilter);
      if (toSummarize.length === 0) {
        return currentSnapshot;
      }
      const maxBatchNodes = Math.max(
        1,
        Math.floor(
          deps.contextBudget?.summaryBatchMaxNodes ??
            DEFAULT_CONTEXT_BUDGET.summaryBatchMaxNodes,
        ),
      );
      const maxBatchChars = Math.max(
        1,
        Math.floor(
          deps.contextBudget?.summaryBatchMaxChars ??
            DEFAULT_CONTEXT_BUDGET.summaryBatchMaxChars,
        ),
      );
      const batch = takeSummaryBatch(
        toSummarize,
        maxBatchNodes,
        maxBatchChars,
        setupFilter,
      );
      if (batch.length === 0) {
        return currentSnapshot;
      }

      const summarizeBatch = async (
        previousContent: string,
        nodes: TurnNode[],
        filter?: SetupNodeFilter,
      ): Promise<string | null> => {
        try {
          const result = await streamText(
            config,
            buildSummaryCompressionMessages(previousContent, nodes, filter, maxBatchChars),
            { signal },
          );
          return result.finishReason === 'stop' ? result.content.trim() || null : null;
        } catch (err) {
          if (isAbortError(err)) throw err;
          return null;
        }
      };

      const oversizedNode = batch.length === 1 ? batch[0] : undefined;
      const oversizedContent = oversizedNode
        ? getEffectiveNodeContent(oversizedNode, setupFilter)
        : '';
      if (oversizedNode && oversizedContent.length > maxBatchChars) {
        let rollingContent = currentSnapshot.content;
        for (const chunk of splitSummaryText(oversizedContent, maxBatchChars)) {
          const next = await summarizeBatch(
            rollingContent,
            [{ ...oversizedNode, content: chunk }],
          );
          if (!next) return currentSnapshot;
          rollingContent = next;
        }
        currentSnapshot = {
          content: rollingContent,
          coveredUpToNodeId: oversizedNode.id,
          summarizedTurnCount: currentSnapshot.summarizedTurnCount + 1,
        };
        continue;
      }

      const finalContent = await summarizeBatch(currentSnapshot.content, batch, setupFilter);
      if (!finalContent) return currentSnapshot;
      currentSnapshot = {
        content: finalContent,
        coveredUpToNodeId: batch[batch.length - 1].id,
        summarizedTurnCount: currentSnapshot.summarizedTurnCount + batch.length,
      };
    }
  };

  const prepareTurn = async (
    story: Story,
    parentId: string | null,
    config: ModelConfig,
    signal?: AbortSignalLike,
    applyEdit = parentId === story.activeLeafNodeId,
  ) => {
    const globalDocument = await deps.loadPublicDocument?.();
    const publicVersion = globalDocument ? documentVersion(globalDocument) : undefined;
    const saved = await deps.storage?.getStory(story.id);
    if (saved && saved.updatedAt !== story.updatedAt) throw new Error('故事已在其他位置变化，请重新打开后继续。');
    const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
    const state = storyDocumentState(scoped, parentId, applyEdit);
    const original = parentId ? scoped.nodes[parentId].summarySnapshot : EMPTY_SUMMARY_SNAPSHOT;
    const base = documentVersion(scoped.documents.local, state.local);
    const progress = documentProgress(base.markdown);
    const previous = progress ? { ...original, content: progress } : EMPTY_SUMMARY_SNAPSHOT;
    const snapshot = await summarizeOverflowTurns(scoped, parentId, previous, config, signal);
    const local = snapshot.content === progress ? { ...scoped.documents.local, head: base.id } :
      writeDocument(scoped.documents.local, base.id, replaceDocumentProgress(base.markdown, snapshot.content), 'automatic');
    const container = documentVersion(scoped.documents.container, state.container);
    const reads: DocumentRead[] = [
      ...(publicVersion ? [referenceDocument('public', '公共记忆', publicVersion)] : []),
      referenceDocument('container', scoped.title, container),
      referenceDocument('local', '当前路径', documentVersion(local)),
    ];
    const edits = { ...scoped.documents.edits };
    const containerEdits = { ...scoped.documents.containerEdits };
    if (applyEdit) {
      delete edits[parentId ?? ''];
      delete containerEdits[parentId ?? ''];
    }
    return {
      story: { ...scoped, documents: { ...scoped.documents, local: { ...local, head: scoped.documents.local.head }, edits, containerEdits } },
      state: { container: state.container, local: local.head },
      snapshot,
      expectedUpdatedAt: saved?.updatedAt,
      reads,
      request: { publicVersion, container, local: documentVersion(local), snapshot },
    };
  };

  const calculateActiveBranchSummary = async (
    story: Story,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ): Promise<Story> => {
    const leafId = story.activeLeafNodeId;
    if (!leafId) return story;
    const leaf = story.nodes[leafId];
    if (!leaf) return story;

    const updatedSnapshot = await summarizeOverflowTurns(
      story,
      leafId,
      getActiveSummarySnapshot(story, leafId),
      config,
      signal,
    );
    if (updatedSnapshot.content === getActiveSummarySnapshot(story, leafId).content &&
      updatedSnapshot.coveredUpToNodeId === leaf.summarySnapshot.coveredUpToNodeId) {
      return story;
    }

    const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
    const state = storyDocumentState(scoped, leafId, true);
    if (scoped.documents.edits[leafId]) return story;
    const revise = writeDocument(scoped.documents.local, state.local,
      replaceDocumentProgress(documentVersion(scoped.documents.local, state.local).markdown, updatedSnapshot.content), 'automatic');
    return {
      ...scoped,
      documents: { ...scoped.documents, local: { ...revise, head: scoped.documents.local.head } },
      nodes: {
        ...scoped.nodes,
        [leafId]: { ...scoped.nodes[leafId], documents: { ...state, local: revise.head }, summarySnapshot: updatedSnapshot },
      },
      updatedAt: now(),
    };
  };

  const finalizeAssistantReply = async (opts: {
    baseStory: Story & { documents: StoryDocuments };
    documentState: StoryDocumentState;
    reads: DocumentRead[];
    proposal?: TurnExecutionResult['proposal'];
    expectedUpdatedAt?: number;
    userNode: TurnNode;
    baseSnapshot: PlotSummarySnapshot;
    content: string;
    reasoningContent: string;
    extraNodes: Record<string, TurnNode>;
    rootNodeIds: string[];
    config: ModelConfig;
    signal?: AbortSignalLike;
  }): Promise<TurnExecutionResult> => {
    const assistantCreatedAt = Math.max(now(), opts.baseStory.updatedAt + 1);
    const initialAssistantNode: TurnNode = {
      id: createId(),
      parentId: opts.userNode.id,
      role: 'assistant',
      content: opts.content,
      ...(opts.reasoningContent ? { reasoningContent: opts.reasoningContent } : {}),
      createdAt: assistantCreatedAt,
      summarySnapshot: opts.baseSnapshot,
      documents: opts.documentState,
      documentReads: opts.reads,
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

    const updatedSnapshot = opts.proposal?.target === 'local'
      ? opts.baseSnapshot
      : await summarizeOverflowTurns(
        provisionalStory,
        provisionalStory.activeLeafNodeId,
        opts.baseSnapshot,
        opts.config,
        opts.signal,
      );

    const documents = opts.baseStory.documents;
    const before = documentVersion(documents.local, opts.documentState.local);
    const revised = updatedSnapshot === opts.baseSnapshot ? documents.local : writeDocument(
      documents.local, before.id, replaceDocumentProgress(before.markdown, updatedSnapshot.content), 'automatic',
    );
    const finalAssistantNode: TurnNode = updatedSnapshot === opts.baseSnapshot ? initialAssistantNode : {
      ...initialAssistantNode, summarySnapshot: updatedSnapshot,
      documents: { ...opts.documentState, local: revised.head },
    };

    const updatedStory: Story =
      finalAssistantNode === initialAssistantNode
        ? provisionalStory
        : {
            ...provisionalStory,
            documents: { ...documents, local: { ...revised, head: documents.local.head } },
            nodes: {
              ...provisionalStory.nodes,
              [finalAssistantNode.id]: finalAssistantNode,
            },
          };

    throwIfAborted(opts.signal);
    await persistStory(updatedStory, true, opts.expectedUpdatedAt);

    return {
      userNode: opts.userNode,
      assistantNode: finalAssistantNode,
      story: updatedStory,
      ...(opts.proposal ? { proposal: opts.proposal } : {}),
    };
  };

  const executeTurnFromParent = async (
    story: Story,
    parentId: string | null,
    trimmedInput: string,
    config: ModelConfig,
    callbacks?: TurnCallbacks,
  ): Promise<TurnExecutionResult> => {
    const prepared = await prepareTurn(story, parentId, config, callbacks?.signal);
    const { story: workingStory, snapshot: parentSnapshot } = prepared;

    const { messages } = assembleThreeZoneContext(
      workingStory,
      parentId,
      trimmedInput,
      deps.contextBudget,
      true,
      prepared.request,
    );

    const result = await streamText(config, messages, callbacks, true);
    const { content, proposal, proposalStatus } = splitMarkdownReply(result.content);
    deps.transport.recordMarkdownProposal?.(result.finishReason === 'stop' ? proposalStatus : 'incomplete');
    if (!content.trim() && !proposal) throw new Error('模型没有返回可用内容，请重试。');

    const userNode: TurnNode = {
      id: createId(),
      parentId,
      role: 'user',
      content: trimmedInput,
      createdAt: now(),
      summarySnapshot: parentSnapshot,
      documents: prepared.state,
    };

    return finalizeAssistantReply({
      baseStory: workingStory,
      userNode,
      baseSnapshot: parentSnapshot,
      content: content || '请核对拟保存的资料。',
      reasoningContent: result.reasoningContent,
      documentState: prepared.state,
      reads: prepared.reads,
      proposal: result.finishReason === 'stop' ? proposal : undefined,
      expectedUpdatedAt: prepared.expectedUpdatedAt,
      extraNodes: { [userNode.id]: userNode },
      rootNodeIds:
        parentId === null ? [...workingStory.rootNodeIds, userNode.id] : workingStory.rootNodeIds,
      config,
      signal: callbacks?.signal,
    });
  };

  return {
    transport: deps.transport,
    createStory: createStoryRecord,

    async createAndSaveStory(input: CreateStoryInput): Promise<Story> {
      const story = createStoryRecord(input);
      return persistStory(story, true);
    },

    async saveStory(story: Story, expectedUpdatedAt?: number): Promise<Story> {
      return persistStory(story, false, expectedUpdatedAt);
    },

    async listStories(): Promise<Story[]> {
      if (!deps.storage) return [];
      return (await deps.storage.listStories()).map(migrateStoryDocuments);
    },

    async loadActiveStory(): Promise<Story | null> {
      if (!deps.storage) return null;
      const activeId = await deps.storage.getActiveStoryId();
      if (activeId) {
        const found = await deps.storage.getStory(activeId);
        if (found) return migrateStoryDocuments(found);
      }
      const all = await deps.storage.listStories();
      return all[0] ? migrateStoryDocuments(all[0]) : null;
    },

    async setActiveStory(id: string | null): Promise<Story | null> {
      if (!deps.storage) return null;
      await deps.storage.setActiveStoryId(id);
      const selected = id ? await deps.storage.getStory(id) : null;
      return selected ? migrateStoryDocuments(selected) : null;
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
        updatedAt: Math.max(now(), existing.updatedAt + 1),
      };
      await deps.storage.saveStory(updated, existing.updatedAt);
      return updated;
    },

    calculateBranchRename,

    async renameBranch(story: Story, branchEntryNodeId: string, name: string): Promise<Story> {
      return persistStory(calculateBranchRename(story, branchEntryNodeId, name), false);
    },

    async extractBranchGist(
      story: Story,
      branchEntryNodeId: string,
      config: ModelConfig,
      signal?: AbortSignalLike,
    ): Promise<Story> {
      if (!story.nodes[branchEntryNodeId]) {
        throw new Error(`目标分支节点 ${branchEntryNodeId} 不存在。`);
      }
      const { content } = await streamText(
        config,
        buildBranchGistMessages(story, branchEntryNodeId),
        { signal },
      );
      const gist = content.replace(/\s+/g, ' ').trim();
      if (!gist) {
        return story;
      }
      const updated: Story = {
        ...story,
        branchSummaries: {
          ...(story.branchSummaries ?? {}),
          [branchEntryNodeId]: gist,
        },
        updatedAt: now(),
      };
      return persistStory(updated, false);
    },

    async ensureActiveBranchSummary(
      story: Story,
      config: ModelConfig,
      signal?: AbortSignalLike,
    ): Promise<Story> {
      const summarized = await calculateActiveBranchSummary(story, config, signal);
      return summarized === story ? story : persistStory(summarized, true);
    },

    async calculateActiveBranchSummary(
      story: Story,
      config: ModelConfig,
      signal?: AbortSignalLike,
    ): Promise<Story> {
      return calculateActiveBranchSummary(story, config, signal);
    },

    getReviewState(story: Story): ActiveReviewState {
      return computeActiveReviewState(story, deps.contextBudget);
    },

    async updateStoryBlueprint(story: Story, blueprint: StoryBlueprint): Promise<Story> {
      const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
      const currentVersion = storyDocumentState(scoped, scoped.activeLeafNodeId, true).container;
      const base = documentVersion(scoped.documents.container, currentVersion);
      const markdown = syncConfirmedBlueprintMarkdown(base.markdown, scoped.blueprint, blueprint);
      const withUpdatedDocument = editStoryDocument(scoped, 'container', base.id, markdown);
      const updated: Story = {
        ...withUpdatedDocument, blueprint,
        updatedAt: Math.max(now(), scoped.updatedAt + 1),
      };
      return persistStory(updated, false, scoped.updatedAt);
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

      const { content } = await streamText(
        config,
        buildBlueprintExtractionMessages(trimmed),
        { signal },
      );
      return parseBlueprintResponse(content, fallbackTitle);
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

      const prepared = await prepareTurn(
        story,
        userNode.parentId,
        config,
        callbacks?.signal,
        false,
      );
      const { story: workingStory, snapshot: parentSnapshot } = prepared;
      const { messages } = assembleThreeZoneContext(
        workingStory,
        userNode.parentId,
        userNode.content,
        deps.contextBudget,
        true,
        prepared.request,
      );
      const result = await streamText(config, messages, callbacks, true);
      const { content, proposal, proposalStatus } = splitMarkdownReply(result.content);
      deps.transport.recordMarkdownProposal?.(result.finishReason === 'stop' ? proposalStatus : 'incomplete');
      if (!content.trim() && !proposal) throw new Error('模型没有返回可用内容，请重试。');

      return finalizeAssistantReply({
        baseStory: workingStory,
        userNode,
        baseSnapshot: parentSnapshot,
        content: content || '请核对拟保存的资料。',
        reasoningContent: result.reasoningContent,
        documentState: prepared.state,
        reads: prepared.reads,
        proposal: result.finishReason === 'stop' ? proposal : undefined,
        expectedUpdatedAt: prepared.expectedUpdatedAt,
        extraNodes: {},
        rootNodeIds: workingStory.rootNodeIds,
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
