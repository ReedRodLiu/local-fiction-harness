import { useState } from 'react';
import {
  getBranchTreeSummary,
  type PlotSummarySnapshot,
  type Story,
  type StoryBlueprint,
  type ThreeZoneMetrics,
} from '../harness/index.ts';

interface ContextOverviewProps {
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  metrics: ThreeZoneMetrics;
  onSaveBlueprintTweak: (updatedBlueprint: StoryBlueprint) => Promise<void>;
  onSwitchBranch: (targetNodeId: string) => void;
}

export function ContextOverview({
  story,
  summarySnapshot,
  metrics,
  onSaveBlueprintTweak,
  onSwitchBranch,
}: ContextOverviewProps) {
  const [editingBlueprint, setEditingBlueprint] = useState(false);
  const [protagonistDraft, setProtagonistDraft] = useState('');
  const [taboosDraft, setTaboosDraft] = useState('');

  const hasBlueprintOrScript =
    Boolean(story.rawScript) || story.blueprint.worldRules.length > 0;
  const branchLeaves = getBranchTreeSummary(story);

  return (
    <div className="overview-stack">
      {hasBlueprintOrScript && (
        <details className="reasoning-details">
          <summary>
            故事蓝图与原始剧本锚定（原文 {story.rawScript.length} 字符）
          </summary>
          <div className="blueprint-summary">
            {editingBlueprint ? (
              <div className="config-form" style={{ marginTop: '0.5rem' }}>
                <div className="field">
                  <label htmlFor="tweak-protagonist">微调主角设定</label>
                  <input
                    id="tweak-protagonist"
                    type="text"
                    value={protagonistDraft}
                    onChange={(e) => setProtagonistDraft(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tweak-taboos">微调禁忌条款（每行一条）</label>
                  <textarea
                    id="tweak-taboos"
                    rows={2}
                    value={taboosDraft}
                    onChange={(e) => setTaboosDraft(e.target.value)}
                  />
                </div>
                <div className="btn-group">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      void onSaveBlueprintTweak({
                        ...story.blueprint,
                        protagonist: protagonistDraft.trim(),
                        taboos: taboosDraft
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }).then(() => setEditingBlueprint(false));
                    }}
                  >
                    保存蓝图微调
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setEditingBlueprint(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                {story.blueprint.protagonist && (
                  <p>
                    <strong>主角：</strong>
                    {story.blueprint.protagonist}
                  </p>
                )}
                {story.blueprint.worldRules.length > 0 && (
                  <p>
                    <strong>规则：</strong>
                    {story.blueprint.worldRules.join('；')}
                  </p>
                )}
                {story.blueprint.taboos.length > 0 && (
                  <p>
                    <strong>禁忌：</strong>
                    {story.blueprint.taboos.join('；')}
                  </p>
                )}
                {story.blueprint.npcs.length > 0 && (
                  <p>
                    <strong>角色：</strong>
                    {story.blueprint.npcs
                      .map((n) => `${n.name}${n.role ? `(${n.role})` : ''}`)
                      .join('、')}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setProtagonistDraft(story.blueprint.protagonist);
                    setTaboosDraft(story.blueprint.taboos.join('\n'));
                    setEditingBlueprint(true);
                  }}
                >
                  微调蓝图
                </button>
              </>
            )}
          </div>
        </details>
      )}

      <details className="reasoning-details" data-testid="context-overview">
        <summary>
          三区上下文与剧情摘要（估算 {metrics.totalEstimatedTokens} tokens · 已压缩{' '}
          {summarySnapshot.summarizedTurnCount} 条历史 · {branchLeaves.length} 条分支）
        </summary>
        <div className="blueprint-summary">
          <p>
            <strong>三区占比：</strong>
            固定锚定 {metrics.anchorChars} 字 / 滚动摘要 {metrics.summaryChars} 字 / 近期窗口{' '}
            {metrics.recentNodeCount} 条（{metrics.recentChars} 字）
          </p>
          <p data-testid="active-plot-summary">
            <strong>当前剧情摘要：</strong>
            {summarySnapshot.content || '尚未触发压缩（近期窗口内保留完整对话）'}
          </p>
          {branchLeaves.length > 1 && (
            <div className="branch-tree-list" aria-label="平行分支树概览">
              <strong>平行分支概览：</strong>
              <ul>
                {branchLeaves.map((branch, idx) => (
                  <li key={branch.leafId}>
                    <button
                      type="button"
                      className={`btn btn-sm ${branch.isActive ? 'btn-primary' : ''}`}
                      onClick={() => onSwitchBranch(branch.leafId)}
                    >
                      分支 {idx + 1}（{branch.turnCount} 轮）：{branch.preview}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
