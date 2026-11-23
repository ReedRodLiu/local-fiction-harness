import { createBackgroundModelConfig } from './keyConfig.ts';
import {
  CHANGE_PROMPT,
  documentMessages,
  documentProgress,
  documentVersion,
  legacyStoryMarkdown,
  storyDocumentState,
  type MarkdownVersion,
} from './markdownDocuments.ts';
import {
  buildPromptPackAnchorMessages,
  promptPackTailMessage,
  resolvePromptPackContext,
  type PromptPackContextOptions,
  type PromptPackLibrary,
} from './promptPack.ts';
import type {
  AbortSignalLike,
  GenerationPreference,
  LlmMessage,
  LlmTransport,
  ModelConfig,
  PlotSummarySnapshot,
  Story,
  TurnNode,
} from './types.ts';

const ESTIMATED_TOKENS_PER_CHAR = 0.65;
const MIN_RECENT_NODES_PER_TURN = 2;

export interface ContextBudgetConfig {
  recentMaxNodes: number;
  recentMaxChars: number;
  summaryBatchMaxNodes: number;
  summaryBatchMaxChars: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  recentMaxNodes: 8,
  recentMaxChars: 6000,
  summaryBatchMaxNodes: 16,
  summaryBatchMaxChars: 10000,
};

export interface ThreeZoneMetrics {
  anchorChars: number;
  summaryChars: number;
  recentChars: number;
  recentNodeCount: number;
  totalEstimatedTokens: number;
}

export interface ThreeZoneContextResult {
  messages: LlmMessage[];
  metrics: ThreeZoneMetrics;
}

export const EMPTY_SUMMARY_SNAPSHOT: PlotSummarySnapshot = {
  content: '',
  coveredUpToNodeId: null,
  summarizedTurnCount: 0,
};

export function estimateTokensFromChars(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.ceil(charCount * ESTIMATED_TOKENS_PER_CHAR);
}

/**
 * Walks from the target leaf node back to the root to reconstruct the linear active branch.
 */
export function getActiveBranchNodes(
  story: Pick<Story, 'nodes' | 'activeLeafNodeId'>,
  leafId: string | null = story.activeLeafNodeId,
): TurnNode[] {
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

export function getActiveSummarySnapshot(
  story: Story,
  leafId: string | null = story.activeLeafNodeId,
): PlotSummarySnapshot {
  if (!leafId) return EMPTY_SUMMARY_SNAPSHOT;
  const node = story.nodes[leafId];
  if (!node) return EMPTY_SUMMARY_SNAPSHOT;
  if (!story.documents) return node.summarySnapshot;
  const scoped = { ...story, documents: story.documents };
  const state = storyDocumentState(scoped, leafId, leafId === story.activeLeafNodeId);
  const content = documentProgress(documentVersion(story.documents.local, state.local).markdown);
  return content ? { ...node.summarySnapshot, content } : EMPTY_SUMMARY_SNAPSHOT;
}

export function getUncoveredNodes(
  branchNodes: TurnNode[],
  coveredUpToNodeId: string | null,
): TurnNode[] {
  if (!coveredUpToNodeId) {
    return branchNodes;
  }
  const idx = branchNodes.findIndex((n) => n.id === coveredUpToNodeId);
  if (idx === -1) {
    return branchNodes;
  }
  return branchNodes.slice(idx + 1);
}

const DEFAULT_STORY_SYSTEM_PROMPT = [
  '你是文游的叙事者，也是在场的世界与众人。保持角色与设定一致，用具体场景、感官细节、动作与对话推进剧情，而非跳出戏外做总结或解说。',
  '禁止跳出叙事分析局势、评价玩家选择、写主题升华式结语、代写或劫持玩家的行动与内心决定，也不要在正文中用“1/2/3”列举下一步菜单。',
  '如需提供可点选行动，把选项单独写在 lfh-choices 围栏内，每行一项，正文里不再重复罗列。普通剧情内的信件、清单等正文列表照常写。',
  '每轮回复末尾必须附带一个单行 lfh-summary 元数据围栏，用 15–25 个中文字的纯文本概括本轮剧情推进（不要使用任何 Markdown 标记）：\n```lfh-summary\n一句15至25字的纯文本本轮剧情摘要\n```',
  '若「我的记忆」或「当前设定」中明确指定了文风、人称、格式或叙事偏好，以用户设定为准。',
].join('\n');

export function buildSystemAnchorPrompt(
  story: Story,
  nodeId = story.activeLeafNodeId,
  selected?: MarkdownVersion,
  promptPack?: PromptPackContextOptions,
  includeSetting = true,
): string {
  const markdown = selected?.markdown ?? (story.documents
    ? documentVersion(story.documents.container, storyDocumentState({ ...story, documents: story.documents }, nodeId,
      nodeId === story.activeLeafNodeId).container).markdown
    : legacyStoryMarkdown(story));
  const basePrompt = [
    DEFAULT_STORY_SYSTEM_PROMPT,
    CHANGE_PROMPT,
  ].join('\n\n');
  if (!includeSetting) return basePrompt;
  return [basePrompt, markdown && `以下是当前故事 Markdown。\n\n${markdown}`]
    .filter(Boolean)
    .join('\n\n');
}

export const SETUP_NODE_PLACEHOLDER =
  '（开局设定与剧本附件已完整锚定于系统提示词原始剧本区，此处略去重复全文）';

const SUMMARY_PREVIOUS_TRUNCATION_MARKER = '…（较早摘要已省略，以下保留最近内容）…';

function takeLastTextChars(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) return '';

  let start = Math.max(0, text.length - limit);
  if (start > 0 && start < text.length) {
    const previousCodeUnit = text.charCodeAt(start - 1);
    const firstCodeUnit = text.charCodeAt(start);
    if (
      previousCodeUnit >= 0xd800 &&
      previousCodeUnit <= 0xdbff &&
      firstCodeUnit >= 0xdc00 &&
      firstCodeUnit <= 0xdfff
    ) {
      start += 1;
    }
  }
  return text.slice(start);
}

function capPreviousSummary(previousSummary: string, maxChars: number): string {
  const normalized = previousSummary.trim();
  if (normalized.length <= maxChars) return normalized;

  if (maxChars <= SUMMARY_PREVIOUS_TRUNCATION_MARKER.length) {
    return takeLastTextChars(normalized, maxChars);
  }
  return `${SUMMARY_PREVIOUS_TRUNCATION_MARKER}${takeLastTextChars(
    normalized,
    maxChars - SUMMARY_PREVIOUS_TRUNCATION_MARKER.length,
  )}`;
}

export interface SetupNodeFilter {
  readonly markdown?: string;
  readonly setupNodeIds?: ReadonlySet<string>;
  readonly hasRawScript: boolean;
}

export function getSetupNodeFilter(
  story: Pick<Story, 'rawScript' | 'setupNodeIds' | 'documents'> & { nodes?: Story['nodes'] },
  at?: string | null,
  selected?: MarkdownVersion,
): SetupNodeFilter {
  const version = at ? story.nodes?.[at]?.documents?.container : undefined;
  const markdown = selected?.markdown ?? (story.documents ? documentVersion(story.documents.container, version).markdown : null);
  return {
    ...(markdown ? { markdown } : {}),
    hasRawScript: Boolean(story.rawScript.trim() && (markdown === null || markdown.includes(story.rawScript.trim()))),
    setupNodeIds: story.setupNodeIds?.length ? new Set(story.setupNodeIds) : undefined,
  };
}

export function getEffectiveNodeContent(node: TurnNode, filter?: SetupNodeFilter): string {
  if ((filter?.hasRawScript && filter.setupNodeIds?.has(node.id)) ||
    (node.role === 'user' && node.content.length >= 180 && filter?.markdown?.includes(node.content))) {
    return SETUP_NODE_PLACEHOLDER;
  }
  return node.content;
}

function sumNodeChars(nodes: readonly TurnNode[], filter?: SetupNodeFilter): number {
  return nodes.reduce((sum, n) => sum + getEffectiveNodeContent(n, filter).length, 0);
}

export function trimRecentWindow(
  nodes: TurnNode[],
  budget: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
  pendingUserChars = 0,
  filter?: SetupNodeFilter,
): TurnNode[] {
  if (nodes.length === 0) return [];
  const maxNodes = Math.max(MIN_RECENT_NODES_PER_TURN, budget.recentMaxNodes);
  const windowed = nodes.length > maxNodes ? nodes.slice(nodes.length - maxNodes) : [...nodes];

  while (windowed.length > MIN_RECENT_NODES_PER_TURN && windowed[0]?.role === 'assistant') {
    windowed.shift();
  }

  let totalChars = sumNodeChars(windowed, filter) + pendingUserChars;
  while (windowed.length > MIN_RECENT_NODES_PER_TURN && totalChars > budget.recentMaxChars) {
    const dropCount =
      windowed[0]?.role === 'user' && windowed[1]?.role === 'assistant' ? 2 : 1;
    if (windowed.length - dropCount < MIN_RECENT_NODES_PER_TURN) {
      break;
    }
    for (let i = 0; i < dropCount; i++) {
      const removed = windowed.shift()!;
      totalChars -= getEffectiveNodeContent(removed, filter).length;
    }
  }
  return windowed;
}

/**
 * Assembles the Three-Zone Context (Fixed Anchor + Rolling Plot Summary + Recent Turn Window).
 * Reasoning chains (reasoningContent) are strictly excluded from conversation history.
 */
export function assembleThreeZoneContext(
  story: Story,
  targetParentId: string | null = story.activeLeafNodeId,
  userInput?: string,
  budgetOverrides?: Partial<ContextBudgetConfig>,
  requireHistory = false,
  requestDocuments?: {
    publicVersion?: MarkdownVersion;
    container: MarkdownVersion;
    local: MarkdownVersion;
    snapshot: PlotSummarySnapshot;
    promptPackLibrary?: PromptPackLibrary;
    generationPreference?: GenerationPreference;
    promptPack?: PromptPackContextOptions['promptPack'];
    includePromptPackTail?: boolean;
    includeTail?: boolean;
  },
  promptPackOptions?: PromptPackContextOptions,
): ThreeZoneContextResult {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budgetOverrides };
  const resolvedPromptPackOptions: PromptPackContextOptions = {
    ...(requestDocuments?.promptPackLibrary ? { promptPackLibrary: requestDocuments.promptPackLibrary } : {}),
    ...(requestDocuments?.generationPreference ? { generationPreference: requestDocuments.generationPreference } : {}),
    ...(requestDocuments?.promptPack !== undefined ? { promptPack: requestDocuments.promptPack } : {}),
    ...(requestDocuments?.includePromptPackTail !== undefined
      ? { includePromptPackTail: requestDocuments.includePromptPackTail }
      : {}),
    ...(requestDocuments?.includeTail !== undefined ? { includeTail: requestDocuments.includeTail } : {}),
    ...promptPackOptions,
  };
  const effectivePromptPack = resolvePromptPackContext(resolvedPromptPackOptions);
  const anchorText = buildSystemAnchorPrompt(
    story,
    targetParentId,
    requestDocuments?.container,
    resolvedPromptPackOptions,
    false,
  );
  const setupFilter = getSetupNodeFilter(story, targetParentId, requestDocuments?.container);
  const snapshot = requestDocuments?.snapshot ?? getActiveSummarySnapshot(story, targetParentId);
  const branchNodes = getActiveBranchNodes(story, targetParentId);
  const uncovered = getUncoveredNodes(branchNodes, snapshot.coveredUpToNodeId);
  const trimmedInput = userInput?.trim() ?? '';
  const historyChars = sumNodeChars(uncovered, setupFilter);
  if (requireHistory && historyChars > budget.recentMaxChars && uncovered.length > 2) {
    throw new Error('尚未补齐这段剧情，原文又超过近期预算。请重试续写。');
  }
  const recentNodes = requireHistory
    ? uncovered
    : trimRecentWindow(uncovered, budget, trimmedInput.length, setupFilter);

  const readDocs = requestDocuments?.publicVersion
    ? documentMessages([['我的记忆', requestDocuments.publicVersion]])
    : [];
  const settingMarkdown = requestDocuments?.container?.markdown ?? (story.documents
    ? documentVersion(
        story.documents.container,
        storyDocumentState({ ...story, documents: story.documents }, targetParentId, targetParentId === story.activeLeafNodeId).container,
      ).markdown
    : legacyStoryMarkdown(story));
  const settingMessage = settingMarkdown.trim()
    ? { role: 'system' as const, content: `以下是当前故事 Markdown。\n\n${settingMarkdown}` }
    : null;
  const anchorMessages = effectivePromptPack.enabled
    ? [
        ...buildPromptPackAnchorMessages(anchorText, effectivePromptPack),
        ...readDocs,
        ...(settingMessage ? [settingMessage] : []),
      ]
    : [{ role: 'system' as const, content: anchorText }, ...readDocs, ...(settingMessage ? [settingMessage] : [])];
  const messages: LlmMessage[] = [...anchorMessages];
  let summaryChars = 0;

  if (requestDocuments?.local?.markdown.trim()) {
    const local = documentMessages([['分支笔记', requestDocuments.local]])[0];
    summaryChars = local.content.length;
    messages.push(local);
  } else if (snapshot.content.trim()) {
    const summaryMsg = `## 滚动剧情摘要（已覆盖 ${snapshot.summarizedTurnCount} 条历史节点）\n${snapshot.content.trim()}`;
    summaryChars = summaryMsg.length;
    messages.push({ role: 'system', content: summaryMsg });
  }

  let recentChars = 0;
  for (const node of recentNodes) {
    const content = getEffectiveNodeContent(node, setupFilter);
    recentChars += content.length;
    messages.push({
      role: node.role,
      content,
    });
  }

  const tail = promptPackTailMessage(
    effectivePromptPack,
    resolvedPromptPackOptions.includePromptPackTail ?? resolvedPromptPackOptions.includeTail ?? false,
  );
  if (tail) messages.push(tail);

  if (trimmedInput) {
    recentChars += trimmedInput.length;
    messages.push({ role: 'user', content: trimmedInput });
  }

  const anchorChars = anchorMessages.reduce((sum, message) => sum + message.content.length, 0) +
    (tail?.content.length ?? 0);
  const totalChars = anchorChars + summaryChars + recentChars;
  return {
    messages,
    metrics: {
      anchorChars,
      summaryChars,
      recentChars,
      recentNodeCount: recentNodes.length,
      totalEstimatedTokens: estimateTokensFromChars(totalChars),
    },
  };
}

/**
 * Determines which oldest uncovered turns should be folded into the Plot Summary
 * when the uncovered window exceeds configured turn or character budgets.
 */
export function selectNodesToSummarize(
  uncoveredNodes: TurnNode[],
  budgetOverrides?: Partial<ContextBudgetConfig>,
  filter?: SetupNodeFilter,
): TurnNode[] {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budgetOverrides };
  const maxNodes = Math.max(MIN_RECENT_NODES_PER_TURN, budget.recentMaxNodes);
  const totalChars = sumNodeChars(uncoveredNodes, filter);

  if (uncoveredNodes.length <= maxNodes && totalChars <= budget.recentMaxChars) {
    return [];
  }

  // Keep at least the latest turn pair in the recent window when possible
  const maxCutEnd = Math.max(0, uncoveredNodes.length - MIN_RECENT_NODES_PER_TURN);
  if (maxCutEnd < MIN_RECENT_NODES_PER_TURN) {
    return [];
  }

  let cutCount = Math.min(maxCutEnd, Math.max(MIN_RECENT_NODES_PER_TURN, uncoveredNodes.length - maxNodes));
  let remainingChars = sumNodeChars(uncoveredNodes.slice(cutCount), filter);
  while (cutCount < maxCutEnd && remainingChars > budget.recentMaxChars) {
    remainingChars -= getEffectiveNodeContent(uncoveredNodes[cutCount], filter).length;
    cutCount += 1;
  }

  if (uncoveredNodes[cutCount - 1]?.role !== 'assistant' && cutCount + 1 <= maxCutEnd) {
    cutCount += 1;
  }

  return uncoveredNodes.slice(0, cutCount);
}

export function buildSummaryCompressionMessages(
  previousSummary: string,
  nodesToFold: TurnNode[],
  filter?: SetupNodeFilter,
  maxPreviousSummaryChars = DEFAULT_CONTEXT_BUDGET.summaryBatchMaxChars,
): LlmMessage[] {
  const turnsText = nodesToFold
    .map(
      (n) =>
        `[${n.role === 'user' ? '玩家' : '叙事'}]: ${getEffectiveNodeContent(n, filter)}`,
    )
    .join('\n\n');
  const boundedPreviousSummary = capPreviousSummary(previousSummary, maxPreviousSummaryChars);

  return [
    {
      role: 'system',
      content: [
        '你是互动叙事剧情摘要压缩助手（剧情摘要压缩）。请将“既有摘要”与“新增历史轮次”合并为一段精炼、客观、连贯的中文剧情要点。',
        '保留关键人物关系变动、地点转移、已获得线索/物品、关键数值或状态变化与未解决伏笔；不要包含任何多余寒暄或虚构未来剧情。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        boundedPreviousSummary
          ? `### 既有剧情摘要\n${boundedPreviousSummary}`
          : '### 既有剧情摘要\n（暂无）',
        `### 需要压缩并合入的历史轮次\n${turnsText}`,
      ].join('\n\n'),
    },
  ];
}

export interface TurnTreeState {
  nodes: Record<string, TurnNode>;
  activeLeafNodeId: string | null;
}

/**
 * Appends a TurnNode into a branch tree and activates it as the new leaf.
 */
export function appendTurnNodeToTree(tree: TurnTreeState, node: TurnNode): TurnTreeState {
  return {
    nodes: { ...tree.nodes, [node.id]: node },
    activeLeafNodeId: node.id,
  };
}

/**
 * Switches the active leaf pointer within an existing TurnNode tree without mutating sibling branches.
 */
export function switchTurnTreeBranch(tree: TurnTreeState, targetLeafId: string | null): TurnTreeState {
  if (targetLeafId !== null && !Object.hasOwn(tree.nodes, targetLeafId)) {
    throw new Error(`目标分支节点 ${targetLeafId} 不存在。`);
  }
  return {
    ...tree,
    activeLeafNodeId: targetLeafId,
  };
}

/**
 * Resolves the rolling summary snapshot for a target branch leaf, rejecting cross-branch coverage pointers.
 */
export function getTurnTreeSummarySnapshot(
  nodes: Record<string, TurnNode>,
  leafId: string | null,
): PlotSummarySnapshot {
  if (!leafId || !Object.hasOwn(nodes, leafId)) return EMPTY_SUMMARY_SNAPSHOT;
  const leaf = nodes[leafId];
  const snapshot = leaf.summarySnapshot ?? EMPTY_SUMMARY_SNAPSHOT;
  if (snapshot.coveredUpToNodeId === null) {
    return snapshot.content.trim() ? snapshot : EMPTY_SUMMARY_SNAPSHOT;
  }
  const branchNodes = getActiveBranchNodes({ nodes, activeLeafNodeId: leafId }, leafId);
  const coveredOnBranch = branchNodes.some((node) => node.id === snapshot.coveredUpToNodeId);
  return coveredOnBranch ? snapshot : EMPTY_SUMMARY_SNAPSHOT;
}

export interface CreativeThreeZoneContextInput {
  systemPrompt: string;
  documents?: readonly [string, MarkdownVersion][];
  localDocument?: MarkdownVersion;
  manuscriptWindow?: string;
  nodes: Record<string, TurnNode>;
  targetParentId: string | null;
  userInput?: string;
  budgetOverrides?: Partial<ContextBudgetConfig>;
  promptPackLibrary?: PromptPackLibrary;
  generationPreference?: GenerationPreference;
  promptPack?: PromptPackContextOptions['promptPack'];
  includePromptPackTail?: boolean;
  includeTail?: boolean;
}

/**
 * Assembles Three-Zone Context (Anchored Setting + Rolling Summary + Recent Window)
 * for 写故事, 角色互动, or any TurnNode branch tree without throwing on compression fallback.
 */
export function assembleCreativeThreeZoneContext(
  input: CreativeThreeZoneContextInput,
): ThreeZoneContextResult {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...input.budgetOverrides };
  const promptPackOptions: PromptPackContextOptions = {
    ...(input.promptPackLibrary ? { promptPackLibrary: input.promptPackLibrary } : {}),
    ...(input.generationPreference ? { generationPreference: input.generationPreference } : {}),
    ...(input.promptPack !== undefined ? { promptPack: input.promptPack } : {}),
    ...(input.includePromptPackTail !== undefined ? { includePromptPackTail: input.includePromptPackTail } : {}),
    ...(input.includeTail !== undefined ? { includeTail: input.includeTail } : {}),
  };
  const effectivePromptPack = resolvePromptPackContext(promptPackOptions);
  const anchorMessages: LlmMessage[] = [
    ...(effectivePromptPack.enabled
      ? buildPromptPackAnchorMessages(input.systemPrompt, effectivePromptPack)
      : [{ role: 'system' as const, content: input.systemPrompt }]),
    ...documentMessages(input.documents ?? []),
  ];
  const manuscript = input.manuscriptWindow?.trim();
  if (manuscript) {
    anchorMessages.push({
      role: 'system',
      content: `以下是当前作品的正文参考窗口。\n\n${manuscript}`,
    });
  }

  const snapshot = getTurnTreeSummarySnapshot(input.nodes, input.targetParentId);
  const branchNodes = getActiveBranchNodes(
    { nodes: input.nodes, activeLeafNodeId: input.targetParentId },
    input.targetParentId,
  );
  const uncovered = getUncoveredNodes(branchNodes, snapshot.coveredUpToNodeId);
  const trimmedInput = input.userInput?.trim() ?? '';
  const recentNodes = trimRecentWindow(uncovered, budget, trimmedInput.length);

  const messages: LlmMessage[] = [...anchorMessages];
  let summaryChars = 0;
  const localDoc = input.localDocument;
  const localProgress = localDoc ? documentProgress(localDoc.markdown) : '';
  if (localDoc && localDoc.markdown.trim()) {
    const [localMsg] = documentMessages([['当前对话', localDoc]]);
    if (localMsg) {
      summaryChars += localMsg.content.length;
      messages.push(localMsg);
    }
  }
  if (!localProgress && snapshot.content.trim()) {
    const summaryMsg = `## 滚动剧情摘要（已覆盖 ${snapshot.summarizedTurnCount} 条历史节点）\n${snapshot.content.trim()}`;
    summaryChars += summaryMsg.length;
    messages.push({ role: 'system', content: summaryMsg });
  }

  let recentChars = 0;
  for (const node of recentNodes) {
    recentChars += node.content.length;
    messages.push({
      role: node.role,
      content: node.content,
    });
  }

  const tail = promptPackTailMessage(
    effectivePromptPack,
    input.includePromptPackTail ?? input.includeTail ?? false,
  );
  if (tail) messages.push(tail);

  if (trimmedInput) {
    recentChars += trimmedInput.length;
    messages.push({ role: 'user', content: trimmedInput });
  }

  const anchorChars = anchorMessages.reduce((sum, msg) => sum + msg.content.length, 0) +
    (tail?.content.length ?? 0);
  const totalChars = anchorChars + summaryChars + recentChars;
  return {
    messages,
    metrics: {
      anchorChars,
      summaryChars,
      recentChars,
      recentNodeCount: recentNodes.length,
      totalEstimatedTokens: estimateTokensFromChars(totalChars),
    },
  };
}

function takeCreativeSummaryBatch(
  toSummarize: TurnNode[],
  maxNodes: number,
  maxChars: number,
): TurnNode[] {
  let end = 0;
  let batchChars = 0;
  for (const node of toSummarize) {
    if (end >= maxNodes) break;
    const nodeChars = node.content.length;
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

function splitCreativeSummaryText(text: string, maxChars: number): string[] {
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

export interface SummarizeCreativeTurnNodesOptions {
  nodes: Record<string, TurnNode>;
  targetLeafId: string | null;
  transport: LlmTransport;
  config: ModelConfig;
  budget?: Partial<ContextBudgetConfig>;
  signal?: AbortSignalLike;
  baseSnapshot?: PlotSummarySnapshot;
}

export interface SummarizeCreativeTurnNodesResult {
  nodes: Record<string, TurnNode>;
  snapshot: PlotSummarySnapshot;
  updated: boolean;
  status: 'done' | 'skipped' | 'failed';
}

/**
 * Silently compresses uncovered TurnNodes along a single branch into the target leaf's
 * summarySnapshot. Never throws on network/model failure or abort; preserves last good summary.
 */
export async function summarizeCreativeTurnNodes(
  options: SummarizeCreativeTurnNodesOptions,
): Promise<SummarizeCreativeTurnNodesResult> {
  const { nodes, targetLeafId, transport, config, signal } = options;
  if (!targetLeafId || !Object.hasOwn(nodes, targetLeafId)) {
    return {
      nodes,
      snapshot: EMPTY_SUMMARY_SNAPSHOT,
      updated: false,
      status: 'skipped',
    };
  }

  const branchNodes = getActiveBranchNodes({ nodes, activeLeafNodeId: targetLeafId }, targetLeafId);
  const initialSnapshot = options.baseSnapshot ?? getTurnTreeSummarySnapshot(nodes, targetLeafId);
  let currentSnapshot = initialSnapshot;
  let hadFailure = false;
  let sawOverflow = false;

  const maxBatchNodes = Math.max(
    1,
    Math.floor(options.budget?.summaryBatchMaxNodes ?? DEFAULT_CONTEXT_BUDGET.summaryBatchMaxNodes),
  );
  const maxBatchChars = Math.max(
    1,
    Math.floor(options.budget?.summaryBatchMaxChars ?? DEFAULT_CONTEXT_BUDGET.summaryBatchMaxChars),
  );

  const bgConfig = createBackgroundModelConfig(config);
  const runBatch = async (previousContent: string, batchNodes: TurnNode[]): Promise<string | null> => {
    if (signal?.aborted) return null;
    try {
      let content = '';
      let finishReason: string | null | undefined;
      for await (const delta of transport.streamChat({
        baseUrl: bgConfig.baseUrl,
        apiKey: bgConfig.apiKey,
        model: bgConfig.model,
        reasoningEffort: bgConfig.reasoningEffort,
        messages: buildSummaryCompressionMessages(previousContent, batchNodes, undefined, maxBatchChars),
        signal,
      })) {
        if (signal?.aborted) return null;
        if (delta.finishReason != null) finishReason = delta.finishReason;
        if (delta.contentDelta) content += delta.contentDelta;
      }
      if (signal?.aborted || finishReason !== 'stop') return null;
      return content.trim() || null;
    } catch {
      return null;
    }
  };

  while (true) {
    const uncovered = getUncoveredNodes(branchNodes, currentSnapshot.coveredUpToNodeId);
    const toSummarize = selectNodesToSummarize(uncovered, options.budget);
    if (toSummarize.length === 0) break;

    sawOverflow = true;
    const batch = takeCreativeSummaryBatch(toSummarize, maxBatchNodes, maxBatchChars);
    if (batch.length === 0) break;

    const single = batch.length === 1 ? batch[0] : undefined;
    if (single && single.content.length > maxBatchChars) {
      let rolling = currentSnapshot.content;
      let chunkFailed = false;
      for (const chunk of splitCreativeSummaryText(single.content, maxBatchChars)) {
        const next = await runBatch(rolling, [{ ...single, content: chunk }]);
        if (!next) {
          chunkFailed = true;
          break;
        }
        rolling = next;
      }
      if (chunkFailed) {
        hadFailure = true;
        break;
      }
      currentSnapshot = {
        content: rolling,
        coveredUpToNodeId: single.id,
        summarizedTurnCount: currentSnapshot.summarizedTurnCount + 1,
      };
      continue;
    }

    const compressed = await runBatch(currentSnapshot.content, batch);
    if (!compressed) {
      hadFailure = true;
      break;
    }
    currentSnapshot = {
      content: compressed,
      coveredUpToNodeId: batch[batch.length - 1].id,
      summarizedTurnCount: currentSnapshot.summarizedTurnCount + batch.length,
    };
  }

  const updated =
    currentSnapshot.content !== initialSnapshot.content ||
    currentSnapshot.coveredUpToNodeId !== initialSnapshot.coveredUpToNodeId ||
    currentSnapshot.summarizedTurnCount !== initialSnapshot.summarizedTurnCount;

  const nextNodes = updated
    ? {
        ...nodes,
        [targetLeafId]: {
          ...nodes[targetLeafId],
          summarySnapshot: currentSnapshot,
        },
      }
    : nodes;

  return {
    nodes: nextNodes,
    snapshot: currentSnapshot,
    updated,
    status: hadFailure ? 'failed' : sawOverflow ? 'done' : 'skipped',
  };
}
