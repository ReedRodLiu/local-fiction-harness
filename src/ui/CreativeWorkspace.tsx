import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  adoptSuggestion, characterContext, conversationExport, conversationLocalVersion, createDefaultId,
  creativeContext, documentLineage, documentVersion, EMPTY_SUMMARY_SNAPSHOT, getActiveBranchNodes,
  newCharacter, newConversation, newWork, referenceDocument, streamCreativeReply, writeDocument, writingInput,
  type CharacterConversation, type CreativeWorkspaceState, type DraftWork, type InteractionMode,
  type LlmMessage, type LocalCharacter, type MarkdownProposal, type ModelConfig, type PlatformRuntime,
  type TurnNode, type WritingSuggestion,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DocumentReadDetails } from './DocumentReadDetails.tsx';
import { MessageContent } from './MessageContent.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { toErrorMessage } from './textHelpers.ts';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

type RequestModel = (label: string, run: (config: ModelConfig) => void) => void;

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
  onBack: () => void;
}

function updateWork(state: CreativeWorkspaceState, id: string, update: (work: DraftWork) => DraftWork) {
  if (!state.works.some((work) => work.id === id)) throw new Error('作品已不存在。');
  return { ...state, works: state.works.map((work) => work.id === id ? update(work) : work) };
}

function updateCharacter(state: CreativeWorkspaceState, id: string, update: (character: LocalCharacter) => LocalCharacter) {
  if (!state.characters.some((character) => character.id === id)) throw new Error('角色已不存在。');
  return { ...state, characters: state.characters.map((character) => character.id === id ? update(character) : character) };
}

function updateConversation(character: LocalCharacter, id: string, update: (conversation: CharacterConversation) => CharacterConversation) {
  if (!character.conversations.some((conversation) => conversation.id === id)) throw new Error('对话已不存在。');
  return { ...character, conversations: character.conversations.map((conversation) => conversation.id === id ? update(conversation) : conversation) };
}

function makeTurn(role: TurnNode['role'], content: string, parentId: string | null): TurnNode {
  return { id: createDefaultId(), parentId, role, content, summarySnapshot: EMPTY_SUMMARY_SNAPSHOT, createdAt: Date.now() };
}

function useCreativeReply(runtime: PlatformRuntime, requestModel: RequestModel) {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  function start(label: string, run: (
    request: (messages: LlmMessage[]) => ReturnType<typeof streamCreativeReply>,
    signal: AbortSignal,
  ) => Promise<void>) {
    requestModel(label, (config) => {
      if (!mounted.current || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError('');
      setOutput('');
      void run((messages) => streamCreativeReply(runtime.transport, config, messages, {
        signal: controller.signal,
        onContentDelta: (delta) => { if (!controller.signal.aborted) setOutput((text) => text + delta); },
      }), controller.signal).catch((err) => {
        if (!controller.signal.aborted) setError(toErrorMessage(err, '生成失败，请重试。'));
      }).finally(() => {
        if (active.current !== controller) return;
        active.current = null;
        if (!mounted.current) return;
        setOutput('');
        setBusy(false);
      });
    });
  }
  const fail = (error: unknown) => setError(toErrorMessage(error, '本地操作失败。'));
  return { start, busy, output, error, fail, stop: () => active.current?.abort() };
}

function replyContent(content: string, proposal?: MarkdownProposal) {
  return content.trim() || (proposal ? '请核对拟保存的文档。' : '');
}

function DraftPane(props: Props & { work: DraftWork }) {
  const { work, save, read, runtime, openDocument, openPublic } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const [text, setText] = useState(work.body);
  const editing = Boolean(work.writingStarted || work.body || work.source);
  const [instruction, setInstruction] = useState('');
  const [useDiscussion, setUseDiscussion] = useState(false);
  const [excerpt, setExcerpt] = useState('');
  const [exported, setExported] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState<{ suggestion: WritingSuggestion; target: WritingSuggestion } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const unsaved = useRef(work.body);
  const saved = useRef(work.body);
  saved.current = work.body;

  function editDocument(proposal?: string, document = work.document) {
    const base = documentVersion(document);
    openDocument({
      title: '作品资料', base, proposal,
      history: documentLineage(document),
      reload: async () => {
        const found = (await read()).works.find((item) => item.id === work.id);
        if (!found) throw new Error('作品已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) => updateWork(state, work.id, (live) => {
          if (live.document.head !== version) throw new Error('作品资料已变化，请重新核对。');
          return { ...live, document: writeDocument(live.document, version, markdown) };
        }));
      },
    });
  }

  function saveText(value: string, retry = false) {
    const before = retry ? saved.current : unsaved.current;
    unsaved.current = value;
    setText(value);
    setExported(false);
    void save((state) => updateWork(state, work.id, (live) => {
      if (live.body !== before) throw new Error('正文底稿已变化。请核对后重试保存。');
      if (live.body === value) return live;
      return { ...live, body: value, bodyRevision: live.bodyRevision + 1 };
    })).catch(reply.fail);
  }

  async function currentWork() {
    const state = await read();
    const live = state.works.find((item) => item.id === work.id);
    if (!live) throw new Error('作品已不存在。');
    if (live.body !== unsaved.current) throw new Error('正文尚未保存，请检查保存错误后重试。');
    return { state, live };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = instruction.trim();
    if (!input || reply.busy) return;
    const { start, end } = selection.current;
    const includeDiscussion = useDiscussion;
    const selectedExcerpt = excerpt.trim();
    reply.start(editing ? '请求写作建议' : '开书讨论', async (request, signal) => {
      const { state, live } = await currentWork();
      if (signal.aborted) return;
      const publicDoc = documentVersion(state.publicDocument);
      const workDoc = documentVersion(live.document);
      const linked = !editing || includeDiscussion ? live.discussion : [];
      const draftInput = editing ? writingInput(live, start, end, input) : input;
      const messages = creativeContext(editing
        ? '给作者一份可采纳的短文本建议。按当前指令和选区创作，结合正文和作品资料。只有明确提供的关联讨论才可引用。若无法从所给材料确认所指原段，请作者选段。'
        : '和作者自由讨论开书想法、原作设定和续写起点。提醒作者核对不确定细节。用户明确要求留下总结时将其提议写入作品资料。',
      [['公共记忆', publicDoc], ['作品资料', workDoc]], selectedExcerpt && editing ? [] : linked, selectedExcerpt && editing
        ? `${draftInput}\n\n【作者选定的开书原话】\n${selectedExcerpt}` : draftInput);
      const result = await request(messages);
      if (signal.aborted) return;
      const reads = [referenceDocument('public', '公共记忆', publicDoc), referenceDocument('container', live.title, workDoc)];
      await save((now) => updateWork(now, live.id, (latest) => {
        if (editing) return {
          ...latest,
          suggestions: [...latest.suggestions, { id: createDefaultId(), instruction: input,
            text: result.content, revision: live.bodyRevision, start, end, documentReads: reads }],
        };
        const user = makeTurn('user', input, latest.discussion.at(-1)?.id ?? null);
        return { ...latest, discussion: [...latest.discussion, user, {
          ...makeTurn('assistant', replyContent(result.content, result.proposal), user.id), documentReads: reads,
        }] };
      }));
      if (signal.aborted) return;
      setInstruction('');
      if (result.proposal?.target === 'public') openPublic(result.proposal.markdown, publicDoc.id);
      if (result.proposal?.target === 'container' || result.proposal?.target === 'local') editDocument(result.proposal.markdown, live.document);
    });
  }

  async function adopt(target: WritingSuggestion, chosen: string) {
    const { live } = await currentWork();
    const updated = await save((state) => updateWork(state, live.id, (latest) => adoptSuggestion(latest, target, chosen)));
    const accepted = updated.works.find((item) => item.id === live.id)!;
    unsaved.current = accepted.body;
    setText(accepted.body);
    setExported(false);
    setSelectedSuggestion(null);
    selection.current = { start: target.start + chosen.length, end: target.start + chosen.length };
    window.requestAnimationFrame(() => textarea.current?.setSelectionRange(selection.current.start, selection.current.end));
  }

  async function chooseSuggestion(suggestion: WritingSuggestion, chosen: string) {
    const { live } = await currentWork();
    if (live.bodyRevision !== suggestion.revision || suggestion.start !== suggestion.end) {
      const target = live.bodyRevision === suggestion.revision ? suggestion : {
        ...suggestion, revision: live.bodyRevision, start: selection.current.start, end: selection.current.end,
      };
      setSelectedSuggestion({ suggestion: { ...suggestion, text: chosen }, target });
      return;
    }
    await adopt(suggestion, chosen);
  }

  return (
    <>
      <section className="creative-section" data-testid="writing-workspace">
        <div className="creative-toolbar">
          <h2>{work.title}</h2>
          <button type="button" className="btn" onClick={() => editDocument()}>作品资料</button>
        </div>
        {work.source && <p className="status-text">已保存开稿时采用的文游资料。</p>}
        {editing ? <>
          <label className="field">正文
            <textarea ref={textarea} className="creative-manuscript" value={text} onChange={(event) => saveText(event.target.value)}
              onSelect={(event) => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} />
          </label>
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => {
              void currentWork().then(({ live }) => {
                if (!runtime.backupExporter.exportMarkdown) throw new Error('当前设备无法导出 Markdown。');
                return runtime.backupExporter.exportMarkdown(`${live.title.replace(/[\\/:*?"<>|]/g, '_')}.md`, live.body);
              }).then(() => setExported(true)).catch(reply.fail);
            }}>导出正文</button>
            {text !== saved.current && <button type="button" className="btn" onClick={() => saveText(text, true)}>重试保存</button>}
          </div>
          {exported && <p role="status">已提交正文导出。</p>}
        </> : <>
          <p className="status-text">可先谈谈人物与开篇，也可以直接动笔。</p>
          <button type="button" className="btn btn-primary" onClick={() => {
            void save((state) => updateWork(state, work.id, (live) => ({ ...live, writingStarted: true }))).catch(reply.fail);
          }}>开始写</button>
        </>}
      </section>
      <section className="creative-section">
        <h2>{editing ? '灵感' : '开书讨论'}</h2>
        {work.discussion.length > 0 && (
          <details className="reasoning-details" open={!editing}>
            <summary>开书讨论记录</summary>
            {work.discussion.map((turn) => <div key={turn.id} className="creative-turn">
              <p className="creative-text">{turn.role === 'user' ? '你' : 'AI'} · {turn.content}</p>
              {editing && <button type="button" className="btn" onClick={() => { setUseDiscussion(true); setExcerpt(turn.content); }}>引用这一段</button>}
              {turn.role === 'assistant' && <DocumentReadDetails reads={turn.documentReads} />}
            </div>)}
          </details>
        )}
        {work.suggestions.map((suggestion) => suggestion.text && (
          <div className="creative-turn" key={suggestion.id}>
            <p className="status-text">{suggestion.instruction}</p>
            <p className="creative-text">{suggestion.text}</p>
            <button type="button" className="btn" onPointerDown={(event) => event.preventDefault()} onClick={() => {
              const chosen = window.getSelection()?.toString().trim();
              void chooseSuggestion(suggestion, chosen && suggestion.text.includes(chosen) ? chosen : suggestion.text).catch(reply.fail);
            }}>采纳建议</button>
            <DocumentReadDetails reads={suggestion.documentReads} />
          </div>
        ))}
        {reply.error && <BannerAlert tone="danger">{reply.error}</BannerAlert>}
        {reply.output && <p className="creative-text" aria-live="polite">{reply.output}</p>}
        <form className="creative-message-form" onSubmit={submit}>
          {editing && work.discussion.length > 0 && <label><input type="checkbox" checked={useDiscussion}
            onChange={(event) => { setUseDiscussion(event.target.checked); setExcerpt(''); }} /> 引用开书讨论</label>}
          {editing && excerpt && <p className="status-text">将引用所选开书段落。</p>}
          <label className="field">{editing ? '写作要求' : '讨论内容'}
            <textarea value={instruction} rows={3} onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <div className="btn-group">
            <button type="submit" className="btn btn-primary" disabled={reply.busy || !instruction.trim()}>{editing ? '获取建议' : '发送'}</button>
            {reply.busy && <button type="button" className="btn" onClick={reply.stop}>停止</button>}
          </div>
        </form>
      </section>
      <ModalDialog open={Boolean(selectedSuggestion)} label="核对正文位置" onClose={() => setSelectedSuggestion(null)}>
        {selectedSuggestion && <div className="local-document-dialog">
          <h2>核对正文位置</h2>
          <p className="creative-text">{text.slice(selectedSuggestion.target.start, selectedSuggestion.target.end) || '在当前光标插入'}</p>
          <p className="creative-text">{selectedSuggestion.suggestion.text}</p>
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => setSelectedSuggestion(null)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => {
              const { suggestion, target } = selectedSuggestion;
              void adopt(target, suggestion.text).catch((err) => { setSelectedSuggestion(null); reply.fail(err); });
            }}>确认采纳</button>
          </div>
        </div>}
      </ModalDialog>
    </>
  );
}

const conversationLabel = (kind: InteractionMode) => kind === 'personal' ? '本人聊天' : '扮演对戏';

function CharacterPane(props: Props & { character: LocalCharacter }) {
  const { character, save, read, runtime, openDocument, openPublic } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const [input, setInput] = useState('');
  const [confirm, setConfirm] = useState<'export' | 'delete' | null>(null);
  const conversation = character.conversations.find((item) => item.id === character.activeConversationId);
  const path = conversation ? getActiveBranchNodes(conversation) : [];

  function editCharacter(proposal?: string, expected?: string) {
    openDocument({
      title: '角色人设 · 新对话采用新版',
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

  async function startConversation(kind: InteractionMode, markdown = '', openWithModel = true) {
    let id = '';
    await save((state) => updateCharacter(state, character.id, (live) => {
      const next = newConversation(live, kind, markdown);
      id = next.id;
      return { ...live, conversations: [...live.conversations, next], activeConversationId: id };
    }));
    if (openWithModel) send(id, '');
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
            {node.role === 'assistant' && <DocumentReadDetails reads={node.documentReads} />}
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
        <form className="creative-message-form" onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() && !reply.busy) send(conversation.id, input.trim());
        }}>
          <label className="field">发消息<textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} /></label>
          <div className="btn-group">
            <button type="submit" className="btn btn-primary" disabled={reply.busy || !input.trim()}>发送</button>
            {reply.busy && <button type="button" className="btn" onClick={reply.stop}>停止</button>}
          </div>
        </form>
        <details className="reasoning-details">
          <summary>对话管理</summary>
          <p className="status-text">空白开聊不带入这里的历史。已保存的人设和公共资料可在各自的文档中修改。</p>
          <div className="btn-group">
            <button type="button" className="btn" disabled={reply.busy} onClick={() => void startConversation(conversation.kind, '', false).catch(reply.fail)}>空白开聊</button>
            <button type="button" className="btn" disabled={reply.busy} onClick={() => openDocument({
              title: '核对要带入新对话的资料',
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
  const { mode, workspace, save, onBack, ready, storageError } = props;
  const [form, setForm] = useState(false);
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [error, setError] = useState('');
  const selectedWork = workspace.works.find((work) => work.id === workspace.activeWorkId);
  const selectedCharacter = workspace.characters.find((character) => character.id === workspace.activeCharacterId);
  const isWriting = mode === 'writing';
  useWebHistoryLayer('creative-workspace', 20, true, onBack);

  function create(event: FormEvent) {
    event.preventDefault();
    if (!isWriting && (!name.trim() || !persona.trim())) return;
    const work = newWork(name);
    const character = newCharacter(name, persona);
    void save((state) => isWriting
      ? { ...state, works: [...state.works, work], activeWorkId: work.id }
      : { ...state, characters: [...state.characters, character], activeCharacterId: character.id },
    ).then(() => {
      setForm(false);
      setName('');
      setPersona('');
      setError('');
    }).catch((err) => setError(toErrorMessage(err, '创建失败。')));
  }

  return (
    <OverlayPageShell title={isWriting ? '产粮' : '人机恋'} onBack={onBack}
      testId={isWriting ? 'writing-page' : 'character-page'}>
      {(error || storageError) && <BannerAlert tone="danger">{error || storageError}</BannerAlert>}
      {ready && <>
        <div className="creative-toolbar">
          <button type="button" className="btn btn-primary" onClick={() => setForm((open) => !open)}>
            {isWriting ? '开新书' : '添加角色'}
          </button>
          <button type="button" className="btn" onClick={() => props.openPublic()}>公共记忆</button>
        </div>
        <div className="creative-picks" aria-label={isWriting ? '本地作品' : '本地角色'}>
          {(isWriting ? workspace.works.map(({ id, title }) => ({ id, label: title }))
            : workspace.characters.map(({ id, name: label }) => ({ id, label }))).map(({ id, label }) => (
            <button type="button" className="btn" key={id} aria-pressed={(isWriting ? selectedWork : selectedCharacter)?.id === id}
              onClick={() => {
                void save((state) => isWriting ? { ...state, activeWorkId: id } : { ...state, activeCharacterId: id })
                  .catch((err) => setError(toErrorMessage(err, '打开失败。')));
                setForm(false);
              }}>{label}</button>
          ))}
        </div>
        {form && <form className="creative-section" onSubmit={create}>
          <label className="field">{isWriting ? '作品标题' : '角色名称'}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          {!isWriting && <label className="field">自由文本人设<textarea rows={7} value={persona} onChange={(event) => setPersona(event.target.value)} /></label>}
          <button type="submit" className="btn btn-primary">{isWriting ? '开始讨论' : '保存角色'}</button>
        </form>}
        {!form && isWriting && selectedWork && <DraftPane key={selectedWork.id} {...props} work={selectedWork} />}
        {!form && !isWriting && selectedCharacter && <CharacterPane key={selectedCharacter.id} {...props} character={selectedCharacter} />}
      </>}
    </OverlayPageShell>
  );
}
