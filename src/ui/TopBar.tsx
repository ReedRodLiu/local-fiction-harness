import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpenText, ChevronDown, GitBranch, Menu, PanelLeft, PanelRight } from 'lucide-react';
import type { StageAssetMode } from '../harness/index.ts';

const MODE_LABELS: Record<StageAssetMode, string> = {
  story: '文游',
  writing: '写故事',
  character: '角色互动',
};

interface TopBarProps {
  title: string;
  stageMode?: StageAssetMode;
  showModeSwitcher?: boolean;
  onSwitchStageMode?: (targetMode: StageAssetMode) => void;
  modeSwitchDisabled?: boolean;
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
  showModeSwitcher = false,
  onSwitchStageMode,
  modeSwitchDisabled = false,
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
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.topbar-mode-switcher')) {
        setModeMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modeMenuOpen]);

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
        {showModeSwitcher && onSwitchStageMode && (
          <div className="topbar-mode-switcher" ref={modeMenuRef}>
            <button
              type="button"
              className="topbar-mode-chip"
              data-testid="topbar-mode-switcher"
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              aria-label={`当前模式：${MODE_LABELS[stageMode]}，点击切换`}
              disabled={modeSwitchDisabled}
              onClick={() => setModeMenuOpen((open) => !open)}
            >
              <span>{MODE_LABELS[stageMode]}</span>
              <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {modeMenuOpen && (
              <div
                className="topbar-mode-menu"
                role="menu"
                aria-label="切换创作模式"
                data-testid="topbar-mode-menu"
              >
                {(['story', 'writing', 'character'] as const).map((target) => (
                  <button
                    key={target}
                    type="button"
                    role="menuitemradio"
                    aria-checked={stageMode === target}
                    className={`topbar-mode-menu-item${stageMode === target ? ' is-active' : ''}`}
                    data-testid={`topbar-mode-option-${target}`}
                    onClick={() => {
                      setModeMenuOpen(false);
                      if (target !== stageMode) onSwitchStageMode(target);
                    }}
                  >
                    <span>{MODE_LABELS[target]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
