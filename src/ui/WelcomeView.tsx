import { type Story } from '../harness/index.ts';

const modes = [
  ['story', '文游'],
  ['writing', '产粮'],
  ['character', '人机恋'],
] as const;

interface WelcomeViewProps {
  stories: Story[];
  mode: (typeof modes)[number][0];
  onModeChange: (mode: WelcomeViewProps['mode']) => void;
  onStartDeepSeekImport: () => void;
  onStartScriptImport: () => void;
  onStartManuscript: () => void;
  onSelectStory: (id: string) => void;
  recentCreative: Array<{ id: string; title: string; activate: () => void }>;
}

export function WelcomeView({
  stories,
  mode,
  onModeChange,
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
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="welcome-mode-controls">
        <div className="recent-story-list" role="group" aria-label="创作模式">
          {modes.map(([id, label]) => (
            <button key={id} type="button" className="btn" aria-pressed={mode === id}
              onClick={() => onModeChange(id)}>{label}</button>
          ))}
        </div>
        {mode === 'story' && <div className="recent-story-list">
          <button type="button" className="btn btn-sm" data-testid="welcome-deepseek-import" onClick={onStartDeepSeekImport}>从 DeepSeek 导入</button>
          <button type="button" className="btn btn-sm" data-testid="welcome-script-import" onClick={onStartScriptImport}>导入剧本文件</button>
        </div>}
        {mode === 'writing' && <button type="button" className="btn btn-sm" onClick={onStartManuscript}>直接写正文</button>}
      </div>
    </section>
  );
}
