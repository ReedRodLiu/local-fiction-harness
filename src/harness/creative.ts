import { createDefaultId } from './id.ts';
import { getActiveBranchNodes } from './context.ts';
import {
  CHANGE_PROMPT,
  documentMessages,
  documentVersion,
  newDocument,
  referenceDocument,
  splitMarkdownReply,
  visibleReplyPrefix,
  type MarkdownDocument,
  type MarkdownVersion,
} from './markdownDocuments.ts';
import type { LlmMessage, LlmTransport, ModelConfig, TurnCallbacks, TurnNode } from './types.ts';

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
  suggestions: WritingSuggestion[];
  source?: { storyId: string; nodeId: string | null };
}

export interface CharacterConversation {
  id: string;
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
    body: '', bodyRevision: 0, discussion: [], suggestions: [], ...(source ? { source } : {}),
  };
}

export function newCharacter(name: string, markdown: string): LocalCharacter {
  return {
    id: createDefaultId(), name: name.trim(), document: newDocument(markdown),
    conversations: [], activeConversationId: null,
  };
}

export function newConversation(character: LocalCharacter, kind: InteractionMode, markdown = ''): CharacterConversation {
  return {
    id: createDefaultId(), kind, characterVersion: character.document.head, document: newDocument(markdown),
    edits: {}, nodes: {}, activeLeafNodeId: null,
  };
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
) {
  const publicVersion = documentVersion(global);
  const persona = documentVersion(character.document, conversation.characterVersion);
  const local = documentVersion(conversation.document, conversationLocalVersion(conversation));
  const prompt = conversation.kind === 'personal'
    ? '和用户以本人身份聊天。自然延续关系；不清楚对方身份时可自然询问。'
    : '和用户共同扮演对戏。维持人设，用户自己决定关键行动。自然承接旧事件及当时的参与者，新身份按初见交流。';
  const path = getActiveBranchNodes(conversation);
  return {
    messages: creativeContext(prompt, [['公共记忆', publicVersion], ['角色人设', persona], ['当前对话', local]], path,
      input || '按当前人设和身份自然开场，由你先说第一句。'),
    reads: [referenceDocument('public', '公共记忆', publicVersion),
      referenceDocument('container', character.name, persona), referenceDocument('local', '当前对话', local)],
    localVersion: local.id,
  };
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
  let finishReason: string | null | undefined;
  let visible = '';
  for await (const delta of transport.streamChat({ ...config, messages, signal: callbacks.signal })) {
    if (delta.finishReason != null) finishReason = delta.finishReason;
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
  const reply = splitMarkdownReply(raw);
  transport.recordMarkdownProposal?.(reply.proposalStatus);
  if (!reply.content.trim() && !reply.proposal) throw new Error('模型没有返回可用内容。');
  return reply;
}

export function conversationExport(character: LocalCharacter, conversation: CharacterConversation): string {
  const path = getActiveBranchNodes(conversation);
  return [
    `# ${character.name} · ${conversation.kind === 'personal' ? '本人聊天' : '扮演对戏'}`,
    ...path.map((node) => `### ${node.role === 'user' ? '你' : character.name}\n\n${node.content}`),
    documentVersion(conversation.document, conversationLocalVersion(conversation)).markdown,
  ].filter(Boolean).join('\n\n');
}
