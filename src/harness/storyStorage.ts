import { documentVersion, migrateStoryDocuments, replaceDocumentProgress, validateDocumentReads, validateMarkdownDocument, writeDocument, type StoryDocuments } from './markdownDocuments.ts';
import { createDefaultId } from './id.ts';
import type {
  NodeDiagnosticStatus,
  NodeDiagnostics,
  PlotSummarySnapshot,
  Story,
  StoryAttachment,
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

    async saveStory(story: Story, expectedUpdatedAt?: number): Promise<void> {
      if (expectedUpdatedAt !== undefined && stories.get(story.id)?.updatedAt !== expectedUpdatedAt) {
        throw new Error('故事版本已变化，请重新核对。');
      }
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
  const nodes: Record<string, TurnNode> = Object.create(null);
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
    const attachmentIds = entry.attachmentIds === undefined ? undefined : assertStringArray(entry.attachmentIds, 'node.attachmentIds');
    const reads = validateDocumentReads(entry.documentReads);
    const documents = entry.documents;
    if (documents !== undefined && (!isRecord(documents) ||
      typeof documents.local !== 'string' || typeof documents.container !== 'string')) {
      throw new Error('备份中的节点文档引用无效。');
    }
    nodes[id] = {
      id: entry.id,
      parentId: entry.parentId,
      role: entry.role,
      content: entry.content,
      ...(entry.reasoningContent !== undefined ? { reasoningContent: entry.reasoningContent } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(attachmentIds ? { attachmentIds } : {}),
      createdAt: entry.createdAt,
      summarySnapshot: validateSummarySnapshot(entry.summarySnapshot, id),
      ...(documents && isRecord(documents) ? { documents: { local: documents.local as string, container: documents.container as string } } : {}),
      ...(reads ? { documentReads: reads } : {}),
    };
  }

  const checked = new Set<string>();
  for (const node of Object.values(nodes)) {
    const chain = new Set<string>();
    let parentId: string | null = node.id;
    while (parentId !== null && !checked.has(parentId)) {
      if (!Object.hasOwn(nodes, parentId) || chain.has(parentId)) {
        throw new Error(`备份文件节点 ${node.id} 的父节点路径无效。`);
      }
      chain.add(parentId);
      parentId = nodes[parentId].parentId;
    }
    for (const id of chain) checked.add(id);
  }
  for (const node of Object.values(nodes)) {
    const coverage = node.summarySnapshot.coveredUpToNodeId;
    if (coverage === null) continue;
    let cursor: string | null = node.id;
    while (cursor !== null && cursor !== coverage) cursor = nodes[cursor].parentId;
    if (cursor === null) node.summarySnapshot = { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };
  }
  return nodes;
}

export function exportStoryBackup(story: Story, now: () => number = () => Date.now()): string {
  const envelope: StoryBackupEnvelope = {
    schemaVersion: 2,
    exportedAt: now(),
    story: cloneStory(migrateStoryDocuments(story)),
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

  if (!isRecord(parsed) || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !isRecord(parsed.story)) {
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

  const sourceKind =
    rawStory.sourceKind === 'manual_script' || rawStory.sourceKind === 'deepseek_import'
      ? rawStory.sourceKind
      : undefined;
  if (rawStory.sourceKind !== undefined && sourceKind === undefined) {
    throw new Error('备份文件中的故事来源类型无效。');
  }

  const rootNodeIds = assertStringArray(rawStory.rootNodeIds, 'story.rootNodeIds');
  const blueprint = validateBlueprint(rawStory.blueprint);
  const nodes = validateNodes(rawStory.nodes);
  const attachments: Record<string, StoryAttachment> = Object.create(null);
  if (rawStory.attachments !== undefined) {
    if (!isRecord(rawStory.attachments)) throw new Error('备份中的附件记录无效。');
    for (const [id, file] of Object.entries(rawStory.attachments)) {
      if (!isRecord(file) || typeof file.fileName !== 'string' || typeof file.base64 !== 'string' ||
        file.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.base64) || file.base64.slice(0, -2).includes('=') || /=[^=]/.test(file.base64)) {
        throw new Error('备份中的附件内容无效。');
      }
      attachments[id] = { fileName: file.fileName, base64: file.base64 };
    }
  }
  if (Object.values(nodes).some((node) => node.attachmentIds?.some((id) => !Object.hasOwn(attachments, id)))) {
    throw new Error('备份缺少节点引用的附件。');
  }
  let documents: StoryDocuments | undefined;
  if (parsed.schemaVersion === 2) {
    if (!isRecord(rawStory.documents)) throw new Error('备份缺少 Markdown 文档版本。');
    const container = validateMarkdownDocument(rawStory.documents.container);
    let local = validateMarkdownDocument(rawStory.documents.local);
    const edits = validateOptionalStringMap(rawStory.documents.edits, 'documents.edits') ?? {};
    const containerEdits = validateOptionalStringMap(rawStory.documents.containerEdits, 'documents.containerEdits') ?? {};
    for (const [versions, references] of [[local.versions, edits], [container.versions, containerEdits]] as const) {
      for (const [anchor, revision] of Object.entries(references)) {
        if ((anchor && !Object.hasOwn(nodes, anchor)) || !Object.hasOwn(versions, revision)) {
          throw new Error('备份中的路径文档引用无效。');
        }
      }
    }
    for (const node of Object.values(nodes)) {
      if (!node.documents || !Object.hasOwn(container.versions, node.documents.container) ||
        !Object.hasOwn(local.versions, node.documents.local)) {
        throw new Error('备份缺少节点引用的文档版本。');
      }
      for (const read of node.documentReads ?? []) {
        if ((read.scope === 'container' && !Object.hasOwn(container.versions, read.versionId)) ||
          (read.scope === 'local' && !Object.hasOwn(local.versions, read.versionId))) {
          throw new Error('备份缺少请求引用的文档版本。');
        }
      }
      const snapshot = node.summarySnapshot;
      if (snapshot.coveredUpToNodeId === null && snapshot.content === '') {
        // Invalid legacy coverage has been discarded. Its derived progress must not enter a request.
        const original = rawStory.nodes as Record<string, { summarySnapshot: { coveredUpToNodeId: string | null } }>;
        if (original[node.id].summarySnapshot.coveredUpToNodeId !== null) {
          const initialHead = local.head;
          const version = documentVersion(local, node.documents.local);
          local = writeDocument(local, version.id, replaceDocumentProgress(version.markdown, ''), 'migration');
          node.documents = { ...node.documents, local: local.head };
          local = { ...local, head: initialHead };
        }
      }
    }
    documents = { container, local, edits, containerEdits };
  }

  for (const rootId of rootNodeIds) {
    if (!nodes[rootId]) {
      throw new Error(`备份文件 rootNodeIds 包含不存在的节点 ${rootId}。`);
    }
  }
  if (new Set(rootNodeIds).size !== rootNodeIds.length ||
    Object.values(nodes).filter((node) => node.parentId === null).length !== rootNodeIds.length ||
    rootNodeIds.some((id) => nodes[id].parentId !== null)) {
    throw new Error('备份文件的故事起点与节点树不一致。');
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

  const restored: Story = {
    ...(documents ? { documents } : {}),
    ...(Object.keys(attachments).length > 0 ? { attachments } : {}),
    ...(typeof rawStory.importCandidate === 'string' ? { importCandidate: rawStory.importCandidate } : {}),
    id: hasCollision ? createId() : rawStory.id,
    title: hasCollision ? `${rawStory.title}（导入副本）` : rawStory.title,
    ...(sourceKind ? { sourceKind } : {}),
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
  return documents ? restored : migrateStoryDocuments(restored);
}
