import {
  emptyWorkspace,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type DraftWork,
  type InteractionMode,
  type LocalCharacter,
  type WritingSuggestion,
} from './creative.ts';
import { createDefaultId } from './id.ts';
import {
  documentVersion,
  validateDocumentReads,
  validateMarkdownDocument,
  writeDocument,
} from './markdownDocuments.ts';
import { migrateStoryToV02, migrateWorkspaceToV02 } from './migration.ts';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  isDefaultPromptPackLibrary,
  validatePromptPackLibrary,
  type PromptPack,
  type PromptPackLibrary,
} from './promptPack.ts';
import {
  validateGenerationPreference,
  validateNodes,
  validateStoryPayload,
  validateTurnNodeEntry,
} from './storyStorage.ts';
import type { GenerationPreference, Story, TurnNode } from './types.ts';

export interface FolioBackupDisplayPreferences {
  themePreference?: string;
  fontSize?: number;
}

export interface FolioBackupEnvelopeV3 {
  schemaVersion: 3;
  exportedAt: number;
  appVersion: string;
  stories: Story[];
  workspace: CreativeWorkspaceState;
  displayPreferences?: FolioBackupDisplayPreferences;
  promptPacks?: PromptPackLibrary;
}

export interface ExportFolioBackupV3Options {
  stories: Story[];
  workspace: CreativeWorkspaceState;
  appVersion?: string;
  displayPreferences?: FolioBackupDisplayPreferences;
  promptPacks?: PromptPackLibrary;
  now?: () => number;
}

export interface FolioWorkspaceSnapshot {
  stories: Story[];
  workspace: CreativeWorkspaceState;
  displayPreferences?: FolioBackupDisplayPreferences;
  promptPacks?: PromptPackLibrary;
}

export interface MergeRestoredBackupOptions {
  createId?: () => string;
  now?: () => number;
}

export interface MergedBackupResult {
  stories: Story[];
  workspace: CreativeWorkspaceState;
  displayPreferences?: FolioBackupDisplayPreferences;
  promptPacks?: PromptPackLibrary;
  report: {
    addedStories: number;
    renamedStories: number;
    addedWorks: number;
    renamedWorks: number;
    addedCharacters: number;
    renamedCharacters: number;
    mergedPublicMemory: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeDisplayPreferences(
  raw: FolioBackupDisplayPreferences | undefined,
): FolioBackupDisplayPreferences | undefined {
  if (!raw) return undefined;
  const out: FolioBackupDisplayPreferences = {};
  if (typeof raw.themePreference === 'string' && raw.themePreference.trim()) {
    out.themePreference = raw.themePreference.trim();
  }
  if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize) && raw.fontSize > 0) {
    out.fontSize = raw.fontSize;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeWorkForExport(work: DraftWork): DraftWork {
  return cloneJson({
    id: work.id,
    title: work.title,
    ...(work.generationPreference ? { generationPreference: work.generationPreference } : {}),
    document: work.document,
    body: work.body,
    ...(work.writingStarted !== undefined ? { writingStarted: work.writingStarted } : {}),
    bodyRevision: work.bodyRevision,
    discussion: work.discussion,
    ...(work.discussionNodes !== undefined ? { discussionNodes: work.discussionNodes } : {}),
    ...(work.activeDiscussionLeafId !== undefined
      ? { activeDiscussionLeafId: work.activeDiscussionLeafId }
      : {}),
    suggestions: work.suggestions,
    ...(work.source ? { source: work.source } : {}),
  });
}

function sanitizeCharacterForExport(character: LocalCharacter): LocalCharacter {
  return cloneJson({
    id: character.id,
    name: character.name,
    ...(character.generationPreference ? { generationPreference: character.generationPreference } : {}),
    document: character.document,
    conversations: character.conversations.map((conv) => ({
      id: conv.id,
      ...(conv.title !== undefined ? { title: conv.title } : {}),
      kind: conv.kind,
      characterVersion: conv.characterVersion,
      document: conv.document,
      edits: conv.edits,
      nodes: conv.nodes,
      activeLeafNodeId: conv.activeLeafNodeId,
    })),
    activeConversationId: character.activeConversationId,
  });
}

function sanitizeWorkspaceForExport(workspace: CreativeWorkspaceState): CreativeWorkspaceState {
  const migrated = migrateWorkspaceToV02(workspace);
  return {
    revision: migrated.revision,
    publicDocument: cloneJson(migrated.publicDocument),
    works: migrated.works.map(sanitizeWorkForExport),
    characters: migrated.characters.map(sanitizeCharacterForExport),
    ...(migrated.activeWorkId !== undefined ? { activeWorkId: migrated.activeWorkId } : {}),
    ...(migrated.activeCharacterId !== undefined ? { activeCharacterId: migrated.activeCharacterId } : {}),
    ...(migrated.v2Migrated ? { v2Migrated: true } : {}),
  };
}

function sanitizeStoryForExport(story: Story): Story {
  const migrated = migrateStoryToV02(story);
  return cloneJson({
    id: migrated.id,
    title: migrated.title,
    ...(migrated.sourceKind !== undefined ? { sourceKind: migrated.sourceKind } : {}),
    ...(migrated.sourceSessionId !== undefined ? { sourceSessionId: migrated.sourceSessionId } : {}),
    ...(migrated.v2Migrated ? { v2Migrated: true } : {}),
    ...(migrated.generationPreference ? { generationPreference: migrated.generationPreference } : {}),
    ...(migrated.documents ? { documents: migrated.documents } : {}),
    ...(migrated.importCandidate !== undefined ? { importCandidate: migrated.importCandidate } : {}),
    ...(migrated.attachments ? { attachments: migrated.attachments } : {}),
    rawScript: migrated.rawScript,
    blueprint: migrated.blueprint,
    nodes: migrated.nodes,
    rootNodeIds: migrated.rootNodeIds,
    activeLeafNodeId: migrated.activeLeafNodeId,
    ...(migrated.setupNodeIds ? { setupNodeIds: migrated.setupNodeIds } : {}),
    ...(migrated.branchNames ? { branchNames: migrated.branchNames } : {}),
    ...(migrated.branchSummaries ? { branchSummaries: migrated.branchSummaries } : {}),
    createdAt: migrated.createdAt,
    updatedAt: migrated.updatedAt,
  });
}

/**
 * Exports all 3 modes (文游 stories, 写故事 works, 角色互动 characters), 我的记忆,
 * and optional display preferences into a `.folio.json` v3 bundle. Strictly excludes API keys.
 */
export function exportFolioBackupV3(options: ExportFolioBackupV3Options): string {
  const now = options.now ?? (() => Date.now());
  const displayPreferences = sanitizeDisplayPreferences(options.displayPreferences);
  const promptPacks = options.promptPacks
    ? validatePromptPackLibrary(options.promptPacks)
    : undefined;
  const envelope: FolioBackupEnvelopeV3 = {
    schemaVersion: 3,
    exportedAt: now(),
    appVersion: options.appVersion?.trim() || '0.4.0',
    stories: options.stories.map(sanitizeStoryForExport),
    workspace: sanitizeWorkspaceForExport(options.workspace),
    ...(displayPreferences ? { displayPreferences } : {}),
    ...(promptPacks ? { promptPacks } : {}),
  };
  return JSON.stringify(envelope, null, 2);
}

function validateWritingSuggestion(raw: unknown, workId: string, index: number): WritingSuggestion {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.instruction !== 'string' ||
    typeof raw.text !== 'string' ||
    typeof raw.revision !== 'number' ||
    !Number.isFinite(raw.revision) ||
    typeof raw.start !== 'number' ||
    !Number.isFinite(raw.start) ||
    typeof raw.end !== 'number' ||
    !Number.isFinite(raw.end)
  ) {
    throw new Error(`备份作品 ${workId} 的 suggestions[${index}] 结构无效。`);
  }
  const reads = validateDocumentReads(raw.documentReads) ?? [];
  return {
    id: raw.id,
    instruction: raw.instruction,
    text: raw.text,
    revision: raw.revision,
    start: raw.start,
    end: raw.end,
    documentReads: reads,
  };
}

function validateDraftWork(raw: unknown, index: number): DraftWork {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    typeof raw.title !== 'string' ||
    typeof raw.body !== 'string' ||
    typeof raw.bodyRevision !== 'number' ||
    !Number.isFinite(raw.bodyRevision) ||
    !Array.isArray(raw.discussion) ||
    !Array.isArray(raw.suggestions)
  ) {
    throw new Error(`备份文件 workspace.works[${index}] 结构无效。`);
  }
  if (raw.writingStarted !== undefined && typeof raw.writingStarted !== 'boolean') {
    throw new Error(`备份作品 ${raw.id} 的 writingStarted 必须为布尔值。`);
  }
  const document = validateMarkdownDocument(raw.document);
  const discussion: TurnNode[] = raw.discussion.map((item) => validateTurnNodeEntry(item));
  const discussionNodes =
    raw.discussionNodes === undefined ? undefined : validateNodes(raw.discussionNodes);
  let activeDiscussionLeafId: string | null | undefined;
  if (raw.activeDiscussionLeafId !== undefined) {
    if (raw.activeDiscussionLeafId !== null && typeof raw.activeDiscussionLeafId !== 'string') {
      throw new Error(`备份作品 ${raw.id} 的 activeDiscussionLeafId 无效。`);
    }
    if (
      raw.activeDiscussionLeafId !== null &&
      discussionNodes &&
      !Object.hasOwn(discussionNodes, raw.activeDiscussionLeafId)
    ) {
      throw new Error(`备份作品 ${raw.id} 的 activeDiscussionLeafId 不存在。`);
    }
    activeDiscussionLeafId = raw.activeDiscussionLeafId;
  }
  const suggestions = raw.suggestions.map((item, sIdx) =>
    validateWritingSuggestion(item, raw.id as string, sIdx),
  );
  let source: DraftWork['source'];
  if (raw.source !== undefined) {
    if (
      !isRecord(raw.source) ||
      typeof raw.source.storyId !== 'string' ||
      (raw.source.nodeId !== null && typeof raw.source.nodeId !== 'string')
    ) {
      throw new Error(`备份作品 ${raw.id} 的 source 引用无效。`);
    }
    source = { storyId: raw.source.storyId, nodeId: raw.source.nodeId };
  }
  const generationPreference = validateGenerationPreference(
    raw.generationPreference,
    `备份作品 ${raw.id}`,
  );
  return {
    id: raw.id,
    title: raw.title,
    ...(generationPreference ? { generationPreference } : {}),
    document,
    body: raw.body,
    ...(raw.writingStarted !== undefined ? { writingStarted: raw.writingStarted } : {}),
    bodyRevision: raw.bodyRevision,
    discussion,
    ...(discussionNodes !== undefined ? { discussionNodes } : {}),
    ...(activeDiscussionLeafId !== undefined ? { activeDiscussionLeafId } : {}),
    suggestions,
    ...(source ? { source } : {}),
  };
}

function validateCharacterConversation(
  raw: unknown,
  character: { id: string; document: ReturnType<typeof validateMarkdownDocument> },
  index: number,
): CharacterConversation {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error(`备份角色 ${character.id} 的 conversations[${index}] 结构无效。`);
  }
  let kind: InteractionMode = 'personal';
  if (raw.kind !== undefined) {
    if (raw.kind !== 'personal' && raw.kind !== 'roleplay') {
      throw new Error(`备份角色 ${character.id} 的对话类型 kind 无效。`);
    }
    kind = raw.kind;
  }
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    throw new Error(`备份角色 ${character.id} 的对话标题必须为字符串。`);
  }
  const document = validateMarkdownDocument(raw.document);
  const nodes = validateNodes(raw.nodes);
  if (raw.activeLeafNodeId !== null && typeof raw.activeLeafNodeId !== 'string') {
    throw new Error(`备份角色 ${character.id} 的 activeLeafNodeId 无效。`);
  }
  if (raw.activeLeafNodeId !== null && !Object.hasOwn(nodes, raw.activeLeafNodeId)) {
    throw new Error(`备份角色 ${character.id} 的 activeLeafNodeId 不存在。`);
  }
  if (typeof raw.characterVersion !== 'string' || !raw.characterVersion.trim()) {
    throw new Error(`备份角色 ${character.id} 的对话缺少可恢复的 characterVersion。`);
  }
  // Migration repairs a stale nonempty revision from the active node pin or profile head.
  if (!isRecord(raw.edits)) {
    throw new Error(`备份角色 ${character.id} 的 edits 必须为键值对象。`);
  }
  const edits: Record<string, string> = {};
  for (const [anchor, rev] of Object.entries(raw.edits)) {
    // Migration can recover a stale revision from the node's valid local version.
    if (typeof rev !== 'string' || (anchor && !Object.hasOwn(nodes, anchor))) {
      throw new Error(`备份角色 ${character.id} 的对话版本引用无效。`);
    }
    edits[anchor] = rev;
  }
  return {
    id: raw.id,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    kind,
    characterVersion: raw.characterVersion,
    document,
    edits,
    nodes,
    activeLeafNodeId: raw.activeLeafNodeId,
  };
}

function validateLocalCharacter(raw: unknown, index: number): LocalCharacter {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    typeof raw.name !== 'string' ||
    !Array.isArray(raw.conversations)
  ) {
    throw new Error(`备份文件 workspace.characters[${index}] 结构无效。`);
  }
  const document = validateMarkdownDocument(raw.document);
  const conversations = raw.conversations.map((conv, cIdx) =>
    validateCharacterConversation(conv, { id: raw.id as string, document }, cIdx),
  );
  if (raw.activeConversationId !== null && typeof raw.activeConversationId !== 'string') {
    throw new Error(`备份角色 ${raw.id} 的 activeConversationId 无效。`);
  }
  if (
    raw.activeConversationId !== null &&
    !conversations.some((conv) => conv.id === raw.activeConversationId)
  ) {
    throw new Error(`备份角色 ${raw.id} 的 activeConversationId 不存在。`);
  }
  const generationPreference = validateGenerationPreference(
    raw.generationPreference,
    `备份角色 ${raw.id}`,
  );
  return {
    id: raw.id,
    name: raw.name,
    ...(generationPreference ? { generationPreference } : {}),
    document,
    conversations,
    activeConversationId: raw.activeConversationId,
  };
}

function validateWorkspacePayload(raw: unknown): CreativeWorkspaceState {
  if (!isRecord(raw)) {
    throw new Error('备份文件缺少有效的 workspace 对象。');
  }
  if (typeof raw.revision !== 'number' || !Number.isFinite(raw.revision) || raw.revision < 0) {
    throw new Error('备份文件 workspace.revision 必须为有效数字。');
  }
  const publicDocument = validateMarkdownDocument(raw.publicDocument);
  if (!Array.isArray(raw.works)) {
    throw new Error('备份文件 workspace.works 必须为数组。');
  }
  if (!Array.isArray(raw.characters)) {
    throw new Error('备份文件 workspace.characters 必须为数组。');
  }
  const works = raw.works.map((work, idx) => validateDraftWork(work, idx));
  const characters = raw.characters.map((ch, idx) => validateLocalCharacter(ch, idx));
  if (raw.activeWorkId !== undefined && typeof raw.activeWorkId !== 'string') {
    throw new Error('备份文件 workspace.activeWorkId 必须为字符串。');
  }
  if (raw.activeCharacterId !== undefined && typeof raw.activeCharacterId !== 'string') {
    throw new Error('备份文件 workspace.activeCharacterId 必须为字符串。');
  }
  if (raw.v2Migrated !== undefined && typeof raw.v2Migrated !== 'boolean') {
    throw new Error('备份文件 workspace.v2Migrated 必须为布尔值。');
  }
  return migrateWorkspaceToV02({
    revision: raw.revision,
    publicDocument,
    works,
    characters,
    ...(typeof raw.activeWorkId === 'string' ? { activeWorkId: raw.activeWorkId } : {}),
    ...(typeof raw.activeCharacterId === 'string' ? { activeCharacterId: raw.activeCharacterId } : {}),
    ...(raw.v2Migrated === true ? { v2Migrated: true } : {}),
  });
}

function validateDisplayPreferences(raw: unknown): FolioBackupDisplayPreferences | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error('备份文件 displayPreferences 必须为对象。');
  }
  const out: FolioBackupDisplayPreferences = {};
  if (raw.themePreference !== undefined) {
    if (typeof raw.themePreference !== 'string' || !raw.themePreference.trim()) {
      throw new Error('备份文件 displayPreferences.themePreference 无效。');
    }
    out.themePreference = raw.themePreference.trim();
  }
  if (raw.fontSize !== undefined) {
    if (typeof raw.fontSize !== 'number' || !Number.isFinite(raw.fontSize) || raw.fontSize <= 0) {
      throw new Error('备份文件 displayPreferences.fontSize 无效。');
    }
    out.fontSize = raw.fontSize;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Detects the schema version (1, 2, or 3) of a Folio / legacy LFH JSON backup string.
 */
export function detectBackupSchemaVersion(rawJson: string): 1 | 2 | 3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('备份文件不是有效的 JSON 格式。');
  }
  if (!isRecord(parsed) || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)) {
    throw new Error('不支持的备份文件版本。');
  }
  return parsed.schemaVersion;
}

/**
 * Parses and validates either a `.folio.json` v3 full bundle or a legacy `.lfh.json` v1/v2
 * single-story backup, migrating everything into a normalized `FolioBackupEnvelopeV3`.
 */
export function parseAndValidateFolioBackup(rawJson: string): FolioBackupEnvelopeV3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('备份文件不是有效的 JSON 格式。');
  }

  if (!isRecord(parsed)) {
    throw new Error('备份文件顶层结构无效。');
  }

  if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) {
    if (!isRecord(parsed.story)) {
      throw new Error('不支持的备份版本或缺少 story 主体。');
    }
    const exportedAt =
      typeof parsed.exportedAt === 'number' && Number.isFinite(parsed.exportedAt)
        ? parsed.exportedAt
        : Date.now();
    const story = migrateStoryToV02(validateStoryPayload(parsed.story, parsed.schemaVersion));
    return {
      schemaVersion: 3,
      exportedAt,
      appVersion: '0.1.0',
      stories: [story],
      workspace: migrateWorkspaceToV02(emptyWorkspace()),
    };
  }

  if (parsed.schemaVersion === 3) {
    if (typeof parsed.exportedAt !== 'number' || !Number.isFinite(parsed.exportedAt)) {
      throw new Error('备份文件缺少有效的 exportedAt 时间戳。');
    }
    if (typeof parsed.appVersion !== 'string' || !parsed.appVersion.trim()) {
      throw new Error('备份文件缺少有效的 appVersion。');
    }
    if (!Array.isArray(parsed.stories)) {
      throw new Error('备份文件 stories 必须为数组。');
    }
    const stories = parsed.stories.map((item) =>
      migrateStoryToV02(validateStoryPayload(item, 3)),
    );
    const workspace = validateWorkspacePayload(parsed.workspace);
    const displayPreferences = validateDisplayPreferences(parsed.displayPreferences);
    const promptPacks = parsed.promptPacks === undefined
      ? undefined
      : validatePromptPackLibrary(parsed.promptPacks);
    return {
      schemaVersion: 3,
      exportedAt: parsed.exportedAt,
      appVersion: parsed.appVersion.trim(),
      stories,
      workspace,
      ...(displayPreferences ? { displayPreferences } : {}),
      ...(promptPacks ? { promptPacks } : {}),
    };
  }

  throw new Error('不支持的备份文件版本。');
}

interface PromptPackMergeResult {
  library?: PromptPackLibrary;
  idRemap: Map<string, string>;
}

function mergePromptPackLibraries(
  existing: PromptPackLibrary | undefined,
  incoming: PromptPackLibrary | undefined,
  createId: () => string,
): PromptPackMergeResult {
  if (!existing && !incoming) return { idRemap: new Map() };
  if (!existing) return { library: validatePromptPackLibrary(incoming), idRemap: new Map() };
  if (!incoming) return { library: validatePromptPackLibrary(existing), idRemap: new Map() };

  const current = validatePromptPackLibrary(existing);
  const restored = validatePromptPackLibrary(incoming);
  const currentHasCustomState = !isDefaultPromptPackLibrary(current);
  const usedIds = new Set(current.packs.map((pack) => pack.id));
  const idRemap = new Map<string, string>();
  const packs: PromptPack[] = current.packs.map((pack) => cloneJson(pack));

  const incomingBuiltin = restored.packs.find(
    (pack) => pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id,
  );
  if (!currentHasCustomState && incomingBuiltin?.enabled === false) {
    for (let index = 0; index < packs.length; index += 1) {
      if (packs[index]?.id === BUILTIN_NARRATIVE_PROMPT_PACK.id) {
        packs[index] = { ...packs[index], enabled: false };
      }
    }
  }

  for (const incomingPack of restored.packs) {
    if (incomingPack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id) continue;
    let nextPack = cloneJson(incomingPack);
    if (usedIds.has(nextPack.id)) {
      const nextId = createId();
      idRemap.set(nextPack.id, nextId);
      nextPack = {
        ...nextPack,
        id: nextId,
        title: `${nextPack.title} (备份导入)`,
      };
    }
    usedIds.add(nextPack.id);
    packs.push(nextPack);
  }

  const incomingActivePackId = restored.activePackId === null
    ? null
    : idRemap.get(restored.activePackId) ?? restored.activePackId;
  const activePackId = currentHasCustomState
    ? current.activePackId
    : incomingActivePackId && packs.some(
        (pack) => pack.id === incomingActivePackId && pack.enabled !== false,
      )
      ? incomingActivePackId
      : null;

  return {
    library: validatePromptPackLibrary({
      packs,
      activePackId,
      defaultPrefixCompletion: currentHasCustomState
        ? current.defaultPrefixCompletion
        : restored.defaultPrefixCompletion,
      includeTail: currentHasCustomState ? current.includeTail : restored.includeTail,
    }),
    idRemap,
  };
}

function remapPromptPackReference<T extends { generationPreference?: GenerationPreference }>(
  value: T,
  idRemap: ReadonlyMap<string, string>,
): T {
  const mode = value.generationPreference?.promptPackMode;
  const nextMode = mode && mode !== 'inherit' && mode !== 'off' ? idRemap.get(mode) : undefined;
  if (!nextMode) return value;
  return {
    ...value,
    generationPreference: {
      ...value.generationPreference,
      promptPackMode: nextMode,
    },
  };
}

/**
 * Non-destructively merges an incoming backup snapshot into the existing local state.
 * Colliding IDs generate fresh IDs and `(备份导入)` copies so existing user edits are never clobbered.
 */
export function mergeRestoredBackup(
  existing: FolioWorkspaceSnapshot,
  incoming: FolioBackupEnvelopeV3 | FolioWorkspaceSnapshot,
  options: MergeRestoredBackupOptions = {},
): MergedBackupResult {
  const createId = options.createId ?? createDefaultId;
  const now = options.now ?? (() => Date.now());

  const existingStories = existing.stories.map(migrateStoryToV02);
  const existingWorkspace = migrateWorkspaceToV02(existing.workspace);

  const usedStoryIds = new Set(existingStories.map((s) => s.id));
  const storyIdRemap = new Map<string, string>();
  const mergedStories: Story[] = [...existingStories];
  const importedStories = new Set<Story>();
  let addedStories = 0;
  let renamedStories = 0;

  for (const rawStory of incoming.stories) {
    const story = migrateStoryToV02(rawStory);
    if (usedStoryIds.has(story.id)) {
      const nextId = createId();
      storyIdRemap.set(story.id, nextId);
      usedStoryIds.add(nextId);
      const mergedStory = {
        ...cloneJson(story),
        id: nextId,
        title: `${story.title} (备份导入)`,
        updatedAt: now(),
      };
      mergedStories.push(mergedStory);
      importedStories.add(mergedStory);
      renamedStories += 1;
    } else {
      usedStoryIds.add(story.id);
      const mergedStory = cloneJson(story);
      mergedStories.push(mergedStory);
      importedStories.add(mergedStory);
      addedStories += 1;
    }
  }

  const usedWorkIds = new Set(existingWorkspace.works.map((w) => w.id));
  const mergedWorks: DraftWork[] = [...existingWorkspace.works];
  const importedWorks = new Set<DraftWork>();
  let addedWorks = 0;
  let renamedWorks = 0;

  for (const rawWork of incoming.workspace.works) {
    const clonedWork = cloneJson(rawWork);
    if (clonedWork.source && storyIdRemap.has(clonedWork.source.storyId)) {
      clonedWork.source = {
        ...clonedWork.source,
        storyId: storyIdRemap.get(clonedWork.source.storyId)!,
      };
    }
    if (usedWorkIds.has(clonedWork.id)) {
      const nextId = createId();
      usedWorkIds.add(nextId);
      const mergedWork = {
        ...clonedWork,
        id: nextId,
        title: `${clonedWork.title} (备份导入)`,
      };
      mergedWorks.push(mergedWork);
      importedWorks.add(mergedWork);
      renamedWorks += 1;
    } else {
      usedWorkIds.add(clonedWork.id);
      mergedWorks.push(clonedWork);
      importedWorks.add(clonedWork);
      addedWorks += 1;
    }
  }

  const usedCharIds = new Set(existingWorkspace.characters.map((c) => c.id));
  const mergedCharacters: LocalCharacter[] = [...existingWorkspace.characters];
  const importedCharacters = new Set<LocalCharacter>();
  let addedCharacters = 0;
  let renamedCharacters = 0;

  for (const rawCharacter of incoming.workspace.characters) {
    const clonedChar = cloneJson(rawCharacter);
    if (usedCharIds.has(clonedChar.id)) {
      const nextCharId = createId();
      usedCharIds.add(nextCharId);
      const convIdMap = new Map<string, string>();
      const clonedConversations = clonedChar.conversations.map((conv) => {
        const nextConvId = createId();
        convIdMap.set(conv.id, nextConvId);
        return { ...conv, id: nextConvId };
      });
      const nextActiveConvId = clonedChar.activeConversationId
        ? convIdMap.get(clonedChar.activeConversationId) ?? null
        : null;
      const mergedCharacter = {
        ...clonedChar,
        id: nextCharId,
        name: `${clonedChar.name} (备份导入)`,
        conversations: clonedConversations,
        activeConversationId: nextActiveConvId,
      };
      mergedCharacters.push(mergedCharacter);
      importedCharacters.add(mergedCharacter);
      renamedCharacters += 1;
    } else {
      usedCharIds.add(clonedChar.id);
      mergedCharacters.push(clonedChar);
      importedCharacters.add(clonedChar);
      addedCharacters += 1;
    }
  }

  // Non-destructive merge for 我的记忆 (publicDocument)
  let mergedPublicDoc = existingWorkspace.publicDocument;
  let mergedPublicMemory = false;
  const existingPublicMd = documentVersion(existingWorkspace.publicDocument).markdown;
  const incomingPublicMd = documentVersion(incoming.workspace.publicDocument).markdown;
  if (incomingPublicMd.trim() && incomingPublicMd.trim() !== existingPublicMd.trim()) {
    if (!existingPublicMd.trim()) {
      mergedPublicDoc = writeDocument(
        existingWorkspace.publicDocument,
        existingWorkspace.publicDocument.head,
        incomingPublicMd,
        'migration',
        createId(),
      );
      mergedPublicMemory = true;
    } else if (!existingPublicMd.includes(incomingPublicMd.trim())) {
      const combined = `${existingPublicMd.trimEnd()}\n\n---\n\n## 我的记忆 (备份导入)\n\n${incomingPublicMd.trim()}`;
      mergedPublicDoc = writeDocument(
        existingWorkspace.publicDocument,
        existingWorkspace.publicDocument.head,
        combined,
        'migration',
        createId(),
      );
      mergedPublicMemory = true;
    }
  }

  const promptPackMerge = mergePromptPackLibraries(
    existing.promptPacks,
    incoming.promptPacks,
    createId,
  );
  const remappedStories = mergedStories.map((story) =>
    importedStories.has(story) ? remapPromptPackReference(story, promptPackMerge.idRemap) : story,
  );
  const remappedWorks = mergedWorks.map((work) =>
    importedWorks.has(work) ? remapPromptPackReference(work, promptPackMerge.idRemap) : work,
  );
  const remappedCharacters = mergedCharacters.map((character) =>
    importedCharacters.has(character)
      ? remapPromptPackReference(character, promptPackMerge.idRemap)
      : character,
  );

  const activeWorkId = existingWorkspace.activeWorkId ?? remappedWorks[0]?.id;
  const activeCharacterId = existingWorkspace.activeCharacterId ?? remappedCharacters[0]?.id;

  const mergedWorkspace = migrateWorkspaceToV02({
    revision: existingWorkspace.revision + 1,
    publicDocument: mergedPublicDoc,
    works: remappedWorks,
    characters: remappedCharacters,
    ...(activeWorkId !== undefined ? { activeWorkId } : {}),
    ...(activeCharacterId !== undefined ? { activeCharacterId } : {}),
    v2Migrated: true,
  });

  const displayPreferences =
    existing.displayPreferences || incoming.displayPreferences
      ? sanitizeDisplayPreferences({
          ...incoming.displayPreferences,
          ...existing.displayPreferences,
        })
      : undefined;
  const promptPacks = promptPackMerge.library;

  return {
    stories: remappedStories,
    workspace: mergedWorkspace,
    ...(displayPreferences ? { displayPreferences } : {}),
    ...(promptPacks ? { promptPacks } : {}),
    report: {
      addedStories,
      renamedStories,
      addedWorks,
      renamedWorks,
      addedCharacters,
      renamedCharacters,
      mergedPublicMemory,
    },
  };
}
