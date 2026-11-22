import { useState, type KeyboardEvent } from 'react';
import { ChevronRight, Download, Edit3 } from 'lucide-react';
import {
  documentVersion,
  legacyStoryMarkdown,
  storyDocumentState,
  type PlotSummarySnapshot,
  type Story,
  type StoryDocuments,
} from '../harness/index.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { StoryTree } from './StoryTree.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';

type CompanionTab = 'branches' | 'settings';

const TABS: { id: CompanionTab; label: string }[] = [
  { id: 'branches', label: '分支' },
  { id: 'settings', label: '设定' },
];

interface CompanionSheetProps {
  open: boolean;
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  isStreaming: boolean;
  isSummarizing: boolean;
  isBranchSwitching: boolean;
  onSwitchBranch: (targetNodeId: string) => void;
  onRenameBranch: (branchEntryNodeId: string, name: string) => Promise<void> | void;
  onEditSetting?: () => void;
  onOpenMyMemory?: () => void;
  onEditBranchNote?: () => void;
  onExportMarkdown?: () => void;
  onClose: () => void;
}

export function CompanionSheet({
  open,
  story,
  summarySnapshot,
  isStreaming,
  isSummarizing,
  isBranchSwitching,
  onSwitchBranch,
  onRenameBranch,
  onEditSetting,
  onOpenMyMemory,
  onEditBranchNote,
  onExportMarkdown,
  onClose,
}: CompanionSheetProps) {
  const [activeTab, setActiveTab] = useState<CompanionTab>('branches');

  const isBusy = isStreaming || isSummarizing || isBranchSwitching;

  const settingMarkdown = story.documents
    ? documentVersion(
        story.documents.container,
        storyDocumentState(story as Story & { documents: StoryDocuments }, story.activeLeafNodeId, true).container,
      ).markdown
    : legacyStoryMarkdown(story);

  const branchNoteMarkdown = story.documents
    ? documentVersion(
        story.documents.local,
        storyDocumentState(story as Story & { documents: StoryDocuments }, story.activeLeafNodeId, true).local,
      ).markdown
    : '';

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
      title="故事伴生"
      label="分支与设定"
      testId="story-tree-sheet"
      onClose={onClose}
    >
      <div className="companion-sheet" data-testid="companion-sheet">
        <div className="companion-tabs companion-tabs-two" role="tablist" aria-label="故事信息">
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
            </button>
          ))}
        </div>

        <section
          id="companion-panel-branches"
          className="companion-panel"
          role="tabpanel"
          aria-labelledby="companion-tab-branches"
          data-testid="companion-panel-branches"
          hidden={activeTab !== 'branches'}
        >
          <div className="context-overview-stack">
            {summarySnapshot.content.trim() && (
              <section className="story-review-summary story-review-card" data-testid="active-plot-summary" aria-label="当前进展回顾">
                <strong>当前进展回顾</strong>
                <p>{summarySnapshot.content.trim()}</p>
              </section>
            )}

            <StoryTree
              story={story}
              isBusy={isBusy}
              isRenameBusy={isBusy}
              collapsible={false}
              onSwitchBranch={onSwitchBranch}
              onRenameBranch={onRenameBranch}
            />
          </div>
        </section>

        <section
          id="companion-panel-settings"
          className="companion-panel"
          role="tabpanel"
          aria-labelledby="companion-tab-settings"
          data-testid="companion-panel-settings"
          hidden={activeTab !== 'settings'}
        >
          <div className="context-overview-stack">
            <InsetGroup title="故事设定" testId="story-setting-group">
              <div className="companion-setting-preview">
                <MarkdownView content={settingMarkdown.trim() || '尚未编写故事设定，可在对话中告诉 AI 或点击下方编辑。'} mode="story" />
              </div>
              {onEditSetting && (
                <button
                  type="button"
                  className="btn"
                  data-testid="edit-story-setting-btn"
                  disabled={isBusy}
                  onClick={onEditSetting}
                >
                  <Edit3 size={16} strokeWidth={1.75} aria-hidden="true" />
                  编辑设定
                </button>
              )}
            </InsetGroup>

            <InsetGroup title="通用资料与导出" testId="companion-documents">
              <div className="companion-document-list">
                {onOpenMyMemory && (
                  <button type="button" className="companion-document-row" data-testid="open-my-memory-row" onClick={onOpenMyMemory}>
                    <span>我的记忆</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
                {onExportMarkdown && (
                  <button type="button" className="companion-document-row" data-testid="export-story-markdown-row" onClick={onExportMarkdown}>
                    <span>导出 Markdown (.md)</span>
                    <Download size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            </InsetGroup>

            <details className="branch-note-details" data-testid="branch-note-details">
              <summary>分支笔记</summary>
              <div className="branch-note-body">
                <MarkdownView content={branchNoteMarkdown.trim() || '暂无分支笔记，当前路线的进展会自动记录在这里。'} mode="story" />
                {onEditBranchNote && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid="edit-branch-note-btn"
                    disabled={isBusy}
                    onClick={onEditBranchNote}
                  >
                    编辑分支笔记
                  </button>
                )}
              </div>
            </details>
          </div>
        </section>
      </div>
    </SheetDialog>
  );
}
