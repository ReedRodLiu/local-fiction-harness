import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, ChevronRight, RotateCcw, Square } from 'lucide-react';
import {
  characterContext,
  conversationExport,
  conversationLocalVersion,
  documentLineage,
  documentVersion,
  getActiveBranchNodes,
  newConversation,
  writeDocument,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type InteractionMode,
  type LocalCharacter,
  type PlatformRuntime,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DocumentReadDetails, type DocumentReadEntry } from './DocumentReadDetails.tsx';
import { MessageContent } from './MessageContent.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import {
  makeTurn,
  replyContent,
  sendOnEnter,
  syncTextareaHeight,
  updateCharacter,
  updateConversation,
  useCreativeReply,
  type RequestModel,
} from './useCreativeReply.ts';

type CharacterCompanionTab = 'conversations' | 'profile';

interface CharacterPaneProps {
  character: LocalCharacter;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
}

const conversationLabel = (kind: InteractionMode) => (kind === 'personal' ? '本人聊天' : '扮演对戏');

export function CharacterPane(props: CharacterPaneProps) {
  const { character, save, read, runtime, openDocument, openPublic, companionOpen, setCompanionOpen } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const [input, setInput] = useState('');
  const [confirm, setConfirm] = useState<'export' | 'delete' | null>(null);
  const [companionTab, setCompanionTab] = useState<CharacterCompanionTab>('conversations');
  const [expandedHistoryNodeIds, setExpandedHistoryNodeIds] = useState<Record<string, boolean>>({});

  const conversation = character.conversations.find((item) => item.id === character.activeConversationId);
  const path = conversation ? getActiveBranchNodes(conversation) : [];

  useWebHistoryLayer('creative-companion', 40, companionOpen, () => setCompanionOpen(false));
  useWebHistoryLayer('character-confirm', 50, Boolean(confirm), () => setConfirm(null));

  const documentReadEntries: DocumentReadEntry[] = path.flatMap((node, index) =>
    node.documentReads?.length
      ? [{
          id: node.id,
          label: `第 ${Math.max(1, Math.ceil((index + 1) / 2))} 轮 · ${
            node.role === 'assistant' ? character.name : '玩家消息'
          }`,
          createdAt: node.createdAt,
          reads: node.documentReads,
        }]
      : [],
  );

  const activeLeafNode = path.at(-1);
  const latestTurnNodeIds = new Set(
    [
      activeLeafNode?.id,
      activeLeafNode?.role === 'assistant' ? activeLeafNode.parentId : null,
    ].filter((id): id is string => Boolean(id)),
  );

  function editCharacter(proposal?: string, expected?: string) {
    openDocument({
      title: '角色人设 · 新对话采用新版',
      description:
        proposal !== undefined
          ? '作用范围：角色人设。来源：本轮 AI 回复。'
          : '作用范围：当前角色及之后的新对话。',
      base: documentVersion(character.document, expected ?? character.document.head),
      history: documentLineage(character.document),
      proposal,
      reload: async () => {
        const found = (await read()).characters.find((item) => item.id === character.id);
        if (!found) throw new Error('角色已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) =>
          updateCharacter(state, character.id, (current) => {
            if (current.document.head !== version) throw new Error('角色文档已变化，请重新核对。');
            return { ...current, document: writeDocument(current.document, version, markdown) };
          }),
        );
      },
    });
  }

  function editConversation(target: CharacterConversation, proposal?: string) {
    const base = conversationLocalVersion(target);
    openDocument({
      title: '当前对话资料',
      base: documentVersion(target.document, base),
      description:
        proposal !== undefined
          ? '作用范围：当前对话。来源：本轮 AI 回复。'
          : '作用范围：当前角色对话。',
      history: documentLineage(target.document, base),
      proposal,
      apply: async (expected, markdown) => {
        await save((state) =>
          updateCharacter(state, character.id, (current) =>
            updateConversation(current, target.id, (live) => {
              if (live.activeLeafNodeId !== target.activeLeafNodeId || conversationLocalVersion(live) !== expected) {
                throw new Error('当前对话底稿已变化，请返回后重新核对。');
              }
              const revised = writeDocument(live.document, expected, markdown);
              return {
                ...live,
                document: { ...revised, head: live.document.head },
                edits: { ...live.edits, [live.activeLeafNodeId ?? '']: revised.head },
              };
            }),
          ),
        );
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
      const updated = await save((workspace) =>
        updateCharacter(workspace, current.id, (latest) =>
          updateConversation(latest, target.id, (live) => {
            if (
              live.activeLeafNodeId !== target.activeLeafNodeId ||
              conversationLocalVersion(live) !== ctx.localVersion
            ) {
              throw new Error('对话位置或资料已变化，请从当前记录重新发送。');
            }
            const docs = { container: target.characterVersion, local: ctx.localVersion };
            const user = contents ? { ...makeTurn('user', contents, live.activeLeafNodeId), documents: docs } : null;
            const assistant = {
              ...makeTurn('assistant', replyContent(result.content, result.proposal), user?.id ?? live.activeLeafNodeId),
              documents: docs,
              documentReads: ctx.reads,
            };
            const edits = { ...live.edits };
            delete edits[live.activeLeafNodeId ?? ''];
            return {
              ...live,
              edits,
              nodes: { ...live.nodes, ...(user ? { [user.id]: user } : {}), [assistant.id]: assistant },
              activeLeafNodeId: assistant.id,
            };
          }),
        ),
      );
      if (signal.aborted) return;
      setInput('');
      const saved = updated.characters
        .find((item) => item.id === current.id)
        ?.conversations.find((item) => item.id === target.id);
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
    await save((state) =>
      updateCharacter(state, character.id, (live) => {
        const next = newConversation(live, kind, markdown);
        id = next.id;
        return { ...live, conversations: [...live.conversations, next], activeConversationId: id };
      }),
    );
    if (openWithModel) send(id, '');
    return id;
  }

  function openMode(kind: InteractionMode) {
    const previous = [...character.conversations].reverse().find((item) => item.kind === kind);
    if (previous) navigate(previous.id);
    else void startConversation(kind).catch(reply.fail);
  }

  const navigate = (conversationId: string, nodeId?: string) => {
    setExpandedHistoryNodeIds({});
    void save((state) =>
      updateCharacter(state, character.id, (live) => {
        const active = { ...live, activeConversationId: conversationId };
        return nodeId === undefined
          ? active
          : updateConversation(active, conversationId, (target) => ({ ...target, activeLeafNodeId: nodeId }));
      }),
    ).catch(reply.fail);
  };

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const tabs: CharacterCompanionTab[] = ['conversations', 'profile'];
    const currentIndex = tabs.indexOf(companionTab);
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
    setCompanionTab(nextTab);
    document.getElementById(`character-tab-${nextTab}`)?.focus();
  };

  const closeCompanion = () => {
    setCompanionOpen(false);
  };

  const branchLeaves = conversation
    ? Object.values(conversation.nodes).filter(
        (node) => !Object.values(conversation.nodes).some((child) => child.parentId === node.id),
      )
    : [];
  const hasBranches = conversation
    ? Object.values(conversation.nodes).some((node) => !path.some((active) => active.id === node.id))
    : false;
  const exportText = conversation && confirm === 'export' ? conversationExport(character, conversation) : '';

  return (
    <>
      <section className="timeline creative-timeline" data-testid="character-timeline" aria-label="角色对话记录">
        {(!conversation || (!path.length && !reply.busy)) && (
          <div className="creative-empty-state">
            <p>
              {conversation
                ? `当前为${conversationLabel(conversation.kind)}，可以直接发消息或让 ${character.name} 先开口。`
                : `开启一段与 ${character.name} 的新对话。`}
            </p>
            <button
              type="button"
              className="writing-enter-pill"
              disabled={reply.busy}
              onClick={() => {
                if (conversation) send(conversation.id, '');
                else void startConversation('personal', '', true).catch(reply.fail);
              }}
            >
              让角色先开口
            </button>
          </div>
        )}

        {conversation &&
          path.map((node, index) => {
            const isLatestTurn = latestTurnNodeIds.has(node.id);
            const isExpanded = Boolean(expandedHistoryNodeIds[node.id]);
            const turnNumber = Math.max(1, Math.ceil((index + 1) / 2));
            const historyLabel = `第 ${turnNumber} 轮 · ${node.role === 'assistant' ? character.name : '你'}`;

            return (
              <article
                key={node.id}
                className={`turn-card ${node.role}${!isLatestTurn ? ' is-history' : ''}`}
                data-testid={node.role === 'user' ? 'turn-user' : 'turn-assistant'}
                aria-label={node.role === 'user' ? '玩家消息' : `${character.name}回复`}
              >
                <div className="turn-expanded-content">
                  {node.role === 'user' ? (
                    <div className="turn-user-row">
                      <div className="turn-user-bubble" data-testid="user-bubble">
                        {node.content}
                      </div>
                    </div>
                  ) : (
                    <MessageContent content={node.content} />
                  )}

                  {node.role === 'assistant' && (isLatestTurn ? (
                    <div className="turn-actions" data-testid="turn-actions" aria-label="对话操作">
                      <button
                        type="button"
                        className="btn turn-action-button"
                        disabled={reply.busy}
                        aria-label="从这里继续"
                        title="从这里继续"
                        onClick={() => navigate(conversation.id, node.id)}
                      >
                        <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                  ) : isExpanded ? (
                    <div className="turn-actions" data-testid="turn-actions" aria-label="对话操作">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={reply.busy}
                        onClick={() => navigate(conversation.id, node.id)}
                      >
                        从这里继续
                      </button>
                      <button
                        type="button"
                        className="turn-history-close"
                        onClick={() =>
                          setExpandedHistoryNodeIds((prev) => ({ ...prev, [node.id]: false }))
                        }
                      >
                        收起操作
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="turn-history-toggle"
                      data-testid="turn-history-toggle"
                      aria-expanded={false}
                      onClick={() =>
                        setExpandedHistoryNodeIds((prev) => ({ ...prev, [node.id]: true }))
                      }
                    >
                      <span>{historyLabel}</span>
                      <span>轻点展开操作</span>
                    </button>
                  ))}
                </div>
              </article>
            );
          })}

        {reply.busy && (
          <article
            className="turn-card assistant turn-streaming"
            data-testid="turn-assistant"
            aria-live="polite"
          >
            {reply.output ? (
              <MessageContent content={reply.output} />
            ) : (
              <div className="turn-body">正在等待响应…</div>
            )}
          </article>
        )}
      </section>

      <form
        className="composer"
        data-testid="stage-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const contents = input.trim();
          if (!contents || reply.busy) return;
          if (conversation) send(conversation.id, contents);
          else void startConversation('personal', '', false).then((id) => send(id, contents)).catch(reply.fail);
        }}
      >
        <div className="composer-notices">
          {reply.error && <BannerAlert tone="danger">{reply.error}</BannerAlert>}
        </div>
        <label className="visually-hidden" htmlFor="character-chat-input">
          发消息
        </label>
        <textarea
          id="character-chat-input"
          aria-label="发消息"
          rows={1}
          value={input}
          placeholder={`向 ${character.name} 发消息（Enter 发送，Shift+Enter 换行）…`}
          onChange={(event) => {
            setInput(event.target.value);
            syncTextareaHeight(event.currentTarget);
          }}
          onKeyDown={sendOnEnter}
        />
        <div className="composer-actions">
          {reply.busy ? (
            <button
              type="button"
              className="btn composer-send"
              aria-label="停止"
              onClick={reply.stop}
            >
              <Square size={17} strokeWidth={1.75} aria-hidden="true" />
              <span className="visually-hidden">停止</span>
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary composer-send"
              aria-label="发送"
              disabled={!input.trim()}
            >
              <ArrowUp size={19} strokeWidth={1.75} aria-hidden="true" />
              <span className="visually-hidden">发送</span>
            </button>
          )}
        </div>
      </form>

      <SheetDialog
        open={companionOpen}
        title="角色伴生"
        label="创作资料"
        panelName="创作资料"
        testId="creative-companion"
        onClose={() => setCompanionOpen(false)}
      >
        <div className="companion-sheet" data-testid="character-companion-sheet">
          <div className="companion-tabs companion-tabs-two" role="tablist" aria-label="角色伴生面板">
            <button
              id="character-tab-conversations"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'conversations'}
              aria-controls="character-panel-conversations"
              tabIndex={companionTab === 'conversations' ? 0 : -1}
              onClick={() => setCompanionTab('conversations')}
              onKeyDown={selectAdjacentTab}
            >
              对话与分支
            </button>
            <button
              id="character-tab-profile"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'profile'}
              aria-controls="character-panel-profile"
              tabIndex={companionTab === 'profile' ? 0 : -1}
              onClick={() => setCompanionTab('profile')}
              onKeyDown={selectAdjacentTab}
            >
              角色与资料
            </button>
          </div>

          <section
            id="character-panel-conversations"
            className="companion-panel"
            role="tabpanel"
            aria-labelledby="character-tab-conversations"
            hidden={companionTab !== 'conversations'}
          >
            <div className="context-overview-stack">
              <InsetGroup title="互动方式">
                <div className="character-mode-switcher" role="group" aria-label="互动方式">
                  <button
                    type="button"
                    className="character-mode-pill"
                    aria-pressed={conversation?.kind === 'personal'}
                    disabled={reply.busy}
                    onClick={() => {
                      openMode('personal');
                      closeCompanion();
                    }}
                  >
                    本人聊天
                  </button>
                  <button
                    type="button"
                    className="character-mode-pill"
                    aria-pressed={conversation?.kind === 'roleplay'}
                    disabled={reply.busy}
                    onClick={() => {
                      openMode('roleplay');
                      closeCompanion();
                    }}
                  >
                    扮演对戏
                  </button>
                </div>
              </InsetGroup>

              {character.conversations.length > 0 && (
                <InsetGroup title="历史对话">
                  <div className="companion-document-list">
                    {character.conversations.map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        className="companion-document-row"
                        disabled={reply.busy}
                        aria-pressed={conversation?.id === item.id}
                        onClick={() => {
                          navigate(item.id);
                          closeCompanion();
                        }}
                      >
                        <span>
                          {conversationLabel(item.kind)} {index + 1}
                        </span>
                        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </InsetGroup>
              )}

              {conversation && hasBranches && (
                <InsetGroup title="对话分支">
                  <div className="companion-document-list">
                    {branchLeaves.map((leaf) => (
                      <button
                        key={leaf.id}
                        type="button"
                        className="companion-document-row"
                        disabled={reply.busy}
                        onClick={() => {
                          navigate(conversation.id, leaf.id);
                          closeCompanion();
                        }}
                      >
                        <span>{leaf.content.slice(0, 42) || '未命名分支'}</span>
                        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </InsetGroup>
              )}

              <InsetGroup title="对话管理">
                <div className="companion-document-list">
                  <button
                    type="button"
                    className="companion-document-row"
                    disabled={reply.busy}
                    onClick={() => {
                      void startConversation(conversation?.kind ?? 'personal', '', false)
                        .then(() => closeCompanion())
                        .catch(reply.fail);
                    }}
                  >
                    <span>空白开聊</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="companion-document-row"
                    disabled={reply.busy}
                    onClick={() =>
                      openDocument({
                        title: '核对要带入新对话的资料',
                        description: '作用范围：新对话的初始资料。',
                        base: { id: 'new-conversation', previous: null, markdown: '', savedAt: Date.now(), source: 'user' },
                        apply: async (_version, markdown) => {
                          if (!markdown.trim()) throw new Error('请填入要带入的资料。');
                          await startConversation(conversation?.kind ?? 'personal', markdown, false);
                          closeCompanion();
                        },
                      })
                    }
                  >
                    <span>带资料开新对话</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  {conversation && (
                    <>
                      <button
                        type="button"
                        className="companion-document-row"
                        onClick={() => setConfirm('export')}
                      >
                        <span>预览导出</span>
                        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="companion-document-row danger-menu-item"
                        disabled={reply.busy}
                        onClick={() => setConfirm('delete')}
                      >
                        <span>删除对话</span>
                        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </InsetGroup>
            </div>
          </section>

          <section
            id="character-panel-profile"
            className="companion-panel"
            role="tabpanel"
            aria-labelledby="character-tab-profile"
            hidden={companionTab !== 'profile'}
          >
            <div className="context-overview-stack">
              <InsetGroup title="角色与资料" testId="character-companion-documents">
                <div className="companion-document-list">
                  <button
                    type="button"
                    className="companion-document-row"
                    onClick={() => editCharacter()}
                  >
                    <span>角色人设 · 新对话采用新版</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  {conversation && (
                    <button
                      type="button"
                      className="companion-document-row"
                      disabled={reply.busy}
                      onClick={() => editConversation(conversation)}
                    >
                      <span>当前对话资料</span>
                      <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="companion-document-row"
                    onClick={() => openPublic()}
                  >
                    <span>公共记忆</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </InsetGroup>

              <DocumentReadDetails
                entries={documentReadEntries}
                testId="creative-document-reads"
                summary="资料版本详情"
              />
            </div>
          </section>
        </div>
      </SheetDialog>

      <ModalDialog
        open={Boolean(confirm)}
        label={confirm === 'delete' ? '删除这段对话及其分叉' : '对话导出预览'}
        onClose={() => setConfirm(null)}
      >
        {conversation && confirm && (
          <div className="local-document-dialog">
            <h2>{confirm === 'delete' ? '删除这段对话及其分叉' : '对话导出预览'}</h2>
            {confirm === 'delete' ? (
              <p>删除本机这段对话的全部分叉、局部资料、版本和审计。已导出文件仍由你保管。</p>
            ) : (
              <pre>{exportText}</pre>
            )}
            <div className="btn-group">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (confirm === 'delete') {
                    void save((state) =>
                      updateCharacter(state, character.id, (live) => ({
                        ...live,
                        activeConversationId: null,
                        conversations: live.conversations.filter((item) => item.id !== conversation.id),
                      })),
                    )
                      .then(() => setConfirm(null))
                      .catch(reply.fail);
                  } else if (runtime.backupExporter.exportMarkdown) {
                    const safeName = character.name.replace(/[\\/:*?"<>|]/g, '_').trim() || '角色对话';
                    void runtime.backupExporter
                      .exportMarkdown(`${safeName}-对话.md`, exportText)
                      .then(() => setConfirm(null))
                      .catch(reply.fail);
                  }
                }}
              >
                {confirm === 'delete' ? '确认删除' : '导出 Markdown'}
              </button>
            </div>
          </div>
        )}
      </ModalDialog>
    </>
  );
}
