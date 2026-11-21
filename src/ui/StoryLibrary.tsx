import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getActiveBranchNodes, projectStoryTreeSpine, type Story } from '../harness/index.ts';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

/** A work or character displayed in the library. Subtitle is already formatted for display. */
export interface LibraryItem {
  id: string;
  title: string;
  subtitle: string;
}

/** Callbacks operate on the item ID; export should produce a UTF-8 Markdown file. */
export interface LibraryItemActions {
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
}

export interface StoryLibraryProps {
  stories: Story[];
  works?: LibraryItem[];
  characters?: LibraryItem[];
  activeWorkId?: string;
  activeCharacterId?: string;
  workActions?: LibraryItemActions;
  characterActions?: LibraryItemActions;
  activeStoryId: string;
  onSelectStory: (id: string) => void;
  onRenameStory: (id: string, title: string) => void;
  onDeleteStory: (id: string) => void;
  onExportStoryBackup: (id: string) => void;
}

export function StoryLibrary({
  stories,
  works = [],
  characters = [],
  activeWorkId,
  activeCharacterId,
  workActions,
  characterActions,
  activeStoryId,
  onSelectStory,
  onRenameStory,
  onDeleteStory,
  onExportStoryBackup,
}: StoryLibraryProps) {
  const [category, setCategory] = useState<'story' | 'work' | 'character'>('story');
  const [deleteItem, setDeleteItem] = useState<{
    id: string;
    title: string;
    category: 'story' | 'work' | 'character';
  } | null>(null);
  useWebHistoryLayer('library-delete', 110, Boolean(deleteItem), () => setDeleteItem(null));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreMenuFocusRef = useRef(true);
  const closeMenu = (restoreFocus = true) => {
    restoreMenuFocusRef.current = restoreFocus;
    setOpenMenuId(null);
  };
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;
  useWebHistoryLayer('story-menu', 100, Boolean(openMenuId), closeMenuRef.current);

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.story-menu-container')) closeMenu();
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [openMenuId]);

  useEffect(() => {
    if (!openMenuId) return;
    const menuId = openMenuId;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
    return () => {
      if (!restoreMenuFocusRef.current) {
        restoreMenuFocusRef.current = true;
        return;
      }
      const restoreTriggerFocus = () => {
        if (document.querySelector('[data-testid="story-overflow-menu"]')) return;
        const trigger = menuTriggerRefs.current.get(menuId);
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      };
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(restoreTriggerFocus);
      });
      window.setTimeout(restoreTriggerFocus, 60);
    };
  }, [openMenuId]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const commitRename = (id: string) => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (trimmed) actions?.onRename(id, trimmed);
  };

  const config = {
    story: { label: '文游', heading: '我的故事', items: stories.map((story) => ({
      id: story.id, title: story.title,
      subtitle: `${Math.floor(getActiveBranchNodes(story).length / 2)} 轮 · ${projectStoryTreeSpine(story).forkCount} 分支`,
    })), activeId: activeStoryId, actions: { onSelect: onSelectStory, onRename: onRenameStory, onDelete: onDeleteStory, onExport: onExportStoryBackup } },
    work: { label: '产粮', heading: '我的作品', items: works, activeId: activeWorkId, actions: workActions },
    character: { label: '角色', heading: '我的角色', items: characters, activeId: activeCharacterId, actions: characterActions },
  };
  const current = config[category];
  const actions = current.actions;

  return (
    <section className="story-library" aria-label={current.heading}>
      <div className="library-categories" role="group" aria-label="书架分类">
        {(['story', 'work', 'character'] as const).map((key) => (
          <button key={key} type="button" aria-pressed={category === key} onClick={() => {
            closeMenu(false);
            setRenamingId(null);
            setCategory(key);
          }}>{config[key].label}</button>
        ))}
      </div>
      <div className="library-section-heading">
        <h2>{current.heading}</h2>
        <span className="story-count">{current.items.length}</span>
      </div>

      {current.items.length === 0 ? (
        <p className="library-empty">{category === 'story' ? '导入剧本或 DeepSeek 存档后，故事会保存在这里。' : `还没有${category === 'work' ? '作品' : '角色'}。`}</p>
      ) : (
        <ul className="story-list">
          {current.items.map((item) => {
            const isActive = item.id === current.activeId;
            return (
              <li
                key={item.id}
                className={`story-list-item ${isActive ? 'is-active' : ''} ${openMenuId === item.id ? 'is-menu-open' : ''}`}
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
                      aria-label={`重命名${category === 'story' ? '故事' : category === 'work' ? '作品' : '角色'}标题`}
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
                      onClick={() => actions?.onSelect(item.id)}
                    >
                      <span className="story-active-dot" aria-hidden="true" />
                      <span className="story-list-copy">
                        <span className="story-list-title">{item.title}</span>
                        <span className="story-list-meta">
                          {item.subtitle}
                        </span>
                      </span>
                    </button>
                    <div className="story-menu-container">
                      <button
                        ref={(element) => {
                          if (element) menuTriggerRefs.current.set(item.id, element);
                          else menuTriggerRefs.current.delete(item.id);
                        }}
                        type="button"
                        className="icon-button story-menu-trigger"
                        data-testid="story-menu-trigger"
                        aria-label={`更多 ${item.title} 的操作`}
                        aria-haspopup="menu"
                        aria-expanded={openMenuId === item.id}
                        onClick={() => {
                          if (openMenuId === item.id) {
                            closeMenu();
                          } else {
                            restoreMenuFocusRef.current = true;
                            setOpenMenuId(item.id);
                          }
                        }}
                      >
                        <MoreHorizontal size={18} strokeWidth={1.75} />
                      </button>
                      {openMenuId === item.id && (
                        <div
                          ref={menuRef}
                          className="story-overflow-menu"
                          role="menu"
                          aria-label={`${item.title} 的操作`}
                          data-testid="story-overflow-menu"
                          onKeyDown={handleMenuKeyDown}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu(false);
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
                              closeMenu();
                              actions?.onExport(item.id);
                            }}
                          >
                            导出 {category === 'story' ? '.lfh.json' : '.md'}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger-menu-item"
                            onClick={() => {
                              closeMenu(false);
                              setDeleteItem({ id: item.id, title: item.title, category });
                            }}
                          >
                            删除{category === 'story' ? '故事' : category === 'work' ? '作品' : '角色'}
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
      <ModalDialog open={Boolean(deleteItem)} label="确认删除" onClose={() => setDeleteItem(null)}>
        {deleteItem && <div className="local-document-dialog">
          <h2>确认删除{deleteItem.category === 'story' ? '故事' : deleteItem.category === 'work' ? '作品' : '角色'}</h2>
          <p>将永久删除本机的“{deleteItem.title}”及其相关内容，此操作无法撤销。</p>
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => setDeleteItem(null)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => {
              const target = deleteItem;
              setDeleteItem(null);
              if (target.category === 'story') onDeleteStory(target.id);
              else if (target.category === 'work') workActions?.onDelete(target.id);
              else characterActions?.onDelete(target.id);
            }}>确认删除</button>
          </div>
        </div>}
      </ModalDialog>
    </section>
  );
}
