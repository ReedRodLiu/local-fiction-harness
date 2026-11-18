import {
  buildChildrenByParent,
  buildSubtreeMaxCreatedAt,
  countNodesToRoot,
  getRootNodes,
  pickActiveOrLatestChild,
  toCompactPreview,
} from './branches.ts';
import {
  DEFAULT_CONTEXT_BUDGET,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getSetupNodeFilter,
  getUncoveredNodes,
  selectNodesToSummarize,
  trimRecentWindow,
  type ContextBudgetConfig,
} from './context.ts';
import type {
  LlmMessage,
  NodeDiagnosticStatus,
  PlotSummarySnapshot,
  Story,
  TurnNode,
} from './types.ts';

export interface StoryTreeSpanItem {
  kind: 'span';
  id: string;
  startNodeId: string;
  endNodeId: string;
  startTurn: number;
  endTurn: number;
  nodeCount: number;
  turnCount: number;
  preview: string;
  diagnosticsCount: number;
  isActiveEnd: boolean;
}

export interface StoryTreeForkItem {
  kind: 'fork';
  id: string;
  parentNodeId: string | null;
  afterTurn: number;
  branchCount: number;
  activeChildId: string | null;
  activeBranchLabel: string;
}

export type StoryTreeSpineItem = StoryTreeSpanItem | StoryTreeForkItem;

export interface StoryTreeSpineProjection {
  items: StoryTreeSpineItem[];
  totalActiveTurns: number;
  forkCount: number;
  activeLeafNodeId: string | null;
}

export interface ForkSiblingBranch {
  entryNodeId: string;
  leafId: string;
  label: string;
  customName?: string;
  aiGist?: string;
  isActive: boolean;
  branchTurnCount: number;
  totalTurnDepth: number;
  cues: string[];
  preview: string;
  diagnostics: NodeDiagnosticStatus[];
  hasContentRisk: boolean;
}

export interface TurnRange {
  startTurn: number;
  endTurn: number;
}

export interface ActiveReviewState {
  activeBranchLabel: string;
  totalTurns: number;
  totalNodes: number;
  summarySnapshot: PlotSummarySnapshot;
  coveredTurnRange: TurnRange | null;
  recentNodeCount: number;
  recentTurnRange: TurnRange | null;
  needsSummaryCompression: boolean;
}

function countDiagnostics(nodes: readonly TurnNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.diagnostics?.sourceStatus || node.diagnostics?.contentRisk) {
      count += 1;
    }
  }
  return count;
}

function resolveBranchLabel(
  story: Story,
  entryNodeId: string | null,
  siblingIndex: number,
): string {
  if (entryNodeId) {
    const custom = story.branchNames?.[entryNodeId]?.trim();
    if (custom) return custom;
  }
  return `分支 ${siblingIndex + 1}`;
}

function makeSpanItem(
  nodes: TurnNode[],
  startIndex: number,
  endIndex: number,
  isActiveEnd: boolean,
): StoryTreeSpanItem {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const startTurn = Math.floor(startIndex / 2) + 1;
  const endTurn = Math.floor(endIndex / 2) + 1;
  return {
    kind: 'span',
    id: `span:${first.id}:${last.id}`,
    startNodeId: first.id,
    endNodeId: last.id,
    startTurn,
    endTurn,
    nodeCount: nodes.length,
    turnCount: endTurn - startTurn + 1,
    preview: toCompactPreview(last.content, 48),
    diagnosticsCount: countDiagnostics(nodes),
    isActiveEnd,
  };
}

/**
 * Projects the Story's active path into a focused vertical spine:
 * collapses linear non-branching runs into spans and marks historical forks with branch counts.
 * Never traverses unopened sibling subtrees and never calls any LLM.
 */
export function projectStoryTreeSpine(story: Story): StoryTreeSpineProjection {
  const activePath = getActiveBranchNodes(story, story.activeLeafNodeId);
  const childrenByParent = buildChildrenByParent(story);
  const rootNodes = getRootNodes(story);
  const items: StoryTreeSpineItem[] = [];
  let forkCount = 0;

  if (rootNodes.length > 1 || (activePath.length === 0 && rootNodes.length > 0)) {
    const activeChildId = activePath[0]?.id ?? null;
    const activeIdx = activeChildId ? rootNodes.findIndex((n) => n.id === activeChildId) : -1;
    if (rootNodes.length > 1) {
      forkCount += 1;
    }
    items.push({
      kind: 'fork',
      id: 'fork:root',
      parentNodeId: null,
      afterTurn: 0,
      branchCount: rootNodes.length,
      activeChildId,
      activeBranchLabel: activeIdx >= 0 ? resolveBranchLabel(story, activeChildId, activeIdx) : '开局路口',
    });
  }

  let spanStartIdx = 0;
  for (let i = 0; i < activePath.length; i++) {
    const node = activePath[i];
    const children = childrenByParent.get(node.id) ?? [];
    const isLastOnSpine = i === activePath.length - 1;
    const isFork = children.length > 1 || (isLastOnSpine && children.length > 0);

    if (isFork) {
      const spanNodes = activePath.slice(spanStartIdx, i + 1);
      items.push(makeSpanItem(spanNodes, spanStartIdx, i, false));

      const activeChildId = !isLastOnSpine ? activePath[i + 1].id : null;
      const activeIdx = activeChildId ? children.findIndex((c) => c.id === activeChildId) : -1;
      if (children.length > 1) {
        forkCount += 1;
      }
      items.push({
        kind: 'fork',
        id: `fork:${node.id}`,
        parentNodeId: node.id,
        afterTurn: Math.floor(i / 2) + 1,
        branchCount: children.length,
        activeChildId,
        activeBranchLabel:
          activeIdx >= 0 ? resolveBranchLabel(story, activeChildId, activeIdx) : '待继续分叉',
      });
      spanStartIdx = i + 1;
    }
  }

  if (spanStartIdx < activePath.length) {
    const tailNodes = activePath.slice(spanStartIdx);
    items.push(makeSpanItem(tailNodes, spanStartIdx, activePath.length - 1, true));
  }

  return {
    items,
    totalActiveTurns: Math.ceil(activePath.length / 2),
    forkCount,
    activeLeafNodeId: story.activeLeafNodeId,
  };
}

/**
 * Extracts zero-cost local cues (chapter/heading, time, location, status HUD line) from branch nodes.
 */
export function extractBranchLocalCues(nodes: readonly TurnNode[]): string[] {
  const cues: string[] = [];
  const seen = new Set<string>();
  const addCue = (cue: string) => {
    const trimmed = cue.trim();
    if (!trimmed || seen.has(trimmed) || cues.length >= 4) return;
    seen.add(trimmed);
    cues.push(trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed);
  };

  for (let i = nodes.length - 1; i >= 0 && cues.length < 4; i--) {
    const lines = nodes[i].content.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('```')) continue;

      const chapterMatch =
        /^(?:#{1,3}\s+(.{2,36})|(第[一二三四五六七八九十百千万0-9]+[章幕回节卷][^\n]{0,28}))$/.exec(
          line,
        );
      if (chapterMatch) {
        addCue(chapterMatch[1] ?? chapterMatch[2] ?? '');
      }

      const timeMatch =
        /^(?:时间|日期)[：:]\s*([^\n|]{1,28})|\b(Day\s*\d+[^\n|]{0,18})|(第\s*\d+\s*[天日夜][^\n|]{0,16})/i.exec(
          line,
        );
      if (timeMatch) {
        addCue(timeMatch[1] ? `时间：${timeMatch[1]}` : (timeMatch[2] ?? timeMatch[3] ?? ''));
      }

      const locationMatch = /^(?:地点|位置|场景|当前所在)[：:]\s*([^\n|]{1,28})/.exec(line);
      if (locationMatch?.[1]) {
        addCue(`地点：${locationMatch[1]}`);
      }

      const hudMatch = /^[\[【]([^\]】]{3,36})[\]】]$/.exec(line);
      if (hudMatch?.[1] && /[:：|]/.test(hudMatch[1])) {
        addCue(hudMatch[1]);
      }
    }
  }

  return cues;
}

function collectBranchLine(
  story: Story,
  entryNodeId: string,
  ctx?: {
    childrenByParent: Map<string, TurnNode[]>;
    subtreeMaxMap: ReadonlyMap<string, number>;
    activePathIds: ReadonlySet<string>;
  },
): TurnNode[] {
  const childrenByParent = ctx?.childrenByParent ?? buildChildrenByParent(story);
  const subtreeMaxMap = ctx?.subtreeMaxMap ?? buildSubtreeMaxCreatedAt(story, childrenByParent);
  const activePathIds =
    ctx?.activePathIds ?? new Set(getActiveBranchNodes(story, story.activeLeafNodeId).map((n) => n.id));
  const branchNodes: TurnNode[] = [];
  const visited = new Set<string>();
  let cursor: string | null = entryNodeId;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = story.nodes[cursor];
    if (!node) break;
    branchNodes.push(node);
    const children = childrenByParent.get(cursor);
    if (!children || children.length === 0) break;
    const next = pickActiveOrLatestChild(children, subtreeMaxMap, activePathIds);
    if (!next) break;
    cursor = next.id;
  }

  return branchNodes;
}

/**
 * Lazily expands a fork point into its sibling branches with zero-cost local cues and diagnostics.
 */
export function getForkSiblingBranches(
  story: Story,
  parentNodeId: string | null,
): ForkSiblingBranch[] {
  const childrenByParent = buildChildrenByParent(story);
  const subtreeMaxMap = buildSubtreeMaxCreatedAt(story, childrenByParent);
  const siblings =
    parentNodeId === null ? getRootNodes(story) : (childrenByParent.get(parentNodeId) ?? []);
  const activePathIds = new Set(getActiveBranchNodes(story, story.activeLeafNodeId).map((n) => n.id));

  return siblings.map((entryNode, index) => {
    const branchLine = collectBranchLine(story, entryNode.id, {
      childrenByParent,
      subtreeMaxMap,
      activePathIds,
    });
    const leaf = branchLine[branchLine.length - 1] ?? entryNode;
    const totalNodes = countNodesToRoot(story, leaf.id);

    const diagnosticsSet = new Set<NodeDiagnosticStatus>();
    let hasContentRisk = false;
    for (const n of branchLine) {
      if (n.diagnostics?.sourceStatus) diagnosticsSet.add(n.diagnostics.sourceStatus);
      if (n.diagnostics?.contentRisk) hasContentRisk = true;
    }

    const customName = story.branchNames?.[entryNode.id]?.trim();
    const aiGist = story.branchSummaries?.[entryNode.id]?.trim();

    return {
      entryNodeId: entryNode.id,
      leafId: leaf.id,
      label: customName || `分支 ${index + 1}`,
      ...(customName ? { customName } : {}),
      ...(aiGist ? { aiGist } : {}),
      isActive: activePathIds.has(entryNode.id),
      branchTurnCount: Math.max(1, Math.ceil(branchLine.length / 2)),
      totalTurnDepth: Math.max(1, Math.ceil(totalNodes / 2)),
      cues: extractBranchLocalCues(branchLine),
      preview: toCompactPreview(leaf.content, 52),
      diagnostics: Array.from(diagnosticsSet),
      hasContentRisk,
    };
  });
}

/**
 * Builds an on-demand branch gist request strictly excluding reasoningContent and NodeDiagnostics.
 */
export function buildBranchGistMessages(
  story: Story,
  branchEntryNodeId: string,
): LlmMessage[] {
  const branchLine = collectBranchLine(story, branchEntryNodeId);
  const transcript = branchLine
    .slice(0, 12)
    .map((n) => `[${n.role === 'user' ? '玩家' : '叙事'}]: ${toCompactPreview(n.content, 160)}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        '你是互动叙事分支梗概助手。请用不超过 35 个中文字的一句话概括该分支线的核心事件与走向，不要附加标点以外的多余解释。',
    },
    {
      role: 'user',
      content: transcript || '（暂无对话内容）',
    },
  ];
}

/**
 * Computes the explicit Story Review state for the currently active branch.
 */
export function computeActiveReviewState(
  story: Story,
  budgetOverrides?: Partial<ContextBudgetConfig>,
): ActiveReviewState {
  const budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budgetOverrides };
  const activeNodes = getActiveBranchNodes(story, story.activeLeafNodeId);
  const summarySnapshot = getActiveSummarySnapshot(story, story.activeLeafNodeId);
  const uncovered = getUncoveredNodes(activeNodes, summarySnapshot.coveredUpToNodeId);
  const setupFilter = getSetupNodeFilter(story);
  const recentNodes = trimRecentWindow(uncovered, budget, 0, setupFilter);
  const needsSummaryCompression =
    selectNodesToSummarize(uncovered, budget, setupFilter).length > 0;

  let coveredTurnRange: TurnRange | null = null;
  if (summarySnapshot.coveredUpToNodeId) {
    const idx = activeNodes.findIndex((n) => n.id === summarySnapshot.coveredUpToNodeId);
    if (idx >= 0) {
      coveredTurnRange = {
        startTurn: 1,
        endTurn: Math.floor(idx / 2) + 1,
      };
    }
  }

  let recentTurnRange: TurnRange | null = null;
  if (recentNodes.length > 0) {
    const firstRecentIdx = activeNodes.findIndex((n) => n.id === recentNodes[0].id);
    const lastRecentIdx = activeNodes.findIndex((n) => n.id === recentNodes[recentNodes.length - 1].id);
    if (firstRecentIdx >= 0 && lastRecentIdx >= firstRecentIdx) {
      recentTurnRange = {
        startTurn: Math.floor(firstRecentIdx / 2) + 1,
        endTurn: Math.floor(lastRecentIdx / 2) + 1,
      };
    }
  }

  let activeBranchLabel = '当前主干路线';
  for (let i = activeNodes.length - 1; i >= 0; i--) {
    const custom = story.branchNames?.[activeNodes[i].id]?.trim();
    if (custom) {
      activeBranchLabel = custom;
      break;
    }
  }

  return {
    activeBranchLabel,
    totalTurns: Math.ceil(activeNodes.length / 2),
    totalNodes: activeNodes.length,
    summarySnapshot,
    coveredTurnRange,
    recentNodeCount: recentNodes.length,
    recentTurnRange,
    needsSummaryCompression,
  };
}
