import type { ReactNode } from 'react';
import { GitBranch, Menu, PanelLeft } from 'lucide-react';

interface TopBarProps {
  title: string;
  stageControls?: ReactNode;
  hasStory: boolean;
  hideStoryTools?: boolean;
  onOpenCreativeCompanion: () => void;
  canOpenCreativeCompanion: boolean;
  branchLabel: string;
  forkCount: number;
  isSummaryInProgress: boolean;
  libraryCollapsed: boolean;
  onOpenLibrary: () => void;
  onToggleLibrary: () => void;
  onOpenStoryTree: () => void;
}

export function TopBar({
  title,
  stageControls,
  hasStory,
  hideStoryTools = false,
  onOpenCreativeCompanion,
  canOpenCreativeCompanion,
  branchLabel,
  forkCount,
  isSummaryInProgress,
  libraryCollapsed,
  onOpenLibrary,
  onToggleLibrary,
  onOpenStoryTree,
}: TopBarProps) {
  return (
    <header className="app-topbar" data-testid="app-topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="icon-button mobile-topbar-action"
          data-testid="library-drawer-trigger"
          aria-label="打开书架"
          aria-haspopup="dialog"
          onClick={onOpenLibrary}
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>
        {(
          <button
            type="button"
            className="icon-button desktop-topbar-action"
            data-testid="desktop-library-toggle"
            aria-label={libraryCollapsed ? '展开书架侧栏' : '收起书架侧栏'}
            aria-pressed={libraryCollapsed}
            onClick={onToggleLibrary}
          >
            <PanelLeft size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className="topbar-title-group">
        <h1>{title}</h1>
        {stageControls}
        {hasStory && (
          <button
            type="button"
            className="branch-badge"
            data-testid="open-story-tree"
            onClick={onOpenStoryTree}
            aria-label={`打开剧情树，当前分支 ${branchLabel}，${forkCount} 处分叉`}
          >
            <span>{branchLabel}</span>
            <span aria-hidden="true">·</span>
            <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{forkCount}</span>
          </button>
        )}
      </div>

      <div className="topbar-right">
        {!hideStoryTools && isSummaryInProgress && (
          <span className="summary-progress" data-testid="summary-progress" role="status">补算摘要中…</span>
        )}
        {hideStoryTools && <button type="button" className="icon-button topbar-tree-action" aria-label="创作资料" aria-haspopup="dialog" disabled={!canOpenCreativeCompanion} onClick={onOpenCreativeCompanion}><GitBranch size={20} strokeWidth={1.75} /></button>}
        {!hideStoryTools && <button
          type="button"
          className="icon-button topbar-tree-action"
          data-testid="open-companion-sheet"
          aria-label="打开剧情树"
          disabled={!hasStory}
          onClick={onOpenStoryTree}
        >
          <GitBranch size={20} strokeWidth={1.75} />
        </button>}
      </div>
    </header>
  );
}
