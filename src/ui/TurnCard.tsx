import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, PencilLine, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import type {
  AssistantMode,
  SiblingBranchInfo,
  StoryAttachment,
  TurnNode,
  TurnProposalRecord,
} from '../harness/index.ts';
import { MessageContent } from './MessageContent.tsx';
import { ProposalCard } from './ProposalCard.tsx';
import { formatDiagnosticTags } from './StoryTree.tsx';

export interface ResolvedProposalTargetState {
  currentMarkdown: string;
  currentVersionId?: string;
  targetLabel?: string;
}

interface TurnCardProps {
  node: TurnNode;
  mode?: AssistantMode;
  userLabel?: string;
  assistantLabel?: string;
  isActiveLeaf: boolean;
  isLatestTurn: boolean;
  isSetupNode: boolean;
  turnNumber: number;
  reasoningDurationSeconds?: number;
  editableUserNode?: TurnNode;
  isBusy: boolean;
  isStreaming: boolean;
  siblings: SiblingBranchInfo;
  onSelectChoice?: (choiceText: string) => void;
  onSwitchBranch: (targetNodeId: string) => void;
  onEditAndBranch?: (targetUserNodeId: string, newContent: string) => void;
  onRegenerate?: (targetAssistantNodeId: string) => void;
  attachments?: StoryAttachment[];
  onExportAttachment?: (attachment: StoryAttachment) => void;
  onRewindToNode: (targetNodeId: string) => void;
  resolveProposalTargetState?: (proposal: TurnProposalRecord) => ResolvedProposalTargetState;
  onApplyProposal?: (nodeId: string, proposal: TurnProposalRecord, resolvedMarkdown: string) => void | Promise<void>;
  onDismissProposal?: (nodeId: string, proposal: TurnProposalRecord) => void | Promise<void>;
  onRevertProposal?: (nodeId: string, proposal: TurnProposalRecord) => void | Promise<void>;
  onOpenProposalEditor?: (proposal: TurnProposalRecord) => void;
  onAskAiReorganizeProposal?: (proposal: TurnProposalRecord) => void;
  afterAssistantContent?: ReactNode;
}

export function TurnCard({
  node,
  mode = 'story',
  userLabel = '玩家行动',
  assistantLabel = 'AI 叙事',
  isActiveLeaf,
  isLatestTurn,
  isSetupNode,
  turnNumber,
  reasoningDurationSeconds,
  editableUserNode,
  isBusy,
  isStreaming,
  siblings,
  onSelectChoice,
  onSwitchBranch,
  onEditAndBranch,
  onRegenerate,
  onRewindToNode,
  attachments,
  onExportAttachment,
  resolveProposalTargetState,
  onApplyProposal,
  onDismissProposal,
  onRevertProposal,
  onOpenProposalEditor,
  onAskAiReorganizeProposal,
  afterAssistantContent,
}: TurnCardProps) {
  const [historyActionsOpen, setHistoryActionsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(editableUserNode?.content ?? '');
  const [copyStatus, setCopyStatus] = useState('');

  const hasNodeActions = node.role === 'assistant' || siblings.total > 1;
  const { prevSiblingId, nextSiblingId } = siblings;
  const diagnosticTags = formatDiagnosticTags(
    node.diagnostics?.sourceStatus ? [node.diagnostics.sourceStatus] : [],
    Boolean(node.diagnostics?.contentRisk),
  );
  const roleTestId = node.role === 'user' ? 'turn-user' : 'turn-assistant';

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(node.content);
      setCopyStatus('已复制');
    } catch {
      setCopyStatus('复制失败');
    }
  };

  const turnActions = (node.role === 'assistant' || siblings.total > 1) ? (
    <div className="turn-actions" data-testid="turn-actions" aria-label="节点操作">
      {siblings.total > 1 && (
        <span className="branch-pager" data-testid="branch-pager" aria-label="分支切换">
          <button
            type="button"
            className="btn turn-action-button"
            disabled={isBusy || !prevSiblingId}
            aria-label="上一分支"
            onClick={() => prevSiblingId && onSwitchBranch(prevSiblingId)}
          >
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="status-text">{siblings.currentIndex + 1} / {siblings.total}</span>
          <button
            type="button"
            className="btn turn-action-button"
            disabled={isBusy || !nextSiblingId}
            aria-label="下一分支"
            onClick={() => nextSiblingId && onSwitchBranch(nextSiblingId)}
          >
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
      )}

      {node.role === 'assistant' && (
        <>
          <button
            type="button"
            className="btn turn-action-button"
            disabled={isBusy}
            aria-label="复制正文"
            title="复制正文"
            onClick={() => void handleCopy()}
          >
            <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {onRegenerate && (
            <button
              type="button"
              className="btn turn-action-button"
              disabled={isBusy}
              aria-label="重新生成分支"
              title="重新生成分支"
              onClick={() => onRegenerate(node.id)}
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {!isActiveLeaf && (
            <button
              type="button"
              className="btn turn-action-button"
              disabled={isBusy}
              aria-label="回溯至此"
              title="回溯至此"
              onClick={() => onRewindToNode(node.id)}
            >
              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {editableUserNode && onEditAndBranch && (
            <button
              type="button"
              className="btn turn-action-button"
              disabled={isBusy}
              aria-label="编辑并生成新分支"
              title="编辑并生成新分支"
              onClick={() => {
                setEditDraft(editableUserNode.content);
                setIsEditing(true);
              }}
            >
              <PencilLine size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </>
      )}

      {!isLatestTurn && (
        <button
          type="button"
          className="turn-history-close"
          onClick={() => setHistoryActionsOpen(false)}
        >
          收起操作
        </button>
      )}
    </div>
  ) : null;

  const historySubject = isSetupNode
    ? '故事设定'
    : node.role === 'user' ? userLabel : assistantLabel;
  const historyLabel = `第 ${turnNumber} 轮 · ${historySubject}${
    siblings.total > 1 ? ` · 分支 ${siblings.currentIndex + 1}/${siblings.total}` : ''
  }`;
  const historyActionToggle = !isLatestTurn && hasNodeActions && !historyActionsOpen ? (
    <button
      type="button"
      className="turn-history-toggle"
      data-testid="turn-history-toggle"
      aria-expanded={false}
      onClick={() => setHistoryActionsOpen(true)}
    >
      <span>{historyLabel}</span>
      <span>轻点展开分支与回溯操作</span>
    </button>
  ) : null;
  const contentActions = isLatestTurn || historyActionsOpen ? turnActions : historyActionToggle;

  return (
    <article
      className={`turn-card ${node.role}${!isLatestTurn ? ' is-history' : ''}`}
      data-testid={roleTestId}
      data-node-id={node.id}
      aria-label={node.role === 'user' ? userLabel : `${assistantLabel}回复`}
    >
      <div className="turn-expanded-content">
        {diagnosticTags.length > 0 && (
          <div className="turn-diagnostics" data-testid="turn-diagnostics" role="note">
            来源提示：{diagnosticTags.join(' · ')}
          </div>
        )}

        {node.reasoningContent && (
          <details className="reasoning-details" data-testid="reasoning-details" open={isStreaming}>
            <summary data-testid="reasoning-toggle">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {reasoningDurationSeconds
                  ? `已思考 ${reasoningDurationSeconds} 秒`
                  : '已思考'}
              </span>
              <ChevronUp className="reasoning-chevron-up" size={14} strokeWidth={1.75} aria-hidden="true" />
              <ChevronDown className="reasoning-chevron-down" size={14} strokeWidth={1.75} aria-hidden="true" />
            </summary>
            <div className="reasoning-content" data-testid="reasoning-content">{node.reasoningContent}</div>
          </details>
        )}

        {isEditing && editableUserNode && onEditAndBranch ? (
          <div className="turn-edit-form">
            <label htmlFor={`edit-node-${editableUserNode.id}`}>编辑此内容并创建新分支</label>
            <textarea
              id={`edit-node-${editableUserNode.id}`}
              rows={3}
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
            />
            <div className="turn-actions" data-testid="turn-actions">
              <button
                type="button"
                className="btn turn-action-button"
                disabled={!editDraft.trim() || isBusy}
                onClick={() => {
                  setIsEditing(false);
                  onEditAndBranch(editableUserNode.id, editDraft);
                }}
              >
                提交并生成新分支
              </button>
              <button
                type="button"
                className="btn turn-action-button"
                onClick={() => setIsEditing(false)}
              >
                取消编辑
              </button>
            </div>
          </div>
        ) : (
          <>
            {node.role === 'user' ? (
              isSetupNode ? (
                <details className="setup-node" data-testid="setup-node">
                  <summary>已提交设定 · 点按查看原文</summary>
                  <div className="turn-user-row">
                    <div className="turn-user-bubble" data-testid="user-bubble">{node.content}</div>
                  </div>
                </details>
              ) : (
                <div className="turn-user-row">
                  <div className="turn-user-bubble" data-testid="user-bubble">{node.content}</div>
                </div>
              )
            ) : (
              <MessageContent
                content={node.content}
                mode={mode}
                showChoices={isActiveLeaf}
                disabled={isBusy}
                onSelectChoice={onSelectChoice}
                afterContent={(
                  <>
                    {node.proposals && node.proposals.length > 0 && (
                      <div className="turn-proposals-stack" data-testid="turn-proposals">
                        {node.proposals.map((proposal) => {
                          const targetState = resolveProposalTargetState?.(proposal);
                          return (
                            <ProposalCard
                              key={proposal.id}
                              proposal={proposal}
                              mode={mode}
                              currentMarkdown={targetState?.currentMarkdown}
                              currentVersionId={targetState?.currentVersionId}
                              targetLabel={targetState?.targetLabel}
                              isBusy={isBusy}
                              onApply={
                                onApplyProposal
                                  ? (p, resolved) => onApplyProposal(node.id, p, resolved)
                                  : undefined
                              }
                              onDismiss={
                                onDismissProposal
                                  ? (p) => onDismissProposal(node.id, p)
                                  : undefined
                              }
                              onRevert={
                                onRevertProposal
                                  ? (p) => onRevertProposal(node.id, p)
                                  : undefined
                              }
                              onOpenEditor={onOpenProposalEditor}
                              onAskAiReorganize={onAskAiReorganizeProposal}
                            />
                          );
                        })}
                      </div>
                    )}
                    {afterAssistantContent}
                    {contentActions}
                  </>
                )}
              />
            )}

            {attachments && attachments.length > 0 && onExportAttachment && (
              <details className="reasoning-details">
                <summary>原始附件</summary>
                <div className="btn-group turn-attachment-list">
                  {attachments.map((file, index) => (
                    <button type="button" className="btn" key={index} onClick={() => onExportAttachment(file)}>{file.fileName}</button>
                  ))}
                </div>
              </details>
            )}
            {node.role === 'user' && siblings.total > 1 && contentActions}
            {copyStatus && <span className="turn-copy-status" role="status">{copyStatus}</span>}
          </>
        )}
      </div>
    </article>
  );
}
