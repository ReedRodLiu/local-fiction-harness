import { formatConfirmedBlueprintAnchor } from './blueprint.ts';
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
  story: Story,
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
  return story.nodes[leafId]?.summarySnapshot ?? EMPTY_SUMMARY_SNAPSHOT;
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

export function buildSystemAnchorPrompt(story: Story): string {
  const sections: string[] = [
    '你正在运行一个本地优先交互式文游播放器，请严格遵循以下剧本设定与交互原则：',
    '- 始终保持角色一致性（防 OOC）与设定约束，不要替玩家代操抉择。',
  ];

  const blueprintSummary = formatConfirmedBlueprintAnchor(story.blueprint);
  if (blueprintSummary) {
    sections.push(`## 已确认故事蓝图\n${blueprintSummary}`);
  }

  if (story.rawScript.trim()) {
    sections.push(`## 原始剧本全文（最高权威锚定）\n${story.rawScript.trim()}`);
  }

  return sections.join('\n\n');
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
  readonly setupNodeIds?: ReadonlySet<string>;
  readonly hasRawScript: boolean;
}

export function getSetupNodeFilter(
  story: Pick<Story, 'rawScript' | 'setupNodeIds'>,
): SetupNodeFilter {
  return {
    hasRawScript: Boolean(story.rawScript.trim()),
    setupNodeIds: story.setupNodeIds?.length ? new Set(story.setupNodeIds) : undefined,
  };
}

export function getEffectiveNodeContent(node: TurnNode, filter?: SetupNodeFilter): string {
  if (filter?.hasRawScript && filter.setupNodeIds?.has(node.id)) {
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
): ThreeZoneContextResult {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budgetOverrides };
  const anchorText = buildSystemAnchorPrompt(story);
  const setupFilter = getSetupNodeFilter(story);
  const snapshot = getActiveSummarySnapshot(story, targetParentId);
  const branchNodes = getActiveBranchNodes(story, targetParentId);
  const uncovered = getUncoveredNodes(branchNodes, snapshot.coveredUpToNodeId);
  const trimmedInput = userInput?.trim() ?? '';
  const recentNodes = trimRecentWindow(uncovered, budget, trimmedInput.length, setupFilter);

  const messages: LlmMessage[] = [{ role: 'system', content: anchorText }];
  let summaryChars = 0;

  if (snapshot.content.trim()) {
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

  const totalChars = anchorText.length + summaryChars + recentChars;
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

export function buildFallbackSummary(
  previousSummary: string,
  nodesToFold: TurnNode[],
  filter?: SetupNodeFilter,
): string {
  const digest = nodesToFold
    .map((n) => {
      const prefix = n.role === 'user' ? '玩家' : '叙事';
      const effective = getEffectiveNodeContent(n, filter);
      const snippet = effective.replace(/\s+/g, ' ').trim().slice(0, 80);
      return `- ${prefix}：${snippet}${effective.length > 80 ? '…' : ''}`;
    })
    .join('\n');
  return previousSummary.trim() ? `${previousSummary.trim()}\n${digest}` : digest;
}
