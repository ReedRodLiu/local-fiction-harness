import type { ReactNode } from 'react';
import { BookOpen, ChevronRight, FilePlus2, MessagesSquare, PencilLine, PanelLeftClose, Settings, Sparkles, X } from 'lucide-react';
import type { Story } from '../harness/index.ts';
import { StoryLibrary } from './StoryLibrary.tsx';
import { DrawerDialog } from './primitives/DrawerDialog.tsx';

interface LibraryDrawerProps {
  stories: Story[];
  activeStoryId: string;
  collapsed: boolean;
  mobileOpen: boolean;
  hasCredentials: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onOpenSettings: () => void;
  onStartDeepSeekImport: () => void;
  onStartScriptImport: () => void;
  onSelectStory: (id: string) => void;
  onRenameStory: (id: string, title: string) => void;
  onDeleteStory: (id: string) => void;
  onOpenCreative?: (mode: 'writing' | 'character') => void;
  onExportStoryBackup: (id: string) => void;
}

export function LibraryDrawer({
  stories,
  activeStoryId,
  collapsed,
  mobileOpen,
  hasCredentials,
  onClose,
  onCollapse,
  onOpenSettings,
  onStartDeepSeekImport,
  onStartScriptImport,
  onSelectStory,
  onRenameStory,
  onDeleteStory,
  onOpenCreative,
  onExportStoryBackup,
}: LibraryDrawerProps) {
  const selectStory = (id: string) => {
    onSelectStory(id);
    if (mobileOpen) onClose();
  };

  const actions = (location: 'desktop' | 'mobile') => (
    <div className="library-actions">
      <button
        type="button"
        className="btn btn-primary library-start-deepseek"
        data-testid={`${location}-library-start-deepseek`}
        onClick={onStartDeepSeekImport}
      >
        <Sparkles size={16} strokeWidth={1.75} />
        从 DeepSeek 继续
      </button>
      <button
        type="button"
        className="btn library-start-script"
        data-testid={`${location}-library-start-script`}
        onClick={onStartScriptImport}
      >
        <FilePlus2 size={16} strokeWidth={1.75} />
        导入剧本 / 新建故事
      </button>
      {onOpenCreative && <>
        <button type="button" className="btn" onClick={() => onOpenCreative('writing')}>
          <PencilLine size={16} strokeWidth={1.75} /> 产粮
        </button>
        <button type="button" className="btn" onClick={() => onOpenCreative('character')}>
          <MessagesSquare size={16} strokeWidth={1.75} /> 人机恋
        </button>
      </>}
    </div>
  );

  const storyList = () => (
    <StoryLibrary
      stories={stories}
      activeStoryId={activeStoryId}
      onSelectStory={selectStory}
      onRenameStory={onRenameStory}
      onDeleteStory={onDeleteStory}
      onExportStoryBackup={onExportStoryBackup}
    />
  );

  const settingsFooter = (location: 'desktop' | 'mobile') => (
    <button
      type="button"
      className="library-settings-entry"
      data-testid={`${location}-settings-open`}
      aria-label="设置与模型密钥"
      onClick={() => {
        if (mobileOpen) onClose();
        onOpenSettings();
      }}
    >
      <span className="library-settings-main">
        <Settings size={16} strokeWidth={1.75} />
        <span>设置与模型密钥</span>
      </span>
      <span className={`connection-pill ${hasCredentials ? 'is-ready' : 'is-pending'}`}>
        <span className="connection-dot" aria-hidden="true" />
        {hasCredentials ? 'DeepSeek 已就绪' : '待配置密钥'}
      </span>
      <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );

  const panel = (location: 'desktop' | 'mobile'): ReactNode => (
    <>
      <header className="library-header">
        <div className="library-brand">
          <span className="library-brand-icon"><BookOpen size={20} strokeWidth={1.75} /></span>
          <span className="library-brand-copy">本地文游</span>
        </div>
        {location === 'mobile' ? (
          <button type="button" className="icon-button" aria-label="关闭书架" onClick={onClose}>
            <X size={18} strokeWidth={1.75} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-button"
            data-testid="desktop-library-close"
            aria-label="收起书架侧栏"
            onClick={onCollapse}
          >
            <PanelLeftClose size={18} strokeWidth={1.75} />
          </button>
        )}
      </header>
      {actions(location)}
      <div className="library-list-scroll" data-testid="library-list-scroll">{storyList()}</div>
      {settingsFooter(location)}
    </>
  );

  return (
    <>
      <aside
        className={`library-sidebar ${collapsed ? 'is-collapsed' : ''}`}
        data-testid="desktop-library"
        aria-label="书架"
      >
        {panel('desktop')}
      </aside>
      <DrawerDialog
        open={mobileOpen}
        label="我的故事书架"
        testId="mobile-library-dialog"
        sheetTestId="mobile-library-sheet"
        onClose={onClose}
      >
        {panel('mobile')}
      </DrawerDialog>
    </>
  );
}
