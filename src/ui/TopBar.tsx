import type { ReactNode } from 'react';
import { BookOpenText, GitBranch, Menu, PanelLeft, PanelRight } from 'lucide-react';
import type { StageAssetMode } from '../harness/index.ts';

interface TopBarProps {
  title: string;
  stageMode?: StageAssetMode;
  stageControls?: ReactNode;
  hasStory: boolean;
  hideStoryTools?: boolean;
  onOpenCreativeCompanion: () => void;
  canOpenCreativeCompanion: boolean;
  branchLabel: string;
  forkCount: number;
  libraryCollapsed: boolean;
  onOpenLibrary: () => void;
  onToggleLibrary: () => void;
  onOpenStoryTree: () => void;
}

export function TopBar({
  title,
  stageMode = 'story',
  stageControls,
  hasStory,
  hideStoryTools = false,
  onOpenCreativeCompanion,
  canOpenCreativeCompanion,
  branchLabel,
  forkCount,
  libraryCollapsed,
  onOpenLibrary,
  onToggleLibrary,
  onOpenStoryTree,
}: TopBarProps) {

  const creativeCompanion = stageMode === 'character'
    ? { label: '打开历史对话与设定', Icon: PanelRight }
    : { label: '打开灵感与设定', Icon: BookOpenText };
  const CreativeCompanionIcon = creativeCompanion.Icon;

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
            aria-pressed={true}
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
            aria-label={`打开分支与设定，当前分支 ${branchLabel}，${forkCount} 处分叉`}
          >
            <span>{branchLabel}</span>
            <span aria-hidden="true">·</span>
            <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{forkCount}</span>
          </button>
        )}
      </div>

      <div className="topbar-right">
        {hideStoryTools && (
          <button
            type="button"
            className="icon-button topbar-tree-action"
            data-testid="open-companion-sheet"
            aria-label={creativeCompanion.label}
            aria-haspopup="dialog"
            disabled={!canOpenCreativeCompanion}
            onClick={onOpenCreativeCompanion}
          >
            <CreativeCompanionIcon size={20} strokeWidth={1.75} />
          </button>
        )}
        {!hideStoryTools && (
          <button
            type="button"
            className="icon-button topbar-tree-action"
            data-testid="open-companion-sheet"
            aria-label="打开分支与设定"
            disabled={!hasStory}
            onClick={onOpenStoryTree}
          >
            <GitBranch size={20} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  );
}
