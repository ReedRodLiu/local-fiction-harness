import { formatConfirmedBlueprintAnchor } from './blueprint.ts';
import { createDefaultId } from './id.ts';
import type { DocumentRead, LlmMessage, Story, StoryBlueprint } from './types.ts';

export interface MarkdownVersion {
  id: string;
  previous: string | null;
  markdown: string;
  savedAt: number;
  source: 'user' | 'automatic' | 'migration';
}

export interface MarkdownDocument {
  head: string;
  versions: Record<string, MarkdownVersion>;
}

export interface StoryDocuments {
  container: MarkdownDocument;
  local: MarkdownDocument;
  edits: Record<string, string>;
  containerEdits?: Record<string, string>;
}

export interface StoryDocumentState {
  container: string;
  local: string;
}

export type {
  LegacyProposalTarget,
  MarkdownProposal,
  MarkdownProposalStatus,
  MarkdownReplySplit,
  ParsedProposal,
  ProposalApplyFailureReason,
  ProposalApplyResult,
  ProposalOp,
  ProposalParseStatus,
  ProposalReplySplit,
  ProposalTarget,
  UnparsedProposalBlock,
  UnparsedProposalReason,
} from './markdownProposal.ts';
export {
  CHANGE_FENCE,
  CHANGE_PROMPT,
  PROPOSAL_FENCE,
  V02_CHANGE_PROMPT,
  applyProposalPatch,
  generateProposalSummary,
  inspectStreamingReplyPrefix,
  normalizeProposalTarget,
  parseProposalReply,
  resolveProposalMarkdown,
  splitMarkdownReply,
  toLegacyProposalTarget,
  visibleReplyPrefix,
} from './markdownProposal.ts';

export function newDocument(markdown = '', source: MarkdownVersion['source'] = 'user', id = createDefaultId()): MarkdownDocument {
  return { head: id, versions: { [id]: { id, previous: null, markdown, savedAt: Date.now(), source } } };
}

export function writeDocument(
  document: MarkdownDocument,
  base: string,
  markdown: string,
  source: MarkdownVersion['source'] = 'user',
  id = createDefaultId(),
): MarkdownDocument {
  if (!Object.hasOwn(document.versions, base)) throw new Error('文档底稿已变化，请重新核对。');
  if (markdown === document.versions[base].markdown) return { ...document, head: base };
  return {
    head: id,
    versions: { ...document.versions, [id]: { id, previous: base, markdown, savedAt: Date.now(), source } },
  };
}

export function documentVersion(document: MarkdownDocument, version = document.head): MarkdownVersion {
  if (!Object.hasOwn(document.versions, version)) throw new Error('缺少引用的文档版本。');
  return document.versions[version];
}

export function documentLineage(document: MarkdownDocument, head = document.head): MarkdownVersion[] {
  const history = [];
  let cursor: string | null = head;
  while (cursor !== null) {
    const version = documentVersion(document, cursor);
    history.push(version);
    cursor = version.previous;
  }
  return history;
}

export function referenceDocument(scope: DocumentRead['scope'], name: string, version: MarkdownVersion): DocumentRead {
  return { scope, name, versionId: version.id, readAt: Date.now() };
}

export function documentMessages(entries: readonly [string, MarkdownVersion][]): LlmMessage[] {
  return entries.filter(([, version]) => version.markdown.trim()).map(([name, version]) => ({
    role: 'system',
    content: `以下是作为资料使用的「${name}」Markdown。\n\n${version.markdown}`,
  }));
}

export function legacyStoryMarkdown(story: Pick<Story, 'blueprint' | 'rawScript'>): string {
  const confirmed = formatConfirmedBlueprintAnchor(story.blueprint);
  return [
    confirmed && `## 已确认的规则与资料\n\n${confirmed}`,
    story.rawScript && `## 剧本原文\n\n${story.rawScript}`,
  ].filter(Boolean).join('\n\n');
}

export function syncConfirmedBlueprintMarkdown(
  markdown: string,
  previousBlueprint: StoryBlueprint,
  blueprint: StoryBlueprint,
): string {
  const heading = '## 已确认的规则与资料';
  const previousAnchor = formatConfirmedBlueprintAnchor(previousBlueprint);
  const nextAnchor = formatConfirmedBlueprintAnchor(blueprint);
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error('故事资料中找不到已确认的规则与资料。请先备份手工内容，恢复原蓝图内容及标题，再重新打开蓝图微调。');
  }

  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1;
  const sectionBody = lines.slice(start + 1, end).join('\n');
  const previousAnchorStart = sectionBody.indexOf(previousAnchor);
  const outsideAnchor = previousAnchorStart < 0 ? sectionBody : sectionBody.slice(0, previousAnchorStart) + sectionBody.slice(previousAnchorStart + previousAnchor.length);
  const hasBlueprintFields = /^\s*(?:标题|主角设定|核心规则|关键角色|禁忌条款)：/m.test(outsideAnchor);
  if (previousAnchorStart < 0 || (previousAnchorStart > 0 && sectionBody[previousAnchorStart - 1] !== '\n') || (previousAnchorStart + previousAnchor.length < sectionBody.length && sectionBody[previousAnchorStart + previousAnchor.length] !== '\n') || hasBlueprintFields || lines.slice(start + 1).some((line) => line.trim() === heading)) {
    throw new Error('故事资料中的已确认规则与蓝图不一致或存在重复标题。请先备份手工内容，在故事资料中恢复唯一的原蓝图内容，再重新打开蓝图微调。');
  }
  const nextBody = sectionBody.slice(0, previousAnchorStart) + nextAnchor + sectionBody.slice(previousAnchorStart + previousAnchor.length);
  const tail = lines.slice(end);
  const nextBodyLines = nextBody.split('\n');
  if (tail.length && nextBodyLines.at(-1) !== '') nextBodyLines.push('');
  return [
    ...lines.slice(0, start),
    heading,
    ...nextBodyLines,
    ...tail,
  ].join('\n');
}

const progressHeading = '## 当前进度';

function progressRange(markdown: string): [number, number] | null {
  let offset = 0;
  let start = -1;
  let fence = '';
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (fence[0] === marker[0] && marker.length >= fence.length))) {
      fence = fence ? '' : marker;
    } else if (!fence && /^#{1,2}\s/.test(line)) {
      if (start >= 0) return [start, offset];
      if (line.trim() === progressHeading) start = offset;
    }
    offset += line.length + 1;
  }
  return start >= 0 ? [start, markdown.length] : null;
}

export function documentProgress(markdown: string): string {
  const range = progressRange(markdown);
  return range ? markdown.slice(range[0] + progressHeading.length, range[1]).trim() : '';
}

export function replaceDocumentProgress(markdown: string, progress: string): string {
  const range = progressRange(markdown);
  if (!range && !progress.trim()) return markdown;
  const section = `${progressHeading}\n\n${progress.trim()}`;
  if (!range) return [markdown.trimEnd(), section].filter(Boolean).join('\n\n');
  const after = markdown.slice(range[1]);
  return markdown.slice(0, range[0]) + section + (after ? `\n\n${after}` : '');
}

export function migrateStoryDocuments(story: Story): Story {
  if (story.documents) return story;
  const container = newDocument(legacyStoryMarkdown(story), 'migration', 'story-original');
  let local = newDocument('', 'migration', 'path-original');
  const nodes = { ...story.nodes };
  const progressVersions = new Map<string, string>();
  for (const node of Object.values(nodes)) {
    const progress = node.summarySnapshot.content;
    let revision = progressVersions.get(progress) ?? local.head;
    if (progress && !progressVersions.has(progress)) {
      revision = `path-${node.id}`;
      local = writeDocument(local, 'path-original', replaceDocumentProgress('', progress), 'migration', revision);
      progressVersions.set(progress, revision);
    }
    nodes[node.id] = {
      ...node,
      documents: { container: container.head, local: progress ? revision : 'path-original' },
    };
  }
  return { ...story, nodes, documents: { container, local: { ...local, head: 'path-original' }, edits: {} } };
}

export function storyDocumentState(story: Story & { documents: StoryDocuments }, at: string | null, applyEdit: boolean): StoryDocumentState {
  const inherited = at !== null ? story.nodes[at]?.documents : undefined;
  return {
    container: (applyEdit ? story.documents.containerEdits?.[at ?? ''] : undefined) ?? inherited?.container ?? story.documents.container.head,
    local: (applyEdit ? story.documents.edits[at ?? ''] : undefined) ?? inherited?.local ?? story.documents.local.head,
  };
}

export function editStoryDocument(
  story: Story,
  target: 'container' | 'local',
  expected: string,
  markdown: string,
): Story {
  const current = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
  const docs = current.documents;
  const state = storyDocumentState(current, current.activeLeafNodeId, true);
  if (target === 'container') {
    if (state.container !== expected) throw new Error('故事文档已变化，请重新核对。');
    const container = writeDocument(docs.container, expected, markdown);
    return {
      ...current, documents: {
        ...docs, container,
        containerEdits: { ...docs.containerEdits, [current.activeLeafNodeId ?? '']: container.head },
      },
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
  }
  if (state.local !== expected) throw new Error('当前路径的文档已变化，请重新核对。');
  const local = writeDocument(docs.local, expected, markdown);
  return {
    ...current,
    updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    documents: {
      ...docs,
      local: { ...local, head: docs.local.head },
      edits: { ...docs.edits, [current.activeLeafNodeId ?? '']: local.head },
    },
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateMarkdownDocument(value: unknown): MarkdownDocument {
  if (!objectRecord(value) || typeof value.head !== 'string' || !objectRecord(value.versions)) {
    throw new Error('备份中的 Markdown 文档无效。');
  }
  const versions: Record<string, MarkdownVersion> = Object.create(null);
  for (const [id, revision] of Object.entries(value.versions)) {
    if (!objectRecord(revision) || revision.id !== id ||
      typeof revision.markdown !== 'string' || typeof revision.savedAt !== 'number' ||
      !Number.isFinite(revision.savedAt) ||
      (revision.previous !== null && typeof revision.previous !== 'string') ||
      (revision.source !== 'user' && revision.source !== 'automatic' && revision.source !== 'migration')) {
      throw new Error('备份中的 Markdown 版本无效。');
    }
    versions[id] = { id, previous: revision.previous, markdown: revision.markdown, savedAt: revision.savedAt, source: revision.source };
  }
  if (!Object.hasOwn(versions, value.head)) throw new Error('备份缺少当前文档版本。');
  const checked = new Set<string>();
  for (const id of Object.keys(versions)) {
    let cursor: string | null = id;
    const chain = new Set<string>();
    while (cursor !== null && !checked.has(cursor)) {
      if (!Object.hasOwn(versions, cursor) || chain.has(cursor)) throw new Error('备份中的文档历史无效。');
      chain.add(cursor);
      cursor = versions[cursor].previous;
    }
    for (const revision of chain) checked.add(revision);
  }
  return { head: value.head, versions };
}

export function validateDocumentReads(value: unknown): DocumentRead[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('备份中的请求审计无效。');
  return value.map((read) => {
    if (!objectRecord(read) || (read.scope !== 'public' && read.scope !== 'local' && read.scope !== 'container') ||
      typeof read.name !== 'string' || typeof read.versionId !== 'string' ||
      typeof read.readAt !== 'number' || !Number.isFinite(read.readAt)) {
      throw new Error('备份中的请求审计无效。');
    }
    return { scope: read.scope, name: read.name, versionId: read.versionId, readAt: read.readAt };
  });
}
