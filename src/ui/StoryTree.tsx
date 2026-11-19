import { useId, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import {
  getActiveBranchNodes,
  getForkSiblingBranches,
  projectStoryTreeSpine,
  toCompactPreview,
  type ForkSiblingBranch,
  type NodeDiagnosticStatus,
  type Story,
  type StoryTreeSpanItem,
} from '../harness/index.ts';

export interface StoryTreeProps {
  story: Story;
  isBusy?: boolean;
  isRenameBusy?: boolean;
  onSwitchBranch?: (targetNodeId: string) => void;
  onRenameBranch?: (branchEntryNodeId: string, name: string) => Promise<void> | void;
  onExtractBranchGist?: (branchEntryNodeId: string) => Promise<void> | void;
  defaultExpanded?: boolean;
  collapsible?: boolean;
}

const DIAGNOSTIC_LABELS: Record<NodeDiagnosticStatus, string> = {
  CONTENT_FILTER: '内容过滤中断 (CONTENT_FILTER)',
  TIMEOUT: '响应超时 (TIMEOUT)',
  INCOMPLETE: '输出未完成 (INCOMPLETE)',
};

interface ExpandedSpanNode {
  id: string;
  turn: number;
}

export function formatDiagnosticTags(
  statuses: readonly NodeDiagnosticStatus[],
  hasContentRisk: boolean,
): string[] {
  const tags = statuses.map((s) => DIAGNOSTIC_LABELS[s] ?? s);
  if (hasContentRisk) {
    tags.push('平台风控标记 (CONTENT_RISK)');
  }
  return tags;
}

export function StoryTree({
  story,
  isBusy = false,
  isRenameBusy,
  onSwitchBranch,
  onRenameBranch,
  onExtractBranchGist,
  defaultExpanded = true,
  collapsible = true,
}: StoryTreeProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(defaultExpanded);
  const [expandedForkIds, setExpandedForkIds] = useState<Record<string, boolean>>({});
  const [expandedSpanNodes, setExpandedSpanNodes] = useState<Record<string, ExpandedSpanNode[]>>({});
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [extractingGistId, setExtractingGistId] = useState<string | null>(null);
  const renameBusy = isRenameBusy ?? isBusy;
  const treeOpen = !collapsible || isPanelOpen;
  const spanIdPrefix = useId();

  const spine = useMemo(() => projectStoryTreeSpine(story), [story]);

  const toggleFork = (forkId: string) => {
    setExpandedForkIds((prev) => ({ ...prev, [forkId]: !prev[forkId] }));
  };

  const toggleSpan = (item: StoryTreeSpanItem) => {
    if (expandedSpanNodes[item.id]) {
      setExpandedSpanNodes((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    const activePath = getActiveBranchNodes(story, spine.activeLeafNodeId);
    const startIndex = activePath.findIndex((node) => node.id === item.startNodeId);
    const endIndex = activePath.findIndex((node) => node.id === item.endNodeId);
    if (startIndex < 0 || endIndex < startIndex) return;

    const nodes = activePath.slice(startIndex, endIndex + 1).map((node, offset) => ({
      id: node.id,
      turn: Math.floor((startIndex + offset) / 2) + 1,
    }));
    setExpandedSpanNodes((prev) => ({ ...prev, [item.id]: nodes }));
  };

  const startRename = (branch: ForkSiblingBranch) => {
    setRenamingEntryId(branch.entryNodeId);
    setRenameDraft(branch.customName ?? branch.label);
  };

  const commitRename = async (branchEntryNodeId: string) => {
    if (!onRenameBranch || renameBusy) return;
    await onRenameBranch(branchEntryNodeId, renameDraft);
    setRenamingEntryId(null);
    setRenameDraft('');
  };

  const triggerGist = async (branchEntryNodeId: string) => {
    if (!onExtractBranchGist || isBusy || extractingGistId) return;
    setExtractingGistId(branchEntryNodeId);
    try {
      await onExtractBranchGist(branchEntryNodeId);
    } finally {
      setExtractingGistId(null);
    }
  };

  return (
    <section className="story-tree-panel" data-testid="story-tree-panel" aria-label="剧情树">
      <div className="panel-header">
        <div className="story-tree-heading">
          <h4>剧情树（Story Tree）</h4>
          <span className="status-text">
            主干 {spine.totalActiveTurns} 轮 · {spine.forkCount} 处分叉
          </span>
        </div>
        {collapsible && (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="story-tree-action"
            aria-expanded={isPanelOpen}
            onClick={() => setIsPanelOpen((prev) => !prev)}
          >
            {isPanelOpen ? '收起剧情树' : '展开剧情树'}
          </button>
        )}
      </div>

      {treeOpen && (
        <div className="story-tree-body">
          {spine.items.length === 0 ? (
            <p className="status-text" style={{ margin: 0 }}>
              尚无对话节点，发送第一轮行动即可生成主干剧情树。
            </p>
          ) : (
            <ol className="story-tree-spine">
              {spine.items.map((item, index) => {
                if (item.kind === 'span') {
                  const turnLabel =
                    item.startTurn === item.endTurn
                      ? `第 ${item.startTurn} 轮`
                      : `第 ${item.startTurn}–${item.endTurn} 轮`;
                  const expandedNodes = expandedSpanNodes[item.id];
                  const isExpanded = expandedNodes !== undefined;
                  const previewId = `${spanIdPrefix}-span-${index}`;
                  return (
                    <li
                      key={item.id}
                      className={`story-tree-span ${item.isActiveEnd ? 'active-end' : ''}`}
                      data-testid="story-tree-span"
                    >
                      <button
                        type="button"
                        className="story-tree-span-toggle"
                        aria-label={`${isExpanded ? '收起' : '展开'}${turnLabel}连续区间`}
                        aria-expanded={isExpanded}
                        aria-controls={isExpanded ? previewId : undefined}
                        data-testid="story-tree-span-toggle"
                        onClick={() => toggleSpan(item)}
                      >
                        <span className="badge" data-testid="story-tree-span-label">{turnLabel}</span>
                        <span className="status-text">
                          {isExpanded ? '收起连续区间' : '展开连续区间'}
                        </span>
                        <span className="status-text">
                          {item.isActiveEnd ? '当前激活终点' : `折叠 ${item.turnCount} 轮`}
                        </span>
                        {item.diagnosticsCount > 0 && (
                          <span className="badge badge-warn">
                            含 {item.diagnosticsCount} 条诊断标记
                          </span>
                        )}
                        <span className="story-tree-preview-inline">{item.preview}</span>
                      </button>
                      {expandedNodes && (
                        <ol
                          id={previewId}
                          className="story-tree-span-nodes"
                          aria-label={`${turnLabel}连续节点只读预览`}
                          data-testid="story-tree-span-preview"
                        >
                          {expandedNodes.map(({ id, turn }) => {
                            const node = story.nodes[id];
                            if (!node) return null;
                            const diagnostics = formatDiagnosticTags(
                              node.diagnostics?.sourceStatus ? [node.diagnostics.sourceStatus] : [],
                              Boolean(node.diagnostics?.contentRisk),
                            );
                            return (
                              <li
                                key={id}
                                className="story-tree-span-node"
                                data-node-id={id}
                                data-testid="story-tree-span-node"
                              >
                                <span className="story-tree-span-node-heading">
                                  第 {turn} 轮 · {node.role === 'user' ? '玩家' : '叙事 AI'}
                                </span>
                                <p className="story-tree-span-node-preview">
                                  {toCompactPreview(node.content, 180)}
                                </p>
                                {diagnostics.length > 0 && (
                                  <span className="story-tree-span-node-diagnostics" role="note">
                                    只读诊断：{diagnostics.join(' · ')}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </li>
                  );
                }

                const isForkOpen = Boolean(expandedForkIds[item.id]);
                const siblings = isForkOpen
                  ? getForkSiblingBranches(story, item.parentNodeId)
                  : [];

                return (
                  <li key={item.id} className="story-tree-fork-wrap">
                    <button
                      type="button"
                      className="btn btn-sm story-tree-fork-btn"
                      data-testid={`story-tree-fork-${item.parentNodeId ?? 'root'}`}
                      aria-expanded={isForkOpen}
                      onClick={() => toggleFork(item.id)}
                    >
                      <span className="fork-badge">
                        <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
                        <span>{item.branchCount} 条岔路</span>
                      </span>
                      <span>
                        {item.afterTurn === 0 ? '开局分叉' : `第 ${item.afterTurn} 轮分叉`} · 当前：
                        {item.activeBranchLabel}
                      </span>
                      <span className="status-text">{isForkOpen ? '收起旁支' : '展开旁支'}</span>
                    </button>

                    {isForkOpen && (
                      <ul
                        className="story-tree-siblings"
                        aria-label="分支列表"
                        data-testid="story-tree-branches"
                      >
                        {siblings.map((branch) => {
                          const diagTags = formatDiagnosticTags(
                            branch.diagnostics,
                            branch.hasContentRisk,
                          );
                          const isRenaming = renamingEntryId === branch.entryNodeId;
                          return (
                            <li
                              key={branch.entryNodeId}
                              className={`story-tree-sibling ${branch.isActive ? 'active' : ''}`}
                              data-testid={`story-tree-branch-${branch.entryNodeId}`}
                              data-active={branch.isActive ? 'true' : 'false'}
                            >
                              <div className="story-tree-row-top">
                                <strong>{branch.label}</strong>
                                {branch.isActive && <span className="badge badge-structure">当前路线</span>}
                                <span className="status-text">
                                  支线 {branch.branchTurnCount} 轮（总 {branch.totalTurnDepth} 轮）
                                </span>
                              </div>

                              {branch.cues.length > 0 && (
                                <div className="story-tree-cues">
                                  {branch.cues.map((cue) => (
                                    <span key={cue} className="cue-chip">
                                      {cue}
                                    </span>
                                  ))}
                                </div>
                              )}

                              <div className="story-tree-preview">{branch.preview}</div>

                              {branch.aiGist && (
                                <div className="story-tree-gist">AI 梗概：{branch.aiGist}</div>
                              )}

                              {diagTags.length > 0 && (
                                <div className="story-tree-diagnostics" role="note">
                                  只读诊断（不发往模型）：{diagTags.join(' · ')}
                                </div>
                              )}

                              {isRenaming ? (
                                <div className="rename-row" style={{ marginTop: '0.35rem' }}>
                                  <input
                                    type="text"
                                    aria-label="分支名称"
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === 'Enter' &&
                                        !e.nativeEvent.isComposing &&
                                        e.nativeEvent.keyCode !== 229
                                      ) {
                                        e.preventDefault();
                                        void commitRename(branch.entryNodeId);
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    data-testid="story-tree-action"
                                    disabled={renameBusy}
                                    onClick={() => void commitRename(branch.entryNodeId)}
                                  >
                                    保存名称
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    data-testid="story-tree-action"
                                    onClick={() => setRenamingEntryId(null)}
                                  >
                                    取消
                                  </button>
                                </div>
                              ) : (
                                <div className="btn-group" style={{ marginTop: '0.35rem' }}>
                                  {!branch.isActive && onSwitchBranch && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-primary"
                                      data-testid="story-tree-action"
                                      disabled={isBusy}
                                      onClick={() => onSwitchBranch(branch.entryNodeId)}
                                    >
                                      切换至此分支
                                    </button>
                                  )}
                                  {onRenameBranch && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      data-testid="story-tree-action"
                                      disabled={renameBusy}
                                      onClick={() => startRename(branch)}
                                    >
                                      重命名
                                    </button>
                                  )}
                                  {onExtractBranchGist && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      data-testid="story-tree-action"
                                      disabled={isBusy || extractingGistId === branch.entryNodeId}
                                      onClick={() => void triggerGist(branch.entryNodeId)}
                                    >
                                      {extractingGistId === branch.entryNodeId
                                        ? '提炼中…'
                                        : 'AI 提炼梗概'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
