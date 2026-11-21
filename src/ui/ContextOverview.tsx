import { ChevronRight } from 'lucide-react';
import {
  getActiveBranchNodes,
  type PlotSummarySnapshot,
  type Story,
  type StoryBlueprint,
  type ThreeZoneMetrics,
} from '../harness/index.ts';
import { StoryBlueprintCard } from './StoryBlueprintCard.tsx';
import { DocumentReadDetails } from './DocumentReadDetails.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';

interface CompanionDocuments {
  container(): void;
  local(): void;
  public(): void;
  adoptScript?: () => void;
}

interface ContextOverviewProps {
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  metrics: ThreeZoneMetrics;
  isStreaming: boolean;
  isReextracting?: boolean;
  onOpenDocuments?: CompanionDocuments;
  onSaveBlueprintTweak?: (updatedBlueprint: StoryBlueprint, baseline: Story) => Promise<boolean | void>;
  onReextractBlueprint?: () => void;
}

export function ContextOverview({
  story,
  summarySnapshot,
  metrics,
  isStreaming,
  isReextracting = false,
  onOpenDocuments,
  onSaveBlueprintTweak,
  onReextractBlueprint,
}: ContextOverviewProps) {
  const readEntries = getActiveBranchNodes(story, story.activeLeafNodeId)
    .flatMap((node) => node.documentReads?.length ? [{
      id: node.id,
      label: `${node.role === 'assistant' ? 'AI 回复' : '对话节点'} · ${node.id}`,
      createdAt: node.createdAt,
      reads: node.documentReads,
    }] : [])
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));

  return (
    <div className="context-overview-stack">
      <StoryBlueprintCard
        story={story}
        isBusy={isStreaming}
        isReextracting={isReextracting}
        onSaveBlueprintTweak={onSaveBlueprintTweak}
        onReextractBlueprint={onReextractBlueprint}
      />

      {onOpenDocuments && <InsetGroup title="资料" testId="companion-documents">
        <div className="companion-document-list">
          <button type="button" className="companion-document-row" disabled={isStreaming} onClick={onOpenDocuments.container}>
            <span>故事资料</span><ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="companion-document-row" disabled={isStreaming} onClick={onOpenDocuments.local}>
            <span>当前路径资料</span><ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="companion-document-row" onClick={onOpenDocuments.public}>
            <span>公共记忆</span><ChevronRight size={18} aria-hidden="true" />
          </button>
          {onOpenDocuments.adoptScript && <button type="button" className="companion-document-row"
            disabled={isStreaming} onClick={onOpenDocuments.adoptScript}>
            <span>核对候选剧本</span><ChevronRight size={18} aria-hidden="true" />
          </button>}
        </div>
      </InsetGroup>}

      <DocumentReadDetails entries={readEntries} testId="context-overview">
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
          <p>
            <strong>估算预算：</strong>{metrics.totalEstimatedTokens} tokens · 已压缩{' '}
            {summarySnapshot.summarizedTurnCount} 条历史
          </p>
        </div>
      </DocumentReadDetails>
    </div>
  );
}
