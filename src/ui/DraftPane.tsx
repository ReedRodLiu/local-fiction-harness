import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, ChevronRight, Square, X } from 'lucide-react';
import {
  adoptSuggestion,
  createDefaultId,
  creativeContext,
  documentLineage,
  documentVersion,
  referenceDocument,
  writeDocument,
  writingInput,
  type CreativeWorkspaceState,
  type DraftWork,
  type PlatformRuntime,
  type WritingSuggestion,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DocumentReadDetails, type DocumentReadEntry } from './DocumentReadDetails.tsx';
import { MessageContent } from './MessageContent.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import {
  makeTurn,
  replyContent,
  sendOnEnter,
  syncTextareaHeight,
  updateWork,
  useCreativeReply,
  type RequestModel,
} from './useCreativeReply.ts';

type WritingCompanionTab = 'discussion' | 'documents';

interface DraftPaneProps {
  work: DraftWork;
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

export function DraftPane(props: DraftPaneProps) {
  const { work, save, read, runtime, openDocument, openPublic, companionOpen, setCompanionOpen } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const editing = props.manuscript ?? Boolean(work.writingStarted || work.body || work.source);

  const [text, setText] = useState(work.body);
  const [saveConflict, setSaveConflict] = useState(false);
  const [discussionInput, setDiscussionInput] = useState(() =>
    work.discussion.at(-1)?.role === 'user' ? work.discussion.at(-1)!.content : '',
  );
  const [manuscriptInput, setManuscriptInput] = useState('');
  const [useDiscussion, setUseDiscussion] = useState(false);
  const [excerpt, setExcerpt] = useState('');
  const [exported, setExported] = useState(false);
  const [companionTab, setCompanionTab] = useState<WritingCompanionTab>('discussion');
  const [dismissedSuggestionId, setDismissedSuggestionId] = useState<string | null>(null);
  const [focusedSuggestionId, setFocusedSuggestionId] = useState<string | null>(null);
  const [hasCardSelection, setHasCardSelection] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState<{
    suggestion: WritingSuggestion;
    target: WritingSuggestion;
  } | null>(null);

  const textarea = useRef<HTMLTextAreaElement>(null);
  const suggestionCardRef = useRef<HTMLElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const unsaved = useRef(work.body);
  const saved = useRef(work.body);
  saved.current = work.body;

  useWebHistoryLayer('creative-companion', 40, companionOpen, () => setCompanionOpen(false));

  const documentReadEntries: DocumentReadEntry[] = [
    ...work.discussion.flatMap((turn, index) =>
      turn.documentReads?.length
        ? [{
            id: turn.id,
            label: `第 ${Math.max(1, Math.ceil((index + 1) / 2))} 轮 · 开书讨论回复`,
            createdAt: turn.createdAt,
            reads: turn.documentReads,
          }]
        : [],
    ),
    ...work.suggestions.flatMap((suggestion, index) =>
      suggestion.documentReads.length
        ? [{
            id: suggestion.id,
            label: `写作建议 ${index + 1} · ${suggestion.instruction}`,
            reads: suggestion.documentReads,
          }]
        : [],
    ),
  ];

  const latestSuggestion = [...work.suggestions].reverse().find((item) => Boolean(item.text));
  const activeSuggestion =
    (focusedSuggestionId
      ? work.suggestions.find((item) => item.id === focusedSuggestionId && Boolean(item.text))
      : undefined) ??
    (latestSuggestion && latestSuggestion.id !== dismissedSuggestionId ? latestSuggestion : undefined);

  function openCompanionTab(tab: WritingCompanionTab) {
    setCompanionTab(tab);
    setCompanionOpen(true);
  }

  function editDocument(proposal?: string, document = work.document) {
    const base = documentVersion(document);
    openDocument({
      title: '作品资料',
      base,
      proposal,
      description:
        proposal !== undefined
          ? '作用范围：当前作品资料。来源：本轮 AI 回复。'
          : '作用范围：当前作品。',
      history: documentLineage(document),
      reload: async () => {
        const found = (await read()).works.find((item) => item.id === work.id);
        if (!found) throw new Error('作品已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) =>
          updateWork(state, work.id, (live) => {
            if (live.document.head !== version) throw new Error('作品资料已变化，请重新核对。');
            return { ...live, document: writeDocument(live.document, version, markdown) };
          }),
        );
      },
    });
  }

  function saveText(value: string, retry = false) {
    const before = retry ? saved.current : unsaved.current;
    unsaved.current = value;
    setText(value);
    setExported(false);
    setSaveConflict(false);
    void save((state) =>
      updateWork(state, work.id, (live) => {
        if (live.body !== before) throw new Error('正文底稿已变化。请核对后重试保存。');
        if (live.body === value) return live;
        return { ...live, body: value, bodyRevision: live.bodyRevision + 1 };
      }),
    ).catch((err) => {
      setSaveConflict(true);
      reply.fail(err);
    });
  }

  async function currentWork() {
    const state = await read();
    const live = state.works.find((item) => item.id === work.id);
    if (!live) throw new Error('作品已不存在。');
    if (live.body !== unsaved.current) throw new Error('正文尚未保存，请检查保存错误后重试。');
    return { state, live };
  }

  function submit(value: string) {
    const input = value.trim();
    if (!input || reply.busy) return;
    const { start, end } = selection.current;
    const includeDiscussion = useDiscussion;
    const selectedExcerpt = excerpt.trim();
    if (editing) {
      setDismissedSuggestionId(null);
      setFocusedSuggestionId(null);
      setSelectedSuggestion(null);
      setHasCardSelection(false);
    }
    reply.start(editing ? '请求写作建议' : '开书讨论', async (request, signal) => {
      const { state, live } = await currentWork();
      if (signal.aborted) return;
      const publicDoc = documentVersion(state.publicDocument);
      const workDoc = documentVersion(live.document);
      const pending =
        !editing &&
        live.discussion.at(-1)?.role === 'user' &&
        live.discussion.at(-1)?.content === input
          ? live.discussion.at(-1)
          : undefined;
      const linked =
        !editing || includeDiscussion
          ? pending
            ? live.discussion.slice(0, -1)
            : live.discussion
          : [];
      const draftInput = editing ? writingInput(live, start, end, input) : input;
      const messages = creativeContext(
        editing
          ? '给作者一份可采纳的短文本建议。按当前指令和选区创作，结合正文和作品资料。只有明确提供的关联讨论才可引用。若无法从所给材料确认所指原段，请作者选段。'
          : '和作者自由讨论开书想法、原作设定和续写起点。提醒作者核对不确定细节。用户明确要求留下总结时将其提议写入作品资料。',
        [
          ['公共记忆', publicDoc],
          ['作品资料', workDoc],
        ],
        selectedExcerpt && editing ? [] : linked,
        selectedExcerpt && editing ? `${draftInput}\n\n【作者选定的开书原话】\n${selectedExcerpt}` : draftInput,
      );
      const result = await request(messages);
      if (signal.aborted) return;
      const reads = [
        referenceDocument('public', '公共记忆', publicDoc),
        referenceDocument('container', live.title, workDoc),
      ];
      await save((now) =>
        updateWork(now, live.id, (latest) => {
          if (editing) {
            const newId = createDefaultId();
            return {
              ...latest,
              suggestions: [
                ...latest.suggestions,
                {
                  id: newId,
                  instruction: input,
                  text: result.content,
                  revision: live.bodyRevision,
                  start,
                  end,
                  documentReads: reads,
                },
              ],
            };
          }
          const user = pending ?? makeTurn('user', input, latest.discussion.at(-1)?.id ?? null);
          if (pending && latest.discussion.at(-1)?.id !== pending.id) {
            throw new Error('开书讨论已变化，请重试。');
          }
          return {
            ...latest,
            discussion: [
              ...latest.discussion,
              ...(pending ? [] : [user]),
              {
                ...makeTurn('assistant', replyContent(result.content, result.proposal), user.id),
                documentReads: reads,
              },
            ],
          };
        }),
      );
      if (signal.aborted) return;
      if (editing) {
        setManuscriptInput('');
        setFocusedSuggestionId(null);
        setDismissedSuggestionId(null);
      } else {
        setDiscussionInput('');
      }
      if (result.proposal?.target === 'public') openPublic(result.proposal.markdown, publicDoc.id);
      if (result.proposal?.target === 'container' || result.proposal?.target === 'local') {
        editDocument(result.proposal.markdown, live.document);
      }
    });
  }

  const queuedOpening = useRef(false);
  useEffect(() => {
    if (queuedOpening.current || props.initialTurn?.id !== work.id) return;
    const prompt = props.initialTurn.prompt;
    const timer = window.setTimeout(() => {
      queuedOpening.current = true;
      setDiscussionInput(prompt);
      props.onConsumeInitialTurn();
      submit(prompt);
    }, 0);
    return () => window.clearTimeout(timer);
  });

  function updateCardSelectionState(suggestionText?: string) {
    if (!suggestionText || !suggestionCardRef.current) {
      setHasCardSelection(false);
      return;
    }
    const sel = window.getSelection();
    const chosen = sel?.toString().trim() ?? '';
    const insideCard =
      sel &&
      sel.rangeCount > 0 &&
      suggestionCardRef.current.contains(sel.getRangeAt(0).commonAncestorContainer);
    setHasCardSelection(Boolean(insideCard && chosen && suggestionText.includes(chosen)));
  }

  async function adopt(target: WritingSuggestion, chosen: string) {
    const { live } = await currentWork();
    const updated = await save((state) =>
      updateWork(state, live.id, (latest) => adoptSuggestion(latest, target, chosen)),
    );
    const accepted = updated.works.find((item) => item.id === live.id)!;
    unsaved.current = accepted.body;
    setText(accepted.body);
    setSaveConflict(false);
    setExported(false);
    setSelectedSuggestion(null);
    setFocusedSuggestionId(null);
    setDismissedSuggestionId(target.id);
    setHasCardSelection(false);
    selection.current = { start: target.start + chosen.length, end: target.start + chosen.length };
    window.requestAnimationFrame(() =>
      textarea.current?.setSelectionRange(selection.current.start, selection.current.end),
    );
  }

  async function chooseSuggestion(suggestion: WritingSuggestion, chosen: string) {
    const { live } = await currentWork();
    if (live.bodyRevision !== suggestion.revision || suggestion.start !== suggestion.end) {
      const target =
        live.bodyRevision === suggestion.revision
          ? suggestion
          : {
              ...suggestion,
              revision: live.bodyRevision,
              start: selection.current.start,
              end: selection.current.end,
            };
      setFocusedSuggestionId(suggestion.id);
      setDismissedSuggestionId(null);
      setSelectedSuggestion({ suggestion: { ...suggestion, text: chosen }, target });
      return;
    }
    await adopt(suggestion, chosen);
  }

  function enterManuscript() {
    props.onStartManuscript?.();
    void save((state) =>
      updateWork(state, work.id, (live) => ({ ...live, writingStarted: true })),
    ).catch(reply.fail);
  }

  function exportManuscript() {
    void currentWork()
      .then(({ live }) => {
        if (!runtime.backupExporter.exportMarkdown) {
          throw new Error('当前设备无法导出 Markdown。');
        }
        const safeTitle = live.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名作品';
        return runtime.backupExporter.exportMarkdown(`${safeTitle}.md`, live.body);
      })
      .then(() => setExported(true))
      .catch(reply.fail);
  }

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const tabs: WritingCompanionTab[] = ['discussion', 'documents'];
    const currentIndex = tabs.indexOf(companionTab);
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
    setCompanionTab(nextTab);
    document.getElementById(`writing-tab-${nextTab}`)?.focus();
  };

  const showFloatingSuggestionCard =
    editing && (reply.busy || Boolean(activeSuggestion) || Boolean(selectedSuggestion));

  const composerNotices = (
    <div className="composer-notices">
      {reply.error && <BannerAlert tone="danger">{reply.error}</BannerAlert>}
      {editing && saveConflict && text !== saved.current && (
        <BannerAlert tone="warning">
          <span>正文保存出现冲突，请重试保存。</span>
          <button type="button" className="btn btn-sm" onClick={() => saveText(text, true)}>
            重试保存
          </button>
        </BannerAlert>
      )}
    </div>
  );

  return (
    <>
      {!editing ? (
        <>
          <section className="timeline creative-timeline" data-testid="writing-discussion-timeline" aria-label="开书讨论记录">
            {work.discussion.length === 0 && !reply.busy && (
              <div className="creative-empty-state">
                <p>先聊聊人物、世界观或开篇灵感，准备好后即可进入正文写作。</p>
                <button type="button" className="writing-enter-pill" onClick={enterManuscript}>
                  进入正文写作
                </button>
              </div>
            )}

            {work.discussion.map((turn) => (
              <article
                key={turn.id}
                className={`turn-card ${turn.role}`}
                data-testid={turn.role === 'user' ? 'turn-user' : 'turn-assistant'}
                aria-label={turn.role === 'user' ? '作者讨论' : 'AI 讨论回复'}
              >
                <div className="turn-expanded-content">
                  {turn.role === 'user' ? (
                    <div className="turn-user-row">
                      <div className="turn-user-bubble" data-testid="user-bubble">
                        {turn.content}
                      </div>
                    </div>
                  ) : (
                    <MessageContent content={turn.content} />
                  )}
                </div>
              </article>
            ))}

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

            {work.discussion.length > 0 && !reply.busy && (
              <div className="writing-discussion-ready">
                <button type="button" className="writing-enter-pill" onClick={enterManuscript}>
                  开始写
                </button>
              </div>
            )}
          </section>

          <form
            className="composer"
            data-testid="stage-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit(discussionInput);
            }}
          >
            {composerNotices}
            <label className="visually-hidden" htmlFor="writing-discussion-input">
              讨论内容
            </label>
            <textarea
              id="writing-discussion-input"
              aria-label="讨论内容"
              rows={1}
              value={discussionInput}
              placeholder="聊聊人物、设定或开篇方向…"
              onChange={(event) => {
                setDiscussionInput(event.target.value);
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
                  disabled={!discussionInput.trim()}
                >
                  <ArrowUp size={19} strokeWidth={1.75} aria-hidden="true" />
                  <span className="visually-hidden">发送</span>
                </button>
              )}
            </div>
          </form>
        </>
      ) : (
        <>
          <div className="writing-manuscript-canvas">
            <div className="writing-manuscript-status" data-testid="manuscript-status" role="status">
              {text.length} 字 · {text !== saved.current ? '保存中…' : '已本地保存'}
            </div>
            <label className="visually-hidden" htmlFor="creative-manuscript-editor">
              正文
            </label>
            <textarea
              id="creative-manuscript-editor"
              ref={textarea}
              className="creative-manuscript"
              data-testid="creative-manuscript"
              aria-label="正文"
              placeholder="从这里写下正文…选中片段或放置光标后，可在底部输入续写或改写要求。"
              value={text}
              onChange={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
                saveText(event.target.value);
              }}
              onSelect={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
              onKeyUp={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
              onClick={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
            />
          </div>

          <div className="writing-bottom-dock">
            {showFloatingSuggestionCard && (
              <section
                ref={suggestionCardRef}
                className="writing-suggestion-card"
                data-testid="writing-suggestion-card"
                aria-label="写作建议"
                onMouseUp={() => updateCardSelectionState(activeSuggestion?.text)}
                onTouchEnd={() => updateCardSelectionState(activeSuggestion?.text)}
                onKeyUp={() => updateCardSelectionState(activeSuggestion?.text)}
              >
                <div className="writing-suggestion-header">
                  <span className="writing-suggestion-title">
                    {reply.busy
                      ? '正在生成建议…'
                      : selectedSuggestion
                        ? '确认写入位置'
                        : '写作建议'}
                  </span>
                  {!reply.busy && (
                    <button
                      type="button"
                      className="icon-button writing-suggestion-dismiss"
                      aria-label="关闭建议"
                      onClick={() => {
                        setSelectedSuggestion(null);
                        setFocusedSuggestionId(null);
                        if (activeSuggestion) setDismissedSuggestionId(activeSuggestion.id);
                      }}
                    >
                      <X size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {reply.busy ? (
                  <p className="writing-suggestion-body" aria-live="polite">
                    {reply.output || '正在构思续写与改写建议…'}
                  </p>
                ) : selectedSuggestion ? (
                  <div className="writing-suggestion-confirm">
                    <p className="writing-suggestion-diff-label">
                      {selectedSuggestion.target.start !== selectedSuggestion.target.end
                        ? `将替换原片段：「${text.slice(selectedSuggestion.target.start, selectedSuggestion.target.end)}」`
                        : '将在当前光标位置插入：'}
                    </p>
                    <p className="writing-suggestion-body">{selectedSuggestion.suggestion.text}</p>
                    <div className="writing-suggestion-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSelectedSuggestion(null)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          const { suggestion, target } = selectedSuggestion;
                          void adopt(target, suggestion.text).catch((err) => {
                            setSelectedSuggestion(null);
                            reply.fail(err);
                          });
                        }}
                      >
                        确认采纳
                      </button>
                    </div>
                  </div>
                ) : (
                  activeSuggestion && (
                    <>
                      <p className="writing-suggestion-body">{activeSuggestion.text}</p>
                      <div className="writing-suggestion-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => {
                            const sel = window.getSelection();
                            const chosen = sel?.toString().trim() ?? '';
                            const insideCard =
                              sel &&
                              sel.rangeCount > 0 &&
                              suggestionCardRef.current?.contains(
                                sel.getRangeAt(0).commonAncestorContainer,
                              );
                            const slice =
                              insideCard && chosen && activeSuggestion.text.includes(chosen)
                                ? chosen
                                : activeSuggestion.text;
                            void chooseSuggestion(activeSuggestion, slice).catch(reply.fail);
                          }}
                        >
                          {hasCardSelection ? '采纳所选' : '采纳建议'}
                        </button>
                      </div>
                    </>
                  )
                )}
              </section>
            )}

            <form
              className="composer writing-composer"
              data-testid="stage-composer"
              onSubmit={(event) => {
                event.preventDefault();
                submit(manuscriptInput);
              }}
            >
              {composerNotices}
              <div className="writing-composer-main">
                {work.discussion.length > 0 && (
                  <div className="writing-composer-tools">
                    {excerpt ? (
                      <span className="writing-ref-group">
                        <button
                          type="button"
                          className="writing-ref-pill is-active"
                          onClick={() => openCompanionTab('discussion')}
                        >
                          引用：{excerpt.slice(0, 14)}
                          {excerpt.length > 14 ? '…' : ''}
                        </button>
                        <button
                          type="button"
                          className="writing-ref-clear"
                          aria-label="清除引用讨论"
                          onClick={() => {
                            setExcerpt('');
                            setUseDiscussion(false);
                          }}
                        >
                          <X size={14} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </span>
                    ) : useDiscussion ? (
                      <span className="writing-ref-group">
                        <button
                          type="button"
                          className="writing-ref-pill is-active"
                          aria-pressed={true}
                          onClick={() => setUseDiscussion(false)}
                        >
                          已引用讨论
                        </button>
                        <button
                          type="button"
                          className="writing-ref-pill"
                          onClick={() => openCompanionTab('discussion')}
                        >
                          挑选原话
                        </button>
                        <button
                          type="button"
                          className="writing-ref-clear"
                          aria-label="清除引用讨论"
                          onClick={() => setUseDiscussion(false)}
                        >
                          <X size={14} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="writing-ref-pill"
                        aria-pressed={false}
                        onClick={() => setUseDiscussion(true)}
                      >
                        引用讨论
                      </button>
                    )}
                  </div>
                )}

                <div className="writing-composer-row">
                  <label className="visually-hidden" htmlFor="writing-suggestion-input">
                    写作要求
                  </label>
                  <textarea
                    id="writing-suggestion-input"
                    aria-label="写作要求"
                    rows={1}
                    value={manuscriptInput}
                    placeholder="输入续写或改写要求…"
                    onChange={(event) => {
                      setManuscriptInput(event.target.value);
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
                        aria-label="获取建议"
                        disabled={!manuscriptInput.trim()}
                      >
                        <ArrowUp size={19} strokeWidth={1.75} aria-hidden="true" />
                        <span className="visually-hidden">获取建议</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </form>
          </div>
        </>
      )}

      <SheetDialog
        open={companionOpen}
        title="作品伴生"
        label="创作资料"
        panelName="创作资料"
        testId="creative-companion"
        onClose={() => setCompanionOpen(false)}
      >
        <div className="companion-sheet" data-testid="writing-companion-sheet">
          <div className="companion-tabs companion-tabs-two" role="tablist" aria-label="作品伴生面板">
            <button
              id="writing-tab-discussion"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'discussion'}
              aria-controls="writing-panel-discussion"
              tabIndex={companionTab === 'discussion' ? 0 : -1}
              onClick={() => setCompanionTab('discussion')}
              onKeyDown={selectAdjacentTab}
            >
              灵感与讨论
            </button>
            <button
              id="writing-tab-documents"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'documents'}
              aria-controls="writing-panel-documents"
              tabIndex={companionTab === 'documents' ? 0 : -1}
              onClick={() => setCompanionTab('documents')}
              onKeyDown={selectAdjacentTab}
            >
              作品资料
            </button>
          </div>

          <section
            id="writing-panel-discussion"
            className="companion-panel"
            role="tabpanel"
            aria-labelledby="writing-tab-discussion"
            hidden={companionTab !== 'discussion'}
          >
            <div className="context-overview-stack">
              <InsetGroup title="开书讨论记录">
                {work.discussion.length > 0 ? (
                  <div className="writing-companion-list">
                    {work.discussion.map((turn) => (
                      <div key={turn.id} className="writing-companion-item">
                        <p className="writing-companion-meta">{turn.role === 'user' ? '你' : 'AI'}</p>
                        <p className="creative-text">{turn.content}</p>
                        {editing && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              setUseDiscussion(true);
                              setExcerpt(turn.content);
                              setCompanionOpen(false);
                            }}
                          >
                            引用这一段
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="status-text">暂无开书讨论记录。</p>
                )}
              </InsetGroup>

              <InsetGroup title="历史写作建议">
                {work.suggestions.some((item) => Boolean(item.text)) ? (
                  <div className="writing-companion-list">
                    {[...work.suggestions]
                      .reverse()
                      .filter((item) => Boolean(item.text))
                      .map((suggestion) => (
                        <div key={suggestion.id} className="writing-companion-item">
                          <p className="writing-companion-meta">{suggestion.instruction}</p>
                          <p className="creative-text">{suggestion.text}</p>
                          {editing && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                void chooseSuggestion(suggestion, suggestion.text).catch(reply.fail);
                                setCompanionOpen(false);
                              }}
                            >
                              重新采纳
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="status-text">暂无历史写作建议。</p>
                )}
              </InsetGroup>
            </div>
          </section>

          <section
            id="writing-panel-documents"
            className="companion-panel"
            role="tabpanel"
            aria-labelledby="writing-tab-documents"
            hidden={companionTab !== 'documents'}
          >
            <div className="context-overview-stack">
              <InsetGroup title="作品资料" testId="writing-companion-documents">
                <div className="companion-document-list">
                  <button
                    type="button"
                    className="companion-document-row"
                    onClick={() => editDocument()}
                  >
                    <span>编辑作品资料</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="companion-document-row"
                    onClick={exportManuscript}
                  >
                    <span>导出正文 Markdown</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
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
              {exported && <p className="status-text" role="status">已提交正文导出。</p>}
              {work.source && <p className="status-text">已保存开稿时采用的文游资料。</p>}
              <DocumentReadDetails
                entries={documentReadEntries}
                testId="creative-document-reads"
                summary="资料版本详情"
              />
            </div>
          </section>
        </div>
      </SheetDialog>
    </>
  );
}
