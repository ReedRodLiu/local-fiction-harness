import { Sparkles } from 'lucide-react';
import type { Story, TurnNode } from '../harness/index.ts';
import { MessageContent } from './MessageContent.tsx';
import { useRotatingWaitingPhrase } from './waitingPhrases.ts';

export interface RecentCreativeEntry {
  id: string;
  title: string;
  kindLabel?: string;
  activate: () => void;
}

export interface WelcomeViewProps {
  stories: Story[];
  recentCreative: RecentCreativeEntry[];
  neutralTurns: TurnNode[];
  isStreaming: boolean;
  streamContent: string;
  streamReasoning: string;
  onSelectStory: (id: string) => void;
}

export function WelcomeView({
  stories,
  recentCreative,
  neutralTurns,
  isStreaming,
  streamContent,
  streamReasoning,
  onSelectStory,
}: WelcomeViewProps) {
  const recentStories = [...stories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const hasAnyItems = recentStories.length > 0 || recentCreative.length > 0;
  const inNeutralChat = neutralTurns.length > 0 || isStreaming;
  const waitingPhrase = useRotatingWaitingPhrase({
    scene: 'welcome',
    active: isStreaming && !streamContent.trim(),
  });

  if (inNeutralChat) {
    return (
      <section className="timeline neutral-timeline" data-testid="neutral-timeline" aria-label="自然语言对话">
        <div className="neutral-stage-hint" data-testid="neutral-stage-hint" role="note">
          尚未建档，聊清楚创作方向后会自动保存至对应分类
        </div>
        {neutralTurns.map((node) => (
          <article
            key={node.id}
            className={`turn-card ${node.role}`}
            data-testid={node.role === 'user' ? 'turn-user' : 'turn-assistant'}
            data-node-id={node.id}
          >
            <div className="turn-expanded-content">
              {node.reasoningContent && (
                <details className="reasoning-details" data-testid="reasoning-details">
                  <summary data-testid="reasoning-toggle">
                    <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>已思考</span>
                  </summary>
                  <div className="reasoning-content" data-testid="reasoning-content">
                    {node.reasoningContent}
                  </div>
                </details>
              )}
              {node.role === 'user' ? (
                <div className="turn-user-row">
                  <div className="turn-user-bubble" data-testid="user-bubble">
                    {node.content}
                  </div>
                </div>
              ) : (
                <MessageContent content={node.content} mode="writing" />
              )}
            </div>
          </article>
        ))}

        {isStreaming && (
          <article className="turn-card assistant turn-streaming" data-testid="turn-assistant" aria-live="polite">
            {streamReasoning && (
              <details className="reasoning-details" data-testid="reasoning-details" open>
                <summary data-testid="reasoning-toggle">
                  <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{waitingPhrase}</span>
                </summary>
                <div className="reasoning-content">{streamReasoning}</div>
              </details>
            )}
            {streamContent ? (
              <MessageContent content={streamContent} mode="writing" />
            ) : (
              <div className="turn-body">{waitingPhrase}</div>
            )}
          </article>
        )}
      </section>
    );
  }

  return (
    <section className="welcome-view welcome-creation" data-testid="welcome-view">
      <div className="welcome-content">
        <h2>从一句话开始</h2>
        <p>想玩互动文游、一起写故事，还是找角色聊天？直接输入就行。</p>

        {!hasAnyItems && (
          <p className="welcome-empty-guidance" data-testid="welcome-empty-guidance">
            试试说：「开一个雨夜车站的悬疑文游」「帮我写一段都市奇幻小说开头」或「建个毒舌猫系角色陪我聊天」
          </p>
        )}

        {hasAnyItems && (
          <div className="recent-story-list" aria-label="最近创作">
            {recentStories.map((story) => (
              <button
                key={story.id}
                type="button"
                className="recent-story-chip"
                data-testid="welcome-resume-story"
                onClick={() => onSelectStory(story.id)}
              >
                <strong>{story.title}</strong>
              </button>
            ))}
            {recentCreative.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="recent-story-chip"
                onClick={entry.activate}
              >
                <strong>{entry.title}</strong>
                {entry.kindLabel && <span>{entry.kindLabel}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
