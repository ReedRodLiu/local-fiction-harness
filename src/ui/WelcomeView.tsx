import { FilePlus2, Sparkles } from 'lucide-react';
import { getActiveBranchNodes, type Story } from '../harness/index.ts';

interface WelcomeViewProps {
  stories: Story[];
  onStartDeepSeekImport: () => void;
  onStartScriptImport: () => void;
  onSelectStory: (id: string) => void;
}

export function WelcomeView({
  stories,
  onStartDeepSeekImport,
  onStartScriptImport,
  onSelectStory,
}: WelcomeViewProps) {
  const recentStories = [...stories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);

  return (
    <section className="welcome-view" data-testid="welcome-view">
      <div className="welcome-content">
        <h2>开始一段新故事</h2>
        <p>导入你的剧本或 DeepSeek 存档，用自己的密钥继续演绎。内容保存在本机。</p>
        <div className="welcome-actions">
          <button
            type="button"
            className="welcome-card welcome-card-primary"
            data-testid="welcome-deepseek-import"
            onClick={onStartDeepSeekImport}
          >
            <span className="welcome-card-icon"><Sparkles size={18} strokeWidth={1.75} /></span>
            <span><strong>从 DeepSeek 继续</strong><small>导入 .zip 或粘贴下载链接</small></span>
          </button>
          <button
            type="button"
            className="welcome-card"
            data-testid="welcome-script-import"
            onClick={onStartScriptImport}
          >
            <span className="welcome-card-icon"><FilePlus2 size={18} strokeWidth={1.75} /></span>
            <span><strong>导入自由剧本</strong><small>从原始剧本创建一部新故事</small></span>
          </button>
        </div>

        {recentStories.length > 0 && (
          <div className="recent-stories" aria-label="最近继续的故事">
            <h3>最近继续</h3>
            <div className="recent-story-list">
              {recentStories.map((story) => {
                const turnCount = Math.floor(getActiveBranchNodes(story).length / 2);
                return (
                  <button
                    key={story.id}
                    type="button"
                    className="recent-story-chip"
                    data-testid="welcome-resume-story"
                    onClick={() => onSelectStory(story.id)}
                  >
                    <strong>{story.title}</strong>
                    <span>{turnCount} 轮</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
