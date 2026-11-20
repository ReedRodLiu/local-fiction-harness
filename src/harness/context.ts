import {
  CHANGE_PROMPT,
  documentMessages,
  documentProgress,
  documentVersion,
  legacyStoryMarkdown,
  storyDocumentState,
  type MarkdownVersion,
} from './markdownDocuments.ts';
import type { LlmMessage, PlotSummarySnapshot, Story, TurnNode } from './types.ts';

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

export function buildSystemAnchorPrompt(story: Story, nodeId = story.activeLeafNodeId, selected?: MarkdownVersion): string {
  const markdown = selected?.markdown ?? (story.documents
    ? documentVersion(story.documents.container, storyDocumentState({ ...story, documents: story.documents }, nodeId,
      nodeId === story.activeLeafNodeId).container).markdown
    : legacyStoryMarkdown(story));
  return [
    '你是文游的叙事者。保持角色与设定一致，把玩家关键抉择留给玩家。',
    '如需提供可点选行动，把选项单独写在 lfh-choices 围栏内，每行一项。普通正文列表照常写。',
    CHANGE_PROMPT,
    markdown && `以下是当前故事 Markdown。\n\n${markdown}`,
  ].filter(Boolean).join('\n\n');
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
  requestDocuments?: { publicVersion?: MarkdownVersion; container: MarkdownVersion; local: MarkdownVersion; snapshot: PlotSummarySnapshot },
): ThreeZoneContextResult {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budgetOverrides };
  const anchorText = buildSystemAnchorPrompt(story, targetParentId, requestDocuments?.container);
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
    ? documentMessages([['公共记忆', requestDocuments.publicVersion]])
    : [];
  const messages: LlmMessage[] = [{ role: 'system', content: anchorText }, ...readDocs];
  let summaryChars = 0;

  if (requestDocuments?.local?.markdown.trim()) {
    const local = documentMessages([['当前路径', requestDocuments.local]])[0];
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

  if (trimmedInput) {
    recentChars += trimmedInput.length;
    messages.push({ role: 'user', content: trimmedInput });
  }

  const totalChars = anchorText.length + readDocs.reduce((sum, doc) => sum + doc.content.length, 0) + summaryChars + recentChars;
  return {
    messages,
    metrics: {
      anchorChars: anchorText.length,
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
