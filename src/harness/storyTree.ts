import {
  buildChildrenByParent,
  buildSubtreeMaxCreatedAt,
  countNodesToRoot,
  formatTurnPreview,
  getRootNodes,
  pickActiveOrLatestChild,
  sortNodesChronologically,
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

export const SPAN_STAGE_MAX_TURNS = 50;

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

export interface StoryTreeSpanSegment {
  id: string;
  startNodeId: string;
  endNodeId: string;
  startTurn: number;
  endTurn: number;
  turnCount: number;
  nodeIds: string[];
  preview: string;
  diagnosticsCount: number;
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
  leafRole?: TurnNode['role'];
  label: string;
  shortTitle: string;
  customName?: string;
  aiGist?: string;
  isActive: boolean;
  branchTurnCount: number;
  totalTurnDepth: number;
  forkAfterTurn: number;
  subBranchCount: number;
  createdAt: number;
  createdAtLabel: string;
  lastActiveAt: number;
  isSingleTurnRetry: boolean;
  cues: string[];
  preview: string;
  diagnostics: NodeDiagnosticStatus[];
  hasContentRisk: boolean;
}

export type StoryBranchSortBy = 'recent' | 'scale';

export interface StoryBranchOverviewItem extends ForkSiblingBranch {
  forkParentNodeId: string | null;
  ancestorSearchText: string;
}

export interface StoryTreeOverview {
  totalEffectiveBranches: number;
  totalRetryBranches: number;
  effectiveBranches: StoryBranchOverviewItem[];
  retryBranches: StoryBranchOverviewItem[];
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

const MIN_VALID_BRANCH_TIMESTAMP_MS = 946684800000;

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
    preview: formatTurnPreview(last),
    diagnosticsCount: countDiagnostics(nodes),
    isActiveEnd,
  };
}

/**
 * Formats a branch creation timestamp as `YYYY-MM-DD HH:mm`, returning `时间未知` for legacy/invalid timestamps.
 */
export function formatBranchCreatedAt(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt < MIN_VALID_BRANCH_TIMESTAMP_MS) {
    return '时间未知';
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Derives a compact branch title without LLM calls:
 * customName > normalized turnSummary (entry/leaf assistant, max 12 chars) > plain-text preview (max 12 chars) > fallbackLabel.
 */
export function deriveBranchShortTitle(
  story: Story,
  branchLine: readonly TurnNode[],
  entryNodeId: string,
  fallbackLabel: string,
): string {
  const customName = story.branchNames?.[entryNodeId]?.trim();
  if (customName) return customName;

  const entryNode = branchLine[0];
  const leafNode = branchLine[branchLine.length - 1];
  const assistantSummaryNodes = [entryNode, leafNode].filter(
    (node): node is TurnNode =>
      Boolean(node && node.role === 'assistant' && node.turnSummary?.trim()),
  );
  for (const node of assistantSummaryNodes) {
    const summaryTitle = toCompactPreview(node.turnSummary ?? '', 12, '');
    if (summaryTitle) return summaryTitle;
  }

  for (const node of [entryNode, leafNode]) {
    if (!node) continue;
    const previewTitle = toCompactPreview(node.content, 12, '');
    if (previewTitle) return previewTitle;
  }

  return fallbackLabel;
}

/**
 * Splits a linear Story Tree span along the active path into bounded stage segments (default 50 turns each).
 */
export function projectStoryTreeSpanSegments(
  story: Story,
  spanItem: StoryTreeSpanItem,
  maxTurnsPerSegment = SPAN_STAGE_MAX_TURNS,
): StoryTreeSpanSegment[] {
  const limit = Number.isFinite(maxTurnsPerSegment)
    ? Math.max(1, Math.floor(maxTurnsPerSegment))
    : SPAN_STAGE_MAX_TURNS;
  const activePath = getActiveBranchNodes(story, story.activeLeafNodeId);
  const startIndex = activePath.findIndex((node) => node.id === spanItem.startNodeId);
  const endIndex = activePath.findIndex((node) => node.id === spanItem.endNodeId);
  if (startIndex < 0 || endIndex < startIndex) return [];

  const spanStartTurn = Math.floor(startIndex / 2) + 1;
  const segments: StoryTreeSpanSegment[] = [];
  let bucketNodes: TurnNode[] = [];
  let bucketStartIndex = startIndex;
  let currentBucket = -1;

  const flushSegment = (bucketEndIndex: number) => {
    if (bucketNodes.length === 0) return;
    const first = bucketNodes[0];
    const last = bucketNodes[bucketNodes.length - 1];
    const startTurn = Math.floor(bucketStartIndex / 2) + 1;
    const endTurn = Math.floor(bucketEndIndex / 2) + 1;
    segments.push({
      id: `${spanItem.id}:seg:${first.id}:${last.id}`,
      startNodeId: first.id,
      endNodeId: last.id,
      startTurn,
      endTurn,
      turnCount: endTurn - startTurn + 1,
      nodeIds: bucketNodes.map((n) => n.id),
      preview: formatTurnPreview(last),
      diagnosticsCount: countDiagnostics(bucketNodes),
    });
  };

  for (let idx = startIndex; idx <= endIndex; idx += 1) {
    const nodeTurn = Math.floor(idx / 2) + 1;
    const bucket = Math.floor((nodeTurn - spanStartTurn) / limit);
    if (bucket !== currentBucket) {
      flushSegment(idx - 1);
      bucketNodes = [];
      bucketStartIndex = idx;
      currentBucket = bucket;
    }
    bucketNodes.push(activePath[idx]);
  }
  flushSegment(endIndex);

  return segments;
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

function countDescendantSubBranches(
  entryNodeId: string,
  childrenByParent: ReadonlyMap<string, TurnNode[]>,
): number {
  let subBranches = 0;
  const stack = [entryNodeId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const children = childrenByParent.get(currentId) ?? [];
    if (children.length > 1) {
      subBranches += children.length - 1;
    }
    for (const child of children) {
      if (!visited.has(child.id)) {
        stack.push(child.id);
      }
    }
  }

  return subBranches;
}

function buildBranchMetadata(params: {
  story: Story;
  entryNode: TurnNode;
  branchLine: readonly TurnNode[];
  siblingIndex: number;
  siblingCount: number;
  forkAfterTurn: number;
  subBranchCount: number;
  isActive: boolean;
}): ForkSiblingBranch {
  const {
    story,
    entryNode,
    branchLine,
    siblingIndex,
    siblingCount,
    forkAfterTurn,
    subBranchCount,
    isActive,
  } = params;
  const leaf = branchLine[branchLine.length - 1] ?? entryNode;
  const totalNodes = countNodesToRoot(story, leaf.id);

  const diagnosticsSet = new Set<NodeDiagnosticStatus>();
  let hasContentRisk = false;
  let lastActiveAt = entryNode.createdAt;
  for (const node of branchLine) {
    if (node.diagnostics?.sourceStatus) diagnosticsSet.add(node.diagnostics.sourceStatus);
    if (node.diagnostics?.contentRisk) hasContentRisk = true;
    if (node.createdAt > lastActiveAt) lastActiveAt = node.createdAt;
  }

  const customName = story.branchNames?.[entryNode.id]?.trim();
  const aiGist = story.branchSummaries?.[entryNode.id]?.trim();
  const fallbackLabel = `分支 ${siblingIndex + 1}`;
  const branchTurnCount = Math.max(1, Math.ceil(branchLine.length / 2));
  const createdAt = entryNode.createdAt;
  const isSingleTurnRetry =
    !isActive &&
    !customName &&
    subBranchCount === 0 &&
    ((entryNode.role === 'assistant' && branchLine.length === 1) ||
      (branchTurnCount === 1 && siblingCount > 2));

  return {
    entryNodeId: entryNode.id,
    leafId: leaf.id,
    leafRole: leaf.role,
    label: customName || fallbackLabel,
    shortTitle: deriveBranchShortTitle(story, branchLine, entryNode.id, fallbackLabel),
    ...(customName ? { customName } : {}),
    ...(aiGist ? { aiGist } : {}),
    isActive,
    branchTurnCount,
    totalTurnDepth: Math.max(1, Math.ceil(totalNodes / 2)),
    forkAfterTurn,
    subBranchCount,
    createdAt,
    createdAtLabel: formatBranchCreatedAt(createdAt),
    lastActiveAt,
    isSingleTurnRetry,
    cues: extractBranchLocalCues(branchLine),
    preview: formatTurnPreview(leaf),
    diagnostics: Array.from(diagnosticsSet),
    hasContentRisk,
  };
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
  const forkAfterTurn =
    parentNodeId === null ? 0 : Math.ceil(countNodesToRoot(story, parentNodeId) / 2);

  return siblings.map((entryNode, index) => {
    const branchLine = collectBranchLine(story, entryNode.id, {
      childrenByParent,
      subtreeMaxMap,
      activePathIds,
    });
    const subBranchCount = countDescendantSubBranches(entryNode.id, childrenByParent);
    return buildBranchMetadata({
      story,
      entryNode,
      branchLine,
      siblingIndex: index,
      siblingCount: siblings.length,
      forkAfterTurn,
      subBranchCount,
      isActive: activePathIds.has(entryNode.id),
    });
  });
}

function collectAncestorSearchText(story: Story, entryNode: TurnNode): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const addToken = (raw?: string) => {
    const trimmed = raw?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    tokens.push(trimmed);
  };

  const visited = new Set<string>([entryNode.id]);
  let cursor = entryNode.parentId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = story.nodes[cursor];
    if (!node) break;
    addToken(story.branchNames?.[node.id]);
    addToken(story.branchSummaries?.[node.id]);
    for (const cue of extractBranchLocalCues([node])) {
      addToken(cue);
    }
    cursor = node.parentId;
  }

  return tokens.join(' ');
}

function sortBranchOverviewItems(
  items: readonly StoryBranchOverviewItem[],
  sortBy: StoryBranchSortBy,
): StoryBranchOverviewItem[] {
  return [...items].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (sortBy === 'scale') {
      if (b.branchTurnCount !== a.branchTurnCount) return b.branchTurnCount - a.branchTurnCount;
      if (b.subBranchCount !== a.subBranchCount) return b.subBranchCount - a.subBranchCount;
      if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
      return a.entryNodeId.localeCompare(b.entryNodeId);
    }
    if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.entryNodeId.localeCompare(b.entryNodeId);
  });
}

/**
 * Projects all independent terminal paths across the entire Story tree for overview, search, and retry folding.
 */
export function projectStoryTreeOverview(story: Story): StoryTreeOverview {
  const allNodes = Object.values(story.nodes);
  if (allNodes.length === 0) {
    return {
      totalEffectiveBranches: 0,
      totalRetryBranches: 0,
      effectiveBranches: [],
      retryBranches: [],
    };
  }

  const childrenByParent = buildChildrenByParent(story);
  const rootNodes = getRootNodes(story);
  const leaves = sortNodesChronologically(
    allNodes.filter((node) => (childrenByParent.get(node.id) ?? []).length === 0),
  );

  const effectiveBranches: StoryBranchOverviewItem[] = [];
  const retryBranches: StoryBranchOverviewItem[] = [];

  for (const leaf of leaves) {
    const pathReversed: TurnNode[] = [leaf];
    const visited = new Set<string>([leaf.id]);
    let cursor: TurnNode = leaf;
    let forkParentNodeId: string | null = null;

    while (cursor.parentId) {
      const parent = story.nodes[cursor.parentId];
      if (!parent || visited.has(parent.id)) break;
      const parentChildren = childrenByParent.get(parent.id) ?? [];
      if (parentChildren.length > 1) {
        forkParentNodeId = parent.id;
        break;
      }
      visited.add(parent.id);
      pathReversed.push(parent);
      cursor = parent;
    }

    const branchLine = pathReversed.reverse();
    const entryNode = branchLine[0];
    const siblings =
      forkParentNodeId === null ? rootNodes : (childrenByParent.get(forkParentNodeId) ?? []);
    const siblingIndex = Math.max(0, siblings.findIndex((s) => s.id === entryNode.id));
    const siblingCount = Math.max(1, siblings.length);
    const forkAfterTurn =
      forkParentNodeId === null ? 0 : Math.ceil(countNodesToRoot(story, forkParentNodeId) / 2);

    const metadata = buildBranchMetadata({
      story,
      entryNode,
      branchLine,
      siblingIndex,
      siblingCount,
      forkAfterTurn,
      subBranchCount: countDescendantSubBranches(entryNode.id, childrenByParent),
      isActive: leaf.id === story.activeLeafNodeId,
    });

    const overviewItem: StoryBranchOverviewItem = {
      ...metadata,
      forkParentNodeId,
      ancestorSearchText: collectAncestorSearchText(story, entryNode),
    };

    if (overviewItem.isSingleTurnRetry) {
      retryBranches.push(overviewItem);
    } else {
      effectiveBranches.push(overviewItem);
    }
  }

  const sortedEffective = sortBranchOverviewItems(effectiveBranches, 'recent');
  const sortedRetries = sortBranchOverviewItems(retryBranches, 'recent');

  return {
    totalEffectiveBranches: sortedEffective.length,
    totalRetryBranches: sortedRetries.length,
    effectiveBranches: sortedEffective,
    retryBranches: sortedRetries,
  };
}

/**
 * Filters and sorts overview branches locally without LLM calls.
 */
export function queryStoryBranches(
  overview: StoryTreeOverview,
  options?: { query?: string; sortBy?: StoryBranchSortBy; includeRetries?: boolean },
): StoryBranchOverviewItem[] {
  const query = options?.query?.trim().toLowerCase() ?? '';
  const sortBy: StoryBranchSortBy = options?.sortBy ?? 'recent';
  const includeRetries = options?.includeRetries ?? false;

  const pool = includeRetries
    ? [...overview.effectiveBranches, ...overview.retryBranches]
    : [...overview.effectiveBranches];

  const filtered = query
    ? pool.filter((item) => {
        const forkText =
          item.forkAfterTurn === 0
            ? '开局 开局分支'
            : `第 ${item.forkAfterTurn} 轮 第${item.forkAfterTurn}轮`;
        const haystack = [
          item.shortTitle,
          item.label,
          item.customName ?? '',
          item.preview,
          item.cues.join(' '),
          item.ancestorSearchText,
          forkText,
        ]
          .join('\n')
          .toLowerCase();
        return haystack.includes(query);
      })
    : pool;

  return sortBranchOverviewItems(filtered, sortBy);
}

/**
 * Builds an on-demand branch gist request strictly excluding reasoningContent and NodeDiagnostics.
 */
export function buildBranchGistMessages(
  story: Story,
  branchEntryNodeId: string,
): LlmMessage[] {
  const branchLine = collectBranchLine(story, branchEntryNodeId);
  const progress = getActiveSummarySnapshot(story, branchLine.at(-1)?.id ?? null).content.trim();
  const transcript = branchLine
    .slice(-12)
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
      content: [progress && `当前进度：${progress}`, transcript].filter(Boolean).join('\n\n') || '（暂无对话内容）',
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
