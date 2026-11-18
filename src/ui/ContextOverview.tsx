import { useEffect, useState } from 'react';
import {
  type PlotSummarySnapshot,
  type Story,
  type StoryBlueprint,
  type ThreeZoneMetrics,
} from '../harness/index.ts';
import { splitNonEmptyLines, toErrorMessage } from './textHelpers.ts';

interface ContextOverviewProps {
  story: Story;
  summarySnapshot: PlotSummarySnapshot;
  metrics: ThreeZoneMetrics;
  isStreaming: boolean;
  isReextracting?: boolean;
  onSaveBlueprintTweak: (updatedBlueprint: StoryBlueprint) => Promise<boolean | void>;
  onReextractBlueprint?: () => void;
}

export function ContextOverview({
  story,
  summarySnapshot,
  metrics,
  isStreaming,
  isReextracting = false,
  onSaveBlueprintTweak,
  onReextractBlueprint,
}: ContextOverviewProps) {
  const [editingBlueprint, setEditingBlueprint] = useState(false);
  const [protagonistDraft, setProtagonistDraft] = useState('');
  const [taboosDraft, setTaboosDraft] = useState('');
  const [isSavingTweak, setIsSavingTweak] = useState(false);
  const [tweakError, setTweakError] = useState<string | null>(null);

  useEffect(() => {
    setEditingBlueprint(false);
    setTweakError(null);
  }, [story.id]);

  const handleSaveTweak = async () => {
    if (isSavingTweak || isStreaming) return;
    setIsSavingTweak(true);
    setTweakError(null);
    try {
      const saved = await onSaveBlueprintTweak({
        ...story.blueprint,
        protagonist: protagonistDraft.trim(),
        taboos: splitNonEmptyLines(taboosDraft),
      });
      if (saved !== false) {
        setEditingBlueprint(false);
      }
    } catch (err) {
      setTweakError(toErrorMessage(err, '保存蓝图微调失败。'));
    } finally {
      setIsSavingTweak(false);
    }
  };

  const hasBlueprintOrScript =
    Boolean(story.rawScript) || story.blueprint.worldRules.length > 0;

  return (
    <div className="overview-stack">
      {hasBlueprintOrScript && (
        <details className="reasoning-details">
          <summary>
            故事蓝图与原始剧本锚定（原文 {story.rawScript.length} 字符）
          </summary>
          <div className="blueprint-summary">
            {editingBlueprint ? (
              <div className="config-form" style={{ marginTop: '0.5rem' }}>
                {tweakError && (
                  <div className="error-banner" role="alert">
                    {tweakError}
                  </div>
                )}
                <div className="field">
                  <label htmlFor="tweak-protagonist">微调主角设定</label>
                  <input
                    id="tweak-protagonist"
                    type="text"
                    value={protagonistDraft}
                    onChange={(e) => setProtagonistDraft(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tweak-taboos">微调禁忌条款（每行一条）</label>
                  <textarea
                    id="tweak-taboos"
                    rows={2}
                    value={taboosDraft}
                    onChange={(e) => setTaboosDraft(e.target.value)}
                  />
                </div>
                <div className="btn-group">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={isSavingTweak || isStreaming}
                    onClick={() => void handleSaveTweak()}
                  >
                    保存蓝图微调
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isSavingTweak}
                    onClick={() => {
                      setTweakError(null);
                      setEditingBlueprint(false);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                {story.blueprint.protagonist && (
                  <p>
                    <strong>主角：</strong>
                    {story.blueprint.protagonist}
                  </p>
                )}
                {story.blueprint.worldRules.length > 0 && (
                  <p>
                    <strong>规则：</strong>
                    {story.blueprint.worldRules.join('；')}
                  </p>
                )}
                {story.blueprint.taboos.length > 0 && (
                  <p>
                    <strong>禁忌：</strong>
                    {story.blueprint.taboos.join('；')}
                  </p>
                )}
                {story.blueprint.npcs.length > 0 && (
                  <p>
                    <strong>角色：</strong>
                    {story.blueprint.npcs
                      .map((n) => `${n.name}${n.role ? `(${n.role})` : ''}`)
                      .join('、')}
                  </p>
                )}
                <div className="btn-group">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setProtagonistDraft(story.blueprint.protagonist);
                      setTaboosDraft(story.blueprint.taboos.join('\n'));
                      setEditingBlueprint(true);
                    }}
                  >
                    微调蓝图
                  </button>
                  {story.rawScript.trim() &&
                    story.blueprint.extractionStatus === 'partial_fallback' &&
                    onReextractBlueprint && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={isStreaming || isReextracting}
                        onClick={onReextractBlueprint}
                      >
                        {isReextracting ? '补拆蓝图中…' : '补拆蓝图'}
                      </button>
                    )}
                </div>
              </>
            )}
          </div>
        </details>
      )}

      <details className="reasoning-details" data-testid="context-overview">
        <summary>
          三区上下文详情（估算 {metrics.totalEstimatedTokens} tokens · 已压缩{' '}
          {summarySnapshot.summarizedTurnCount} 条历史）
        </summary>
        <div className="blueprint-summary">
          <p>
            <strong>三区占比：</strong>
            固定锚定 {metrics.anchorChars} 字 / 滚动摘要 {metrics.summaryChars} 字 / 近期窗口{' '}
            {metrics.recentNodeCount} 条（{metrics.recentChars} 字）
          </p>
        </div>
      </details>
    </div>
  );
}
