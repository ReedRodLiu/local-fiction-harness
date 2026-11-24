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

export const AI_PREVIEW_MAX_CHARS = 40;
export const USER_PREVIEW_MAX_CHARS = 30;

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const INTERNAL_LFH_LANG_RE = /^lfh-[a-z0-9_-]+$/i;

function stripInternalAndFenceLines(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const keptLines: string[] = [];
  let activeFence: { char: string; len: number; isInternal: boolean } | null = null;
  let inProposalSearchReplace = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (activeFence) {
      if (activeFence.isInternal) {
        if (/^<<<<<<<\s*SEARCH\b/.test(line.trimEnd()) || /^=======\s*$/.test(line.trimEnd())) {
          inProposalSearchReplace = true;
        } else if (/^>>>>>>>\s*REPLACE\b/.test(line.trimEnd())) {
          inProposalSearchReplace = false;
        }
      }
      const closeMatch = FENCE_CLOSE_RE.exec(line);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFence.char &&
        closeMatch[1].length >= activeFence.len &&
        !inProposalSearchReplace
      ) {
        activeFence = null;
      } else if (!activeFence.isInternal) {
        keptLines.push(line);
      }
      continue;
    }

    const openMatch = FENCE_OPEN_RE.exec(line);
    if (openMatch) {
      const fence = openMatch[1];
      const info = openMatch[2].trim();
      if (fence[0] === '`' && info.includes('`')) {
        keptLines.push(line);
        continue;
      }
      const lang = info.split(/\s+/, 1)[0] ?? '';
      activeFence = {
        char: fence[0],
        len: fence.length,
        isInternal: INTERNAL_LFH_LANG_RE.test(lang),
      };
      inProposalSearchReplace = false;
      continue;
    }

    if (/^[ \t]{0,3}lfh-choices[ \t]*$/i.test(line)) {
      const tail = lines.slice(i + 1).filter((l) => l.trim() !== '');
      if (tail.length >= 2) {
        break;
      }
    }

    keptLines.push(line);
  }

  return keptLines.join('\n');
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/gi, '$1')
    .replace(/`+([^`\n]+)`+/g, '$1')
    .replace(/(\*{3}|_{3})([^\n]+?)\1/g, '$2')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])__([^\n_]+?)__(?=[^\p{L}\p{N}_]|$)/gu, '$1$2')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_([^\n_]+?)_(?=[^\p{L}\p{N}_]|$)/gu, '$1$2')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(/<\/?(?:br|hr|p|div|span|b|i|em|strong|del|s|u|code|pre|blockquote|details|summary|a|img|h[1-6]|ul|ol|li|table|tr|td|th)\b[^>]*>/gi, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
    .replace(/\*{2,}/g, '');
}

/**
 * Strips Markdown syntax and internal `lfh-*` protocol blocks into normalized plain text.
 */
export function stripMarkdownToPlainText(text: string): string {
  if (!text) return '';
  const withoutFences = stripInternalAndFenceLines(text);
  const cleanedLines: string[] = [];

  for (const rawLine of withoutFences.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line)) continue;

    line = line
      .replace(/^(?:>\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '');

    if (line.includes('|')) {
      line = line.replace(/\|/g, ' ');
    }

    line = stripInlineMarkdown(line).replace(/\s+/g, ' ').trim();
    if (line) cleanedLines.push(line);
  }

  return cleanedLines.join(' ').replace(/\s+/g, ' ').trim();
}

export function toCompactPreview(
  text: string,
  maxLen = 44,
  emptyFallback = '（空内容）',
): string {
  const normalized = stripMarkdownToPlainText(text);
  if (!normalized) return emptyFallback;
  const limit = Math.max(1, Math.floor(maxLen));
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  if (limit === 1) return chars[0];
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * Formats a TurnNode for compact Story Tree / branch preview display:
 * prefers persisted `turnSummary` for AI turns, otherwise sanitizes Markdown & truncates cleanly.
 */
export function formatTurnPreview(
  node: Pick<TurnNode, 'role' | 'content' | 'turnSummary' | 'diagnostics'>,
  options?: { aiMaxLen?: number; userMaxLen?: number; emptyFallback?: string },
): string {
  const emptyFallback = options?.emptyFallback ?? '（空内容）';
  if (node.role === 'assistant') {
    const summary =
      node.diagnostics?.sourceStatus === 'REFUSAL' || !node.turnSummary
        ? ''
        : stripMarkdownToPlainText(node.turnSummary);
    if (summary) return summary;
    return toCompactPreview(node.content, options?.aiMaxLen ?? AI_PREVIEW_MAX_CHARS, emptyFallback);
  }
  return toCompactPreview(node.content, options?.userMaxLen ?? USER_PREVIEW_MAX_CHARS, emptyFallback);
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
    const snippet = formatTurnPreview(leaf, { emptyFallback: '' });
    summaries.push({
      leafId: leaf.id,
      turnCount: Math.ceil(depth / 2),
      preview: snippet,
      isActive: leaf.id === story.activeLeafNodeId,
    });
  }

  return summaries;
}
