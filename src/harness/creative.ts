import { createDefaultId } from './id.ts';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  assembleCreativeThreeZoneContext,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  summarizeCreativeTurnNodes,
  type ContextBudgetConfig,
  type TurnTreeState,
} from './context.ts';
import {
  CHANGE_PROMPT,
  documentMessages,
  documentVersion,
  legacyStoryMarkdown,
  newDocument,
  parseProposalReply,
  referenceDocument,
  replaceDocumentProgress,
  storyDocumentState,
  visibleReplyPrefix,
  writeDocument,
  type MarkdownDocument,
  type MarkdownProposalStatus,
  type MarkdownVersion,
  type StoryDocuments,
} from './markdownDocuments.ts';
import type {
  AbortSignalLike,
  DocumentRead,
  LlmMessage,
  LlmTransport,
  ModelConfig,
  PlotSummarySnapshot,
  Story,
  TurnCallbacks,
  TurnNode,
  TurnProposalRecord,
} from './types.ts';

export type InteractionMode = 'personal' | 'roleplay';

export interface WritingSuggestion {
  id: string;
  instruction: string;
  text: string;
  revision: number;
  start: number;
  end: number;
  documentReads: NonNullable<TurnNode['documentReads']>;
}

export interface DraftWork {
  id: string;
  title: string;
  document: MarkdownDocument;
  body: string;
  writingStarted?: boolean;
  bodyRevision: number;
  discussion: TurnNode[];
  discussionNodes?: Record<string, TurnNode>;
  activeDiscussionLeafId?: string | null;
  suggestions: WritingSuggestion[];
  source?: { storyId: string; nodeId: string | null };
}

export interface CharacterConversation {
  id: string;
  title?: string;
  kind: InteractionMode;
  characterVersion: string;
  document: MarkdownDocument;
  edits: Record<string, string>;
  nodes: Record<string, TurnNode>;
  activeLeafNodeId: string | null;
}

export interface LocalCharacter {
  id: string;
  name: string;
  document: MarkdownDocument;
  conversations: CharacterConversation[];
  activeConversationId: string | null;
}

export interface CreativeWorkspaceState {
  revision: number;
  publicDocument: MarkdownDocument;
  works: DraftWork[];
  characters: LocalCharacter[];
  activeWorkId?: string;
  activeCharacterId?: string;
  v2Migrated?: boolean;
}

export interface CreativeStorage {
  load(): Promise<CreativeWorkspaceState | null>;
  save(workspace: CreativeWorkspaceState, expected: number): Promise<void>;
}

export const emptyWorkspace = (): CreativeWorkspaceState => ({
  revision: 0,
  publicDocument: newDocument('', 'user', 'public-original'),
  works: [],
  characters: [],
});

export function newWork(title: string, markdown = '', source?: DraftWork['source']): DraftWork {
  return {
    id: createDefaultId(), title: title.trim() || '未命名作品', document: newDocument(markdown),
    body: '', bodyRevision: 0, discussion: [], discussionNodes: {}, activeDiscussionLeafId: null,
    suggestions: [], ...(source ? { source } : {}),
  };
}

export function newCharacter(name: string, markdown: string): LocalCharacter {
  return {
    id: createDefaultId(), name: name.trim(), document: newDocument(markdown),
    conversations: [], activeConversationId: null,
  };
}

export function newConversation(
  character: LocalCharacter,
  kind: InteractionMode = 'personal',
  markdown = '',
  title?: string,
): CharacterConversation {
  return {
    id: createDefaultId(),
    title: title?.trim() || '新对话',
    kind,
    characterVersion: character.document.head,
    document: newDocument(markdown),
    edits: {},
    nodes: {},
    activeLeafNodeId: null,
  };
}

/**
 * Resolves a DraftWork's discussion TurnNode tree from V0.2 `discussionNodes` or legacy `discussion`.
 */
export function getWorkDiscussionTree(work: DraftWork): TurnTreeState {
  if (work.discussionNodes && Object.keys(work.discussionNodes).length > 0) {
    return {
      nodes: work.discussionNodes,
      activeLeafNodeId: work.activeDiscussionLeafId ?? null,
    };
  }
  const nodes: Record<string, TurnNode> = {};
  let prevId: string | null = null;
  for (const item of work.discussion) {
    const parentId =
      item.parentId && Object.hasOwn(nodes, item.parentId)
        ? item.parentId
        : item.parentId === null && prevId === null
          ? null
          : prevId;
    nodes[item.id] = {
      ...item,
      parentId,
      summarySnapshot: item.summarySnapshot ?? EMPTY_SUMMARY_SNAPSHOT,
    };
    prevId = item.id;
  }
  return {
    nodes,
    activeLeafNodeId: work.discussion.length > 0 ? work.discussion[work.discussion.length - 1].id : null,
  };
}

export function getWorkActiveDiscussionNodes(
  work: DraftWork,
  leafId?: string | null,
): TurnNode[] {
  const tree = getWorkDiscussionTree(work);
  return getActiveBranchNodes(tree, leafId === undefined ? tree.activeLeafNodeId : leafId);
}

export function appendWorkDiscussionTurn(
  work: DraftWork,
  nodeInput: {
    role: TurnNode['role'];
    content: string;
    reasoningContent?: string;
    parentId?: string | null;
    id?: string;
    createdAt?: number;
    summarySnapshot?: PlotSummarySnapshot;
    documentReads?: DocumentRead[];
    proposals?: TurnProposalRecord[];
  },
): { work: DraftWork; node: TurnNode } {
  const tree = getWorkDiscussionTree(work);
  const parentId = nodeInput.parentId === undefined ? tree.activeLeafNodeId : nodeInput.parentId;
  const parentSnapshot =
    nodeInput.summarySnapshot ??
    (parentId ? tree.nodes[parentId]?.summarySnapshot : undefined) ??
    EMPTY_SUMMARY_SNAPSHOT;
  const node: TurnNode = {
    id: nodeInput.id ?? createDefaultId(),
    parentId,
    role: nodeInput.role,
    content: nodeInput.content,
    ...(nodeInput.reasoningContent ? { reasoningContent: nodeInput.reasoningContent } : {}),
    createdAt: nodeInput.createdAt ?? Date.now(),
    summarySnapshot: parentSnapshot,
    ...(nodeInput.documentReads ? { documentReads: nodeInput.documentReads } : {}),
    ...(nodeInput.proposals ? { proposals: nodeInput.proposals } : {}),
  };
  const nextNodes = { ...tree.nodes, [node.id]: node };
  const nextActiveBranch = getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: node.id }, node.id);
  return {
    node,
    work: {
      ...work,
      discussionNodes: nextNodes,
      activeDiscussionLeafId: node.id,
      discussion: nextActiveBranch,
    },
  };
}

export function workBodyWindow(work: DraftWork, maxChars = 4000, cursorPos?: number): string {
  const body = work.body;
  if (!body) return '';
  if (body.length <= maxChars) return body;
  if (cursorPos === undefined) {
    return body.slice(body.length - maxChars);
  }
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(body.length - maxChars, cursorPos - half));
  return body.slice(start, start + maxChars);
}

export function conversationLocalVersion(conversation: CharacterConversation): string {
  return conversation.edits[conversation.activeLeafNodeId ?? ''] ??
    (conversation.activeLeafNodeId ? conversation.nodes[conversation.activeLeafNodeId]?.documents?.local : undefined) ??
    conversation.document.head;
}

export function turnMessages(nodes: TurnNode[]): LlmMessage[] {
  return nodes.map(({ role, content }) => ({ role, content }));
}

export function creativeContext(
  prompt: string,
  entries: readonly [string, MarkdownVersion][],
  path: TurnNode[],
  input: string,
): LlmMessage[] {
  return [
    { role: 'system', content: `${prompt}\n${CHANGE_PROMPT}` },
    ...documentMessages(entries),
    ...turnMessages(path),
    { role: 'user', content: input },
  ];
}

export function characterContext(
  global: MarkdownDocument,
  character: LocalCharacter,
  conversation: CharacterConversation,
  input: string,
  budgetOverrides?: Partial<ContextBudgetConfig>,
) {
  const publicVersion = documentVersion(global);
  const persona = documentVersion(character.document, conversation.characterVersion);
  const local = documentVersion(conversation.document, conversationLocalVersion(conversation));
  const prompt =
    '你是该角色本人。保持人设一致，随用户的说话方式和情境自然切换日常聊天或代入对戏；让用户自主决定自身身份与关键行动。自然承接较早经历与当时参与者，用户换新身份时按初见交流。';
  const assembled = assembleCreativeThreeZoneContext({
    systemPrompt: `${prompt}\n${CHANGE_PROMPT}`,
    documents: [
      ['我的记忆', publicVersion],
      ['角色设定', persona],
    ],
    localDocument: local,
    nodes: conversation.nodes,
    targetParentId: conversation.activeLeafNodeId,
    userInput: input || '按当前人设和情境自然开场，由你先说第一句。',
    budgetOverrides,
  });
  return {
    messages: assembled.messages,
    metrics: assembled.metrics,
    reads: [
      referenceDocument('public', '我的记忆', publicVersion),
      referenceDocument('container', character.name, persona),
      referenceDocument('local', '分支笔记', local),
    ],
    localVersion: local.id,
  };
}

export interface WorkContextOptions {
  systemPrompt?: string;
  cursorPos?: number;
  bodyWindowMaxChars?: number;
  budgetOverrides?: Partial<ContextBudgetConfig>;
  targetParentId?: string | null;
}

/**
 * Automatically assembles 写故事 context from 我的记忆, 作品设定, current body window,
 * and active discussion branch (with rolling summary protection).
 */
export function workContext(
  global: MarkdownDocument,
  work: DraftWork,
  input: string,
  options: WorkContextOptions = {},
) {
  const publicVersion = documentVersion(global);
  const workVersion = documentVersion(work.document);
  const tree = getWorkDiscussionTree(work);
  const targetParentId = options.targetParentId === undefined ? tree.activeLeafNodeId : options.targetParentId;
  const prompt = options.systemPrompt ??
    '和作者自由讨论开书想法、原作设定、正文段落与续写方向。自动结合作品设定与正文现状；用户明确要求持久修改设定或记忆时再附提案。';
  const assembled = assembleCreativeThreeZoneContext({
    systemPrompt: `${prompt}\n${CHANGE_PROMPT}`,
    documents: [
      ['我的记忆', publicVersion],
      ['作品设定', workVersion],
    ],
    manuscriptWindow: workBodyWindow(work, options.bodyWindowMaxChars, options.cursorPos),
    nodes: tree.nodes,
    targetParentId,
    userInput: input,
    budgetOverrides: options.budgetOverrides,
  });
  return {
    messages: assembled.messages,
    metrics: assembled.metrics,
    reads: [
      referenceDocument('public', '我的记忆', publicVersion),
      referenceDocument('container', work.title, workVersion),
    ],
    activeLeafNodeId: targetParentId,
  };
}

export interface CreativeSummaryOptions {
  targetLeafId?: string | null;
  budget?: Partial<ContextBudgetConfig>;
  signal?: AbortSignalLike;
}

export async function summarizeWorkDiscussion(
  work: DraftWork,
  transport: LlmTransport,
  config: ModelConfig,
  options: CreativeSummaryOptions = {},
) {
  const tree = getWorkDiscussionTree(work);
  const targetLeafId = options.targetLeafId === undefined ? tree.activeLeafNodeId : options.targetLeafId;
  const result = await summarizeCreativeTurnNodes({
    nodes: tree.nodes,
    targetLeafId,
    transport,
    config,
    budget: options.budget,
    signal: options.signal,
  });
  const activeLeaf = work.activeDiscussionLeafId ?? tree.activeLeafNodeId;
  const activeDiscussion = getActiveBranchNodes({ nodes: result.nodes, activeLeafNodeId: activeLeaf }, activeLeaf);
  return {
    ...result,
    work: {
      ...work,
      discussionNodes: result.nodes,
      activeDiscussionLeafId: activeLeaf,
      discussion: activeDiscussion,
    },
  };
}

export async function summarizeCharacterConversation(
  conversation: CharacterConversation,
  transport: LlmTransport,
  config: ModelConfig,
  options: CreativeSummaryOptions = {},
) {
  const targetLeafId =
    options.targetLeafId === undefined ? conversation.activeLeafNodeId : options.targetLeafId;
  const result = await summarizeCreativeTurnNodes({
    nodes: conversation.nodes,
    targetLeafId,
    transport,
    config,
    budget: options.budget,
    signal: options.signal,
  });
  return {
    ...result,
    conversation: result.updated
      ? {
          ...conversation,
          nodes: result.nodes,
        }
      : conversation,
  };
}

/**
 * Silently compresses uncovered turns on a 文游 Story branch without throwing on failure or abort.
 */
export async function summarizeStoryBranchSilent(
  story: Story,
  targetLeafId: string | null,
  transport: LlmTransport,
  config: ModelConfig,
  options: Omit<CreativeSummaryOptions, 'targetLeafId'> = {},
): Promise<Story> {
  if (!targetLeafId || !story.nodes[targetLeafId]) return story;
  const baseSnapshot = getActiveSummarySnapshot(story, targetLeafId);
  const result = await summarizeCreativeTurnNodes({
    nodes: story.nodes,
    targetLeafId,
    transport,
    config,
    budget: options.budget,
    signal: options.signal,
    baseSnapshot,
  });
  if (!result.updated) return story;

  let nextStory: Story = {
    ...story,
    nodes: result.nodes,
  };
  if (story.documents && !story.documents.edits[targetLeafId]) {
    const scoped = nextStory as Story & { documents: StoryDocuments };
    const state = storyDocumentState(scoped, targetLeafId, targetLeafId === story.activeLeafNodeId);
    const currentLocal = documentVersion(scoped.documents.local, state.local);
    const revisedLocal = writeDocument(
      scoped.documents.local,
      state.local,
      replaceDocumentProgress(currentLocal.markdown, result.snapshot.content),
      'automatic',
    );
    nextStory = {
      ...scoped,
      documents: {
        ...scoped.documents,
        local: { ...revisedLocal, head: scoped.documents.local.head },
      },
      nodes: {
        ...scoped.nodes,
        [targetLeafId]: {
          ...scoped.nodes[targetLeafId],
          documents: { ...state, local: revisedLocal.head },
        },
      },
    };
  }
  return nextStory;
}

export function writingInput(work: DraftWork, start: number, end: number, instruction: string): string {
  const selected = work.body.slice(start, end);
  const before = work.body.slice(Math.max(0, start - 6000), start);
  const after = work.body.slice(end, end + 6000);
  return [
    instruction,
    before && `【光标或选区前】\n${before}`,
    selected && `【作者所选正文】\n${selected}`,
    after && `【光标或选区后】\n${after}`,
  ].filter(Boolean).join('\n\n');
}

export function adoptSuggestion(work: DraftWork, suggestion: WritingSuggestion, text = suggestion.text): DraftWork {
  if (work.bodyRevision !== suggestion.revision) throw new Error('正文已改动，请重新选择插入或替换位置。');
  return {
    ...work,
    body: work.body.slice(0, suggestion.start) + text + work.body.slice(suggestion.end),
    bodyRevision: work.bodyRevision + 1,
  };
}

export async function streamCreativeReply(
  transport: LlmTransport,
  config: ModelConfig,
  messages: LlmMessage[],
  callbacks: TurnCallbacks = {},
) {
  let raw = '';
  let reasoningContent = '';
  let finishReason: string | null | undefined;
  let visible = '';
  for await (const delta of transport.streamChat({ ...config, messages, signal: callbacks.signal })) {
    if (delta.finishReason != null) finishReason = delta.finishReason;
    if (delta.reasoningDelta) {
      reasoningContent += delta.reasoningDelta;
      callbacks.onReasoningDelta?.(delta.reasoningDelta);
    }
    if (!delta.contentDelta) continue;
    raw += delta.contentDelta;
    const next = visibleReplyPrefix(raw);
    if (next.length > visible.length) callbacks.onContentDelta?.(next.slice(visible.length));
    visible = next;
  }
  if (callbacks.signal?.aborted) throw new Error('生成已取消。');
  if (finishReason !== 'stop') {
    transport.recordMarkdownProposal?.('incomplete');
    throw new Error('回复未完成，请重试。');
  }
  const parsed = parseProposalReply(raw, { finishReason });
  const legacyProposalStatus: MarkdownProposalStatus = parsed.proposals.length > 0
    ? 'recognized'
    : parsed.proposalStatus === 'needs_review'
      ? 'invalid'
      : 'none';
  transport.recordMarkdownProposal?.(legacyProposalStatus);
  if (!parsed.content.trim() && parsed.proposals.length === 0 && parsed.unparsedBlocks.length === 0) {
    throw new Error('模型没有返回可用内容。');
  }
  return {
    content: parsed.content,
    proposalStatus: legacyProposalStatus,
    proposalParseStatus: parsed.proposalStatus,
    proposal: parsed.proposal,
    proposals: parsed.proposals,
    unparsedBlocks: parsed.unparsedBlocks,
    reasoningContent,
  };
}

const SYNTHETIC_CONVERSATION_TITLE_RE = /^(?:本人聊天|扮演对戏|新对话)(?:\s+\d+)?$/;

/**
 * Returns a human-readable title or opening snippet for a character conversation,
 * replacing legacy synthetic `本人聊天 N` / `扮演对戏 N` labels when possible.
 */
export function formatCharacterConversationTitle(
  character: LocalCharacter,
  conversation: CharacterConversation,
): string {
  const explicit = conversation.title?.trim() ?? '';
  if (explicit && !SYNTHETIC_CONVERSATION_TITLE_RE.test(explicit)) {
    return explicit;
  }
  const path = getActiveBranchNodes(conversation);
  const firstMeaningful = path.find((node) => node.content.trim())
    ?? Object.values(conversation.nodes)
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((node) => node.content.trim());
  if (firstMeaningful) {
    const compact = firstMeaningful.content.replace(/\s+/g, ' ').trim();
    return compact.length > 22 ? `${compact.slice(0, 22)}…` : compact;
  }
  return `与${character.name || '角色'}的新对话`;
}

export function conversationExport(character: LocalCharacter, conversation: CharacterConversation): string {
  const path = getActiveBranchNodes(conversation);
  const title = formatCharacterConversationTitle(character, conversation);
  const localNote = documentVersion(conversation.document, conversationLocalVersion(conversation)).markdown.trim();
  return [
    `# ${character.name} · ${title}`,
    ...path.map((node) => `### ${node.role === 'user' ? '你' : character.name}\n\n${node.content}`),
    localNote ? `## 分支笔记\n\n${localNote}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Exports a 文游 story's current setting, active branch narrative, and branch note as UTF-8 Markdown.
 */
export function storyExportMarkdown(story: Story): string {
  const path = getActiveBranchNodes(story);
  let settingMarkdown = '';
  let branchNoteMarkdown = '';
  if (story.documents) {
    const scoped = { ...story, documents: story.documents };
    const state = storyDocumentState(scoped, story.activeLeafNodeId, true);
    settingMarkdown = documentVersion(scoped.documents.container, state.container).markdown.trim();
    branchNoteMarkdown = documentVersion(scoped.documents.local, state.local).markdown.trim();
  } else {
    settingMarkdown = legacyStoryMarkdown(story).trim();
  }
  return [
    `# ${story.title}`,
    settingMarkdown ? `## 故事设定\n\n${settingMarkdown}` : '',
    ...path.map((node) => `### ${node.role === 'user' ? '玩家' : '叙事 AI'}\n\n${node.content}`),
    branchNoteMarkdown ? `## 分支笔记\n\n${branchNoteMarkdown}` : '',
  ].filter(Boolean).join('\n\n');
}
