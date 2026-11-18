import { useMemo, useState } from 'react';
import {
  getForkSiblingBranches,
  projectStoryTreeSpine,
  type ForkSiblingBranch,
  type NodeDiagnosticStatus,
  type Story,
} from '../harness/index.ts';

export interface StoryTreeProps {
  story: Story;
  mode?: 'play' | 'preview';
  isBusy?: boolean;
  onSwitchBranch?: (targetNodeId: string) => void;
  onRenameBranch?: (branchEntryNodeId: string, name: string) => Promise<void> | void;
  onExtractBranchGist?: (branchEntryNodeId: string) => Promise<void> | void;
  defaultExpanded?: boolean;
}

const DIAGNOSTIC_LABELS: Record<NodeDiagnosticStatus, string> = {
  CONTENT_FILTER: '内容过滤中断 (CONTENT_FILTER)',
  TIMEOUT: '响应超时 (TIMEOUT)',
  INCOMPLETE: '输出未完成 (INCOMPLETE)',
};

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
  mode = 'play',
  isBusy = false,
  onSwitchBranch,
  onRenameBranch,
  onExtractBranchGist,
  defaultExpanded = true,
}: StoryTreeProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(defaultExpanded);
  const [expandedForkIds, setExpandedForkIds] = useState<Record<string, boolean>>({});
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [extractingGistId, setExtractingGistId] = useState<string | null>(null);

  const spine = useMemo(() => projectStoryTreeSpine(story), [story]);

  const toggleFork = (forkId: string) => {
    setExpandedForkIds((prev) => ({ ...prev, [forkId]: !prev[forkId] }));
  };

  const startRename = (branch: ForkSiblingBranch) => {
    setRenamingEntryId(branch.entryNodeId);
    setRenameDraft(branch.customName ?? branch.label);
  };

  const commitRename = async (branchEntryNodeId: string) => {
    if (!onRenameBranch || isBusy) return;
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
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={isPanelOpen}
          onClick={() => setIsPanelOpen((prev) => !prev)}
        >
          {isPanelOpen ? '收起剧情树' : '展开剧情树'}
        </button>
      </div>

      {isPanelOpen && (
        <div className="story-tree-body">
          {spine.items.length === 0 ? (
            <p className="status-text" style={{ margin: 0 }}>
              尚无对话节点，发送第一轮行动即可生成主干剧情树。
            </p>
          ) : (
            <ol className="story-tree-spine">
              {spine.items.map((item) => {
                if (item.kind === 'span') {
                  const turnLabel =
                    item.startTurn === item.endTurn
                      ? `第 ${item.startTurn} 轮`
                      : `第 ${item.startTurn}–${item.endTurn} 轮`;
                  return (
                    <li
                      key={item.id}
                      className={`story-tree-span ${item.isActiveEnd ? 'active-end' : ''}`}
                      data-testid="story-tree-span"
                    >
                      <div className="story-tree-row-top">
                        <span className="badge">{turnLabel}</span>
                        <span className="status-text">
                          {item.isActiveEnd ? '当前激活终点' : `折叠 ${item.turnCount} 轮`}
                        </span>
                        {item.diagnosticsCount > 0 && (
                          <span className="badge badge-warn">
                            含 {item.diagnosticsCount} 条诊断标记
                          </span>
                        )}
                      </div>
                      <div className="story-tree-preview">{item.preview}</div>
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
                      <span className="fork-badge">⑂ {item.branchCount}</span>
                      <span>
                        {item.afterTurn === 0 ? '开局分叉' : `第 ${item.afterTurn} 轮分叉`} · 当前：
                        {item.activeBranchLabel}
                      </span>
                      <span className="status-text">{isForkOpen ? '收起旁支' : '展开旁支'}</span>
                    </button>

                    {isForkOpen && (
                      <ul className="story-tree-siblings" aria-label="分支列表">
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
                            >
                              <div className="story-tree-row-top">
                                <strong>{branch.label}</strong>
                                {branch.isActive && <span className="badge">当前路线</span>}
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
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void commitRename(branch.entryNodeId);
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    disabled={isBusy}
                                    onClick={() => void commitRename(branch.entryNodeId)}
                                  >
                                    保存名称
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm"
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
                                      disabled={isBusy}
                                      onClick={() => onSwitchBranch(branch.entryNodeId)}
                                    >
                                      {mode === 'preview' ? '查看此分支' : '切换至此分支'}
                                    </button>
                                  )}
                                  {mode === 'play' && onRenameBranch && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      disabled={isBusy}
                                      onClick={() => startRename(branch)}
                                    >
                                      重命名
                                    </button>
                                  )}
                                  {mode === 'play' && onExtractBranchGist && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
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
