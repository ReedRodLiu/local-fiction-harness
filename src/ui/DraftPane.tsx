import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, ChevronRight, Download, Edit3, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import {
  adoptSuggestion,
  appendWorkDiscussionTurn,
  buildTurnProposalRecords,
  createDefaultId,
  detectNaturalModeSwitchIntent,
  documentLineage,
  documentVersion,
  findLeafForTurnTreeNode,
  formatTurnPreview,
  getActiveBranchNodes,
  getManuscriptIntentSystemPrompt,
  getNodeSiblingBranchInfo,
  getTurnTreeSummarySnapshot,
  getWorkActiveDiscussionNodes,
  getWorkDiscussionTree,
  normalizeProposalTarget,
  normalizeReasoningEffort,
  parseManuscriptAssistantReply,
  parseProposalReply,
  referenceDocument,
  resolveEffectiveModelConfig,
  summarizeWorkDiscussion,
  visibleManuscriptReplyPrefix,
  visibleReplyPrefix,
  workContext,
  writeDocument,
  type CreativeWorkspaceState,
  type DraftWork,
  type PlatformRuntime,
  type StageAssetMode,
  type TurnNode,
  type TurnProposalRecord,
  type WritingSuggestion,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { MarkdownView } from './MarkdownView.tsx';
import { MessageContent } from './MessageContent.tsx';
import { ProposalCard } from './ProposalCard.tsx';
import { TurnCard, type ResolvedProposalTargetState } from './TurnCard.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import {
  createDerivedAssetInWorkspace,
  recordProposalCreationBreadcrumbs,
  recordProposalDiagnostic,
  revertDocumentToVersion,
  updateTurnNodeProposal,
} from './proposalActions.ts';
import { useAutoScrollTimeline } from './useAutoScrollTimeline.ts';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';
import { useManuscriptAutosave } from './useManuscriptAutosave.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import {
  makeTurn,
  sendOnEnter,
  syncTextareaHeight,
  updateWork,
  useCreativeReply,
  type RequestModel,
} from './useCreativeReply.ts';

type WritingCompanionTab = 'discussion' | 'documents';

interface DraftPaneProps {
  work: DraftWork;
  workspace: CreativeWorkspaceState;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  manuscript?: boolean;
  onStartManuscript?: () => void;
  onSwitchToChat?: () => void;
  onSwitchStageMode?: (targetMode: StageAssetMode) => void;
  onNavigateCreatedAsset?: (kind: 'character' | 'work', id: string) => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
}

export function DraftPane(props: DraftPaneProps) {
  const {
    work,
    workspace,
    save,
    read,
    runtime,
    openDocument,
    openPublic,
    companionOpen,
    setCompanionOpen,
  } = props;
  const reply = useCreativeReply(runtime, props.requestModel);
  const editing = props.manuscript ?? Boolean(work.writingStarted || work.body || work.source);

  const [discussionInput, setDiscussionInput] = useState('');
  const [manuscriptInput, setManuscriptInput] = useState('');
  const [exported, setExported] = useState(false);
  const [companionTab, setCompanionTab] = useState<WritingCompanionTab>('discussion');
  const [dismissedSuggestionId, setDismissedSuggestionId] = useState<string | null>(null);
  const [focusedSuggestionId, setFocusedSuggestionId] = useState<string | null>(null);
  const [hasCardSelection, setHasCardSelection] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState<{
    suggestion: WritingSuggestion;
    target: WritingSuggestion;
  } | null>(null);
  const [pendingPushTurnId, setPendingPushTurnId] = useState<string | null>(null);
  const [manuscriptChatAnswer, setManuscriptChatAnswer] = useState<string | null>(null);
  const [manuscriptProposalRef, setManuscriptProposalRef] = useState<{
    nodeId: string;
    proposalId: string;
  } | null>(null);
  const [createdAssetNotice, setCreatedAssetNotice] = useState<{
    kind: 'character' | 'work';
    id: string;
    label: string;
  } | null>(null);
  const [reasoningDurations, setReasoningDurations] = useState<Record<string, number>>({});

  const textarea = useRef<HTMLTextAreaElement>(null);
  const suggestionCardRef = useRef<HTMLElement>(null);
  const selection = useRef({ start: 0, end: 0 });

  useWebHistoryLayer('creative-companion', 40, companionOpen, () => setCompanionOpen(false));

  const discussionTree = useMemo(() => getWorkDiscussionTree(work), [work]);
  const discussionNodes = useMemo(() => getWorkActiveDiscussionNodes(work), [work]);
  const discussionSummary = useMemo(
    () => getTurnTreeSummarySnapshot(discussionTree.nodes, discussionTree.activeLeafNodeId),
    [discussionTree],
  );
  const activeLeafId = discussionTree.activeLeafNodeId;
  const activeLeafNode = activeLeafId ? discussionTree.nodes[activeLeafId] : undefined;
  const latestTurnNodeIds = useMemo(
    () =>
      new Set(
        [
          activeLeafNode?.id,
          activeLeafNode?.role === 'assistant' ? activeLeafNode.parentId : null,
        ].filter((id): id is string => Boolean(id)),
      ),
    [activeLeafNode],
  );

  const branchLeaves = useMemo(() => {
    const parentIds = new Set<string>();
    for (const n of Object.values(discussionTree.nodes)) {
      if (n.parentId) parentIds.add(n.parentId);
    }
    return Object.values(discussionTree.nodes)
      .filter((n) => !parentIds.has(n.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [discussionTree]);

  const autosave = useManuscriptAutosave({
    workId: work.id,
    persistedText: work.body,
    onDiagnosticEvent: (action) => {
      try {
        runtime.diagnostics?.recordEvent({ level: 'info', category: 'ui', action });
      } catch {
        // Ignore diagnostics failures.
      }
    },
    onSave: async (nextText) => {
      await save((state) =>
        updateWork(state, work.id, (live) => {
          if (live.body === nextText) return live;
          return {
            ...live,
            body: nextText,
            bodyRevision: live.bodyRevision + 1,
            writingStarted: live.writingStarted || Boolean(nextText.trim()),
          };
        }),
      );
    },
  });

  const autoScroll = useAutoScrollTimeline({
    contextKey: `${work.id}:${editing ? 'manuscript' : 'chat'}`,
    activeLeafKey: activeLeafId,
    turnCount: discussionNodes.length,
    isStreaming: reply.busy && !editing,
    streamPulse: `${reply.output.length}:${reply.reasoning.length}`,
    paused: editing || companionOpen,
  });

  const latestSuggestion = [...work.suggestions].reverse().find((item) => Boolean(item.text));
  const activeSuggestion =
    (focusedSuggestionId
      ? work.suggestions.find((item) => item.id === focusedSuggestionId && Boolean(item.text))
      : undefined) ??
    (latestSuggestion && latestSuggestion.id !== dismissedSuggestionId ? latestSuggestion : undefined);

  const manuscriptProposalNode = manuscriptProposalRef
    ? discussionTree.nodes[manuscriptProposalRef.nodeId]
    : undefined;
  const activeManuscriptProposal = manuscriptProposalNode?.proposals?.find(
    (p) => p.id === manuscriptProposalRef?.proposalId,
  );

  function editSetting(proposalBody?: string) {
    const base = documentVersion(work.document);
    openDocument({
      title: '作品设定',
      mode: 'writing',
      base,
      proposal: proposalBody,
      description: '以单一 Markdown 管理当前作品的设定、大纲与角色备忘。',
      history: documentLineage(work.document),
      reload: async () => {
        const found = (await read()).works.find((item) => item.id === work.id);
        if (!found) throw new Error('作品已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) =>
          updateWork(state, work.id, (live) => {
            if (live.document.head !== version) throw new Error('作品设定已更新，请重新载入后再试。');
            return { ...live, document: writeDocument(live.document, version, markdown) };
          }),
        );
      },
    });
  }

  async function currentWork() {
    await autosave.flush();
    const state = await read();
    const live = state.works.find((item) => item.id === work.id);
    if (!live) throw new Error('作品已不存在。');
    return { state, live };
  }

  const runSilentSummary = (targetWork: DraftWork, config: Parameters<typeof summarizeWorkDiscussion>[2], targetLeafId: string | null) => {
    void summarizeWorkDiscussion(targetWork, runtime.transport, config, { targetLeafId })
      .then(async (res) => {
        try {
          runtime.diagnostics?.recordEvent({
            level: res.status === 'failed' ? 'warn' : 'info',
            category: 'llm',
            action:
              res.status === 'done'
                ? 'summary_background_done'
                : res.status === 'failed'
                  ? 'summary_background_failed'
                  : 'summary_background_skipped',
          });
        } catch {
          // Ignore diagnostics error.
        }
        if (!res.updated) return;
        await save((state) =>
          updateWork(state, targetWork.id, (live) => {
            const liveTree = getWorkDiscussionTree(live);
            const updatedLeaf = targetLeafId ? res.work.discussionNodes?.[targetLeafId] : undefined;
            if (!targetLeafId || !updatedLeaf || !liveTree.nodes[targetLeafId]) return live;
            const nextNodes = {
              ...liveTree.nodes,
              [targetLeafId]: {
                ...liveTree.nodes[targetLeafId],
                summarySnapshot: updatedLeaf.summarySnapshot,
              },
            };
            const activeLeaf = liveTree.activeLeafNodeId;
            return {
              ...live,
              discussionNodes: nextNodes,
              activeDiscussionLeafId: activeLeaf,
              discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: activeLeaf }, activeLeaf),
            };
          }),
        );
      })
      .catch(() => undefined);
  };

  function submitChatTurn(
    value: string,
    options: { parentId?: string | null; label?: string } = {},
  ) {
    const input = value.trim();
    if (!input || reply.busy) return;

    const switchTarget = detectNaturalModeSwitchIntent(input);
    if (switchTarget && switchTarget !== 'writing' && props.onSwitchStageMode) {
      setDiscussionInput('');
      props.onSwitchStageMode(switchTarget);
      return;
    }

    const startedAt = performance.now();
    reply.start(options.label ?? '继续写故事聊天', async (request, signal, config) => {
      const { state, live } = await currentWork();
      if (signal.aborted) return;

      const tree = getWorkDiscussionTree(live);
      const targetParentId = options.parentId === undefined ? tree.activeLeafNodeId : options.parentId;
      const pendingLast =
        options.parentId === undefined &&
        targetParentId &&
        tree.nodes[targetParentId]?.role === 'user' &&
        tree.nodes[targetParentId]?.content === input
          ? tree.nodes[targetParentId]
          : undefined;
      const contextParentId = pendingLast ? pendingLast.parentId : targetParentId;

      const ctx = workContext(state.publicDocument, live, input, {
        targetParentId: contextParentId,
      });
      const effectiveConfig = resolveEffectiveModelConfig(config, live.generationPreference);
      const result = await request(ctx.messages, { config: effectiveConfig });
      if (signal.aborted) return;

      const publicDoc = documentVersion(state.publicDocument);
      const workDoc = documentVersion(live.document);
      const proposalRecords = buildTurnProposalRecords(
        { proposals: result.proposals, unparsedBlocks: result.unparsedBlocks },
        { setting: workDoc.id, memory: publicDoc.id },
      );

      let assistantId = '';
      let updatedWork: DraftWork | null = null;
      await save((nowState) =>
        updateWork(nowState, live.id, (latest) => {
          let working = latest;
          let userId = pendingLast?.id ?? '';
          if (!pendingLast) {
            const appendedUser = appendWorkDiscussionTurn(working, {
              role: 'user',
              content: input,
              parentId: targetParentId,
            });
            working = appendedUser.work;
            userId = appendedUser.node.id;
          }
          const appendedAssistant = appendWorkDiscussionTurn(working, {
            role: 'assistant',
            content: result.content.trim() || '请核对下方的设定更新建议。',
            ...(result.turnSummary ? { turnSummary: result.turnSummary } : {}),
            reasoningContent: result.reasoningContent || undefined,
            model: result.model,
            reasoningEffort: result.reasoningEffort,
            parentId: userId,
            documentReads: ctx.reads,
            proposals: proposalRecords.length > 0 ? proposalRecords : undefined,
          });
          assistantId = appendedAssistant.node.id;
          updatedWork = appendedAssistant.work;
          return appendedAssistant.work;
        }),
      );
      if (signal.aborted) return;
      if (assistantId) {
        setReasoningDurations((prev) => ({
          ...prev,
          [assistantId]: Math.max(1, Math.round((performance.now() - startedAt) / 1000)),
        }));
      }
      if (proposalRecords.length > 0) {
        recordProposalCreationBreadcrumbs(runtime.diagnostics, proposalRecords);
      }
      if (options.parentId === undefined) setDiscussionInput('');
      if (updatedWork && assistantId) {
        runSilentSummary(updatedWork, effectiveConfig, assistantId);
      }
    });
  }

  function submitManuscriptPrompt(value: string) {
    const input = value.trim();
    if (!input || reply.busy) return;

    setDismissedSuggestionId(null);
    setFocusedSuggestionId(null);
    setSelectedSuggestion(null);
    setHasCardSelection(false);
    setManuscriptChatAnswer(null);
    setManuscriptProposalRef(null);

    const { start, end } = selection.current;
    reply.start('写作协作请求', async (request, signal, config, setStreamText, appendReasoning) => {
      const { state, live } = await currentWork();
      if (signal.aborted) return;

      const selectedText = live.body.slice(start, end);
      const before = live.body.slice(Math.max(0, start - 6000), start);
      const after = live.body.slice(end, end + 6000);
      const composedInput = [
        input,
        before && `【光标或选区前】\n${before}`,
        selectedText && `【作者所选正文】\n${selectedText}`,
        after && `【光标或选区后】\n${after}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const ctx = workContext(state.publicDocument, live, composedInput, {
        systemPrompt: getManuscriptIntentSystemPrompt(),
        cursorPos: start,
      });
      const effectiveConfig = resolveEffectiveModelConfig(config, live.generationPreference);
      const reasoningEffort = normalizeReasoningEffort(effectiveConfig.reasoningEffort);

      let raw = '';
      let reasoningContent = '';
      let finishReason: string | null | undefined;
      let shown = '';
      for await (const delta of runtime.transport.streamChat({
        baseUrl: effectiveConfig.baseUrl,
        apiKey: effectiveConfig.apiKey,
        model: effectiveConfig.model,
        reasoningEffort,
        messages: ctx.messages,
        signal,
      })) {
        if (signal.aborted) return;
        if (delta.finishReason != null) finishReason = delta.finishReason;
        if (delta.reasoningDelta && reasoningEffort !== 'none') {
          reasoningContent += delta.reasoningDelta;
          appendReasoning(delta.reasoningDelta);
        }
        if (!delta.contentDelta) continue;
        raw += delta.contentDelta;
        const visible = visibleReplyPrefix(visibleManuscriptReplyPrefix(raw));
        if (visible.length > shown.length) {
          shown = visible;
          setStreamText(visible);
        }
      }
      if (signal.aborted) return;
      if (finishReason !== 'stop') {
        throw new Error('回复未完成，请重试。');
      }

      const routed = parseManuscriptAssistantReply(raw, input, reasoningContent);
      const publicDoc = documentVersion(state.publicDocument);
      const workDoc = documentVersion(live.document);

      if (routed.kind === 'suggestion') {
        const newId = createDefaultId();
        await save((nowState) =>
          updateWork(nowState, live.id, (latest) => ({
            ...latest,
            suggestions: [
              ...latest.suggestions,
              {
                id: newId,
                instruction: input,
                text: routed.text,
                revision: latest.bodyRevision,
                start,
                end,
                documentReads: ctx.reads,
              },
            ],
          })),
        );
        if (!signal.aborted) {
          setManuscriptInput('');
          setFocusedSuggestionId(newId);
        }
        return;
      }

      if (routed.kind === 'proposal') {
        const proposalRecords = buildTurnProposalRecords(
          { proposals: routed.proposals, unparsedBlocks: routed.unparsedBlocks },
          { setting: workDoc.id, memory: publicDoc.id },
        );
        let assistantId = '';
        await save((nowState) =>
          updateWork(nowState, live.id, (latest) => {
            const u = appendWorkDiscussionTurn(latest, { role: 'user', content: input });
            const a = appendWorkDiscussionTurn(u.work, {
              role: 'assistant',
              content: routed.content,
              ...(routed.turnSummary ? { turnSummary: routed.turnSummary } : {}),
              reasoningContent: reasoningContent || undefined,
              model: effectiveConfig.model,
              reasoningEffort,
              parentId: u.node.id,
              documentReads: ctx.reads,
              proposals: proposalRecords,
            });
            assistantId = a.node.id;
            return a.work;
          }),
        );
        if (!signal.aborted) {
          setManuscriptInput('');
          if (proposalRecords[0] && assistantId) {
            setManuscriptProposalRef({ nodeId: assistantId, proposalId: proposalRecords[0].id });
          }
          recordProposalCreationBreadcrumbs(runtime.diagnostics, proposalRecords);
        }
        return;
      }

      // kind === 'chat'
      let chatAssistantId = '';
      let updatedWork: DraftWork | null = null;
      await save((nowState) =>
        updateWork(nowState, live.id, (latest) => {
          const u = appendWorkDiscussionTurn(latest, { role: 'user', content: input });
          const a = appendWorkDiscussionTurn(u.work, {
            role: 'assistant',
            content: routed.content,
            ...(routed.turnSummary ? { turnSummary: routed.turnSummary } : {}),
            reasoningContent: reasoningContent || undefined,
            model: effectiveConfig.model,
            reasoningEffort,
            parentId: u.node.id,
            documentReads: ctx.reads,
          });
          chatAssistantId = a.node.id;
          updatedWork = a.work;
          return a.work;
        }),
      );
      if (!signal.aborted) {
        setManuscriptInput('');
        setManuscriptChatAnswer(routed.content);
        if (updatedWork && chatAssistantId) {
          runSilentSummary(updatedWork, effectiveConfig, chatAssistantId);
        }
      }
    });
  }

  const queuedOpening = useRef(false);
  useEffect(() => {
    if (queuedOpening.current || props.initialTurn?.id !== work.id) return;
    const prompt = props.initialTurn.prompt;
    const timer = window.setTimeout(() => {
      queuedOpening.current = true;
      props.onConsumeInitialTurn();
      submitChatTurn(prompt);
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
    const updatedWork = adoptSuggestion(live, target, chosen);
    autosave.adoptSuggestion(updatedWork.body, {
      label: '已采纳写作建议',
      selectionStart: target.start + chosen.length,
      selectionEnd: target.start + chosen.length,
    });
    await autosave.flush();
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

  async function pushChatPassageToManuscript(passage: string, mode: 'append' | 'replace') {
    const clean = passage.trim();
    if (!clean) return;
    const base = autosave.text;
    const nextBody =
      mode === 'replace'
        ? clean
        : base.trim()
          ? `${base.replace(/\n+$/, '')}\n\n${clean}`
          : clean;
    autosave.adoptSuggestion(nextBody, {
      label: mode === 'replace' ? '已用对话内容替换正文' : '已追加到正文末尾',
    });
    await autosave.flush();
    setPendingPushTurnId(null);
    setExported(false);
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

  const switchDiscussionBranch = (targetNodeId: string) => {
    const leafId = findLeafForTurnTreeNode(discussionTree.nodes, targetNodeId);
    if (!leafId) return;
    void save((state) =>
      updateWork(state, work.id, (live) => {
        const tree = getWorkDiscussionTree(live);
        return {
          ...live,
          discussionNodes: tree.nodes,
          activeDiscussionLeafId: leafId,
          discussion: getActiveBranchNodes({ nodes: tree.nodes, activeLeafNodeId: leafId }, leafId),
        };
      }),
    ).catch(reply.fail);
  };

  const rewindDiscussionNode = (targetNodeId: string) => {
    void save((state) =>
      updateWork(state, work.id, (live) => {
        const tree = getWorkDiscussionTree(live);
        if (!tree.nodes[targetNodeId]) return live;
        return {
          ...live,
          discussionNodes: tree.nodes,
          activeDiscussionLeafId: targetNodeId,
          discussion: getActiveBranchNodes({ nodes: tree.nodes, activeLeafNodeId: targetNodeId }, targetNodeId),
        };
      }),
    ).catch(reply.fail);
  };

  const regenerateDiscussionNode = (assistantNodeId: string) => {
    const node = discussionTree.nodes[assistantNodeId];
    if (!node || node.role !== 'assistant' || !node.parentId) return;
    const userNode = discussionTree.nodes[node.parentId];
    if (!userNode || userNode.role !== 'user') return;

    const startedAt = performance.now();
    reply.start('重新生成回复', async (request, signal, config) => {
      const { state, live } = await currentWork();
      if (signal.aborted) return;
      const ctx = workContext(state.publicDocument, live, userNode.content, {
        targetParentId: userNode.parentId,
      });
      const effectiveConfig = resolveEffectiveModelConfig(config, live.generationPreference);
      const result = await request(ctx.messages, { config: effectiveConfig });
      if (signal.aborted) return;
      const publicDoc = documentVersion(state.publicDocument);
      const workDoc = documentVersion(live.document);
      const proposalRecords = buildTurnProposalRecords(
        { proposals: result.proposals, unparsedBlocks: result.unparsedBlocks },
        { setting: workDoc.id, memory: publicDoc.id },
      );

      let assistantId = '';
      let updatedWork: DraftWork | null = null;
      await save((nowState) =>
        updateWork(nowState, live.id, (latest) => {
          const appended = appendWorkDiscussionTurn(latest, {
            role: 'assistant',
            content: result.content.trim() || '请核对下方的设定更新建议。',
            reasoningContent: result.reasoningContent || undefined,
            model: result.model,
            reasoningEffort: result.reasoningEffort,
            parentId: userNode.id,
            documentReads: ctx.reads,
            proposals: proposalRecords.length > 0 ? proposalRecords : undefined,
          });
          assistantId = appended.node.id;
          updatedWork = appended.work;
          return appended.work;
        }),
      );
      if (assistantId) {
        setReasoningDurations((prev) => ({
          ...prev,
          [assistantId]: Math.max(1, Math.round((performance.now() - startedAt) / 1000)),
        }));
      }
      if (updatedWork && assistantId) runSilentSummary(updatedWork, effectiveConfig, assistantId);
    });
  };

  const editAndBranchDiscussion = (targetUserNodeId: string, newContent: string) => {
    const targetUserNode = discussionTree.nodes[targetUserNodeId];
    if (!targetUserNode || targetUserNode.role !== 'user') return;
    submitChatTurn(newContent, {
      parentId: targetUserNode.parentId,
      label: '编辑并生成新分支',
    });
  };

  const resolveProposalTarget = (proposal: TurnProposalRecord): ResolvedProposalTargetState => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      const mem = documentVersion(workspace.publicDocument);
      return { currentMarkdown: mem.markdown, currentVersionId: mem.id, targetLabel: '我的记忆' };
    }
    if (normalized === 'character' || normalized === 'draft') {
      return { currentMarkdown: '', targetLabel: normalized === 'character' ? '新建角色' : '新开写故事' };
    }
    const settingVer = documentVersion(work.document);
    return { currentMarkdown: settingVer.markdown, currentVersionId: settingVer.id, targetLabel: '作品设定' };
  };

  const handleApplyProposal = async (
    nodeId: string,
    proposal: TurnProposalRecord,
    resolvedMarkdown: string,
  ) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    let createdAsset: { kind: 'character' | 'work'; id: string; label: string } | null = null;
    try {
      await save((state) => {
        if (normalized === 'memory') {
          const prevId = state.publicDocument.head;
          const nextPublicDoc = writeDocument(state.publicDocument, prevId, resolvedMarkdown, 'user');
          const nextWorks = state.works.map((item) => {
            if (item.id !== work.id) return item;
            const tree = getWorkDiscussionTree(item);
            const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'applied',
              previousVersionId: prevId,
              appliedVersionId: nextPublicDoc.head,
            }));
            return {
              ...item,
              discussionNodes: nextNodes,
              discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
            };
          });
          return { ...state, publicDocument: nextPublicDoc, works: nextWorks };
        }

        if (normalized === 'character' || normalized === 'draft') {
          const derived = createDerivedAssetInWorkspace(state, proposal, resolvedMarkdown);
          createdAsset = { kind: derived.createdKind, id: derived.createdId, label: derived.label };
          return updateWork(derived.nextState, work.id, (live) => {
            const tree = getWorkDiscussionTree(live);
            const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'applied',
            }));
            return {
              ...live,
              discussionNodes: nextNodes,
              discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
            };
          });
        }

        return updateWork(state, work.id, (live) => {
          const prevId = live.document.head;
          const nextDoc = writeDocument(live.document, prevId, resolvedMarkdown, 'user');
          const tree = getWorkDiscussionTree(live);
          const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'applied',
            previousVersionId: prevId,
            appliedVersionId: nextDoc.head,
          }));
          return {
            ...live,
            document: nextDoc,
            discussionNodes: nextNodes,
            discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
          };
        });
      });

      if (proposal.baseVersionId && proposal.baseVersionId !== resolveProposalTarget(proposal).currentVersionId) {
        recordProposalDiagnostic(runtime.diagnostics, 'patch_reapplied', proposal);
      }
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_applied', proposal);
      if (createdAsset) setCreatedAssetNotice(createdAsset);
    } catch (err) {
      reply.fail(err);
    }
  };

  const handleDismissProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    try {
      await save((state) =>
        updateWork(state, work.id, (live) => {
          const tree = getWorkDiscussionTree(live);
          const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'dismissed',
          }));
          return {
            ...live,
            discussionNodes: nextNodes,
            discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
          };
        }),
      );
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_dismissed', proposal);
    } catch (err) {
      reply.fail(err);
    }
  };

  const handleRevertProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    try {
      await save((state) => {
        if (normalized === 'memory') {
          const { nextDocument } = revertDocumentToVersion(state.publicDocument, proposal);
          const nextWorks = state.works.map((item) => {
            if (item.id !== work.id) return item;
            const tree = getWorkDiscussionTree(item);
            const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'reverted',
            }));
            return {
              ...item,
              discussionNodes: nextNodes,
              discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
            };
          });
          return { ...state, publicDocument: nextDocument, works: nextWorks };
        }

        return updateWork(state, work.id, (live) => {
          const { nextDocument } = revertDocumentToVersion(live.document, proposal);
          const tree = getWorkDiscussionTree(live);
          const nextNodes = updateTurnNodeProposal(tree.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'reverted',
          }));
          return {
            ...live,
            document: nextDocument,
            discussionNodes: nextNodes,
            discussion: getActiveBranchNodes({ nodes: nextNodes, activeLeafNodeId: tree.activeLeafNodeId }, tree.activeLeafNodeId),
          };
        });
      });
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_reverted', proposal);
    } catch (err) {
      reply.fail(err);
    }
  };

  const handleOpenProposalEditor = (proposal: TurnProposalRecord) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      openPublic(proposal.status === 'needs_review' ? proposal.body : undefined);
      return;
    }
    editSetting(proposal.status === 'needs_review' ? proposal.body : undefined);
  };

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
      {autosave.saveError && (
        <BannerAlert tone="warning">
          <span>{autosave.saveError}</span>
          <button type="button" className="btn btn-sm" onClick={() => void autosave.flush()}>
            重试保存
          </button>
        </BannerAlert>
      )}
      {autosave.undoBanner && (
        <div className="manuscript-undo-toast" data-testid="manuscript-undo-banner" role="status">
          <span>{autosave.undoBanner.message}</span>
          <div className="manuscript-undo-toast-actions">
            {autosave.canUndo && (
              <button
                type="button"
                className="text-action"
                data-testid="manuscript-undo-btn"
                onClick={() => {
                  autosave.undo();
                  void autosave.flush();
                }}
              >
                撤销
              </button>
            )}
            {!editing && props.onStartManuscript && (
              <button
                type="button"
                className="text-action"
                data-testid="jump-to-manuscript-btn"
                onClick={() => props.onStartManuscript?.()}
              >
                查看正文
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="关闭提示"
              onClick={autosave.dismissUndoBanner}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}
      {createdAssetNotice && (
        <div className="manuscript-undo-toast" role="status">
          <span>{createdAssetNotice.label}</span>
          {props.onNavigateCreatedAsset && (
            <button
              type="button"
              className="text-action"
              onClick={() => {
                const { kind, id } = createdAssetNotice;
                setCreatedAssetNotice(null);
                props.onNavigateCreatedAsset?.(kind, id);
              }}
            >
              去看看
            </button>
          )}
        </div>
      )}
      {!editing && autoScroll.showScrollToBottom && (
        <button
          type="button"
          className="scroll-to-bottom"
          data-testid="scroll-to-bottom"
          onClick={autoScroll.scrollToBottom}
        >
          回到底部 ↓
        </button>
      )}
    </div>
  );

  return (
    <>
      {!editing ? (
        <>
          <section
            ref={autoScroll.stageRef}
            className="timeline creative-timeline"
            data-testid="writing-discussion-timeline"
            aria-label="写故事聊天记录"
            {...autoScroll.containerHandlers}
          >
            {discussionNodes.length === 0 && !reply.busy && (
              <div className="creative-empty-state">
                <p>聊聊角色、情节或直接让 AI 写一段草稿，再安全写入正文；也可以随时切到右上「正文」自由起笔。</p>
              </div>
            )}

            {discussionNodes.map((node, index) => {
              const parentNode =
                node.role === 'assistant' && node.parentId
                  ? discussionTree.nodes[node.parentId]
                  : undefined;
              const editableUserNode = parentNode?.role === 'user' ? parentNode : undefined;
              const isConfirmingPush = pendingPushTurnId === node.id;

              return (
                <TurnCard
                  key={node.id}
                  node={node}
                  mode="writing"
                  userLabel="你"
                  assistantLabel="AI 助手"
                  isActiveLeaf={node.id === activeLeafId}
                  isLatestTurn={latestTurnNodeIds.has(node.id)}
                  isSetupNode={false}
                  turnNumber={Math.max(1, Math.ceil((index + 1) / 2))}
                  reasoningDurationSeconds={reasoningDurations[node.id]}
                  editableUserNode={editableUserNode}
                  isBusy={reply.busy}
                  isStreaming={false}
                  siblings={getNodeSiblingBranchInfo(discussionTree.nodes, node.id)}
                  onSwitchBranch={switchDiscussionBranch}
                  onEditAndBranch={editAndBranchDiscussion}
                  onRegenerate={regenerateDiscussionNode}
                  onRewindToNode={rewindDiscussionNode}
                  resolveProposalTargetState={resolveProposalTarget}
                  onApplyProposal={handleApplyProposal}
                  onDismissProposal={handleDismissProposal}
                  onRevertProposal={handleRevertProposal}
                  onOpenProposalEditor={handleOpenProposalEditor}
                  onAskAiReorganizeProposal={(p) =>
                    submitChatTurn(
                      `我刚刚修改了「作品设定」，请结合最新设定重新整理这条建议：${p.summary}`,
                    )
                  }
                  afterAssistantContent={
                    node.role === 'assistant' && node.content.trim() ? (
                      isConfirmingPush ? (
                        <div className="push-manuscript-card" data-testid="push-manuscript-confirm">
                          <span className="push-manuscript-label">将这段内容写入正文：</span>
                          <div className="push-manuscript-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              data-testid="push-manuscript-append"
                              disabled={reply.busy}
                              onClick={() => void pushChatPassageToManuscript(node.content, 'append')}
                            >
                              追加到正文末尾
                            </button>
                            {autosave.text.trim() && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                data-testid="push-manuscript-replace"
                                disabled={reply.busy}
                                onClick={() => void pushChatPassageToManuscript(node.content, 'replace')}
                              >
                                替换当前正文
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setPendingPushTurnId(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="push-manuscript-trigger-row">
                          <button
                            type="button"
                            className="writing-enter-pill push-manuscript-trigger"
                            data-testid="push-to-manuscript-btn"
                            disabled={reply.busy}
                            onClick={() => setPendingPushTurnId(node.id)}
                          >
                            写入正文
                          </button>
                        </div>
                      )
                    ) : undefined
                  }
                />
              );
            })}

            {reply.busy && (
              <article
                className="turn-card assistant turn-streaming"
                data-testid="turn-assistant"
                aria-live="polite"
              >
                {reply.reasoning && (
                  <details className="reasoning-details" data-testid="reasoning-details" open>
                    <summary data-testid="reasoning-toggle">
                      <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>思考中…</span>
                    </summary>
                    <div className="reasoning-content">{reply.reasoning}</div>
                  </details>
                )}
                {reply.output ? (
                  <MessageContent content={reply.output} mode="writing" />
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
              submitChatTurn(discussionInput);
            }}
          >
            {composerNotices}
            <label className="visually-hidden" htmlFor="writing-discussion-input">
              聊天内容
            </label>
            <textarea
              id="writing-discussion-input"
              aria-label="聊天内容"
              rows={1}
              value={discussionInput}
              placeholder="聊聊设定、构思情节，或让 AI 试写一段…"
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
              <span>
                {autosave.text.length} 字 ·{' '}
                {autosave.saving ? '保存中…' : autosave.dirty ? '待保存…' : '已本地保存'}
              </span>
              {autosave.canUndo && (
                <button
                  type="button"
                  className="text-action manuscript-status-undo"
                  data-testid="manuscript-toolbar-undo"
                  onClick={() => {
                    autosave.undo();
                    void autosave.flush();
                  }}
                >
                  <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                  撤销
                </button>
              )}
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
              placeholder="从这里写下正文…选中片段或放置光标后，可在底部输入续写、改写、设定修改或plot提问。"
              value={autosave.text}
              onBlur={autosave.handleBlur}
              onChange={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
                setExported(false);
                autosave.updateText(event.currentTarget.value, {
                  selectionStart: event.currentTarget.selectionStart,
                  selectionEnd: event.currentTarget.selectionEnd,
                });
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
            {activeManuscriptProposal && manuscriptProposalNode && (
              <div className="manuscript-inline-proposal" data-testid="manuscript-inline-proposal">
                <ProposalCard
                  proposal={activeManuscriptProposal}
                  mode="writing"
                  defaultExpanded={true}
                  currentMarkdown={resolveProposalTarget(activeManuscriptProposal).currentMarkdown}
                  currentVersionId={resolveProposalTarget(activeManuscriptProposal).currentVersionId}
                  targetLabel={resolveProposalTarget(activeManuscriptProposal).targetLabel}
                  isBusy={reply.busy}
                  onApply={(p, resolved) => handleApplyProposal(manuscriptProposalNode.id, p, resolved)}
                  onDismiss={async (p) => {
                    await handleDismissProposal(manuscriptProposalNode.id, p);
                    setManuscriptProposalRef(null);
                  }}
                  onRevert={(p) => handleRevertProposal(manuscriptProposalNode.id, p)}
                  onOpenEditor={handleOpenProposalEditor}
                />
              </div>
            )}

            {manuscriptChatAnswer && (
              <section
                className="writing-suggestion-card"
                data-testid="manuscript-chat-answer"
                aria-label="聊天答复"
              >
                <div className="writing-suggestion-header">
                  <span className="writing-suggestion-title">剧情交流</span>
                  <button
                    type="button"
                    className="icon-button writing-suggestion-dismiss"
                    aria-label="关闭答复"
                    onClick={() => setManuscriptChatAnswer(null)}
                  >
                    <X size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
                <div className="writing-suggestion-body">
                  <MarkdownView content={manuscriptChatAnswer} mode="writing" />
                </div>
                {props.onSwitchToChat && (
                  <div className="writing-suggestion-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setManuscriptChatAnswer(null);
                        props.onSwitchToChat?.();
                      }}
                    >
                      去聊天继续
                    </button>
                  </div>
                )}
              </section>
            )}

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
                      ? '正在构思…'
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
                        ? `将替换原片段：「${autosave.text.slice(selectedSuggestion.target.start, selectedSuggestion.target.end)}」`
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
                submitManuscriptPrompt(manuscriptInput);
              }}
            >
              {composerNotices}
              <div className="writing-composer-main">
                <div className="writing-composer-row">
                  <label className="visually-hidden" htmlFor="writing-suggestion-input">
                    写作要求
                  </label>
                  <textarea
                    id="writing-suggestion-input"
                    aria-label="写作要求"
                    rows={1}
                    value={manuscriptInput}
                    placeholder="输入续写/改写要求、调整设定，或直接提问…"
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
                        aria-label="发送请求"
                        disabled={!manuscriptInput.trim()}
                      >
                        <ArrowUp size={19} strokeWidth={1.75} aria-hidden="true" />
                        <span className="visually-hidden">发送请求</span>
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
        label="灵感与设定"
        panelName="灵感与设定"
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
              data-testid="writing-tab-discussion"
              onClick={() => setCompanionTab('discussion')}
              onKeyDown={selectAdjacentTab}
            >
              灵感与版本
            </button>
            <button
              id="writing-tab-documents"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'documents'}
              aria-controls="writing-panel-documents"
              tabIndex={companionTab === 'documents' ? 0 : -1}
              data-testid="writing-tab-documents"
              onClick={() => setCompanionTab('documents')}
              onKeyDown={selectAdjacentTab}
            >
              设定
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
              <InsetGroup title="聊天分支">
                {branchLeaves.length > 0 ? (
                  <div className="companion-document-list">
                    {branchLeaves.map((leaf) => {
                      const isActive = leaf.id === activeLeafId;
                      return (
                        <button
                          key={leaf.id}
                          type="button"
                          className="companion-document-row"
                          aria-pressed={isActive}
                          onClick={() => {
                            switchDiscussionBranch(leaf.id);
                            setCompanionOpen(false);
                          }}
                        >
                          <span
                            className={`companion-branch-preview ${leaf.role === 'user' ? 'is-user' : 'is-assistant'}`}
                          >
                            {formatTurnPreview(leaf, { emptyFallback: '聊天分支' })}
                          </span>
                          <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="status-text" style={{ margin: 0 }}>
                    在聊天页讨论情节后，分支会自动保存在这里。
                  </p>
                )}
              </InsetGroup>

              <InsetGroup title="已保存的写作建议">
                {work.suggestions.length > 0 ? (
                  <div className="writing-companion-list">
                    {[...work.suggestions].reverse().map((item) => (
                      <article className="writing-companion-item" key={item.id}>
                        <div className="writing-companion-meta">
                          <span>{item.instruction}</span>
                        </div>
                        <p>{item.text}</p>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setFocusedSuggestionId(item.id);
                            setDismissedSuggestionId(null);
                            setSelectedSuggestion(null);
                            props.onStartManuscript?.();
                            setCompanionOpen(false);
                          }}
                        >
                          在正文中查看
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="status-text" style={{ margin: 0 }}>
                    暂无已保存的写作建议。
                  </p>
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
              <InsetGroup title="作品设定" testId="writing-companion-documents">
                <div className="companion-setting-preview">
                  <MarkdownView
                    content={documentVersion(work.document).markdown.trim() || '尚未编写作品设定，可以在聊天中让 AI 协助整理或直接编辑。'}
                    mode="writing"
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  data-testid="edit-writing-setting-btn"
                  disabled={reply.busy}
                  onClick={() => editSetting()}
                >
                  <Edit3 size={16} strokeWidth={1.75} aria-hidden="true" />
                  编辑设定
                </button>
              </InsetGroup>

              <InsetGroup title="通用资料与导出">
                <div className="companion-document-list">
                  <button
                    type="button"
                    className="companion-document-row"
                    onClick={() => openPublic()}
                  >
                    <span>我的记忆</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="companion-document-row"
                    data-testid="export-writing-markdown-row"
                    onClick={exportManuscript}
                  >
                    <span>导出正文 Markdown (.md)</span>
                    <Download size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
                {exported && <div className="status-text" role="status">已导出 Markdown。</div>}
              </InsetGroup>

              <details className="branch-note-details" data-testid="branch-note-details">
                <summary>分支笔记</summary>
                <div className="branch-note-body">
                  <MarkdownView
                    content={
                      discussionSummary.content.trim() ||
                      '暂无分支笔记，长对话的背景要点会自动整理在这里。'
                    }
                    mode="writing"
                  />
                </div>
              </details>
            </div>
          </section>
        </div>
      </SheetDialog>
    </>
  );
}
