import { useRef, useState } from 'react';
import type { Story } from '../harness/index.ts';

interface StoryLibraryProps {
  stories: Story[];
  activeStoryId: string;
  onSelectStory: (id: string) => void;
  onRenameStory: (id: string, title: string) => void;
  onDeleteStory: (id: string) => void;
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => void;
}

export function StoryLibrary({
  stories,
  activeStoryId,
  onSelectStory,
  onRenameStory,
  onDeleteStory,
  onExportBackup,
  onImportBackupFile,
}: StoryLibraryProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const commitRename = (id: string) => {
    setRenamingId(null);
    onRenameStory(id, renameDraft);
  };

  return (
    <section className="story-library" aria-label="本地故事列表与备份">
      <div className="panel-header">
        <h3>我的故事（{stories.length}）</h3>
        <div className="btn-group">
          <button type="button" className="btn btn-sm" onClick={onExportBackup}>
            导出 JSON
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => backupInputRef.current?.click()}
          >
            导入 JSON
          </button>
          <input
            ref={backupInputRef}
            type="file"
            accept=".json,application/json"
            aria-label="导入故事 JSON 备份"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) {
                onImportBackupFile(file);
              }
            }}
          />
        </div>
      </div>

      {stories.length === 0 ? (
        <p className="status-text">尚无已保存故事，导入剧本或发送第一轮后将自动保存。</p>
      ) : (
        <ul className="story-list">
          {stories.map((item) => {
            const isActive = item.id === activeStoryId;
            return (
              <li key={item.id} className={`story-item ${isActive ? 'active' : ''}`}>
                {renamingId === item.id ? (
                  <div className="rename-row">
                    <input
                      type="text"
                      aria-label="重命名故事标题"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          commitRename(item.id);
                        }
                      }}
                    />
                    <button type="button" className="btn btn-sm" onClick={() => commitRename(item.id)}>
                      保存
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="story-select-btn"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => onSelectStory(item.id)}
                    >
                      {item.title}
                    </button>
                    <div className="btn-group">
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`重命名 ${item.title}`}
                        onClick={() => {
                          setRenamingId(item.id);
                          setRenameDraft(item.title);
                        }}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`删除 ${item.title}`}
                        onClick={() => onDeleteStory(item.id)}
                      >
                        删除
                      </button>
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
