import { unzipSync } from 'fflate';
import { createDefaultBlueprint } from './blueprint.ts';
import { getActiveBranchNodes } from './context.ts';
import { decodeUtf8WithGbFallback } from './encoding.ts';
import type { FictionHarness } from './harness.ts';
import { createDefaultId } from './id.ts';
import { DEFAULT_STORY_TITLE, parseScriptInput } from './scriptParser.ts';
import type {
  AbortSignalLike,
  LlmTransport,
  ModelConfig,
  NodeDiagnosticStatus,
  NodeDiagnostics,
  PlotSummarySnapshot,
  Story,
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

export interface DeepSeekZipScanResult {
  exportFormatVersion: number;
  sessions: DeepSeekSessionIndexItem[];
}

export interface DeepSeekAttachmentResult {
  fileName: string;
  exportPath: string;
  kind: DeepSeekAttachmentKind;
  hint?: string;
}

export interface DeepSeekSessionPreview {
  sessionId: string;
  title: string;
  story: Story;
  rawScript: string;
  scriptConfidence: 'strong' | 'ambiguous';
  latestSnippet: string;
  turnCount: number;
  forkCount: number;
  recoveredAttachments: DeepSeekAttachmentResult[];
  skippedAttachments: DeepSeekAttachmentResult[];
  diagnosticCount: number;
}

export interface DeepSeekImportBatchResult {
  stories: Story[];
  previews: DeepSeekSessionPreview[];
}

export interface DeepSeekPreviewOptions {
  createId?: () => string;
  now?: () => number;
  scriptTurnOverrides?: Record<string, number>;
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

function extractFragments(msg: DeepSeekRawMessage): {
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
    const t = (frag.type ?? '').toUpperCase();
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
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
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
  let manifest: { export_format_version?: unknown };
  try {
    manifest = JSON.parse(decodeUtf8WithGbFallback(manifestBytes)) as {
      export_format_version?: unknown;
    };
  } catch {
    throw new Error('DeepSeek 导出包的 manifest.json 格式无效。');
  }
  if (manifest.export_format_version !== 3) {
    throw new Error(
      `不支持的 DeepSeek 导出格式版本：${String(manifest.export_format_version ?? '未知')}（当前仅支持 v3）。`,
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
    const attachments: DeepSeekAttachmentMeta[] = [];
    const seenPaths = new Set<string>();
    let diagnosticCount = 0;
    let firstUserSnippet = '';
    let latestSnippet = '';

    for (const msg of messages) {
      const { text, fileRefs, hasContentRisk } = extractFragments(msg);
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
        attachments.push({
          fileName,
          exportPath,
          ext: getFileExtension(fileName),
          kind: classifyAttachment(fileName, f.is_image),
          fileSize: typeof f.file_size === 'number' ? f.file_size : 0,
        });
      }
    }

    const { title, hasNullTitle } = resolveSessionTitle(raw.title, firstUserSnippet);
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

  return { exportFormatVersion, sessions };
}

function detectRawScriptFromActivePath(
  activeNodes: readonly TurnNode[],
  attachmentTextsByNodeId: ReadonlyMap<string, string[]>,
  overrideTurnCount?: number,
): { rawScript: string; confidence: 'strong' | 'ambiguous' } {
  const userNodes = activeNodes.filter((n) => n.role === 'user');
  if (overrideTurnCount !== undefined && overrideTurnCount > 0) {
    const chosen = userNodes.slice(0, overrideTurnCount);
    const parts: string[] = [];
    for (const node of chosen) {
      const attach = attachmentTextsByNodeId.get(node.id) ?? [];
      parts.push(...attach);
      if (node.content.trim()) parts.push(node.content.trim());
    }
    return { rawScript: parts.join('\n\n').trim(), confidence: 'strong' };
  }

  const earlyUsers = userNodes.slice(0, 3);
  const attachmentParts: string[] = [];
  for (const node of earlyUsers) {
    const texts = attachmentTextsByNodeId.get(node.id);
    if (texts && texts.length > 0) {
      attachmentParts.push(...texts);
    }
  }
  if (attachmentParts.length > 0) {
    const firstUserText = earlyUsers[0]?.content.trim() ?? '';
    const combined = [...attachmentParts, ...(firstUserText.length >= 120 ? [firstUserText] : [])]
      .join('\n\n')
      .trim();
    return { rawScript: combined, confidence: 'strong' };
  }

  for (let i = 0; i < earlyUsers.length; i++) {
    const content = earlyUsers[i].content.trim();
    if (content.length >= 180 || countStrongFictionMatches(content) >= 2) {
      const combined = earlyUsers
        .slice(0, i + 1)
        .map((n) => n.content.trim())
        .filter(Boolean)
        .join('\n\n');
      return { rawScript: combined, confidence: 'strong' };
    }
  }

  const fallback = userNodes[0]?.content.trim() ?? '';
  return { rawScript: fallback, confidence: 'ambiguous' };
}

function buildStoryFromRawSession(
  raw: DeepSeekRawSession,
  extractedFiles: Record<string, Uint8Array>,
  opts: {
    createId: () => string;
    now: () => number;
    scriptTurnOverride?: number;
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
  const skippedAttachments: DeepSeekAttachmentResult[] = [];
  const seenAttachmentPaths = new Set<string>();
  const attachmentTextsByNodeId = new Map<string, string[]>();
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

    for (const f of fileRefs) {
      const fileName = f.file_name?.trim() || '未命名附件';
      const exportPath = resolveAttachmentPath(raw.id, f);
      const kind = classifyAttachment(fileName, f.is_image);
      const isFirstSeen = !seenAttachmentPaths.has(exportPath);
      seenAttachmentPaths.add(exportPath);

      if (kind === 'text') {
        const bytes = extractedFiles[exportPath];
        if (bytes) {
          try {
            const parsed = parseScriptInput({ kind: 'file', fileName, bytes });
            rawAttachmentTexts.push(parsed.rawScript);
            inlineAttachmentSections.push(`【附件：${fileName}】\n${parsed.rawScript}`);
            if (isFirstSeen) {
              recoveredAttachments.push({ fileName, exportPath, kind });
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
            hint: '文本附件内容为空或无法读取，已跳过。',
          });
        }
      } else if (kind === 'legacy_doc') {
        if (isFirstSeen) {
          skippedAttachments.push({
            fileName,
            exportPath,
            kind,
            hint: '旧版二进制 .doc 暂不支持前端直读，请先在 Word/WPS 中另存为 .docx 后再导入。',
          });
        }
      } else if (isFirstSeen) {
        skippedAttachments.push({
          fileName,
          exportPath,
          kind,
          hint: kind === 'media' ? '图片或 PDF 附件已跳过（未解压）。' : '不支持的附件格式已跳过。',
        });
      }
    }

    if (rawAttachmentTexts.length > 0) {
      attachmentTextsByNodeId.set(nodeId, rawAttachmentTexts);
    }

    const combinedText = [text, ...inlineAttachmentSections].filter(Boolean).join('\n\n').trim();
    if (!combinedText && !reasoning && !diagnostics) {
      continue;
    }

    if (diagnostics) diagnosticCount += 1;
    if (!firstUserSnippet && role === 'user' && text) {
      firstUserSnippet = toSnippet(text, 40);
    }

    const finalContent = combinedText || '（原平台回复在此中断，未返回正文）';
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
    attachmentTextsByNodeId,
    opts.scriptTurnOverride,
  );

  const firstAssistant = activeNodes.find((n) => n.role === 'assistant');
  const story: Story = {
    ...baseStory,
    rawScript: detected.rawScript,
    blueprint: {
      ...baseStory.blueprint,
      openingHook: firstAssistant ? toSnippet(firstAssistant.content, 120) : '',
    },
  };

  const activeLeaf = activeLeafNodeId ? nodes[activeLeafNodeId] : null;
  return {
    sessionId: raw.id,
    title,
    story,
    rawScript: detected.rawScript,
    scriptConfidence: detected.confidence,
    latestSnippet: activeLeaf ? toSnippet(activeLeaf.content, 64) : '',
    turnCount: Math.ceil(activeNodes.length / 2),
    forkCount: countForkPoints(messages),
    recoveredAttachments,
    skippedAttachments,
    diagnosticCount,
  };
}

/**
 * Stage 2: Decompresses ONLY the selected sessions' JSONs and their referenced .docx/.md/.txt files.
 * Media (.png/.jpg/.pdf/.doc) and unselected sessions are never decompressed.
 */
export function previewDeepSeekSessions(
  zipBytes: Uint8Array,
  selectedSessionIds: readonly string[],
  options: DeepSeekPreviewOptions = {},
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
        if (classifyAttachment(fileName, f.is_image) === 'text') {
          neededAttachmentPaths.add(resolveAttachmentPath(raw.id, f));
        }
      }
    }
  }

  let extractedFiles: Record<string, Uint8Array> = {};
  if (neededAttachmentPaths.size > 0) {
    const rawFiles = unzipSync(zipBytes, {
      filter: (file) => neededAttachmentPaths.has(normalizeZipPath(file.name)),
    });
    extractedFiles = {};
    for (const [k, v] of Object.entries(rawFiles)) {
      extractedFiles[normalizeZipPath(k)] = v;
    }
  }

  const createId = options.createId ?? createDefaultId;
  const now = options.now ?? (() => Date.now());

  return parsedSessions.map((raw) =>
    buildStoryFromRawSession(raw, extractedFiles, {
      createId,
      now,
      scriptTurnOverride: options.scriptTurnOverrides?.[raw.id],
    }),
  );
}

/**
 * Persists each selected DeepSeek session 1-to-1 as an independent Story without requiring an API key.
 */
export async function importDeepSeekSessions(
  zipBytes: Uint8Array,
  selectedSessionIds: readonly string[],
  harness: Pick<FictionHarness, 'saveStory' | 'setActiveStory'>,
  options: DeepSeekPreviewOptions = {},
): Promise<DeepSeekImportBatchResult> {
  const previews = previewDeepSeekSessions(zipBytes, selectedSessionIds, options);
  const stories: Story[] = [];
  for (const preview of previews) {
    const saved = await harness.saveStory(preview.story);
    stories.push(saved);
  }
  if (stories.length > 0) {
    await harness.setActiveStory(stories[0].id);
  }
  return { stories, previews };
}

/**
 * Optional LLM-assisted session filter: sends compact session titles and opening snippets
 * to identify interactive-fiction candidates among large DeepSeek exports.
 */
export async function assistFilterDeepSeekSessions(
  sessions: readonly DeepSeekSessionIndexItem[],
  transport: LlmTransport,
  config: ModelConfig,
  signal?: AbortSignalLike,
): Promise<string[]> {
  if (sessions.length === 0) return [];
  const compactList = sessions.slice(0, 60).map((s) => ({
    id: s.sessionId,
    title: s.title,
    turns: s.turnCount,
    snippet: s.firstSnippet,
    files: s.attachments.map((a) => a.fileName),
  }));

  let rawResponse = '';
  for await (const delta of transport.streamChat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    signal,
    messages: [
      {
        role: 'system',
        content:
          '你是互动叙事文游识别助手。请从给定会话列表 JSON 中挑出属于“互动叙事 / 文字冒险 / 角色扮演文游”的会话 ID，严格只输出 JSON：{"fictionSessionIds":["..."]}。',
      },
      {
        role: 'user',
        content: JSON.stringify(compactList),
      },
    ],
  })) {
    if (delta.contentDelta) {
      rawResponse += delta.contentDelta;
    }
  }

  const jsonMatch = /\{[\s\S]*\}/.exec(rawResponse);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { fictionSessionIds?: unknown };
    if (!Array.isArray(parsed.fictionSessionIds)) return [];
    const validIds = new Set(sessions.map((s) => s.sessionId));
    return parsed.fictionSessionIds.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id),
    );
  } catch {
    return [];
  }
}
