import { useState } from 'react';
import type { SiblingBranchInfo, TurnNode } from '../harness/index.ts';
import { MessageContent } from './MessageContent.tsx';

interface TurnCardProps {
  node: TurnNode;
  isActiveLeaf: boolean;
  isStreaming: boolean;
  siblings: SiblingBranchInfo;
  onSelectChoice: (choiceText: string) => void;
  onSwitchBranch: (targetNodeId: string) => void;
  onEditAndBranch: (targetUserNodeId: string, newContent: string) => void;
  onRegenerate: (targetAssistantNodeId: string) => void;
  onRewindToNode: (targetNodeId: string) => void;
}

export function TurnCard({
  node,
  isActiveLeaf,
  isStreaming,
  siblings,
  onSelectChoice,
  onSwitchBranch,
  onEditAndBranch,
  onRegenerate,
  onRewindToNode,
}: TurnCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(node.content);

  const hasSiblings = siblings.total > 1;
  const prevSibling = siblings.currentIndex > 0 ? siblings.siblings[siblings.currentIndex - 1] : null;
  const nextSibling =
    siblings.currentIndex >= 0 && siblings.currentIndex < siblings.total - 1
      ? siblings.siblings[siblings.currentIndex + 1]
      : null;

  return (
    <article className={`turn-card ${node.role}`} data-node-id={node.id}>
      <div className="turn-header">
        <div className="turn-role">{node.role === 'user' ? '玩家' : '叙事 AI'}</div>
        <div className="btn-group">
          {hasSiblings && (
            <span className="branch-pager" aria-label="分支切换">
              <button
                type="button"
                className="btn btn-sm"
                disabled={isStreaming || !prevSibling}
                aria-label="上一分支"
                onClick={() => prevSibling && onSwitchBranch(prevSibling.id)}
              >
                &lt;
              </button>
              <span className="status-text">
                {siblings.currentIndex + 1} / {siblings.total}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={isStreaming || !nextSibling}
                aria-label="下一分支"
                onClick={() => nextSibling && onSwitchBranch(nextSibling.id)}
              >
                &gt;
              </button>
            </span>
          )}

          {node.role === 'user' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={isStreaming}
              onClick={() => {
                setEditDraft(node.content);
                setIsEditing((prev) => !prev);
              }}
            >
              {isEditing ? '取消编辑' : '撤回并编辑重发'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={isStreaming}
                onClick={() => onRegenerate(node.id)}
              >
                重新生成分支
              </button>
              {!isActiveLeaf && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={isStreaming}
                  onClick={() => onRewindToNode(node.id)}
                >
                  回溯至此
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {node.reasoningContent && (
        <details className="reasoning-details">
          <summary>思考过程（不回传后续上下文）</summary>
          <div className="reasoning-content">{node.reasoningContent}</div>
        </details>
      )}

      {isEditing ? (
        <div className="config-form" style={{ marginTop: '0.5rem' }}>
          <label htmlFor={`edit-node-${node.id}`}>编辑此行动并创建新分支</label>
          <textarea
            id={`edit-node-${node.id}`}
            rows={3}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!editDraft.trim() || isStreaming}
              onClick={() => {
                setIsEditing(false);
                onEditAndBranch(node.id, editDraft);
              }}
            >
              提交并生成新分支
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setIsEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : node.role === 'assistant' ? (
        <MessageContent
          content={node.content}
          showChoices={isActiveLeaf}
          disabled={isStreaming}
          onSelectChoice={onSelectChoice}
        />
      ) : (
        <div className="turn-body">{node.content}</div>
      )}
    </article>
  );
}
