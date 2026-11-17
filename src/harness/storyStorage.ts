import type {
  Story,
  StoryBackupEnvelope,
  StoryBlueprint,
  StoryStorage,
  TurnNode,
} from './types.ts';

function cloneStory(story: Story): Story {
  return JSON.parse(JSON.stringify(story)) as Story;
}

function defaultCreateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function validateBlueprint(raw: unknown): StoryBlueprint {
  if (!isRecord(raw) || typeof raw.title !== 'string') {
    throw new Error('备份文件缺少有效的故事蓝图字段。');
  }
  return {
    title: raw.title,
    worldRules: Array.isArray(raw.worldRules) ? raw.worldRules.filter((x): x is string => typeof x === 'string') : [],
    protagonist: typeof raw.protagonist === 'string' ? raw.protagonist : '',
    npcs: Array.isArray(raw.npcs)
      ? raw.npcs
          .filter(isRecord)
          .map((n) => ({
            name: typeof n.name === 'string' ? n.name : '',
            role: typeof n.role === 'string' ? n.role : '',
            traits: typeof n.traits === 'string' ? n.traits : '',
          }))
          .filter((n) => n.name.length > 0)
      : [],
    taboos: Array.isArray(raw.taboos) ? raw.taboos.filter((x): x is string => typeof x === 'string') : [],
    openingHook: typeof raw.openingHook === 'string' ? raw.openingHook : '',
    extractionStatus: raw.extractionStatus === 'complete' ? 'complete' : 'partial_fallback',
  };
}

function validateNodes(raw: unknown): Record<string, TurnNode> {
  if (!isRecord(raw)) {
    throw new Error('备份文件缺少有效的节点树记录。');
  }
  const nodes: Record<string, TurnNode> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      typeof entry.content !== 'string'
    ) {
      throw new Error(`备份文件中的节点 ${id} 格式无效。`);
    }
    const snap = isRecord(entry.summarySnapshot) ? entry.summarySnapshot : {};
    nodes[id] = {
      id: entry.id,
      parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
      role: entry.role,
      content: entry.content,
      ...(typeof entry.reasoningContent === 'string' ? { reasoningContent: entry.reasoningContent } : {}),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      summarySnapshot: {
        content: typeof snap.content === 'string' ? snap.content : '',
        coveredUpToNodeId:
          typeof snap.coveredUpToNodeId === 'string' ? snap.coveredUpToNodeId : null,
        summarizedTurnCount:
          typeof snap.summarizedTurnCount === 'number' ? snap.summarizedTurnCount : 0,
      },
    };
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
  createId: () => string = defaultCreateId,
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
    !Array.isArray(rawStory.rootNodeIds)
  ) {
    throw new Error('备份文件中的故事主体结构不完整。');
  }

  const blueprint = validateBlueprint(rawStory.blueprint);
  const nodes = validateNodes(rawStory.nodes);
  const existingSet = new Set(existingStoryIds);
  const hasCollision = existingSet.has(rawStory.id);
  const timestamp = now();

  return {
    id: hasCollision ? createId() : rawStory.id,
    title: hasCollision ? `${rawStory.title}（导入副本）` : rawStory.title,
    rawScript: rawStory.rawScript,
    blueprint,
    nodes,
    rootNodeIds: rawStory.rootNodeIds.filter((id): id is string => typeof id === 'string'),
    activeLeafNodeId:
      typeof rawStory.activeLeafNodeId === 'string' ? rawStory.activeLeafNodeId : null,
    createdAt: typeof rawStory.createdAt === 'number' ? rawStory.createdAt : timestamp,
    updatedAt: timestamp,
  };
}
