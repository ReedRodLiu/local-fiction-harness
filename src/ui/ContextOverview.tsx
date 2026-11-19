import {
  type PlotSummarySnapshot,
  type Story,
  type StoryBlueprint,
  type ThreeZoneMetrics,
} from '../harness/index.ts';
import { StoryBlueprintCard } from './StoryBlueprintCard.tsx';

interface ContextOverviewProps {
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  metrics: ThreeZoneMetrics;
  isStreaming: boolean;
  isReextracting?: boolean;
  onSaveBlueprintTweak: (updatedBlueprint: StoryBlueprint) => Promise<boolean | void>;
  onReextractBlueprint?: () => void;
}

export function ContextOverview({
  story,
  summarySnapshot,
  metrics,
  isStreaming,
  isReextracting = false,
  onSaveBlueprintTweak,
  onReextractBlueprint,
}: ContextOverviewProps) {
  return (
    <div className="context-overview-stack">
      <StoryBlueprintCard
        story={story}
        isBusy={isStreaming}
        isReextracting={isReextracting}
        onSaveBlueprintTweak={onSaveBlueprintTweak}
        onReextractBlueprint={onReextractBlueprint}
      />

      <details id="context-overview" className="reasoning-details" data-testid="context-overview">
        <summary>
          三区上下文（估算 {metrics.totalEstimatedTokens} tokens · 已压缩{' '}
          {summarySnapshot.summarizedTurnCount} 条历史）
        </summary>
        <div className="blueprint-summary context-overview-details">
          <p>
            <strong>固定锚定：</strong>{metrics.anchorChars} 字
          </p>
          <p>
            <strong>滚动摘要：</strong>{metrics.summaryChars} 字
          </p>
          <p>
            <strong>近期窗口：</strong>{metrics.recentNodeCount} 条节点（{metrics.recentChars} 字）
          </p>
        </div>
      </details>
    </div>
  );
}
