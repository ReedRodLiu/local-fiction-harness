import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getActiveBranchNodes, projectStoryTreeSpine, type Story } from '../harness/index.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

interface StoryLibraryProps {
  stories: Story[];
  activeStoryId: string;
  onSelectStory: (id: string) => void;
  onRenameStory: (id: string, title: string) => void;
  onDeleteStory: (id: string) => void;
  onExportStoryBackup: (id: string) => void;
}

export function StoryLibrary({
  stories,
  activeStoryId,
  onSelectStory,
  onRenameStory,
  onDeleteStory,
  onExportStoryBackup,
}: StoryLibraryProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const closeMenuRef = useRef(() => setOpenMenuId(null));
  closeMenuRef.current = () => setOpenMenuId(null);
  useWebHistoryLayer('story-menu', 100, Boolean(openMenuId), closeMenuRef.current);

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.story-menu-container')) setOpenMenuId(null);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [openMenuId]);

  const commitRename = (id: string) => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (trimmed) onRenameStory(id, trimmed);
  };

  return (
    <section className="story-library" aria-label="我的故事">
      <div className="library-section-heading">
        <h2>我的故事</h2>
        <span className="story-count">{stories.length}</span>
      </div>

      {stories.length === 0 ? (
        <p className="library-empty">导入剧本或 DeepSeek 存档后，故事会保存在这里。</p>
      ) : (
        <ul className="story-list">
          {stories.map((item) => {
            const isActive = item.id === activeStoryId;
            const activeNodes = getActiveBranchNodes(item);
            const turnCount = Math.floor(activeNodes.length / 2);
            const forkCount = projectStoryTreeSpine(item).forkCount;
            const recentTitle = activeNodes.at(-1)?.content.replace(/\s+/g, ' ').trim();
            return (
              <li
                key={item.id}
                className={`story-list-item ${isActive ? 'is-active' : ''}`}
                data-testid="story-list-item"
                data-active={isActive ? 'true' : undefined}
              >
                {renamingId === item.id ? (
                  <form
                    className="story-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename(item.id);
                    }}
                  >
                    <input
                      type="text"
                      aria-label="重命名故事标题"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                        ) {
                          event.preventDefault();
                        }
                      }}
                      autoFocus
                    />
                    <button type="submit" className="btn btn-sm">保存</button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="story-select-button"
                      data-testid="story-select-button"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => onSelectStory(item.id)}
                    >
                      <span className="story-active-dot" aria-hidden="true" />
                      <span className="story-list-copy">
                        <span className="story-list-title">{item.title}</span>
                        <span className="story-list-meta">
                          {turnCount} 轮 · {forkCount} 分支
                        </span>
                        {recentTitle && <span className="story-list-recent">{recentTitle}</span>}
                      </span>
                    </button>
                    <div className="story-menu-container">
                      <button
                        type="button"
                        className="icon-button story-menu-trigger"
                        data-testid="story-menu-trigger"
                        aria-label={`更多 ${item.title} 的操作`}
                        aria-haspopup="menu"
                        aria-expanded={openMenuId === item.id}
                        onClick={() => setOpenMenuId((current) => current === item.id ? null : item.id)}
                      >
                        <MoreHorizontal size={18} strokeWidth={1.75} />
                      </button>
                      {openMenuId === item.id && (
                        <div
                          className="story-overflow-menu"
                          role="menu"
                          aria-label={`${item.title} 的操作`}
                          data-testid="story-overflow-menu"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setOpenMenuId(null);
                              setRenamingId(item.id);
                              setRenameDraft(item.title);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setOpenMenuId(null);
                              onExportStoryBackup(item.id);
                            }}
                          >
                            导出 .lfh.json
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger-menu-item"
                            onClick={() => {
                              setOpenMenuId(null);
                              onDeleteStory(item.id);
                            }}
                          >
                            删除故事
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
