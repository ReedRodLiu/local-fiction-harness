import { unzipSync } from 'fflate';
import { DEFAULT_ZIP_MAX_BYTES } from './binaryDownload.ts';
import { createDefaultBlueprint } from './blueprint.ts';
import { toCompactPreview } from './branches.ts';
import { getActiveBranchNodes } from './context.ts';
import { decodeUtf8WithGbFallback } from './encoding.ts';
import { isAbortError, type FictionHarness } from './harness.ts';
import { createDefaultId } from './id.ts';
import { createBackgroundModelConfig } from './keyConfig.ts';
import { newDocument } from './markdownDocuments.ts';
import { DEFAULT_STORY_TITLE, parseScriptInput } from './scriptParser.ts';
import type {
  AbortSignalLike,
  LlmTransport,
  ModelConfig,
  NodeDiagnosticStatus,
  NodeDiagnostics,
  PlotSummarySnapshot,
  Story,
  StoryAttachment,
  TurnNode,
} from './types.ts';

export interface DeepSeekRawFileRef {
  id?: string;
  file_name?: string;
  file_size?: number;
  export_path?: string;
  is_image?: boolean;
}

export interface DeepSeekRawFragment {
  type?: string;
  content?: string;
  files?: DeepSeekRawFileRef[];
}

export interface DeepSeekRawMessage {
  id: string | number;
  parent_id?: string | number | null;
  role?: string;
  status?: string;
  inserted_at?: string | number;
  fragments?: DeepSeekRawFragment[];
}

export interface DeepSeekRawSession {
  id: string;
  title?: string | null;
  current_message_id?: string | number | null;
  inserted_at?: string | number;
  updated_at?: string | number;
  messages?: DeepSeekRawMessage[] | Record<string, DeepSeekRawMessage>;
}

export type DeepSeekAttachmentKind = 'text' | 'legacy_doc' | 'media' | 'unsupported';

export interface DeepSeekAttachmentMeta {
  fileName: string;
  exportPath: string;
  ext: string;
  kind: DeepSeekAttachmentKind;
  fileSize: number;
}

export interface DeepSeekSessionIndexItem {
  sessionId: string;
  filePath: string;
  title: string;
  hasNullTitle: boolean;
  updatedAt: number;
  insertedAt: number;
  messageCount: number;
  turnCount: number;
  forkCount: number;
  currentMessageId: string | null;
  firstSnippet: string;
  latestSnippet: string;
  attachments: DeepSeekAttachmentMeta[];
  diagnosticCount: number;
  fictionScore: number;
  isLikelyFiction: boolean;
}

export interface DeepSeekStructureStats {
  exportFormatVersion: number;
  totalSessions: number;
  danglingParentCount: number;
  emptyTitleCount: number;
  unknownFragmentTypes: string[];
  attachmentExtensions: Record<string, number>;
}

export interface DeepSeekZipScanResult {
  exportFormatVersion: number;
  sessions: DeepSeekSessionIndexItem[];
  structure: DeepSeekStructureStats;
}

export class UnsupportedDeepSeekExportVersionError extends Error {
  constructor(readonly exportFormatVersion: number | undefined) {
    super(`不支持的 DeepSeek 导出格式版本：${exportFormatVersion ?? '未知'}（当前仅支持 v3）。`);
  }
}

export interface DeepSeekAttachmentResult {
  fileName: string;
  exportPath: string;
  kind: DeepSeekAttachmentKind;
  hint?: string;
}

export interface RecoveredTextAttachment {
  fileName: string;
  content: string;
}

export interface DeepSeekSessionPreview {
  sessionId: string;
  title: string;
  story: Story;
  rawScript: string;
  settingMarkdown: string;
  scriptConfidence: 'strong' | 'ambiguous';
  latestSnippet: string;
  turnCount: number;
  forkCount: number;
  recoveredAttachments: DeepSeekAttachmentResult[];
  recoveredTextAttachments: RecoveredTextAttachment[];
  skippedAttachments: DeepSeekAttachmentResult[];
  diagnosticCount: number;
}

export interface MarkedDeepSeekSession extends DeepSeekSessionIndexItem {
  alreadyImported: boolean;
}

export interface ScriptTurnRange {
  startTurn: number;
  endTurn: number;
}

export type ImportSummaryStatus = 'within_window' | 'pending_key' | 'pending_summary';

export interface DeepSeekImportBatchResult {
  stories: Story[];
  previews: DeepSeekSessionPreview[];
  summaryStatuses: Record<string, ImportSummaryStatus>;
}

export interface DeepSeekPreviewOptions {
  createId?: () => string;
  now?: () => number;
  scriptRangeOverrides?: Record<string, ScriptTurnRange>;
}

export interface DeepSeekImportOptions extends DeepSeekPreviewOptions {
  modelConfig?: ModelConfig;
  transport?: LlmTransport;
  signal?: AbortSignalLike;
  existingStories?: readonly Pick<Story, 'title' | 'sourceSessionId'>[];
}

export interface ScriptBoundaryResult {
  rawScript: string;
  scriptMessageIds: string[];
  firstPlayMessageId: string | null;
  usedFallback: boolean;
}

const TEXT_ATTACHMENT_EXTS = new Set(['.docx', '.md', '.txt']);
const MEDIA_ATTACHMENT_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.pdf',
]);

const STRONG_FICTION_REGEX =
  /规则|设定|世界观|主角|角色|好感度|属性|状态栏|禁忌|开局|第一幕|第[一二三四五六七八九十0-9]+[章幕回节]|玩家|剧情|人物档案|扮演/g;
const TECH_NOISE_REGEX =
  /\b(?:import|export|function|const|tsconfig|traceback|SELECT\s+\*|kubectl|docker|git\s+|npm\s+run)\b/i;

function countStrongFictionMatches(text: string): number {
  return text.match(STRONG_FICTION_REGEX)?.length ?? 0;
}

function resolveSessionTitle(rawTitle: unknown, firstUserSnippet: string): {
  title: string;
  hasNullTitle: boolean;
} {
  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  return {
    title: trimmed || firstUserSnippet || DEFAULT_STORY_TITLE,
    hasNullTitle: !trimmed,
  };
}

function normalizeZipPath(p: string): string {
  return p.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

function classifyAttachment(fileName: string, isImage?: boolean): DeepSeekAttachmentKind {
  const ext = getFileExtension(fileName);
  if (TEXT_ATTACHMENT_EXTS.has(ext)) return 'text';
  if (ext === '.doc') return 'legacy_doc';
  if (isImage || MEDIA_ATTACHMENT_EXTS.has(ext)) return 'media';
  return 'unsupported';
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getSessionMessages(raw: DeepSeekRawSession): DeepSeekRawMessage[] {
  if (Array.isArray(raw.messages)) return raw.messages;
  if (raw.messages && typeof raw.messages === 'object') {
    return Object.values(raw.messages);
  }
  return [];
}

function normalizeDiagnosticStatus(status?: string): NodeDiagnosticStatus | undefined {
  if (!status) return undefined;
  const upper = status.toUpperCase();
  if (upper === 'CONTENT_FILTER') return 'CONTENT_FILTER';
  if (upper === 'TIMEOUT') return 'TIMEOUT';
  if (upper === 'INCOMPLETE' || upper === 'WIP') return 'INCOMPLETE';
  return undefined;
}

function extractFragments(msg: DeepSeekRawMessage, unknownTypes?: Set<string>): {
  text: string;
  reasoning: string;
  fileRefs: DeepSeekRawFileRef[];
  hasContentRisk: boolean;
} {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const fileRefs: DeepSeekRawFileRef[] = [];
  let hasContentRisk = false;

  for (const frag of msg.fragments ?? []) {
    const t = typeof frag.type === 'string' ? frag.type.toUpperCase() : '';
    if (unknownTypes && isUnknownFragmentType(t)) {
      unknownTypes.add(SAFE_FRAGMENT_TYPE_REGEX.test(t) ? t : 'INVALID_TYPE_NAME');
    }
    if (t === 'REQUEST' || t === 'RESPONSE') {
      if (typeof frag.content === 'string' && frag.content.trim()) {
        textParts.push(frag.content.trim());
      }
    } else if (t === 'THINK') {
      if (typeof frag.content === 'string' && frag.content.trim()) {
        reasoningParts.push(frag.content.trim());
      }
    } else if (t === 'FILE') {
      for (const f of frag.files ?? []) {
        fileRefs.push(f);
      }
    } else if (t === 'CONTENT_RISK') {
      hasContentRisk = true;
    }
    // TOOL_SEARCH, TOOL_OPEN, TOOL_FIND, READ_LINK, TIP, TEMPLATE_RESPONSE, PARTIAL_FILE_READ are intentionally stripped
  }

  return {
    text: textParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    fileRefs,
    hasContentRisk,
  };
}

function toSnippet(text: string, maxLen = 56): string {
  return toCompactPreview(text, maxLen, '');
}

function countForkPoints(messages: readonly DeepSeekRawMessage[]): number {
  const childCounts = new Map<string, number>();
  for (const msg of messages) {
    const parentKey = msg.parent_id === null || msg.parent_id === undefined ? '__ROOT__' : String(msg.parent_id);
    childCounts.set(parentKey, (childCounts.get(parentKey) ?? 0) + 1);
  }
  let forks = 0;
  for (const count of childCounts.values()) {
    if (count > 1) forks += 1;
  }
  return forks;
}

function scoreSessionAsFiction(
  title: string,
  messages: readonly DeepSeekRawMessage[],
  attachments: readonly DeepSeekAttachmentMeta[],
  forkCount: number,
): number {
  let score = 0;
  if (attachments.some((a) => a.kind === 'text')) score += 3;
  if (forkCount > 0) score += 1;
  if (messages.length >= 6) score += 1;
  if (messages.length >= 20) score += 2;

  const sampleParts: string[] = [title];
  for (const msg of messages.slice(0, 8)) {
    const { text } = extractFragments(msg);
    if (text) sampleParts.push(text.slice(0, 600));
  }
  const sampleText = sampleParts.join('\n');

  const matchCount = countStrongFictionMatches(sampleText);
  if (matchCount > 0) {
    score += Math.min(5, matchCount);
  }
  if (/```[\s\S]*```/.test(sampleText) && /好感|体力|声望|银两|属性|状态/.test(sampleText)) {
    score += 2;
  }
  if (/^[AB12][.、):]/m.test(sampleText)) {
    score += 1;
  }
  if (TECH_NOISE_REGEX.test(sampleText) && matchCount < 2) {
    score -= 3;
  }
  return score;
}

function parseManifestAndCheckVersion(entries: Record<string, Uint8Array>): number {
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) {
    throw new Error('压缩包缺少 manifest.json，无法识别为 DeepSeek 导出包。');
  }
  let manifest: { export_format_version?: unknown } | null;
  try {
    manifest = JSON.parse(decodeUtf8WithGbFallback(manifestBytes)) as {
      export_format_version?: unknown;
    };
  } catch {
    throw new Error('DeepSeek 导出包的 manifest.json 格式无效。');
  }
  const version = manifest?.export_format_version;
  if (version !== 3) {
    throw new UnsupportedDeepSeekExportVersionError(
      typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
        ? version
        : undefined,
    );
  }
  return 3;
}

function resolveAttachmentPath(sessionId: string, fileRef: DeepSeekRawFileRef): string {
  if (fileRef.export_path) {
    return normalizeZipPath(fileRef.export_path);
  }
  const fileName = fileRef.file_name ?? 'attachment';
  return normalizeZipPath(`chat_sessions/${sessionId}/${fileName}`);
}

const KNOWN_FRAGMENT_TYPES = new Set([
  'REQUEST',
  'RESPONSE',
  'THINK',
  'FILE',
  'CONTENT_RISK',
  'TIP',
  'TEMPLATE_RESPONSE',
  'PARTIAL_FILE_READ',
  'READ_LINK',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_FIND',
]);
const SAFE_FRAGMENT_TYPE_REGEX = /^[A-Z][A-Z0-9_]{0,31}$/;
const SAFE_EXTENSION_REGEX = /^\.[a-z0-9]{1,8}$/;

function isUnknownFragmentType(upperType: string): boolean {
  return upperType !== '' && !KNOWN_FRAGMENT_TYPES.has(upperType);
}

function countDanglingParents(messages: readonly DeepSeekRawMessage[]): number {
  const ids = new Set(messages.map((m) => String(m.id)));
  return messages.filter(
    (m) => m.parent_id !== null && m.parent_id !== undefined && !ids.has(String(m.parent_id)),
  ).length;
}

/**
 * Stage 1: Decompresses ONLY manifest.json and chat_sessions/*.json metadata.
 * Never touches image, PDF, or binary attachment bytes.
 */
export function scanDeepSeekExportZip(zipBytes: Uint8Array): DeepSeekZipScanResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, {
      filter: (file) => {
        const name = normalizeZipPath(file.name);
        return (
          name === 'manifest.json' ||
          (name.startsWith('chat_sessions/') && name.endsWith('.json'))
        );
      },
    });
  } catch {
    throw new Error('无法读取 DeepSeek 导出 .zip 文件，请确认文件完整未损坏。');
  }

  const exportFormatVersion = parseManifestAndCheckVersion(entries);
  const sessions: DeepSeekSessionIndexItem[] = [];
  const nowFallback = Date.now();
  const unknownFragmentTypes = new Set<string>();
  const attachmentExtensions: Record<string, number> = {};
  let danglingParentCount = 0;
  let emptyTitleCount = 0;

  for (const [rawPath, bytes] of Object.entries(entries)) {
    const filePath = normalizeZipPath(rawPath);
    if (!filePath.startsWith('chat_sessions/') || !filePath.endsWith('.json')) continue;

    let raw: DeepSeekRawSession;
    try {
      raw = JSON.parse(decodeUtf8WithGbFallback(bytes)) as DeepSeekRawSession;
    } catch {
      continue;
    }
    if (!raw || typeof raw.id !== 'string') continue;

    const messages = getSessionMessages(raw);
    danglingParentCount += countDanglingParents(messages);
    const attachments: DeepSeekAttachmentMeta[] = [];
    const seenPaths = new Set<string>();
    let diagnosticCount = 0;
    let firstUserSnippet = '';
    let latestSnippet = '';

    for (const msg of messages) {
      const { text, fileRefs, hasContentRisk } = extractFragments(msg, unknownFragmentTypes);
      if (normalizeDiagnosticStatus(msg.status) || hasContentRisk) {
        diagnosticCount += 1;
      }
      if (!firstUserSnippet && (msg.role ?? '').toUpperCase() === 'USER' && text) {
        firstUserSnippet = toSnippet(text, 40);
      }
      if (text) {
        latestSnippet = toSnippet(text, 56);
      }
      for (const f of fileRefs) {
        const fileName = f.file_name?.trim() || '未命名附件';
        const exportPath = resolveAttachmentPath(raw.id, f);
        if (seenPaths.has(exportPath)) continue;
        seenPaths.add(exportPath);
        const ext = getFileExtension(fileName);
        const safeExt = SAFE_EXTENSION_REGEX.test(ext) ? ext : ext ? '.other' : '.none';
        attachmentExtensions[safeExt] = (attachmentExtensions[safeExt] ?? 0) + 1;
        attachments.push({
          fileName,
          exportPath,
          ext,
          kind: classifyAttachment(fileName, f.is_image),
          fileSize: typeof f.file_size === 'number' ? f.file_size : 0,
        });
      }
    }

    const { title, hasNullTitle } = resolveSessionTitle(raw.title, firstUserSnippet);
    if (hasNullTitle) emptyTitleCount += 1;
    const forkCount = countForkPoints(messages);
    const fictionScore = scoreSessionAsFiction(title, messages, attachments, forkCount);

    sessions.push({
      sessionId: raw.id,
      filePath,
      title,
      hasNullTitle,
      updatedAt: parseTimestamp(raw.updated_at ?? raw.inserted_at, nowFallback),
      insertedAt: parseTimestamp(raw.inserted_at, nowFallback),
      messageCount: messages.length,
      turnCount: Math.ceil(messages.length / 2),
      forkCount,
      currentMessageId:
        raw.current_message_id !== null && raw.current_message_id !== undefined
          ? String(raw.current_message_id)
          : null,
      firstSnippet: firstUserSnippet,
      latestSnippet,
      attachments,
      diagnosticCount,
      fictionScore,
      isLikelyFiction: fictionScore >= 3,
    });
  }

  sessions.sort((a, b) => {
    if (a.isLikelyFiction !== b.isLikelyFiction) {
      return a.isLikelyFiction ? -1 : 1;
    }
    if (b.fictionScore !== a.fictionScore) {
      return b.fictionScore - a.fictionScore;
    }
    return b.updatedAt - a.updatedAt;
  });

  return {
    exportFormatVersion,
    sessions,
    structure: {
      exportFormatVersion,
      totalSessions: sessions.length,
      danglingParentCount,
      emptyTitleCount,
      unknownFragmentTypes: Array.from(unknownFragmentTypes).sort(),
      attachmentExtensions,
    },
  };
}

interface SetupAttachmentText {
  requestText: string;
  texts: string[];
}

function buildSetupAttachmentScript({ requestText, texts }: SetupAttachmentText): string {
  const instruction = requestText.trim();
  const scriptParts = [...new Set(texts)];
  if (instruction && !scriptParts.includes(instruction)) scriptParts.push(instruction);
  return scriptParts.join('\n\n').trim();
}

function detectRawScriptFromActivePath(
  activeNodes: readonly TurnNode[],
  attachmentsByNodeId: ReadonlyMap<string, SetupAttachmentText>,
  overrideRange?: ScriptTurnRange,
): { rawScript: string; confidence: 'strong' | 'ambiguous'; setupNodeIds: string[] } {
  const userNodes = activeNodes.filter((n) => n.role === 'user');
  if (overrideRange && overrideRange.endTurn >= 1) {
    const startIdx = Math.max(0, (overrideRange.startTurn ?? 1) - 1);
    const endIdx = Math.max(startIdx + 1, overrideRange.endTurn);
    const chosen = userNodes.slice(startIdx, endIdx);
    const parts: string[] = [];
    const setupNodeIds: string[] = [];
    for (const node of chosen) {
      const attachments = attachmentsByNodeId.get(node.id);
      const text = attachments ? buildSetupAttachmentScript(attachments) : node.content.trim();
      if (text) {
        parts.push(text);
        setupNodeIds.push(node.id);
      }
    }
    return { rawScript: parts.join('\n\n').trim(), confidence: 'strong', setupNodeIds };
  }

  const firstUser = userNodes[0];
  if (firstUser) {
    const firstAttachments = attachmentsByNodeId.get(firstUser.id);
    if (firstAttachments) {
      return {
        rawScript: buildSetupAttachmentScript(firstAttachments),
        confidence: 'ambiguous',
        setupNodeIds: [],
      };
    }
    const firstText = firstUser.content.trim();
    if (firstText.length >= 180 || countStrongFictionMatches(firstText) >= 2) {
      return { rawScript: firstText, confidence: 'ambiguous', setupNodeIds: [] };
    }
  }

  // Turn 1 lacked strong script signals (ambiguous opening, e.g. chitchat before script).
  // Provide best local fallback candidate while keeping confidence='ambiguous' for Level-2 LLM refinement.
  for (const node of userNodes.slice(1, 5)) {
    const attachments = attachmentsByNodeId.get(node.id);
    if (attachments) {
      return {
        rawScript: buildSetupAttachmentScript(attachments),
        confidence: 'ambiguous',
        setupNodeIds: [],
      };
    }
    const text = node.content.trim();
    if (text.length >= 120 || countStrongFictionMatches(text) >= 2) {
      return { rawScript: text, confidence: 'ambiguous', setupNodeIds: [] };
    }
  }

  const fallbackText = firstUser?.content.trim() ?? '';
  return {
    rawScript: fallbackText,
    confidence: 'ambiguous',
    setupNodeIds: [],
  };
}

export function buildImportSettingMarkdown(
  initialScript: string,
  recoveredAttachments: readonly RecoveredTextAttachment[],
): string {
  const trimmedScript = initialScript.trim();
  const extraAttachments = recoveredAttachments
    .map((att) => ({ fileName: att.fileName, content: att.content.trim() }))
    .filter((att) => att.content && !trimmedScript.includes(att.content));

  const sections: string[] = [];
  if (trimmedScript) {
    sections.push(trimmedScript);
  }
  for (const att of extraAttachments) {
    sections.push(`## 附件：${att.fileName}\n\n${att.content}`);
  }
  return sections.join('\n\n').trim();
}

function initializeStorySettingDocument(
  story: Story,
  settingMarkdown: string,
  preserveSetupRawScript = '',
): Story {
  const container = newDocument(settingMarkdown, 'migration', 'story-original');
  const local = newDocument('', 'migration', 'path-original');
  const nodes: Record<string, TurnNode> = {};
  for (const [id, node] of Object.entries(story.nodes)) {
    nodes[id] = {
      ...node,
      documents: {
        container: 'story-original',
        local: 'path-original',
      },
    };
  }
  return {
    ...story,
    rawScript: story.setupNodeIds?.length ? preserveSetupRawScript : '',
    v2Migrated: true,
    nodes,
    documents: {
      container,
      local,
      edits: {},
    },
  };
}

function buildStoryFromRawSession(
  raw: DeepSeekRawSession,
  extractedFiles: Record<string, Uint8Array>,
  opts: {
    createId: () => string;
    now: () => number;
    scriptRangeOverride?: ScriptTurnRange;
    retainAttachments: boolean;
  },
): DeepSeekSessionPreview {
  const messages = getSessionMessages(raw);
  const createdAt = parseTimestamp(raw.inserted_at, opts.now());
  const updatedAt = parseTimestamp(raw.updated_at, createdAt);

  const rawById = new Map<string, DeepSeekRawMessage>();
  for (const m of messages) {
    rawById.set(String(m.id), m);
  }

  const dsToNodeId = new Map<string, string>();
  const rawOrdered = [...messages].sort(
    (a, b) => parseTimestamp(a.inserted_at, createdAt) - parseTimestamp(b.inserted_at, createdAt),
  );
  for (const m of rawOrdered) {
    dsToNodeId.set(String(m.id), opts.createId());
  }

  const recoveredAttachments: DeepSeekAttachmentResult[] = [];
  const recoveredTextAttachments: RecoveredTextAttachment[] = [];
  const skippedAttachments: DeepSeekAttachmentResult[] = [];
  const seenAttachmentPaths = new Set<string>();
  const attachmentsByNodeId = new Map<string, SetupAttachmentText>();
  const attachments: Record<string, StoryAttachment> = Object.create(null);
  const nodes: Record<string, TurnNode> = {};
  const rawParentByNodeId = new Map<string, string | null>();
  const emptySnapshot: PlotSummarySnapshot = {
    content: '',
    coveredUpToNodeId: null,
    summarizedTurnCount: 0,
  };
  let diagnosticCount = 0;
  let firstUserSnippet = '';

  const resolveValidParentId = (rawParentId: string | number | null | undefined): string | null => {
    let cursor = rawParentId !== null && rawParentId !== undefined ? String(rawParentId) : null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const mappedId = dsToNodeId.get(cursor);
      if (mappedId && nodes[mappedId]) return mappedId;
      const parentRaw = rawById.get(cursor);
      cursor =
        parentRaw?.parent_id !== null && parentRaw?.parent_id !== undefined
          ? String(parentRaw.parent_id)
          : null;
    }
    return null;
  };

  for (const msg of rawOrdered) {
    const rawId = String(msg.id);
    const nodeId = dsToNodeId.get(rawId)!;
    const roleUpper = (msg.role ?? '').toUpperCase();
    const role: 'user' | 'assistant' = roleUpper === 'ASSISTANT' ? 'assistant' : 'user';
    const { text, reasoning, fileRefs, hasContentRisk } = extractFragments(msg);
    const sourceStatus = normalizeDiagnosticStatus(msg.status);
    const diagnostics: NodeDiagnostics | undefined =
      sourceStatus || hasContentRisk
        ? {
            ...(sourceStatus ? { sourceStatus } : {}),
            ...(hasContentRisk ? { contentRisk: true } : {}),
          }
        : undefined;

    const inlineAttachmentSections: string[] = [];
    const rawAttachmentTexts: string[] = [];
    const attachmentIds = new Set<string>();

    for (const f of fileRefs) {
      const fileName = f.file_name?.trim() || '未命名附件';
      const exportPath = resolveAttachmentPath(raw.id, f);
      const kind = classifyAttachment(fileName, f.is_image);
      const isFirstSeen = !seenAttachmentPaths.has(exportPath);
      seenAttachmentPaths.add(exportPath);
      const original = extractedFiles[exportPath];
      if (opts.retainAttachments && original) {
        if (!Object.hasOwn(attachments, exportPath)) {
          attachments[exportPath] = { fileName, base64: encodeAttachment(original) };
        }
        attachmentIds.add(exportPath);
      }

      if (kind === 'text') {
        const bytes = extractedFiles[exportPath];
        if (bytes) {
          try {
            const parsed = parseScriptInput({ kind: 'file', fileName, bytes });
            rawAttachmentTexts.push(parsed.rawScript);
            inlineAttachmentSections.push(`【附件：${fileName}】\n${parsed.rawScript}`);
            if (isFirstSeen) {
              recoveredAttachments.push({ fileName, exportPath, kind });
              if (parsed.rawScript.trim()) {
                recoveredTextAttachments.push({ fileName, content: parsed.rawScript.trim() });
              }
            }
            continue;
          } catch {
            // Fall through to skipped if corrupt text file
          }
        }
        if (isFirstSeen) {
          skippedAttachments.push({
            fileName,
            exportPath,
            kind: 'unsupported',
            hint: '文本附件内容为空或无法读取，已跳过正文整理。',
          });
        }
      } else if (kind === 'legacy_doc') {
        if (isFirstSeen) {
          skippedAttachments.push({
            fileName,
            exportPath,
            kind,
            hint: '旧版 .doc 暂不支持直接读取正文，已保留原文件备查；如需整理进设定，请先另存为 .docx。',
          });
        }
      } else if (isFirstSeen) {
        skippedAttachments.push({
          fileName,
          exportPath,
          kind,
          hint: kind === 'media' ? '图片与 PDF 仅保留原文件备查。' : '此附件仅保留原文件备查。',
        });
      }
    }

    if (rawAttachmentTexts.length > 0) {
      attachmentsByNodeId.set(nodeId, { requestText: text, texts: rawAttachmentTexts });
    }

    const combinedText = [text, ...inlineAttachmentSections].filter(Boolean).join('\n\n').trim();
    if (!combinedText && !reasoning && !diagnostics && attachmentIds.size === 0) {
      continue;
    }

    if (diagnostics) diagnosticCount += 1;
    if (!firstUserSnippet && role === 'user' && text) {
      firstUserSnippet = toSnippet(text, 40);
    }

    const finalContent = combinedText || (attachmentIds.size ? '（原平台消息包含附件）' : '（原平台回复在此中断，未返回正文）');
    rawParentByNodeId.set(
      nodeId,
      msg.parent_id !== null && msg.parent_id !== undefined ? String(msg.parent_id) : null,
    );

    nodes[nodeId] = {
      id: nodeId,
      parentId: null,
      role,
      content: finalContent,
      ...(reasoning ? { reasoningContent: reasoning } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(attachmentIds.size > 0 ? { attachmentIds: [...attachmentIds] } : {}),
      createdAt: parseTimestamp(msg.inserted_at, createdAt),
      summarySnapshot: emptySnapshot,
    };
  }

  // Resolve parentId after all nodes are populated so identical/out-of-order timestamps never skip parents
  for (const [nodeId, rawParentId] of rawParentByNodeId.entries()) {
    nodes[nodeId] = {
      ...nodes[nodeId],
      parentId: resolveValidParentId(rawParentId),
    };
  }

  const rootNodeIds = Object.values(nodes)
    .filter((n) => n.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((n) => n.id);

  // Resolve activeLeafNodeId from current_message_id (falling back to nearest valid ancestor or latest node)
  let activeLeafNodeId: string | null = null;
  if (raw.current_message_id !== null && raw.current_message_id !== undefined) {
    const directMapped = dsToNodeId.get(String(raw.current_message_id));
    if (directMapped && nodes[directMapped]) {
      activeLeafNodeId = directMapped;
    } else {
      activeLeafNodeId = resolveValidParentId(raw.current_message_id);
    }
  }
  if (!activeLeafNodeId) {
    const allNodes = Object.values(nodes);
    activeLeafNodeId = allNodes.length > 0 ? allNodes[allNodes.length - 1].id : null;
  }

  const { title } = resolveSessionTitle(raw.title, firstUserSnippet);
  const baseStory: Story = {
    id: opts.createId(),
    title,
    sourceKind: 'deepseek_import',
    sourceSessionId: raw.id,
    ...(Object.keys(attachments).length > 0 ? { attachments } : {}),
    rawScript: '',
    blueprint: createDefaultBlueprint(title),
    nodes,
    rootNodeIds,
    activeLeafNodeId,
    createdAt,
    updatedAt,
  };

  const activeNodes = getActiveBranchNodes(baseStory, activeLeafNodeId);
  const detected = detectRawScriptFromActivePath(
    activeNodes,
    attachmentsByNodeId,
    opts.scriptRangeOverride,
  );
  const settingMarkdown = buildImportSettingMarkdown(detected.rawScript, recoveredTextAttachments);

  const firstAssistant = activeNodes.find((n) => n.role === 'assistant');
  const story = initializeStorySettingDocument(
    {
      ...baseStory,
      ...(detected.setupNodeIds.length > 0 ? { setupNodeIds: detected.setupNodeIds } : {}),
      blueprint: {
        ...baseStory.blueprint,
        openingHook: firstAssistant ? toSnippet(firstAssistant.content, 120) : '',
      },
    },
    settingMarkdown,
    detected.rawScript,
  );

  const activeLeaf = activeLeafNodeId ? nodes[activeLeafNodeId] : null;
  return {
    sessionId: raw.id,
    title,
    story,
    rawScript: detected.rawScript,
    settingMarkdown,
    scriptConfidence: detected.confidence,
    latestSnippet: activeLeaf ? toSnippet(activeLeaf.content, 64) : '',
    turnCount: Math.ceil(activeNodes.length / 2),
    forkCount: countForkPoints(messages),
    recoveredAttachments,
    recoveredTextAttachments,
    skippedAttachments,
    diagnosticCount,
  };
}

function encodeAttachment(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    encoded += alphabet[first >>> 2] + alphabet[((first & 3) << 4) | (second >>> 4)] +
      (index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >>> 6)] : '=') +
      (index + 2 < bytes.length ? alphabet[third & 63] : '=');
  }
  return encoded;
}

export function previewDeepSeekSessions(
  zipBytes: Uint8Array,
  selectedSessionIds: readonly string[],
  options: DeepSeekPreviewOptions = {},
): DeepSeekSessionPreview[] {
  return readDeepSeekSessions(zipBytes, selectedSessionIds, options, false);
}

function readDeepSeekSessions(
  zipBytes: Uint8Array,
  selectedSessionIds: readonly string[],
  options: DeepSeekPreviewOptions,
  retainAttachments: boolean,
): DeepSeekSessionPreview[] {
  const selectedSet = new Set(selectedSessionIds);
  if (selectedSet.size === 0) return [];

  const targetSessionFiles = new Set(
    Array.from(selectedSet, (id) => normalizeZipPath(`chat_sessions/${id}.json`)),
  );

  let sessionEntries: Record<string, Uint8Array>;
  try {
    sessionEntries = unzipSync(zipBytes, {
      filter: (file) => {
        const name = normalizeZipPath(file.name);
        return name === 'manifest.json' || targetSessionFiles.has(name);
      },
    });
  } catch {
    throw new Error('读取所选 DeepSeek 会话 JSON 失败。');
  }

  parseManifestAndCheckVersion(sessionEntries);

  const parsedSessions: DeepSeekRawSession[] = [];
  const neededAttachmentPaths = new Set<string>();

  for (const id of selectedSessionIds) {
    const filePath = normalizeZipPath(`chat_sessions/${id}.json`);
    const bytes = sessionEntries[filePath];
    if (!bytes) continue;
    let raw: DeepSeekRawSession;
    try {
      raw = JSON.parse(decodeUtf8WithGbFallback(bytes)) as DeepSeekRawSession;
    } catch {
      continue;
    }
    parsedSessions.push(raw);

    for (const msg of getSessionMessages(raw)) {
      const { fileRefs } = extractFragments(msg);
      for (const f of fileRefs) {
        const fileName = f.file_name?.trim() || '';
        if (retainAttachments || classifyAttachment(fileName, f.is_image) === 'text') {
          neededAttachmentPaths.add(resolveAttachmentPath(raw.id, f));
        }
      }
    }
  }

  const extractedFiles: Record<string, Uint8Array> = Object.create(null);
  function extract(paths: Set<string>) {
    let remaining = DEFAULT_ZIP_MAX_BYTES;
    return unzipSync(zipBytes, {
      filter: (file) => {
        if (!paths.has(normalizeZipPath(file.name)) || file.originalSize > remaining) return false;
        remaining -= file.originalSize;
        return true;
      },
    });
  }
  if (neededAttachmentPaths.size > 0) {
    let files: Record<string, Uint8Array>;
    try {
      files = extract(neededAttachmentPaths);
    } catch {
      // A damaged entry should not discard other originals or their conversation history.
      files = Object.create(null);
      let remaining = DEFAULT_ZIP_MAX_BYTES;
      for (const path of neededAttachmentPaths) {
        try {
          for (const [name, value] of Object.entries(extract(new Set([path])))) {
            if (value.length > remaining) break;
            files[name] = value;
            remaining -= value.length;
          }
        } catch {
          // The original cannot be restored from this ZIP entry.
        }
      }
    }
    for (const [key, value] of Object.entries(files)) extractedFiles[normalizeZipPath(key)] = value;
  }

  const createId = options.createId ?? createDefaultId;
  const now = options.now ?? (() => Date.now());

  return parsedSessions.map((raw) =>
    buildStoryFromRawSession(raw, extractedFiles, {
      createId,
      now,
      scriptRangeOverride: options.scriptRangeOverrides?.[raw.id],
      retainAttachments,
    }),
  );
}

async function streamJsonObject(
  transport: LlmTransport,
  config: ModelConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  signal?: AbortSignalLike,
): Promise<Record<string, unknown> | null> {
  const bgConfig = createBackgroundModelConfig(config);
  let rawResponse = '';
  for await (const delta of transport.streamChat({
    baseUrl: bgConfig.baseUrl,
    apiKey: bgConfig.apiKey,
    model: bgConfig.model,
    reasoningEffort: bgConfig.reasoningEffort,
    signal,
    messages,
  })) {
    if (delta.contentDelta) {
      rawResponse += delta.contentDelta;
    }
  }
  const jsonMatch = /\{[\s\S]*\}/.exec(rawResponse);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Level 2 boundary locator for ambiguous openings (e.g. chitchat turns before pasting the script).
 * Sends only compact snippets of the first few active-path turns to identify scriptMessageIds.
 */
export async function locateDeepSeekScriptBoundary(
  story: Story,
  transport: LlmTransport,
  config: ModelConfig,
  signal?: AbortSignalLike,
): Promise<ScriptBoundaryResult> {
  const fallbackResult = (firstPlayMessageId: string | null = null): ScriptBoundaryResult => ({
    rawScript: story.rawScript,
    scriptMessageIds: [],
    firstPlayMessageId,
    usedFallback: true,
  });

  const activeNodes = getActiveBranchNodes(story, story.activeLeafNodeId);
  const earlyNodes = activeNodes.slice(0, 8);
  if (earlyNodes.length === 0) return fallbackResult();

  const compactPreview = earlyNodes.map((n, index) => ({
    index: index + 1,
    nodeId: n.id,
    role: n.role,
    snippet: toSnippet(n.content, 240),
  }));

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = await streamJsonObject(
      transport,
      config,
      [
        {
          role: 'system',
          content:
            '你是互动叙事剧本边界定位助手（剧本边界定位）。给定对话前几轮的精简摘要，请识别哪几条节点属于“原始剧本/规则设定”（排除开头闲聊），以及哪条是“第一轮正式游玩起点”。严格只输出 JSON：{"scriptMessageIds":["..."],"firstPlayMessageId":"...|null"}。',
        },
        {
          role: 'user',
          content: JSON.stringify(compactPreview),
        },
      ],
      signal,
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return fallbackResult();
  }

  if (!parsed) return fallbackResult();

  const validIds = new Set(earlyNodes.map((n) => n.id));
  const userIds = new Set(earlyNodes.filter((node) => node.role === 'user').map((node) => node.id));
  const scriptMessageIds = Array.isArray(parsed.scriptMessageIds)
    ? earlyNodes.filter((node) => userIds.has(node.id) && (parsed.scriptMessageIds as unknown[]).includes(node.id)).map((node) => node.id)
    : [];
  const firstPlayMessageId =
    typeof parsed.firstPlayMessageId === 'string' && validIds.has(parsed.firstPlayMessageId)
      ? parsed.firstPlayMessageId
      : null;

  if (scriptMessageIds.length === 0) {
    return fallbackResult(firstPlayMessageId);
  }

  const rawScript = scriptMessageIds
    .map((id) => story.nodes[id]?.content.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return {
    rawScript: rawScript || story.rawScript,
    scriptMessageIds,
    firstPlayMessageId,
    usedFallback: false,
  };
}

export function markDuplicateImportSessions(
  sessions: readonly DeepSeekSessionIndexItem[],
  existingStories: Iterable<Pick<Story, 'sourceSessionId'> | string>,
): MarkedDeepSeekSession[] {
  const existingIds = new Set<string>();
  for (const item of existingStories) {
    if (typeof item === 'string') {
      if (item) existingIds.add(item);
    } else if (item.sourceSessionId) {
      existingIds.add(item.sourceSessionId);
    }
  }
  return sessions.map((session) => ({
    ...session,
    alreadyImported: existingIds.has(session.sessionId),
  }));
}

export function resolveDuplicateImportTitle(
  baseTitle: string,
  sourceSessionId: string,
  existingStories: readonly Pick<Story, 'title' | 'sourceSessionId'>[],
): string {
  const normalizedBase = baseTitle.trim() || DEFAULT_STORY_TITLE;
  const existingTitles = new Set(existingStories.map((story) => story.title));
  const hasSameSession = existingStories.some(
    (story) => story.sourceSessionId !== undefined && story.sourceSessionId === sourceSessionId,
  );
  if (!hasSameSession && !existingTitles.has(normalizedBase)) {
    return normalizedBase;
  }
  const firstCopy = `${normalizedBase} (副本)`;
  if (!existingTitles.has(firstCopy)) {
    return firstCopy;
  }
  let suffix = 2;
  while (existingTitles.has(`${normalizedBase} (副本 ${suffix})`)) {
    suffix += 1;
  }
  return `${normalizedBase} (副本 ${suffix})`;
}

/**
 * Persists each selected DeepSeek session 1-to-1 as an independent Story.
 * Merges initial setup text and readable text attachments directly into the canonical
 * single-Markdown 「故事设定」 (`story.documents.container`) without blocking approval.
 */
export async function importDeepSeekSessions(
  zipBytes: Uint8Array,
  selectedSessionIds: readonly string[],
  harness: Pick<
    FictionHarness,
    | 'saveStory'
    | 'setActiveStory'
    | 'getReviewState'
    | 'transport'
  > & Partial<Pick<FictionHarness, 'listStories'>>,
  options: DeepSeekImportOptions = {},
): Promise<DeepSeekImportBatchResult> {
  const previews = readDeepSeekSessions(zipBytes, selectedSessionIds, options, true);
  const stories: Story[] = [];
  const summaryStatuses: Record<string, ImportSummaryStatus> = {};
  const modelConfig = options.modelConfig;
  const transport = options.transport ?? harness.transport;
  const knownStories: Array<Pick<Story, 'title' | 'sourceSessionId'>> = [
    ...(options.existingStories ?? (harness.listStories ? await harness.listStories() : [])),
  ];

  for (const preview of previews) {
    let workingStory = preview.story;
    const hasManualOverride = Boolean(options.scriptRangeOverrides?.[preview.sessionId]);

    if (modelConfig && preview.scriptConfidence === 'ambiguous' && !hasManualOverride) {
      const boundary = await locateDeepSeekScriptBoundary(workingStory, transport, modelConfig, options.signal);
      if (!boundary.usedFallback && boundary.rawScript.trim()) {
        const refinedSetting = buildImportSettingMarkdown(
          boundary.rawScript,
          preview.recoveredTextAttachments,
        );
        workingStory = initializeStorySettingDocument(workingStory, refinedSetting);
      }
    }

    const resolvedTitle = resolveDuplicateImportTitle(
      workingStory.title,
      preview.sessionId,
      knownStories,
    );
    if (resolvedTitle !== workingStory.title) {
      workingStory = {
        ...workingStory,
        title: resolvedTitle,
        blueprint: { ...workingStory.blueprint, title: resolvedTitle },
      };
    }

    summaryStatuses[workingStory.id] = harness.getReviewState(workingStory).needsSummaryCompression
      ? (modelConfig ? 'pending_summary' : 'pending_key')
      : 'within_window';
    const saved = await harness.saveStory(workingStory);
    stories.push(saved);
    knownStories.push(saved);
  }

  if (stories.length > 0) {
    await harness.setActiveStory(stories[0].id);
  }
  return { stories, previews, summaryStatuses };
}

/**
 * Optional LLM-assisted session filter: sends compact session titles, timestamps,
 * and snippets to identify interactive-fiction candidates or match a natural-language query.
 */
export async function assistFilterDeepSeekSessions(
  sessions: readonly DeepSeekSessionIndexItem[],
  transport: LlmTransport,
  config: ModelConfig,
  signal?: AbortSignalLike,
  userQuery?: string,
): Promise<string[]> {
  if (sessions.length === 0) return [];
  const trimmedQuery = userQuery?.trim();
  const compactList = sessions.slice(0, 60).map((s) => ({
    id: s.sessionId,
    title: s.title,
    turns: s.turnCount,
    updatedAt: new Date(s.updatedAt).toISOString().slice(0, 10),
    snippet: s.firstSnippet || s.latestSnippet,
    ...(trimmedQuery && s.latestSnippet && s.latestSnippet !== s.firstSnippet
      ? { latestSnippet: s.latestSnippet }
      : {}),
    files: s.attachments.map((a) => a.fileName),
  }));

  const parsed = await streamJsonObject(
    transport,
    config,
    [
      {
        role: 'system',
        content: trimmedQuery
          ? '你是互动叙事对话筛选助手。请结合用户的自然语言描述（例如题材、角色设定、时间范围或片段线索），从给定对话列表 JSON 中挑出最符合的对话 ID，严格只输出 JSON：{"fictionSessionIds":["..."]}。'
          : '你是互动叙事文游识别助手。请从给定对话列表 JSON 中挑出属于“互动叙事 / 文字冒险 / 角色扮演文游”的对话 ID，严格只输出 JSON：{"fictionSessionIds":["..."]}。',
      },
      {
        role: 'user',
        content: trimmedQuery
          ? JSON.stringify({ query: trimmedQuery, sessions: compactList })
          : JSON.stringify(compactList),
      },
    ],
    signal,
  );

  if (!parsed || !Array.isArray(parsed.fictionSessionIds)) return [];
  const validIds = new Set(sessions.map((s) => s.sessionId));
  return parsed.fictionSessionIds.filter(
    (id): id is string => typeof id === 'string' && validIds.has(id),
  );
}
