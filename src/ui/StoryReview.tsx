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
      <header className="story-review-header">
        <div>
          <h3>当前路线剧情回顾</h3>
          <span className="badge badge-structure">{review.activeBranchLabel}</span>
        </div>
        <p className="story-review-branch-note">分支记忆独立隔离 · 共 {review.totalTurns} 轮</p>
      </header>

      <div className="story-review-metrics" aria-label="剧情摘要指标">
        <div className="story-review-metric">
          <strong>{story.rawScript.length}</strong>
          <span>锚定字数</span>
        </div>
        <div className="story-review-metric">
          <strong>{summarySnapshot.summarizedTurnCount}</strong>
          <span>摘要覆盖节点</span>
        </div>
        <div className="story-review-metric">
          <strong>{metrics.totalEstimatedTokens}</strong>
          <span>上下文预算 Token</span>
        </div>
      </div>

      <div className="story-review-meta">
        <span>{coveredLabel}</span>
        <span>{recentLabel}</span>
      </div>

      <div className="story-review-summary" data-testid="active-plot-summary">
        <strong>当前路线剧情摘要：</strong>
        {summarySnapshot.content ? (
          <span>{summarySnapshot.content}</span>
        ) : review.needsSummaryCompression ? (
          <span className="status-text">当前支线已超出近期窗口，尚未压缩摘要。</span>
        ) : (
          <span className="status-text">尚未触发压缩（近期窗口内保留完整对话）</span>
        )}
      </div>

      {review.needsSummaryCompression && onComputeSummary && (
        <div className="story-review-summary-action">
          <div>
            <strong>为当前分支补齐剧情摘要</strong>
            <p>摘要仅沿当前路线生成，不会混入其他分支的剧情。</p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={isBusy || isSummarizing}
            onClick={onComputeSummary}
          >
            {isSummarizing ? '补算摘要中…' : '立即补算剧情摘要'}
          </button>
        </div>
      )}
    </section>
  );
}
