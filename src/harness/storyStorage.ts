import { createDefaultId } from './id.ts';
import type {
  NodeDiagnosticStatus,
  NodeDiagnostics,
  PlotSummarySnapshot,
  Story,
  StoryBackupEnvelope,
  StoryBlueprint,
  StoryStorage,
  TurnNode,
} from './types.ts';

function cloneStory(story: Story): Story {
  return JSON.parse(JSON.stringify(story)) as Story;
}

export function createInMemoryStoryStorage(): StoryStorage {
  const stories = new Map<string, Story>();
  let activeStoryId: string | null = null;

  return {
    async listStories(): Promise<Story[]> {
      return Array.from(stories.values())
        .map(cloneStory)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getStory(id: string): Promise<Story | null> {
      const found = stories.get(id);
      return found ? cloneStory(found) : null;
    },

    async saveStory(story: Story): Promise<void> {
      stories.set(story.id, cloneStory(story));
    },

    async deleteStory(id: string): Promise<void> {
      stories.delete(id);
      if (activeStoryId === id) {
        activeStoryId = null;
      }
    },

    async getActiveStoryId(): Promise<string | null> {
      return activeStoryId;
    },

    async setActiveStoryId(id: string | null): Promise<void> {
      activeStoryId = id;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`备份文件字段 ${fieldName} 必须为字符串数组。`);
  }
  return value;
}

function validateBlueprint(raw: unknown): StoryBlueprint {
  if (
    !isRecord(raw) ||
    typeof raw.title !== 'string' ||
    typeof raw.protagonist !== 'string' ||
    typeof raw.openingHook !== 'string' ||
    (raw.extractionStatus !== 'complete' && raw.extractionStatus !== 'partial_fallback')
  ) {
    throw new Error('备份文件的故事蓝图字段无效。');
  }

  const worldRules = assertStringArray(raw.worldRules, 'blueprint.worldRules');
  const taboos = assertStringArray(raw.taboos, 'blueprint.taboos');

  if (!Array.isArray(raw.npcs)) {
    throw new Error('备份文件字段 blueprint.npcs 必须为数组。');
  }

  const npcs = raw.npcs.map((n, index) => {
    if (
      !isRecord(n) ||
      typeof n.name !== 'string' ||
      typeof n.role !== 'string' ||
      typeof n.traits !== 'string'
    ) {
      throw new Error(`备份文件角色条目 npcs[${index}] 结构无效。`);
    }
    return { name: n.name, role: n.role, traits: n.traits };
  });

  return {
    title: raw.title,
    worldRules,
    protagonist: raw.protagonist,
    npcs,
    taboos,
    openingHook: raw.openingHook,
    extractionStatus: raw.extractionStatus,
  };
}

function validateSummarySnapshot(raw: unknown, nodeId: string): PlotSummarySnapshot {
  if (
    !isRecord(raw) ||
    typeof raw.content !== 'string' ||
    (raw.coveredUpToNodeId !== null && typeof raw.coveredUpToNodeId !== 'string') ||
    typeof raw.summarizedTurnCount !== 'number'
  ) {
    throw new Error(`备份文件节点 ${nodeId} 的剧情摘要快照无效。`);
  }
  return {
    content: raw.content,
    coveredUpToNodeId: raw.coveredUpToNodeId,
    summarizedTurnCount: raw.summarizedTurnCount,
  };
}

const VALID_DIAGNOSTIC_STATUSES = new Set<NodeDiagnosticStatus>([
  'CONTENT_FILTER',
  'TIMEOUT',
  'INCOMPLETE',
]);

function validateDiagnostics(raw: unknown, nodeId: string): NodeDiagnostics | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`备份文件节点 ${nodeId} 的 diagnostics 格式无效。`);
  }
  const sourceStatus = raw.sourceStatus;
  if (
    sourceStatus !== undefined &&
    (typeof sourceStatus !== 'string' ||
      !VALID_DIAGNOSTIC_STATUSES.has(sourceStatus as NodeDiagnosticStatus))
  ) {
    throw new Error(`备份文件节点 ${nodeId} 的 diagnostics.sourceStatus 无效。`);
  }
  if (raw.contentRisk !== undefined && typeof raw.contentRisk !== 'boolean') {
    throw new Error(`备份文件节点 ${nodeId} 的 diagnostics.contentRisk 必须为布尔值。`);
  }
  const result: { sourceStatus?: NodeDiagnosticStatus; contentRisk?: boolean } = {};
  if (sourceStatus !== undefined) result.sourceStatus = sourceStatus as NodeDiagnosticStatus;
  if (raw.contentRisk !== undefined) result.contentRisk = raw.contentRisk;
  return Object.keys(result).length > 0 ? result : undefined;
}

function validateOptionalStringMap(
  raw: unknown,
  fieldName: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`备份文件字段 ${fieldName} 必须为键值对象。`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      throw new Error(`备份文件字段 ${fieldName}.${k} 必须为字符串。`);
    }
    if (v.trim()) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateNodes(raw: unknown): Record<string, TurnNode> {
  if (!isRecord(raw)) {
    throw new Error('备份文件缺少有效的节点树记录。');
  }
  const nodes: Record<string, TurnNode> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (
      !isRecord(entry) ||
      entry.id !== id ||
      (entry.parentId !== null && typeof entry.parentId !== 'string') ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      typeof entry.content !== 'string' ||
      typeof entry.createdAt !== 'number' ||
      (entry.reasoningContent !== undefined && typeof entry.reasoningContent !== 'string')
    ) {
      throw new Error(`备份文件中的节点 ${id} 格式无效。`);
    }
    const diagnostics = validateDiagnostics(entry.diagnostics, id);
    nodes[id] = {
      id: entry.id,
      parentId: entry.parentId,
      role: entry.role,
      content: entry.content,
      ...(entry.reasoningContent !== undefined ? { reasoningContent: entry.reasoningContent } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      createdAt: entry.createdAt,
      summarySnapshot: validateSummarySnapshot(entry.summarySnapshot, id),
    };
  }

  for (const node of Object.values(nodes)) {
    if (node.parentId !== null && !nodes[node.parentId]) {
      throw new Error(`备份文件节点 ${node.id} 引用了不存在的父节点 ${node.parentId}。`);
    }
    if (node.summarySnapshot.coveredUpToNodeId && !nodes[node.summarySnapshot.coveredUpToNodeId]) {
      throw new Error(
        `备份文件节点 ${node.id} 的摘要指针 ${node.summarySnapshot.coveredUpToNodeId} 不存在。`,
      );
    }
  }
  return nodes;
}

export function exportStoryBackup(story: Story, now: () => number = () => Date.now()): string {
  const envelope: StoryBackupEnvelope = {
    schemaVersion: 1,
    exportedAt: now(),
    story: cloneStory(story),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Validates a versioned Story JSON backup and remaps its story ID if it collides with existing stories.
 */
export function importStoryBackup(
  jsonText: string,
  existingStoryIds: Iterable<string>,
  createId: () => string = createDefaultId,
  now: () => number = () => Date.now(),
): Story {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('备份文件不是有效的 JSON 格式。');
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.story)) {
    throw new Error('不支持的备份版本或缺少 story 主体。');
  }

  const rawStory = parsed.story;
  if (
    typeof rawStory.id !== 'string' ||
    !rawStory.id.trim() ||
    typeof rawStory.title !== 'string' ||
    typeof rawStory.rawScript !== 'string' ||
    typeof rawStory.createdAt !== 'number' ||
    typeof rawStory.updatedAt !== 'number' ||
    (rawStory.activeLeafNodeId !== null && typeof rawStory.activeLeafNodeId !== 'string')
  ) {
    throw new Error('备份文件中的故事主体结构不完整。');
  }

  const rootNodeIds = assertStringArray(rawStory.rootNodeIds, 'story.rootNodeIds');
  const blueprint = validateBlueprint(rawStory.blueprint);
  const nodes = validateNodes(rawStory.nodes);

  for (const rootId of rootNodeIds) {
    if (!nodes[rootId]) {
      throw new Error(`备份文件 rootNodeIds 包含不存在的节点 ${rootId}。`);
    }
  }
  if (rawStory.activeLeafNodeId !== null && !nodes[rawStory.activeLeafNodeId]) {
    throw new Error(`备份文件 activeLeafNodeId ${rawStory.activeLeafNodeId} 不存在。`);
  }

  const branchNames = validateOptionalStringMap(rawStory.branchNames, 'story.branchNames');
  const branchSummaries = validateOptionalStringMap(
    rawStory.branchSummaries,
    'story.branchSummaries',
  );
  let setupNodeIds: string[] | undefined;
  if (rawStory.setupNodeIds !== undefined) {
    const rawSetupIds = assertStringArray(rawStory.setupNodeIds, 'story.setupNodeIds');
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const id of rawSetupIds) {
      if (!nodes[id]) {
        throw new Error(`备份文件 setupNodeIds 包含不存在的节点 ${id}。`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    if (deduped.length > 0) {
      setupNodeIds = deduped;
    }
  }

  const existingSet = new Set(existingStoryIds);
  const hasCollision = existingSet.has(rawStory.id);

  return {
    id: hasCollision ? createId() : rawStory.id,
    title: hasCollision ? `${rawStory.title}（导入副本）` : rawStory.title,
    rawScript: rawStory.rawScript,
    blueprint,
    nodes,
    rootNodeIds,
    activeLeafNodeId: rawStory.activeLeafNodeId,
    ...(setupNodeIds ? { setupNodeIds } : {}),
    ...(branchNames ? { branchNames } : {}),
    ...(branchSummaries ? { branchSummaries } : {}),
    createdAt: rawStory.createdAt,
    updatedAt: hasCollision ? now() : rawStory.updatedAt,
  };
}
