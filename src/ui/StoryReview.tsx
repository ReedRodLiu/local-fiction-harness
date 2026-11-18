import { useMemo } from 'react';
import { computeActiveReviewState, type Story, type ThreeZoneMetrics } from '../harness/index.ts';

interface StoryReviewProps {
  story: Story;
  metrics: ThreeZoneMetrics;
  isBusy: boolean;
  isSummarizing: boolean;
  onComputeSummary?: () => void;
}

export function StoryReview({
  story,
  metrics,
  isBusy,
  isSummarizing,
  onComputeSummary,
}: StoryReviewProps) {
  const review = useMemo(() => computeActiveReviewState(story), [story]);
  const { summarySnapshot, coveredTurnRange, recentTurnRange } = review;

  const coveredLabel = coveredTurnRange
    ? `已覆盖第 ${coveredTurnRange.startTurn}–${coveredTurnRange.endTurn} 轮（${summarySnapshot.summarizedTurnCount} 条节点）`
    : '尚未压缩历史轮次';

  const recentLabel = recentTurnRange
    ? `近期窗口：第 ${recentTurnRange.startTurn}–${recentTurnRange.endTurn} 轮（${review.recentNodeCount} 条节点）`
    : `近期窗口：${review.recentNodeCount} 条节点`;

  return (
    <section className="story-review-panel" data-testid="story-review" aria-label="剧情回顾">
      <div className="panel-header">
        <div className="story-tree-heading">
          <h4>剧情回顾</h4>
          <span className="badge">{review.activeBranchLabel}</span>
          <span className="status-text">共 {review.totalTurns} 轮 · 分支记忆独立隔离</span>
        </div>
        {review.needsSummaryCompression && onComputeSummary && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={isBusy || isSummarizing}
            onClick={onComputeSummary}
          >
            {isSummarizing ? '补算摘要中…' : '补算剧情摘要'}
          </button>
        )}
      </div>

      <div className="story-review-meta">
        <span>{coveredLabel}</span>
        <span>{recentLabel}</span>
        <span>
          锚定设定：原文 {story.rawScript.length} 字 · {story.blueprint.worldRules.length} 条规则 ·{' '}
          {story.blueprint.taboos.length} 条禁忌（约 {metrics.totalEstimatedTokens} tokens）
        </span>
      </div>

      <div className="story-review-summary" data-testid="active-plot-summary">
        <strong>当前路线剧情摘要：</strong>
        {summarySnapshot.content ? (
          <span>{summarySnapshot.content}</span>
        ) : review.needsSummaryCompression ? (
          <span className="status-text">
            当前支线已超出近期窗口但尚未压缩摘要（可点击右上角「补算剧情摘要」，或配置 API Key 后于下轮自动补算）。
          </span>
        ) : (
          <span className="status-text">尚未触发压缩（近期窗口内保留完整对话）</span>
        )}
      </div>
    </section>
  );
}
