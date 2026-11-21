import type { Story, TurnNode } from './types.ts';

export interface SiblingBranchInfo {
  siblings: TurnNode[];
  currentIndex: number;
  total: number;
  prevSiblingId: string | null;
  nextSiblingId: string | null;
}

export interface BranchLeafSummary {
  leafId: string;
  turnCount: number;
  preview: string;
  isActive: boolean;
}

export function toCompactPreview(text: string, maxLen = 44): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '（空内容）';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
}

export function countNodesToRoot(story: Story, nodeId: string): number {
  let depth = 0;
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: TurnNode | undefined = story.nodes[cursor];
    if (!node) break;
    depth += 1;
    cursor = node.parentId;
  }
  return depth;
}

export function sortNodesChronologically(nodes: TurnNode[]): TurnNode[] {
  return [...nodes].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id),
  );
}

export function buildChildrenByParent(story: Story): Map<string, TurnNode[]> {
  const childrenByParent = new Map<string, TurnNode[]>();
  for (const node of Object.values(story.nodes)) {
    if (node.parentId) {
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node);
      childrenByParent.set(node.parentId, list);
    }
  }
  for (const [parentId, list] of childrenByParent.entries()) {
    childrenByParent.set(parentId, sortNodesChronologically(list));
  }
  return childrenByParent;
}

export function getRootNodes(story: Story): TurnNode[] {
  return sortNodesChronologically(
    story.rootNodeIds
      .map((id) => story.nodes[id])
      .filter((n): n is TurnNode => Boolean(n)),
  );
}

/**
 * Returns all sibling TurnNodes sharing the same parentId as targetNodeId in a generic node map.
 */
export function getNodeSiblingBranchInfo(
  nodes: Record<string, TurnNode>,
  targetNodeId: string,
): SiblingBranchInfo {
  const target = nodes[targetNodeId];
  if (!target) {
    return {
      siblings: [],
      currentIndex: -1,
      total: 0,
      prevSiblingId: null,
      nextSiblingId: null,
    };
  }
  const rawSiblings = Object.values(nodes).filter((n) => n.parentId === target.parentId);
  const siblings = sortNodesChronologically(rawSiblings);
  const currentIndex = siblings.findIndex((n) => n.id === targetNodeId);
  return {
    siblings,
    currentIndex,
    total: siblings.length,
    prevSiblingId: currentIndex > 0 ? siblings[currentIndex - 1].id : null,
    nextSiblingId:
      currentIndex >= 0 && currentIndex < siblings.length - 1
        ? siblings[currentIndex + 1].id
        : null,
  };
}

/**
 * Walks down from targetNodeId in a generic TurnNode map along the most recently active subtree.
 */
export function findLeafForTurnTreeNode(
  nodes: Record<string, TurnNode>,
  targetNodeId: string,
): string | null {
  if (!nodes[targetNodeId]) return null;
  const fakeStory = { nodes, rootNodeIds: [] } as unknown as Story;
  const childrenByParent = buildChildrenByParent(fakeStory);
  return findLeafForBranchNode(fakeStory, targetNodeId, childrenByParent);
}

/**
 * Returns all sibling TurnNodes sharing the same parentId as targetNodeId, ordered by creation time.
 */
export function getSiblingBranchInfo(story: Story, targetNodeId: string): SiblingBranchInfo {
  const target = story.nodes[targetNodeId];
  if (!target) {
    return {
      siblings: [],
      currentIndex: -1,
      total: 0,
      prevSiblingId: null,
      nextSiblingId: null,
    };
  }

  const rawSiblings =
    target.parentId === null
      ? getRootNodes(story)
      : Object.values(story.nodes).filter((n) => n.parentId === target.parentId);

  const siblings = sortNodesChronologically(rawSiblings);
  const currentIndex = siblings.findIndex((n) => n.id === targetNodeId);
  return {
    siblings,
    currentIndex,
    total: siblings.length,
    prevSiblingId: currentIndex > 0 ? siblings[currentIndex - 1].id : null,
    nextSiblingId:
      currentIndex >= 0 && currentIndex < siblings.length - 1
        ? siblings[currentIndex + 1].id
        : null,
  };
}

export function buildSubtreeMaxCreatedAt(
  story: Story,
  childrenByParent: Map<string, TurnNode[]>,
): Map<string, number> {
  const maxMap = new Map<string, number>();
  const visiting = new Set<string>();

  const compute = (nodeId: string): number => {
    const cached = maxMap.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return story.nodes[nodeId]?.createdAt ?? 0;
    visiting.add(nodeId);
    let maxVal = story.nodes[nodeId]?.createdAt ?? 0;
    for (const child of childrenByParent.get(nodeId) ?? []) {
      const childMax = compute(child.id);
      if (childMax > maxVal) maxVal = childMax;
    }
    visiting.delete(nodeId);
    maxMap.set(nodeId, maxVal);
    return maxVal;
  };

  for (const id of Object.keys(story.nodes)) {
    compute(id);
  }
  return maxMap;
}

export function pickActiveOrLatestChild(
  children: readonly TurnNode[],
  subtreeMaxMap: ReadonlyMap<string, number>,
  preferredIds?: ReadonlySet<string>,
): TurnNode | undefined {
  if (children.length === 0) return undefined;
  if (preferredIds) {
    const preferred = children.find((c) => preferredIds.has(c.id));
    if (preferred) return preferred;
  }
  let best = children[0];
  let bestMax = subtreeMaxMap.get(best.id) ?? best.createdAt;
  for (let i = 1; i < children.length; i++) {
    const candidate = children[i];
    const candMax = subtreeMaxMap.get(candidate.id) ?? candidate.createdAt;
    if (
      candMax > bestMax ||
      (candMax === bestMax &&
        (candidate.createdAt > best.createdAt ||
          (candidate.createdAt === best.createdAt && candidate.id.localeCompare(best.id) > 0)))
    ) {
      best = candidate;
      bestMax = candMax;
    }
  }
  return best;
}

/**
 * Walks down from targetNodeId along the most recently active subtree chain to locate its branch leaf node.
 */
export function findLeafForBranchNode(
  story: Story,
  targetNodeId: string,
  childrenByParent: Map<string, TurnNode[]> = buildChildrenByParent(story),
): string | null {
  if (!story.nodes[targetNodeId]) {
    return null;
  }

  const subtreeMaxMap = buildSubtreeMaxCreatedAt(story, childrenByParent);
  let cursor = targetNodeId;
  const visited = new Set<string>([cursor]);

  while (true) {
    const children = childrenByParent.get(cursor);
    if (!children || children.length === 0) {
      return cursor;
    }
    const next = pickActiveOrLatestChild(children, subtreeMaxMap);
    if (!next || visited.has(next.id)) {
      return cursor;
    }
    visited.add(next.id);
    cursor = next.id;
  }
}

/**
 * Lists all leaf endpoints in the Story's branch tree for timeline overview & switching.
 */
export function getBranchTreeSummary(story: Story): BranchLeafSummary[] {
  const parentIds = new Set<string>();
  for (const node of Object.values(story.nodes)) {
    if (node.parentId) {
      parentIds.add(node.parentId);
    }
  }

  const leaves = Object.values(story.nodes).filter((node) => !parentIds.has(node.id));
  const summaries: BranchLeafSummary[] = [];

  for (const leaf of sortNodesChronologically(leaves)) {
    const depth = countNodesToRoot(story, leaf.id);
    const snippet = toCompactPreview(leaf.content, 44);
    summaries.push({
      leafId: leaf.id,
      turnCount: Math.ceil(depth / 2),
      preview: snippet === '（空内容）' ? '' : snippet,
      isActive: leaf.id === story.activeLeafNodeId,
    });
  }

  return summaries;
}
