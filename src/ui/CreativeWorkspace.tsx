import { useEffect, useRef, useState } from 'react';
import {
  characterContext, conversationExport, conversationLocalVersion,
  documentLineage, documentVersion, getActiveBranchNodes,
  newConversation, streamCreativeReply, writeDocument,
  type CharacterConversation, type CreativeWorkspaceState, type InteractionMode,
  type LocalCharacter, type ModelConfig, type PlatformRuntime,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DocumentReadDetails, type DocumentReadEntry } from './DocumentReadDetails.tsx';
import { DraftPane } from './DraftPane.tsx';
import { MessageContent } from './MessageContent.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import type { ReactNode } from 'react';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import {
  makeTurn,
  replyContent,
  sendOnEnter,
  updateCharacter,
  updateConversation,
  useCreativeReply,
  type RequestModel,
} from './useCreativeReply.ts';

interface Props {
  mode: 'writing' | 'character';
  workspace: CreativeWorkspaceState;
  ready: boolean;
  storageError: string;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  manuscript?: boolean;
  onStartManuscript?: () => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
}

function CreativeCompanion({ entries, children, open, setOpen }: { entries: DocumentReadEntry[]; children: ReactNode; open: boolean; setOpen: (open: boolean) => void }) {
  useWebHistoryLayer('creative-companion', 40, open, () => setOpen(false));
  return <>
    <SheetDialog open={open} title="创作资料" label="创作资料" panelName="创作资料" testId="creative-companion" onClose={() => setOpen(false)}>
      <div className="btn-group">{children}</div>
      <DocumentReadDetails entries={entries} testId="creative-document-reads" summary="资料版本详情" />
    </SheetDialog>
  </>;
}

const conversationLabel = (kind: InteractionMode) => kind === 'personal' ? '本人聊天' : '扮演对戏';

function CharacterPane(props: Props & { character: LocalCharacter }) {
  const { character, save, read, runtime, openDocument, openPublic } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const [input, setInput] = useState('');
  const [confirm, setConfirm] = useState<'export' | 'delete' | null>(null);
  const conversation = character.conversations.find((item) => item.id === character.activeConversationId);
  const path = conversation ? getActiveBranchNodes(conversation) : [];
  const documentReadEntries: DocumentReadEntry[] = path.flatMap((node, index) => node.documentReads?.length ? [{
      id: node.id,
      label: `第 ${Math.max(1, Math.ceil((index + 1) / 2))} 轮 · ${node.role === 'assistant' ? character.name : '玩家消息'}`,
      createdAt: node.createdAt,
      reads: node.documentReads,
    }] : []);

  function editCharacter(proposal?: string, expected?: string) {
    openDocument({
      title: '角色人设 · 新对话采用新版',
      description: proposal !== undefined
        ? '作用范围：角色人设。来源：本轮 AI 回复。'
        : '作用范围：当前角色及之后的新对话。',
      base: documentVersion(character.document, expected ?? character.document.head),
      history: documentLineage(character.document), proposal,
      reload: async () => {
        const found = (await read()).characters.find((item) => item.id === character.id);
        if (!found) throw new Error('角色已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) => updateCharacter(state, character.id, (current) => {
          if (current.document.head !== version) throw new Error('角色文档已变化，请重新核对。');
          return { ...current, document: writeDocument(current.document, version, markdown) };
        }));
      },
    });
  }

  function editConversation(target: CharacterConversation, proposal?: string) {
    const base = conversationLocalVersion(target);
    openDocument({
      title: '当前对话资料', base: documentVersion(target.document, base),
      description: proposal !== undefined
        ? '作用范围：当前对话。来源：本轮 AI 回复。'
        : '作用范围：当前角色对话。',
      history: documentLineage(target.document, base), proposal,
      apply: async (expected, markdown) => {
        await save((state) => updateCharacter(state, character.id, (current) => updateConversation(current, target.id, (live) => {
          if (live.activeLeafNodeId !== target.activeLeafNodeId || conversationLocalVersion(live) !== expected) {
            throw new Error('当前对话底稿已变化，请返回后重新核对。');
          }
          const revised = writeDocument(live.document, expected, markdown);
          return {
            ...live, document: { ...revised, head: live.document.head },
            edits: { ...live.edits, [live.activeLeafNodeId ?? '']: revised.head },
          };
        })));
      },
    });
  }

  function send(conversationId: string, contents: string) {
    reply.start(contents ? '继续角色互动' : '生成角色开场', async (request, signal) => {
      const state = await read();
      const current = state.characters.find((item) => item.id === character.id);
      const target = current?.conversations.find((item) => item.id === conversationId);
      if (!current || !target || signal.aborted) return;
      const ctx = characterContext(state.publicDocument, current, target, contents);
      const result = await request(ctx.messages);
      if (signal.aborted) return;
      const updated = await save((workspace) => updateCharacter(workspace, current.id, (latest) =>
        updateConversation(latest, target.id, (live) => {
          if (live.activeLeafNodeId !== target.activeLeafNodeId ||
            conversationLocalVersion(live) !== ctx.localVersion) {
            throw new Error('对话位置或资料已变化，请从当前记录重新发送。');
          }
          const docs = { container: target.characterVersion, local: ctx.localVersion };
          const user = contents ? { ...makeTurn('user', contents, live.activeLeafNodeId), documents: docs } : null;
          const assistant = {
            ...makeTurn('assistant', replyContent(result.content, result.proposal), user?.id ?? live.activeLeafNodeId),
            documents: docs, documentReads: ctx.reads,
          };
          const edits = { ...live.edits };
          delete edits[live.activeLeafNodeId ?? ''];
          return { ...live, edits, nodes: { ...live.nodes, ...(user ? { [user.id]: user } : {}), [assistant.id]: assistant },
            activeLeafNodeId: assistant.id };
        })));
      if (signal.aborted) return;
      setInput('');
      const saved = updated.characters.find((item) => item.id === current.id)?.conversations.find((item) => item.id === target.id);
      if (result.proposal?.target === 'public') openPublic(result.proposal.markdown, ctx.reads[0].versionId);
      if (result.proposal?.target === 'container') editCharacter(result.proposal.markdown, target.characterVersion);
      if (result.proposal?.target === 'local' && saved) editConversation(saved, result.proposal.markdown);
    });
  }

  const queuedOpening = useRef(false);
  useEffect(() => {
    if (queuedOpening.current || props.initialTurn?.id !== character.id || !conversation) return;
    const prompt = props.initialTurn.prompt;
    const timer = window.setTimeout(() => {
      queuedOpening.current = true;
      props.onConsumeInitialTurn();
      send(conversation.id, prompt);
    }, 0);
    return () => window.clearTimeout(timer);
  });

  async function startConversation(kind: InteractionMode, markdown = '', openWithModel = true) {
    let id = '';
    await save((state) => updateCharacter(state, character.id, (live) => {
      const next = newConversation(live, kind, markdown);
      id = next.id;
      return { ...live, conversations: [...live.conversations, next], activeConversationId: id };
    }));
    if (openWithModel) send(id, '');
    return id;
  }

  function openMode(kind: InteractionMode) {
    const previous = [...character.conversations].reverse().find((item) => item.kind === kind);
    if (previous) navigate(previous.id);
    else void startConversation(kind).catch(reply.fail);
  }

  const navigate = (conversationId: string, nodeId?: string) => {
    void save((state) => updateCharacter(state, character.id, (live) => {
      const active = { ...live, activeConversationId: conversationId };
      return nodeId === undefined ? active : updateConversation(active, conversationId, (target) => ({ ...target, activeLeafNodeId: nodeId }));
    })).catch(reply.fail);
  };
  const exportText = conversation && confirm === 'export' ? conversationExport(character, conversation) : '';

  return (
    <>
      <section className="creative-section" data-testid="character-workspace">
        <div className="creative-toolbar">
          <h2>{character.name}</h2>
          <CreativeCompanion entries={documentReadEntries} open={props.companionOpen} setOpen={props.setCompanionOpen}>
            <button type="button" className="btn" onClick={() => editCharacter()}>角色人设</button>
            {conversation && <button type="button" className="btn" disabled={reply.busy} onClick={() => editConversation(conversation)}>当前对话资料</button>}
            <button type="button" className="btn" onClick={() => openPublic()}>公共记忆</button>
          </CreativeCompanion>
          <button type="button" className="btn" onClick={() => editCharacter()}>角色人设</button>
        </div>
        <div className="btn-group">
          <button type="button" className="btn" disabled={reply.busy} onClick={() => openMode('personal')}>本人聊天</button>
          <button type="button" className="btn" disabled={reply.busy} onClick={() => openMode('roleplay')}>扮演对戏</button>
        </div>
        {conversation && <p className="status-text">继续上次 · {conversationLabel(conversation.kind)}</p>}
        {character.conversations.length > 0 && <details className="reasoning-details">
          <summary>历史对话</summary>
          {character.conversations.map((item, index) => <button key={item.id} type="button" className="btn" disabled={reply.busy}
            aria-pressed={conversation?.id === item.id} onClick={() => navigate(item.id)}>{conversationLabel(item.kind)} {index + 1}</button>)}
        </details>}
      </section>
      {reply.error && <BannerAlert tone="danger">{reply.error}</BannerAlert>}
      {conversation && <section className="creative-section">
        <div className="creative-toolbar">
          <h2>{conversationLabel(conversation.kind)}</h2>
          <button type="button" className="btn" disabled={reply.busy} onClick={() => editConversation(conversation)}>当前对话资料</button>
        </div>
        {path.map((node) => <article className="creative-turn" key={node.id}>
          <span className="status-text">{node.role === 'assistant' ? character.name : '你'}</span>
          <MessageContent content={node.content} />
          <details className="reasoning-details">
            <summary>对话操作</summary>
            <button className="btn" type="button" disabled={reply.busy} onClick={() => navigate(conversation.id, node.id)}>从这里继续</button>
          </details>
        </article>)}
        {Object.values(conversation.nodes).some((node) => !path.some((active) => active.id === node.id)) && (
          <details className="reasoning-details"><summary>对话分支</summary>
            {Object.values(conversation.nodes).filter((node) =>
              !Object.values(conversation.nodes).some((child) => child.parentId === node.id)).map((leaf) => (
              <button type="button" className="btn" key={leaf.id} disabled={reply.busy}
                onClick={() => navigate(conversation.id, leaf.id)}>{leaf.content.slice(0, 42) || '未命名分支'}</button>
            ))}
          </details>
        )}
        {reply.output && <p className="creative-text" aria-live="polite">{reply.output}</p>}
        {!path.length && !reply.busy && <button type="button" className="btn" onClick={() => send(conversation.id, '')}>生成开场</button>}
        <details className="reasoning-details">
          <summary>对话管理</summary>
          <p className="status-text">空白开聊不带入这里的历史。已保存的人设和公共资料可在各自的文档中修改。</p>
          <div className="btn-group">
            <button type="button" className="btn" disabled={reply.busy} onClick={() => void startConversation(conversation.kind, '', false).catch(reply.fail)}>空白开聊</button>
            <button type="button" className="btn" disabled={reply.busy} onClick={() => openDocument({
              title: '核对要带入新对话的资料',
              description: '作用范围：新对话的初始资料。',
              base: { id: 'new-conversation', previous: null, markdown: '', savedAt: Date.now(), source: 'user' },
              apply: async (_version, markdown) => {
                if (!markdown.trim()) throw new Error('请填入要带入的资料。');
                await startConversation(conversation.kind, markdown, false);
              },
            })}>带资料开新对话</button>
            <button type="button" className="btn" onClick={() => setConfirm('export')}>预览导出</button>
            <button type="button" className="btn" disabled={reply.busy} onClick={() => setConfirm('delete')}>删除对话</button>
          </div>
        </details>
      </section>}
      <form className="composer" data-testid="stage-composer" onSubmit={(event) => {
        event.preventDefault();
        const contents = input.trim();
        if (!contents || reply.busy) return;
        if (conversation) send(conversation.id, contents);
        else void startConversation('personal', '', false).then((id) => send(id, contents)).catch(reply.fail);
      }}>
        <textarea aria-label="发消息" rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={sendOnEnter} />
        <div className="btn-group">
          <button type="submit" className="btn btn-primary" disabled={reply.busy || !input.trim()}>发送</button>
          {reply.busy && <button type="button" className="btn" onClick={reply.stop}>停止</button>}
        </div>
      </form>
      <ModalDialog open={Boolean(confirm)} label={confirm === 'delete' ? '删除这段对话及其分叉' : '对话导出预览'} onClose={() => setConfirm(null)}>
        {conversation && confirm && <div className="local-document-dialog">
          <h2>{confirm === 'delete' ? '删除这段对话及其分叉' : '对话导出预览'}</h2>
          {confirm === 'delete' ? <p>删除本机这段对话的全部分叉、局部资料、版本和审计。已导出文件仍由你保管。</p>
            : <pre>{exportText}</pre>}
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => setConfirm(null)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => {
              if (confirm === 'delete') {
                void save((state) => updateCharacter(state, character.id, (live) => ({
                  ...live, activeConversationId: null, conversations: live.conversations.filter((item) => item.id !== conversation.id),
                }))).then(() => setConfirm(null)).catch(reply.fail);
              } else if (runtime.backupExporter.exportMarkdown) {
                void runtime.backupExporter.exportMarkdown('角色对话.md', exportText).then(() => setConfirm(null)).catch(reply.fail);
              }
            }}>{confirm === 'delete' ? '确认删除' : '导出 Markdown'}</button>
          </div>
        </div>}
      </ModalDialog>
    </>
  );
}

export function CreativeWorkspace(props: Props) {
  const { mode, workspace, ready, storageError } = props;
  const selectedWork = workspace.works.find((work) => work.id === workspace.activeWorkId);
  const selectedCharacter = workspace.characters.find((character) => character.id === workspace.activeCharacterId);
  const isWriting = mode === 'writing';

  return (
    <section className="creative-stage" data-testid={isWriting ? 'writing-page' : 'character-page'}>
      {storageError && <BannerAlert tone="danger">{storageError}</BannerAlert>}
      {ready && isWriting && selectedWork && <DraftPane key={selectedWork.id} {...props} work={selectedWork} />}
      {ready && !isWriting && selectedCharacter && <CharacterPane key={selectedCharacter.id} {...props} character={selectedCharacter} />}
    </section>
  );
}
