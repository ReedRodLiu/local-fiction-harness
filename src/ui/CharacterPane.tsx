import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, ChevronRight, Download, Edit3, Plus, Sparkles, Square } from 'lucide-react';
import {
  buildTurnProposalRecords,
  characterContext,
  conversationExport,
  conversationLocalVersion,
  detectNaturalModeSwitchIntent,
  documentLineage,
  documentVersion,
  findLeafForTurnTreeNode,
  formatCharacterConversationTitle,
  getActiveBranchNodes,
  getNodeSiblingBranchInfo,
  newConversation,
  normalizeProposalTarget,
  summarizeCharacterConversation,
  writeDocument,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type LocalCharacter,
  type PlatformRuntime,
  type StageAssetMode,
  type TurnProposalRecord,
} from '../harness/index.ts';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { MarkdownView } from './MarkdownView.tsx';
import { MessageContent } from './MessageContent.tsx';
import { TurnCard, type ResolvedProposalTargetState } from './TurnCard.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
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
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import {
  makeTurn,
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
  workspace: CreativeWorkspaceState;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  onSwitchStageMode?: (targetMode: StageAssetMode) => void;
  onNavigateCreatedAsset?: (kind: 'character' | 'work', id: string) => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
}

function formatConversationTimestamp(conversation: CharacterConversation): string {
  const timestamps = Object.values(conversation.nodes).map((n) => n.createdAt);
  if (timestamps.length === 0) return '新对话';
  const latest = Math.max(...timestamps);
  return new Date(latest).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function CharacterPane(props: CharacterPaneProps) {
  const {
    character,
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
  const [input, setInput] = useState('');
  const [confirm, setConfirm] = useState<'export' | 'delete' | null>(null);
  const [companionTab, setCompanionTab] = useState<CharacterCompanionTab>('conversations');
  const [reasoningDurations, setReasoningDurations] = useState<Record<string, number>>({});
  const [createdAssetNotice, setCreatedAssetNotice] = useState<{
    kind: 'character' | 'work';
    id: string;
    label: string;
  } | null>(null);

  const conversation = character.conversations.find((item) => item.id === character.activeConversationId);
  const path = useMemo(() => (conversation ? getActiveBranchNodes(conversation) : []), [conversation]);

  useWebHistoryLayer('creative-companion', 40, companionOpen, () => setCompanionOpen(false));
  useWebHistoryLayer('character-confirm', 50, Boolean(confirm), () => setConfirm(null));

  const autoScroll = useAutoScrollTimeline({
    contextKey: `${character.id}:${conversation?.id ?? 'none'}`,
    activeLeafKey: conversation?.activeLeafNodeId ?? null,
    turnCount: path.length,
    isStreaming: reply.busy,
    streamPulse: `${reply.output.length}:${reply.reasoning.length}`,
    paused: companionOpen || Boolean(confirm),
  });

  const activeLeafNode = path.at(-1);
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

  function editCharacter(proposalBody?: string, expected?: string) {
    openDocument({
      title: '角色设定',
      mode: 'character',
      description: '以单一 Markdown 管理角色人设与说话风格，新对话会自动继承。',
      base: documentVersion(character.document, expected ?? character.document.head),
      history: documentLineage(character.document),
      proposal: proposalBody,
      reload: async () => {
        const found = (await read()).characters.find((item) => item.id === character.id);
        if (!found) throw new Error('角色已不存在。');
        return { base: documentVersion(found.document), history: documentLineage(found.document) };
      },
      apply: async (version, markdown) => {
        await save((state) =>
          updateCharacter(state, character.id, (current) => {
            if (current.document.head !== version) throw new Error('角色设定已更新，请重新载入后再试。');
            return { ...current, document: writeDocument(current.document, version, markdown) };
          }),
        );
      },
    });
  }

  function editBranchNote(target: CharacterConversation, proposalBody?: string) {
    const base = conversationLocalVersion(target);
    openDocument({
      title: '分支笔记',
      mode: 'character',
      base: documentVersion(target.document, base),
      description: '当前这段对话路径的局部进展与备忘。',
      history: documentLineage(target.document, base),
      proposal: proposalBody,
      apply: async (expected, markdown) => {
        await save((state) =>
          updateCharacter(state, character.id, (current) =>
            updateConversation(current, target.id, (live) => {
              if (live.activeLeafNodeId !== target.activeLeafNodeId || conversationLocalVersion(live) !== expected) {
                throw new Error('当前对话已更新，请重新打开后再试。');
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

  const runSilentSummary = (
    targetCharacterId: string,
    targetConv: CharacterConversation,
    config: Parameters<typeof summarizeCharacterConversation>[2],
    targetLeafId: string | null,
  ) => {
    void summarizeCharacterConversation(targetConv, runtime.transport, config, { targetLeafId })
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
        if (!res.updated || !targetLeafId) return;
        await save((state) =>
          updateCharacter(state, targetCharacterId, (current) =>
            updateConversation(current, targetConv.id, (live) => {
              const updatedLeaf = res.conversation.nodes[targetLeafId];
              if (!updatedLeaf || !live.nodes[targetLeafId]) return live;
              return {
                ...live,
                nodes: {
                  ...live.nodes,
                  [targetLeafId]: {
                    ...live.nodes[targetLeafId],
                    summarySnapshot: updatedLeaf.summarySnapshot,
                  },
                },
              };
            }),
          ),
        );
      })
      .catch(() => undefined);
  };

  function send(
    conversationId: string,
    contents: string,
    options: { parentId?: string | null; label?: string } = {},
  ) {
    const trimmed = contents.trim();
    if (trimmed) {
      const switchTarget = detectNaturalModeSwitchIntent(trimmed);
      if (switchTarget && switchTarget !== 'character' && props.onSwitchStageMode) {
        setInput('');
        props.onSwitchStageMode(switchTarget);
        return;
      }
    }

    const startedAt = performance.now();
    reply.start(options.label ?? (trimmed ? '继续角色互动' : '生成角色开场'), async (request, signal, config) => {
      const state = await read();
      const current = state.characters.find((item) => item.id === character.id);
      const target = current?.conversations.find((item) => item.id === conversationId);
      if (!current || !target || signal.aborted) return;

      const targetConv: CharacterConversation =
        options.parentId !== undefined ? { ...target, activeLeafNodeId: options.parentId } : target;
      const ctx = characterContext(state.publicDocument, current, targetConv, trimmed);
      const result = await request(ctx.messages);
      if (signal.aborted) return;

      const publicDoc = documentVersion(state.publicDocument);
      const charDoc = documentVersion(current.document, targetConv.characterVersion);
      const localDoc = documentVersion(targetConv.document, ctx.localVersion);
      const proposalRecords = buildTurnProposalRecords(
        { proposals: result.proposals, unparsedBlocks: result.unparsedBlocks },
        { setting: charDoc.id, memory: publicDoc.id, note: localDoc.id },
      );

      let assistantId = '';
      let savedConv: CharacterConversation | undefined;
      const updated = await save((workspaceState) =>
        updateCharacter(workspaceState, current.id, (latest) =>
          updateConversation(latest, target.id, (live) => {
            const expectedParent =
              options.parentId === undefined ? target.activeLeafNodeId : options.parentId;
            if (options.parentId === undefined && live.activeLeafNodeId !== expectedParent) {
              throw new Error('对话位置已变化，请从当前记录重新发送。');
            }
            const docs = { container: target.characterVersion, local: ctx.localVersion };
            const user = trimmed ? { ...makeTurn('user', trimmed, expectedParent), documents: docs } : null;
            const assistant = {
              ...makeTurn(
                'assistant',
                result.content.trim() || '请核对下方的设定更新建议。',
                user?.id ?? expectedParent,
              ),
              ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
              documents: docs,
              documentReads: ctx.reads,
              ...(proposalRecords.length > 0 ? { proposals: proposalRecords } : {}),
            };
            assistantId = assistant.id;
            const edits = { ...live.edits };
            delete edits[expectedParent ?? ''];
            const nextConv: CharacterConversation = {
              ...live,
              edits,
              nodes: { ...live.nodes, ...(user ? { [user.id]: user } : {}), [assistant.id]: assistant },
              activeLeafNodeId: assistant.id,
            };
            savedConv = nextConv;
            return nextConv;
          }),
        ),
      );
      if (signal.aborted) return;
      if (options.parentId === undefined) setInput('');
      if (assistantId) {
        setReasoningDurations((prev) => ({
          ...prev,
          [assistantId]: Math.max(1, Math.round((performance.now() - startedAt) / 1000)),
        }));
      }
      if (proposalRecords.length > 0) {
        recordProposalCreationBreadcrumbs(runtime.diagnostics, proposalRecords);
      }
      const persistedConv =
        savedConv ??
        updated.characters
          .find((item) => item.id === current.id)
          ?.conversations.find((item) => item.id === target.id);
      if (persistedConv && assistantId) {
        runSilentSummary(current.id, persistedConv, config, assistantId);
      }
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

  async function startConversation(openWithModel = true) {
    let id = '';
    await save((state) =>
      updateCharacter(state, character.id, (live) => {
        const next = newConversation(live, 'personal', '');
        id = next.id;
        return { ...live, conversations: [...live.conversations, next], activeConversationId: id };
      }),
    );
    if (openWithModel) send(id, '');
    return id;
  }

  const navigate = (conversationId: string, nodeId?: string) => {
    void save((state) =>
      updateCharacter(state, character.id, (live) => {
        const active = { ...live, activeConversationId: conversationId };
        return nodeId === undefined
          ? active
          : updateConversation(active, conversationId, (target) => ({ ...target, activeLeafNodeId: nodeId }));
      }),
    ).catch(reply.fail);
  };

  const switchBranch = (targetNodeId: string) => {
    if (!conversation) return;
    const leafId = findLeafForTurnTreeNode(conversation.nodes, targetNodeId);
    if (!leafId) return;
    navigate(conversation.id, leafId);
  };

  const regenerateNode = (assistantNodeId: string) => {
    if (!conversation) return;
    const node = conversation.nodes[assistantNodeId];
    if (!node || node.role !== 'assistant') return;
    if (!node.parentId) {
      send(conversation.id, '', { parentId: null, label: '重新生成开场' });
      return;
    }
    const userNode = conversation.nodes[node.parentId];
    if (!userNode || userNode.role !== 'user') return;

    const startedAt = performance.now();
    reply.start('重新生成回复', async (request, signal, config) => {
      const state = await read();
      const current = state.characters.find((item) => item.id === character.id);
      const target = current?.conversations.find((item) => item.id === conversation.id);
      if (!current || !target || signal.aborted) return;

      const convAtUserParent: CharacterConversation = {
        ...target,
        activeLeafNodeId: userNode.parentId,
      };
      const ctx = characterContext(state.publicDocument, current, convAtUserParent, userNode.content);
      const result = await request(ctx.messages);
      if (signal.aborted) return;

      const publicDoc = documentVersion(state.publicDocument);
      const charDoc = documentVersion(current.document, target.characterVersion);
      const localDoc = documentVersion(target.document, ctx.localVersion);
      const proposalRecords = buildTurnProposalRecords(
        { proposals: result.proposals, unparsedBlocks: result.unparsedBlocks },
        { setting: charDoc.id, memory: publicDoc.id, note: localDoc.id },
      );

      let assistantId = '';
      let savedConv: CharacterConversation | undefined;
      await save((workspaceState) =>
        updateCharacter(workspaceState, current.id, (latest) =>
          updateConversation(latest, target.id, (live) => {
            const docs = { container: target.characterVersion, local: ctx.localVersion };
            const assistant = {
              ...makeTurn(
                'assistant',
                result.content.trim() || '请核对下方的设定更新建议。',
                userNode.id,
              ),
              ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
              documents: docs,
              documentReads: ctx.reads,
              ...(proposalRecords.length > 0 ? { proposals: proposalRecords } : {}),
            };
            assistantId = assistant.id;
            const nextConv: CharacterConversation = {
              ...live,
              nodes: { ...live.nodes, [assistant.id]: assistant },
              activeLeafNodeId: assistant.id,
            };
            savedConv = nextConv;
            return nextConv;
          }),
        ),
      );
      if (assistantId) {
        setReasoningDurations((prev) => ({
          ...prev,
          [assistantId]: Math.max(1, Math.round((performance.now() - startedAt) / 1000)),
        }));
      }
      if (savedConv && assistantId) runSilentSummary(current.id, savedConv, config, assistantId);
    });
  };

  const editAndBranch = (targetUserNodeId: string, newContent: string) => {
    if (!conversation) return;
    const userNode = conversation.nodes[targetUserNodeId];
    if (!userNode || userNode.role !== 'user') return;
    send(conversation.id, newContent, {
      parentId: userNode.parentId,
      label: '编辑并生成新分支',
    });
  };

  const resolveProposalTarget = (proposal: TurnProposalRecord): ResolvedProposalTargetState => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      const mem = documentVersion(workspace.publicDocument);
      return { currentMarkdown: mem.markdown, currentVersionId: mem.id, targetLabel: '我的记忆' };
    }
    if (normalized === 'note' && conversation) {
      const localId = conversationLocalVersion(conversation);
      const note = documentVersion(conversation.document, localId);
      return { currentMarkdown: note.markdown, currentVersionId: note.id, targetLabel: '分支笔记' };
    }
    if (normalized === 'character' || normalized === 'draft') {
      return { currentMarkdown: '', targetLabel: normalized === 'character' ? '新建角色' : '新开写故事' };
    }
    const charDoc = documentVersion(character.document);
    return { currentMarkdown: charDoc.markdown, currentVersionId: charDoc.id, targetLabel: '角色设定' };
  };

  const handleApplyProposal = async (
    nodeId: string,
    proposal: TurnProposalRecord,
    resolvedMarkdown: string,
  ) => {
    if (!conversation) return;
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    let createdAsset: { kind: 'character' | 'work'; id: string; label: string } | null = null;

    await save((state) => {
      if (normalized === 'memory') {
        const prevId = state.publicDocument.head;
        const nextPublicDoc = writeDocument(state.publicDocument, prevId, resolvedMarkdown, 'user');
        return updateCharacter(
          { ...state, publicDocument: nextPublicDoc },
          character.id,
          (live) =>
            updateConversation(live, conversation.id, (conv) => ({
              ...conv,
              nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
                ...p,
                status: 'applied',
                previousVersionId: prevId,
                appliedVersionId: nextPublicDoc.head,
              })),
            })),
        );
      }

      if (normalized === 'character' || normalized === 'draft') {
        const derived = createDerivedAssetInWorkspace(state, proposal, resolvedMarkdown);
        createdAsset = { kind: derived.createdKind, id: derived.createdId, label: derived.label };
        return updateCharacter(derived.nextState, character.id, (live) =>
          updateConversation(live, conversation.id, (conv) => ({
            ...conv,
            nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'applied',
            })),
          })),
        );
      }

      if (normalized === 'note') {
        return updateCharacter(state, character.id, (live) =>
          updateConversation(live, conversation.id, (conv) => {
            const baseId = conversationLocalVersion(conv);
            const revised = writeDocument(conv.document, baseId, resolvedMarkdown, 'user');
            return {
              ...conv,
              document: { ...revised, head: conv.document.head },
              edits: { ...conv.edits, [conv.activeLeafNodeId ?? '']: revised.head },
              nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
                ...p,
                status: 'applied',
                previousVersionId: baseId,
                appliedVersionId: revised.head,
              })),
            };
          }),
        );
      }

      return updateCharacter(state, character.id, (live) => {
        const prevId = live.document.head;
        const nextDoc = writeDocument(live.document, prevId, resolvedMarkdown, 'user');
        return updateConversation(
          { ...live, document: nextDoc },
          conversation.id,
          (conv) => ({
            ...conv,
            characterVersion: nextDoc.head,
            nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'applied',
              previousVersionId: prevId,
              appliedVersionId: nextDoc.head,
            })),
          }),
        );
      });
    });

    recordProposalDiagnostic(runtime.diagnostics, 'proposal_applied', proposal);
    if (createdAsset) setCreatedAssetNotice(createdAsset);
  };

  const handleDismissProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    if (!conversation) return;
    await save((state) =>
      updateCharacter(state, character.id, (live) =>
        updateConversation(live, conversation.id, (conv) => ({
          ...conv,
          nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'dismissed',
          })),
        })),
      ),
    );
    recordProposalDiagnostic(runtime.diagnostics, 'proposal_dismissed', proposal);
  };

  const handleRevertProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    if (!conversation) return;
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    await save((state) => {
      if (normalized === 'memory') {
        const { nextDocument } = revertDocumentToVersion(state.publicDocument, proposal);
        return updateCharacter(
          { ...state, publicDocument: nextDocument },
          character.id,
          (live) =>
            updateConversation(live, conversation.id, (conv) => ({
              ...conv,
              nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
                ...p,
                status: 'reverted',
              })),
            })),
        );
      }

      if (normalized === 'note') {
        return updateCharacter(state, character.id, (live) =>
          updateConversation(live, conversation.id, (conv) => {
            const baseId = conversationLocalVersion(conv);
            const prevId = proposal.previousVersionId;
            if (!prevId || !Object.hasOwn(conv.document.versions, prevId)) {
              throw new Error('找不到可用于撤销的历史版本。');
            }
            const prevMd = documentVersion(conv.document, prevId).markdown;
            const revised = writeDocument(conv.document, baseId, prevMd, 'user');
            return {
              ...conv,
              document: { ...revised, head: conv.document.head },
              edits: { ...conv.edits, [conv.activeLeafNodeId ?? '']: revised.head },
              nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
                ...p,
                status: 'reverted',
              })),
            };
          }),
        );
      }

      return updateCharacter(state, character.id, (live) => {
        const { nextDocument } = revertDocumentToVersion(live.document, proposal);
        return updateConversation(
          { ...live, document: nextDocument },
          conversation.id,
          (conv) => ({
            ...conv,
            characterVersion: nextDocument.head,
            nodes: updateTurnNodeProposal(conv.nodes, nodeId, proposal.id, (p) => ({
              ...p,
              status: 'reverted',
            })),
          }),
        );
      });
    });
    recordProposalDiagnostic(runtime.diagnostics, 'proposal_reverted', proposal);
  };

  const handleOpenProposalEditor = (proposal: TurnProposalRecord) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      openPublic(proposal.status === 'needs_review' ? proposal.body : undefined);
      return;
    }
    if (normalized === 'note' && conversation) {
      editBranchNote(conversation, proposal.status === 'needs_review' ? proposal.body : undefined);
      return;
    }
    editCharacter(proposal.status === 'needs_review' ? proposal.body : undefined);
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
  const localNoteMarkdown = conversation
    ? documentVersion(conversation.document, conversationLocalVersion(conversation)).markdown
    : '';

  return (
    <>
      <section
        ref={autoScroll.stageRef}
        className="timeline creative-timeline"
        data-testid="character-timeline"
        aria-label="角色对话记录"
        {...autoScroll.containerHandlers}
      >
        {(!conversation || (!path.length && !reply.busy)) && (
          <div className="creative-empty-state">
            <p>可以直接发消息，或让 {character.name} 先开口；语气和身份变化会在对话中自然承接。</p>
            <button
              type="button"
              className="writing-enter-pill"
              disabled={reply.busy}
              onClick={() => {
                if (conversation) send(conversation.id, '');
                else void startConversation(true).catch(reply.fail);
              }}
            >
              让角色先开口
            </button>
          </div>
        )}

        {conversation &&
          path.map((node, index) => {
            const parentNode =
              node.role === 'assistant' && node.parentId
                ? conversation.nodes[node.parentId]
                : undefined;
            const editableUserNode = parentNode?.role === 'user' ? parentNode : undefined;
            return (
              <TurnCard
                key={node.id}
                node={node}
                mode="character"
                userLabel="你"
                assistantLabel={character.name}
                isActiveLeaf={node.id === conversation.activeLeafNodeId}
                isLatestTurn={latestTurnNodeIds.has(node.id)}
                isSetupNode={false}
                turnNumber={Math.max(1, Math.ceil((index + 1) / 2))}
                reasoningDurationSeconds={reasoningDurations[node.id]}
                editableUserNode={editableUserNode}
                isBusy={reply.busy}
                isStreaming={false}
                siblings={getNodeSiblingBranchInfo(conversation.nodes, node.id)}
                onSwitchBranch={switchBranch}
                onEditAndBranch={editAndBranch}
                onRegenerate={regenerateNode}
                onRewindToNode={(nodeId) => navigate(conversation.id, nodeId)}
                resolveProposalTargetState={resolveProposalTarget}
                onApplyProposal={handleApplyProposal}
                onDismissProposal={handleDismissProposal}
                onRevertProposal={handleRevertProposal}
                onOpenProposalEditor={handleOpenProposalEditor}
                onAskAiReorganizeProposal={(p) =>
                  send(
                    conversation.id,
                    `我刚刚更新了设定，请结合最新设定重新整理这条建议：${p.summary}`,
                  )
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
              <MessageContent content={reply.output} mode="character" />
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
          else void startConversation(false).then((id) => send(id, contents)).catch(reply.fail);
        }}
      >
        <div className="composer-notices">
          {reply.error && <BannerAlert tone="danger">{reply.error}</BannerAlert>}
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
          {autoScroll.showScrollToBottom && (
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
        <label className="visually-hidden" htmlFor="character-chat-input">
          发消息
        </label>
        <textarea
          id="character-chat-input"
          aria-label="发消息"
          rows={1}
          value={input}
          placeholder={`给 ${character.name} 发消息…`}
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
        label="历史对话与设定"
        panelName="历史对话与设定"
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
              data-testid="character-tab-conversations"
              onClick={() => setCompanionTab('conversations')}
              onKeyDown={selectAdjacentTab}
            >
              历史对话
            </button>
            <button
              id="character-tab-profile"
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={companionTab === 'profile'}
              aria-controls="character-panel-profile"
              tabIndex={companionTab === 'profile' ? 0 : -1}
              data-testid="character-tab-profile"
              onClick={() => setCompanionTab('profile')}
              onKeyDown={selectAdjacentTab}
            >
              设定
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
              <button
                type="button"
                className="btn btn-primary"
                data-testid="character-new-conversation-btn"
                disabled={reply.busy}
                onClick={() => {
                  void startConversation(false)
                    .then(() => closeCompanion())
                    .catch(reply.fail);
                }}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                新开一段对话
              </button>

              {character.conversations.length > 0 && (
                <InsetGroup title="历史对话">
                  <div className="companion-document-list">
                    {character.conversations.map((item) => (
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
                        <span className="companion-conv-copy">
                          <span className="companion-conv-title">
                            {formatCharacterConversationTitle(character, item)}
                          </span>
                          <span className="companion-conv-time">
                            {formatConversationTimestamp(item)}
                          </span>
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
                        <span>{leaf.content.replace(/\s+/g, ' ').trim().slice(0, 40) || '分支对话'}</span>
                        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </InsetGroup>
              )}

              {conversation && (
                <InsetGroup title="当前对话">
                  <div className="companion-document-list">
                    <button
                      type="button"
                      className="companion-document-row"
                      onClick={() => setConfirm('export')}
                    >
                      <span>导出对话 Markdown (.md)</span>
                      <Download size={18} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="companion-document-row danger-menu-item"
                      disabled={reply.busy}
                      onClick={() => setConfirm('delete')}
                    >
                      <span>删除此段对话</span>
                      <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </InsetGroup>
              )}
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
              <InsetGroup title="角色设定" testId="character-companion-documents">
                <div className="companion-setting-preview">
                  <MarkdownView
                    content={documentVersion(character.document).markdown.trim() || '尚未编写角色设定，可在聊天中告诉 TA 或直接编辑。'}
                    mode="character"
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  data-testid="edit-character-setting-btn"
                  disabled={reply.busy}
                  onClick={() => editCharacter()}
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
                  {conversation && (
                    <button
                      type="button"
                      className="companion-document-row"
                      data-testid="export-character-markdown-row"
                      onClick={() => setConfirm('export')}
                    >
                      <span>导出对话 Markdown (.md)</span>
                      <Download size={18} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </InsetGroup>

              {conversation && (
                <details className="branch-note-details" data-testid="branch-note-details">
                  <summary>分支笔记</summary>
                  <div className="branch-note-body">
                    <MarkdownView
                      content={localNoteMarkdown.trim() || '暂无分支笔记，当前对话的细节备忘会记录在这里。'}
                      mode="character"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={reply.busy}
                      onClick={() => editBranchNote(conversation)}
                    >
                      编辑分支笔记
                    </button>
                  </div>
                </details>
              )}
            </div>
          </section>
        </div>
      </SheetDialog>

      <ModalDialog
        open={Boolean(confirm)}
        label={confirm === 'delete' ? '删除这段对话' : '导出对话 Markdown'}
        onClose={() => setConfirm(null)}
      >
        {conversation && confirm && (
          <div className="local-document-dialog">
            <h2>{confirm === 'delete' ? '删除这段对话' : '导出对话 Markdown'}</h2>
            {confirm === 'delete' ? (
              <p>将永久删除这段对话及其全部分支。已导出的文件不受影响。</p>
            ) : (
              <div className="document-proposal-preview">
                <MarkdownView content={exportText} mode="character" />
              </div>
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
