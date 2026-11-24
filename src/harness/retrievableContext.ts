import type { LlmMessage, TurnNode } from './types.ts';

export const DEFAULT_RETRIEVABLE_CONTEXT_LIMIT = 3;
export const DEFAULT_RETRIEVABLE_CONTEXT_MAX_CHARS = 2400;
const MINIMUM_SCORE_WITHOUT_EXACT_MATCH = 4;

const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '自己', '什么', '怎么', '怎样', '为什么',
  '这个', '那个', '这些', '那些', '这里', '那里', '没有', '不是', '不会',
  '可以', '能够', '应该', '已经', '现在', '刚才', '之后', '以前', '以后',
  '就是', '还是', '或者', '因为', '所以', '如果', '虽然', '但是', '不过',
  '一个', '一下', '一直', '一起', '起来', '下来', '进去', '出来', '过来',
  '知道', '觉得', '看着', '看到', '看见', '看看', '听见', '问他', '问她',
  '不要', '不能', '继续', '然后', '接着',
]);

export interface RetrievableTurnSelection {
  node: TurnNode;
  score: number;
  pathTurnNumber: number;
  content: string;
}

export interface RetrievableContextResult {
  pathNodeIds: string[];
  candidateNodeIds: string[];
  selected: RetrievableTurnSelection[];
  totalChars: number;
}

export interface RetrieveCoveredBranchContextOptions {
  nodes: Record<string, TurnNode>;
  targetParentId: string | null;
  coveredUpToNodeId: string | null;
  excludeNodeIds?: ReadonlySet<string>;
  excludeSetupIds?: ReadonlySet<string>;
  query: string;
  limit?: number;
  maxChars?: number;
  formatContent?: (node: TurnNode) => string;
}

function walkBranchPath(
  nodes: Record<string, TurnNode>,
  leafId: string | null,
): TurnNode[] {
  const path: TurnNode[] = [];
  const visited = new Set<string>();
  let cursor = leafId;
  while (cursor) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const node = Object.hasOwn(nodes, cursor) ? nodes[cursor] : undefined;
    if (!node) break;
    path.push(node);
    cursor = node.parentId;
  }
  return path.reverse();
}

function normalizedQueryTerms(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s，。！？、；：“”‘’"'（）()[\]{}<>《》【】]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreNodeContent(
  text: string,
  terms: readonly string[],
): { score: number; hasExactTerm: boolean } {
  const normalized = text.normalize('NFKC').toLowerCase();
  let score = 0;
  let hasExactTerm = false;

  for (const term of terms) {
    if (normalized.includes(term)) {
      hasExactTerm = true;
      score += term.length * 20;
    }
    for (let index = 0; index < term.length - 1; index += 1) {
      const bigram = term.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(bigram) && normalized.includes(bigram)) {
        score += 4;
      }
      if (index + 3 <= term.length) {
        const trigram = term.slice(index, index + 3);
        if (normalized.includes(trigram)) {
          score += 6;
        }
      }
    }
  }

  return { score, hasExactTerm };
}

/**
 * Retrieves relevant historical turns strictly from the current active branch
 * (which already contains shared ancestors and excludes all sibling/foreign branches),
 * limited to nodes outside the active recent window (e.g., summary-covered or trimmed turns).
 */
export function retrieveCoveredBranchContext(
  options: RetrieveCoveredBranchContextOptions,
): RetrievableContextResult {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_RETRIEVABLE_CONTEXT_LIMIT));
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? DEFAULT_RETRIEVABLE_CONTEXT_MAX_CHARS));
  const branchNodes = walkBranchPath(options.nodes, options.targetParentId);
  const pathNodeIds = branchNodes.map((node) => node.id);

  if (limit === 0 || maxChars === 0 || branchNodes.length === 0) {
    return { pathNodeIds, candidateNodeIds: [], selected: [], totalChars: 0 };
  }

  const terms = normalizedQueryTerms(options.query);
  if (terms.length === 0) {
    return { pathNodeIds, candidateNodeIds: [], selected: [], totalChars: 0 };
  }

  const excludeNodeIds = options.excludeNodeIds ?? new Set<string>();
  const excludeSetupIds = options.excludeSetupIds ?? new Set<string>();
  const coveredIdx = options.coveredUpToNodeId
    ? branchNodes.findIndex((node) => node.id === options.coveredUpToNodeId)
    : -1;

  const firstExcludedIndex = branchNodes.findIndex((node) => excludeNodeIds.has(node.id));
  const eligibleBoundary =
    firstExcludedIndex >= 0
      ? Math.max(coveredIdx + 1, firstExcludedIndex)
      : coveredIdx + 1;

  if (eligibleBoundary <= 0) {
    return { pathNodeIds, candidateNodeIds: [], selected: [], totalChars: 0 };
  }

  const formatContent = options.formatContent ?? ((node: TurnNode) => node.content);
  const scoredCandidates: Array<{
    selection: RetrievableTurnSelection;
    pathIndex: number;
  }> = [];
  const candidateNodeIds: string[] = [];

  for (let index = 0; index < eligibleBoundary; index += 1) {
    const node = branchNodes[index];
    if (
      excludeNodeIds.has(node.id) ||
      excludeSetupIds.has(node.id) ||
      node.diagnostics?.sourceStatus === 'REFUSAL'
    ) {
      continue;
    }
    const content = formatContent(node).trim();
    if (!content) continue;

    candidateNodeIds.push(node.id);
    const { score, hasExactTerm } = scoreNodeContent(content, terms);
    if (score <= 0 || (!hasExactTerm && score < MINIMUM_SCORE_WITHOUT_EXACT_MATCH)) {
      continue;
    }

    scoredCandidates.push({
      pathIndex: index,
      selection: {
        node,
        score,
        pathTurnNumber: Math.floor(index / 2) + 1,
        content,
      },
    });
  }

  scoredCandidates.sort(
    (left, right) =>
      right.selection.score - left.selection.score ||
      right.selection.node.createdAt - left.selection.node.createdAt,
  );

  const chosen: Array<{ selection: RetrievableTurnSelection; pathIndex: number }> = [];
  let usedChars = 0;
  for (const candidate of scoredCandidates) {
    if (chosen.length >= limit) break;
    const content =
      candidate.selection.content.length > maxChars && chosen.length === 0
        ? candidate.selection.content.slice(0, maxChars)
        : candidate.selection.content;
    if (chosen.length > 0 && usedChars + content.length > maxChars) continue;
    usedChars += content.length;
    chosen.push({
      pathIndex: candidate.pathIndex,
      selection: { ...candidate.selection, content },
    });
  }

  chosen.sort((left, right) => left.pathIndex - right.pathIndex);
  const selected = chosen.map((item) => item.selection);

  return {
    pathNodeIds,
    candidateNodeIds,
    selected,
    totalChars: selected.reduce((sum, entry) => sum + entry.content.length, 0),
  };
}

export function formatRetrievableContextMessage(
  selected: readonly RetrievableTurnSelection[],
): LlmMessage | null {
  if (selected.length === 0) return null;
  const lines = selected.map((entry) => {
    const speaker = entry.node.role === 'user' ? '玩家/用户' : 'AI/前文';
    return `- [第 ${entry.pathTurnNumber} 轮 · ${speaker}] ${entry.content}`;
  });
  return {
    role: 'system',
    content: `## 按需回取当前分支前情（已隔离其他分支，仅供当前回合核对细节）\n${lines.join('\n')}`,
  };
}
