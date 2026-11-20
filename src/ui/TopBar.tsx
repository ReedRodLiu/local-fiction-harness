import { GitBranch, Menu, PanelLeft } from 'lucide-react';

interface TopBarProps {
  title: string;
  hasStory: boolean;
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
  hasStory,
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
        {libraryCollapsed && (
          <button
            type="button"
            className="icon-button desktop-topbar-action"
            data-testid="desktop-library-toggle"
            aria-label="展开书架侧栏"
            aria-pressed={libraryCollapsed}
            onClick={onToggleLibrary}
          >
            <PanelLeft size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className="topbar-title-group">
        <h1>{title}</h1>
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
        {isSummaryInProgress && (
          <span className="summary-progress" data-testid="summary-progress" role="status">补算摘要中…</span>
        )}
        <button
          type="button"
          className="icon-button topbar-tree-action"
          data-testid="open-companion-sheet"
          aria-label="打开剧情树"
          disabled={!hasStory}
          onClick={onOpenStoryTree}
        >
          <GitBranch size={20} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
