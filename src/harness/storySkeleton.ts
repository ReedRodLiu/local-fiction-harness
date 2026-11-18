import type { NodeDiagnosticStatus, Story, TurnNode } from './types.ts';

export interface RedactedStorySkeletonNode {
  id: string;
  parentId: string | null;
  role: TurnNode['role'];
  isSetupNode: boolean;
  contentLen: number;
  reasoningLen: number;
  diagnostics?: {
    sourceStatus?: NodeDiagnosticStatus;
    contentRisk?: boolean;
  };
  summaryCoveredCount: number;
  summaryContentLen: number;
}

export interface RedactedStorySkeleton {
  storyAnonId: 's1';
  sourceKind: 'manual_script' | 'deepseek_import' | 'unknown';
  blueprintStatus: 'complete' | 'partial_fallback';
  activeLeafAnonId: string | null;
  rawScriptLength: number;
  setupNodeCount: number;
  blueprintCounts: {
    rules: number;
    npcs: number;
    taboos: number;
  };
  forkCount: number;
  branchNamesCount: number;
  branchGistCount: number;
  nodes: RedactedStorySkeletonNode[];
}

/** Projects a story into anonymous topology, counts, and read-only status codes. */
export function buildRedactedStorySkeleton(story: Story): RedactedStorySkeleton {
  const insertionOrder = Object.values(story.nodes).map((node, index) => ({ node, index }));
  const nodeById = new Map(insertionOrder.map(({ node }) => [node.id, node]));
  const creationOrder = insertionOrder.slice().sort(
    (a, b) => a.node.createdAt - b.node.createdAt || a.index - b.index,
  );
  const ordered: TurnNode[] = [];
  const visited = new Set<string>();

  for (const { node: startNode } of creationOrder) {
    if (visited.has(startNode.id)) continue;
    const ancestors: TurnNode[] = [];
    const path = new Set<string>();
    let node: TurnNode | undefined = startNode;
    while (node && !visited.has(node.id) && !path.has(node.id)) {
      ancestors.push(node);
      path.add(node.id);
      const parent: TurnNode | undefined = node.parentId
        ? nodeById.get(node.parentId)
        : undefined;
      if (!parent || visited.has(parent.id)) break;
      node = parent;
    }
    for (let index = ancestors.length - 1; index >= 0; index--) {
      const ancestor = ancestors[index]!;
      if (visited.has(ancestor.id)) continue;
      ordered.push(ancestor);
      visited.add(ancestor.id);
    }
  }

  const anonymousId = new Map(ordered.map((node, index) => [node.id, `n${index + 1}`]));
  const setupNodeIds = new Set(
    (story.setupNodeIds ?? []).filter((id) => nodeById.has(id)),
  );
  const childrenByParent = new Map<string, number>();
  for (const node of ordered) {
    if (node.parentId && nodeById.has(node.parentId)) {
      childrenByParent.set(node.parentId, (childrenByParent.get(node.parentId) ?? 0) + 1);
    }
  }
  const rootFork = story.rootNodeIds.filter((id) => nodeById.has(id)).length > 1 ? 1 : 0;
  const sourceKind = (story as Story & { sourceKind?: unknown }).sourceKind;

  return {
    storyAnonId: 's1',
    sourceKind: sourceKind === 'manual_script' || sourceKind === 'deepseek_import'
      ? sourceKind
      : 'unknown',
    blueprintStatus:
      story.blueprint.extractionStatus === 'complete' ? 'complete' : 'partial_fallback',
    activeLeafAnonId: story.activeLeafNodeId
      ? anonymousId.get(story.activeLeafNodeId) ?? null
      : null,
    rawScriptLength: story.rawScript.length,
    setupNodeCount: setupNodeIds.size,
    blueprintCounts: {
      rules: story.blueprint.worldRules.length,
      npcs: story.blueprint.npcs.length,
      taboos: story.blueprint.taboos.length,
    },
    forkCount: rootFork + Array.from(childrenByParent.values()).filter((count) => count > 1).length,
    branchNamesCount: Object.keys(story.branchNames ?? {}).length,
    branchGistCount: Object.keys(story.branchSummaries ?? {}).length,
    nodes: ordered.map((node) => {
      const sourceStatus = node.diagnostics?.sourceStatus;
      const contentRisk = node.diagnostics?.contentRisk;
      const diagnostics = {
        ...(sourceStatus === 'CONTENT_FILTER' || sourceStatus === 'TIMEOUT' || sourceStatus === 'INCOMPLETE'
          ? { sourceStatus }
          : {}),
        ...(typeof contentRisk === 'boolean' ? { contentRisk } : {}),
      };

      return {
        id: anonymousId.get(node.id)!,
        parentId: node.parentId === null ? null : anonymousId.get(node.parentId) ?? null,
        role: node.role === 'assistant' ? 'assistant' : 'user',
        isSetupNode: setupNodeIds.has(node.id),
        contentLen: node.content.length,
        reasoningLen: node.reasoningContent?.length ?? 0,
        ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
        summaryCoveredCount: node.summarySnapshot.summarizedTurnCount,
        summaryContentLen: node.summarySnapshot.content.length,
      };
    }),
  };
}
