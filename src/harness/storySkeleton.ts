import type { CreativeWorkspaceState, DraftWork, LocalCharacter } from './creative.ts';
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

export type BodyCharBucket = '0' | '1-500' | '501-2000' | '2001-10000' | '10001+';

export interface RedactedWorkspaceStorySummary {
  storyAnonId: string;
  nodeCount: number;
  forkCount: number;
  sourceKind: 'manual_script' | 'deepseek_import' | 'unknown';
}

export interface RedactedWorkSkeleton {
  workAnonId: string;
  bodyCharBucket: BodyCharBucket;
  suggestionCount: number;
  discussionTurnCount: number;
  hasSourceStory: boolean;
  documentVersionCount: number;
}

export interface RedactedCharacterSkeleton {
  charAnonId: string;
  conversationCount: number;
  turnCounts: number[];
  documentVersionCount: number;
}

export interface RedactedWorkspaceSkeleton {
  storyCount: number;
  workCount: number;
  characterCount: number;
  stories: RedactedWorkspaceStorySummary[];
  works: RedactedWorkSkeleton[];
  characters: RedactedCharacterSkeleton[];
}

export interface WorkspaceSkeletonInput {
  stories?: readonly Story[];
  storyCount?: number;
  creativeWorkspace?: Pick<CreativeWorkspaceState, 'works' | 'characters'> | null;
  works?: readonly DraftWork[];
  characters?: readonly LocalCharacter[];
}

function resolveStorySourceKind(story: Story): 'manual_script' | 'deepseek_import' | 'unknown' {
  const sourceKind = (story as Story & { sourceKind?: unknown }).sourceKind;
  return sourceKind === 'manual_script' || sourceKind === 'deepseek_import'
    ? sourceKind
    : 'unknown';
}

function countStoryForks(story: Story, orderedNodes: readonly TurnNode[], nodeById: ReadonlyMap<string, TurnNode>): number {
  const childrenByParent = new Map<string, number>();
  for (const node of orderedNodes) {
    if (node.parentId && nodeById.has(node.parentId)) {
      childrenByParent.set(node.parentId, (childrenByParent.get(node.parentId) ?? 0) + 1);
    }
  }
  const rootFork = (story.rootNodeIds ?? []).filter((id) => nodeById.has(id)).length > 1 ? 1 : 0;
  return rootFork + Array.from(childrenByParent.values()).filter((count) => count > 1).length;
}

function toBodyCharBucket(length: number): BodyCharBucket {
  if (length <= 0) return '0';
  if (length <= 500) return '1-500';
  if (length <= 2000) return '501-2000';
  if (length <= 10000) return '2001-10000';
  return '10001+';
}

function countDocumentVersions(doc: unknown): number {
  if (!doc || typeof doc !== 'object') return 0;
  const versions = (doc as { versions?: unknown }).versions;
  if (!versions || typeof versions !== 'object') return 0;
  return Object.keys(versions).length;
}

/** Projects a story into anonymous topology, counts, and read-only status codes. */
export function buildRedactedStorySkeleton(story: Story): RedactedStorySkeleton {
  const rawNodes = Object.values(story.nodes ?? {});
  const insertionOrder = rawNodes.map((node, index) => ({ node, index }));
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
  const blueprint = story.blueprint;

  return {
    storyAnonId: 's1',
    sourceKind: resolveStorySourceKind(story),
    blueprintStatus:
      blueprint?.extractionStatus === 'complete' ? 'complete' : 'partial_fallback',
    activeLeafAnonId: story.activeLeafNodeId
      ? anonymousId.get(story.activeLeafNodeId) ?? null
      : null,
    rawScriptLength: typeof story.rawScript === 'string' ? story.rawScript.length : 0,
    setupNodeCount: setupNodeIds.size,
    blueprintCounts: {
      rules: blueprint?.worldRules?.length ?? 0,
      npcs: blueprint?.npcs?.length ?? 0,
      taboos: blueprint?.taboos?.length ?? 0,
    },
    forkCount: countStoryForks(story, ordered, nodeById),
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
        summaryCoveredCount: node.summarySnapshot?.summarizedTurnCount ?? 0,
        summaryContentLen: node.summarySnapshot?.content?.length ?? 0,
      };
    }),
  };
}

/** Projects all 3 creative modes into anonymized structural counts with zero titles, names, or text. */
export function buildRedactedWorkspaceSkeleton(
  input: WorkspaceSkeletonInput,
): RedactedWorkspaceSkeleton {
  const stories = input.stories ?? [];
  const works = input.creativeWorkspace?.works ?? input.works ?? [];
  const characters = input.creativeWorkspace?.characters ?? input.characters ?? [];
  const rawStoryCount =
    typeof input.storyCount === 'number' && Number.isInteger(input.storyCount) && input.storyCount >= 0
      ? input.storyCount
      : stories.length;

  return {
    storyCount: Math.max(rawStoryCount, stories.length),
    workCount: works.length,
    characterCount: characters.length,
    stories: stories.map((story, index) => {
      const nodes = Object.values(story.nodes ?? {});
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      return {
        storyAnonId: `s${index + 1}`,
        nodeCount: nodes.length,
        forkCount: countStoryForks(story, nodes, nodeById),
        sourceKind: resolveStorySourceKind(story),
      };
    }),
    works: works.map((work, index) => {
      const discussionArrayLen = Array.isArray(work.discussion) ? work.discussion.length : 0;
      const workWithNodes = work as DraftWork & { nodes?: Record<string, TurnNode> };
      const discussionNodeLen =
        workWithNodes.nodes && typeof workWithNodes.nodes === 'object'
          ? Object.keys(workWithNodes.nodes).length
          : 0;
      return {
        workAnonId: `w${index + 1}`,
        bodyCharBucket: toBodyCharBucket(typeof work.body === 'string' ? work.body.length : 0),
        suggestionCount: Array.isArray(work.suggestions) ? work.suggestions.length : 0,
        discussionTurnCount: Math.max(discussionArrayLen, discussionNodeLen),
        hasSourceStory: Boolean(work.source && typeof work.source.storyId === 'string' && work.source.storyId.length > 0),
        documentVersionCount: countDocumentVersions(work.document),
      };
    }),
    characters: characters.map((character, index) => {
      const conversations = Array.isArray(character.conversations) ? character.conversations : [];
      return {
        charAnonId: `c${index + 1}`,
        conversationCount: conversations.length,
        turnCounts: conversations.map((conversation) =>
          conversation?.nodes && typeof conversation.nodes === 'object'
            ? Object.keys(conversation.nodes).length
            : 0,
        ),
        documentVersionCount: countDocumentVersions(character.document),
      };
    }),
  };
}
