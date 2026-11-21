import { useState, type KeyboardEvent } from 'react';
import {
  computeActiveReviewState,
  type PlotSummarySnapshot,
  type Story,
  type StoryBlueprint,
  type ThreeZoneMetrics,
} from '../harness/index.ts';
import { ContextOverview } from './ContextOverview.tsx';
import { StoryReview } from './StoryReview.tsx';
import { StoryTree } from './StoryTree.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';

type CompanionTab = 'tree' | 'review' | 'blueprint';

const TABS: { id: CompanionTab; label: string }[] = [
  { id: 'tree', label: '剧情树' },
  { id: 'review', label: '剧情回顾' },
  { id: 'blueprint', label: '故事蓝图' },
];

interface CompanionSheetProps {
  open: boolean;
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  metrics: ThreeZoneMetrics;
  hasCredentials: boolean;
  isStreaming: boolean;
  isSummarizing: boolean;
  isSummaryInProgress: boolean;
  isBlueprintReextracting: boolean;
  isBranchSwitching: boolean;
  onSwitchBranch: (targetNodeId: string) => void;
  onRenameBranch: (branchEntryNodeId: string, name: string) => Promise<void> | void;
  onExtractBranchGist: (branchEntryNodeId: string) => Promise<void> | void;
  onComputeSummary: () => void;
  onOpenDocuments?: { container(): void; local(): void; public(): void; adoptScript?: () => void };
  onSaveBlueprintTweak?: (blueprint: StoryBlueprint, baseline: Story) => Promise<boolean | void>;
  onReextractBlueprint: () => void;
  onClose: () => void;
}

export function CompanionSheet({
  open,
  story,
  summarySnapshot,
  metrics,
  hasCredentials,
  isStreaming,
  isSummarizing,
  isSummaryInProgress,
  isBlueprintReextracting,
  isBranchSwitching,
  onSwitchBranch,
  onRenameBranch,
  onExtractBranchGist,
  onComputeSummary,
  onOpenDocuments,
  onSaveBlueprintTweak,
  onReextractBlueprint,
  onClose,
}: CompanionSheetProps) {
  const [activeTab, setActiveTab] = useState<CompanionTab>('tree');
  const needsSummary = computeActiveReviewState(story).needsSummaryCompression;

  const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const nextTab = TABS[(currentIndex + direction + TABS.length) % TABS.length];
    setActiveTab(nextTab.id);
    document.getElementById(`companion-tab-${nextTab.id}`)?.focus();
  };

  return (
    <SheetDialog
      open={open}
      title="故事结构"
      label="故事伴生面板"
      testId="story-tree-sheet"
      status={isSummaryInProgress ? '补算摘要中…' : undefined}
      statusTestId="companion-summary-progress"
      onClose={onClose}
    >
      <div className="companion-sheet" data-testid="companion-sheet">
        <div className="companion-tabs" role="tablist" aria-label="故事信息">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`companion-tab-${tab.id}`}
              type="button"
              role="tab"
              className="companion-tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`companion-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              data-testid={`companion-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={selectAdjacentTab}
            >
              {tab.label}
              {tab.id === 'review' && needsSummary && (
                <span
                  className="companion-tab-warning"
                  data-testid="summary-needed-indicator"
                  aria-label="剧情摘要待补算"
                />
              )}
            </button>
          ))}
        </div>

        <section
          id="companion-panel-tree"
          className="companion-panel"
          role="tabpanel"
          aria-labelledby="companion-tab-tree"
          data-testid="companion-panel-tree"
          hidden={activeTab !== 'tree'}
        >
          <StoryTree
            story={story}
            isBusy={isStreaming || isSummarizing || isBranchSwitching}
            isRenameBusy={isStreaming || isBranchSwitching || isSummarizing}
            collapsible={false}
            onSwitchBranch={onSwitchBranch}
            onRenameBranch={onRenameBranch}
            onExtractBranchGist={(id) => {
              if (!hasCredentials) onClose();
              onExtractBranchGist(id);
            }}
          />
        </section>

        <section
          id="companion-panel-review"
          className="companion-panel"
          role="tabpanel"
          aria-labelledby="companion-tab-review"
          data-testid="companion-panel-review"
          hidden={activeTab !== 'review'}
        >
          <StoryReview
            story={story}
            metrics={metrics}
            isBusy={isStreaming || isSummarizing || isBranchSwitching}
            isSummarizing={isSummaryInProgress}
            onComputeSummary={() => {
              if (!hasCredentials) onClose();
              onComputeSummary();
            }}
          />
        </section>

        <section
          id="companion-panel-blueprint"
          className="companion-panel"
          role="tabpanel"
          aria-labelledby="companion-tab-blueprint"
          data-testid="companion-panel-blueprint"
          hidden={activeTab !== 'blueprint'}
        >
          <ContextOverview
            story={story}
            summarySnapshot={summarySnapshot}
            metrics={metrics}
            isStreaming={isStreaming || isSummarizing || isBranchSwitching}
            isReextracting={isBlueprintReextracting}
            onOpenDocuments={onOpenDocuments}
            onSaveBlueprintTweak={onSaveBlueprintTweak}
            onReextractBlueprint={() => {
              if (!hasCredentials) onClose();
              onReextractBlueprint();
            }}
          />
        </section>
      </div>
    </SheetDialog>
  );
}
