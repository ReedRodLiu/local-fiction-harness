import { type Story } from '../harness/index.ts';

const modes = [
  ['story', '文游'],
  ['writing', '产粮'],
  ['character', '人机恋'],
] as const;

interface RecentCreativeEntry {
  id: string;
  title: string;
  kindLabel?: string;
  activate: () => void;
}

interface WelcomeViewProps {
  stories: Story[];
  mode: (typeof modes)[number][0];
  onModeChange: (mode: WelcomeViewProps['mode']) => void;
  characterName: string;
  onCharacterNameChange: (name: string) => void;
  onStartDeepSeekImport: () => void;
  onStartScriptImport: () => void;
  onStartManuscript: () => void;
  onSelectStory: (id: string) => void;
  recentCreative: RecentCreativeEntry[];
}

export function WelcomeView({
  stories,
  mode,
  onModeChange,
  characterName,
  onCharacterNameChange,
  onStartDeepSeekImport,
  onStartScriptImport,
  onStartManuscript,
  onSelectStory,
  recentCreative,
}: WelcomeViewProps) {
  const recentStories = [...stories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  return (
    <section className="welcome-view welcome-creation" data-testid="welcome-view">
      <div className="welcome-content">
        <h2>开始新的创作</h2>
        <p>从一个设定、一句话或一段人设开始。</p>
        {(recentStories.length > 0 || recentCreative.length > 0) && (
          <div className="recent-story-list" aria-label="最近创作">
            {recentStories.map((story) => (
              <button key={story.id} type="button" className="recent-story-chip"
                data-testid="welcome-resume-story" onClick={() => onSelectStory(story.id)}>
                <strong>{story.title}</strong>
              </button>
            ))}
            {recentCreative.map((entry) => (
              <button key={entry.id} type="button" className="recent-story-chip" onClick={entry.activate}>
                <strong>{entry.title}</strong>
                {entry.kindLabel && <span>{entry.kindLabel}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="welcome-mode-controls">
        <div className="welcome-mode-pills" role="group" aria-label="创作模式">
          {modes.map(([id, label]) => (
            <button key={id} type="button" className="welcome-mode-pill" aria-pressed={mode === id}
              onClick={() => onModeChange(id)}>{label}</button>
          ))}
        </div>
        {mode === 'character' && (
          <label className="welcome-character-name">
            <span className="visually-hidden">角色名（可选）</span>
            <input
              type="text"
              data-testid="welcome-character-name"
              value={characterName}
              placeholder="角色名（可选）"
              onChange={(event) => onCharacterNameChange(event.target.value)}
            />
          </label>
        )}
        {mode === 'story' && <div className="welcome-quick-actions">
          <button type="button" className="welcome-quick-pill" data-testid="welcome-deepseek-import" onClick={onStartDeepSeekImport}>从 DeepSeek 导入</button>
          <button type="button" className="welcome-quick-pill" data-testid="welcome-script-import" onClick={onStartScriptImport}>导入剧本文件</button>
        </div>}
        {mode === 'writing' && <button type="button" className="welcome-quick-pill" onClick={onStartManuscript}>直接写正文</button>}
      </div>
    </section>
  );
}
