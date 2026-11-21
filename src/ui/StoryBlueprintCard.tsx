import { useEffect, useState } from 'react';
import { type Story, type StoryBlueprint } from '../harness/index.ts';
import { splitNonEmptyLines, toErrorMessage } from './textHelpers.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';

export interface StoryBlueprintCardProps {
  story: Story;
  isBusy?: boolean;
  isReextracting?: boolean;
  onSaveBlueprintTweak?: (updatedBlueprint: StoryBlueprint) => Promise<boolean | void>;
  onReextractBlueprint?: () => void;
}

export function StoryBlueprintCard({
  story,
  isBusy = false,
  isReextracting = false,
  onSaveBlueprintTweak,
  onReextractBlueprint,
}: StoryBlueprintCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StoryBlueprint | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [story.id]);

  const saveTweak = async () => {
    if (!onSaveBlueprintTweak || isSaving || isBusy) return;
    setIsSaving(true);
    setError(null);
    try {
      if (!draft) return;
      const saved = await onSaveBlueprintTweak(draft);
      if (saved !== false) setEditing(false);
    } catch (err) {
      setError(toErrorMessage(err, '保存蓝图微调失败。'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="story-blueprint-card" data-testid="story-blueprint-card" aria-label="故事蓝图">
      <header className="story-blueprint-header">
        <div>
          <h3>{story.title}</h3>
          <p>原始剧本锚定 {story.rawScript.length} 字</p>
        </div>
        {onSaveBlueprintTweak && !editing && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={isBusy}
            onClick={() => {
              setDraft({
                ...story.blueprint,
                worldRules: [...story.blueprint.worldRules],
                npcs: story.blueprint.npcs.map((npc) => ({ ...npc })),
                taboos: [...story.blueprint.taboos],
              });
              setEditing(true);
            }}
          >
            微调
          </button>
        )}
      </header>

      {error && <BannerAlert tone="danger">{error}</BannerAlert>}

      {editing ? (
        <div className="story-blueprint-editor" data-testid="story-blueprint-editor">
          <div className="field">
            <label htmlFor="tweak-protagonist">微调主角设定</label>
            <input
              id="tweak-protagonist"
              type="text"
              value={draft?.protagonist ?? ''}
              onChange={(event) => setDraft((current) => current
                ? { ...current, protagonist: event.target.value }
                : current)}
            />
          </div>
          <div className="field">
            <label htmlFor="tweak-world-rules">背景规则（每行一条）</label>
            <textarea
              id="tweak-world-rules"
              rows={3}
              value={draft?.worldRules.join('\n') ?? ''}
              onChange={(event) => setDraft((current) => current
                ? { ...current, worldRules: splitNonEmptyLines(event.target.value) }
                : current)}
            />
          </div>
          <fieldset className="story-blueprint-editor-npcs" aria-label="关键角色">
            <legend>关键角色</legend>
            {draft?.npcs.map((npc, index) => (
              <div className="story-blueprint-editor-npc" key={`${index}-${npc.name}`}>
                <label className="field">姓名
                  <input value={npc.name} onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    npcs: current.npcs.map((item, itemIndex) => itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item),
                  } : current)} />
                </label>
                <label className="field">身份
                  <input value={npc.role} onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    npcs: current.npcs.map((item, itemIndex) => itemIndex === index
                      ? { ...item, role: event.target.value }
                      : item),
                  } : current)} />
                </label>
                <label className="field">特征
                  <input value={npc.traits} onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    npcs: current.npcs.map((item, itemIndex) => itemIndex === index
                      ? { ...item, traits: event.target.value }
                      : item),
                  } : current)} />
                </label>
                <button type="button" className="btn btn-sm" aria-label={`删除角色 ${npc.name || index + 1}`}
                  onClick={() => setDraft((current) => current ? {
                    ...current, npcs: current.npcs.filter((_, itemIndex) => itemIndex !== index),
                  } : current)}>删除角色</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setDraft((current) => current
              ? { ...current, npcs: [...current.npcs, { name: '', role: '', traits: '' }] }
              : current)}>添加角色</button>
          </fieldset>
          <div className="field">
            <label htmlFor="tweak-taboos">微调禁忌条款（每行一条）</label>
            <textarea
              id="tweak-taboos"
              rows={2}
              value={draft?.taboos.join('\n') ?? ''}
              onChange={(event) => setDraft((current) => current
                ? { ...current, taboos: splitNonEmptyLines(event.target.value) }
                : current)}
            />
          </div>
          <div className="field">
            <label htmlFor="tweak-opening-hook">开场提示</label>
            <textarea
              id="tweak-opening-hook"
              rows={3}
              value={draft?.openingHook ?? ''}
              onChange={(event) => setDraft((current) => current
                ? { ...current, openingHook: event.target.value }
                : current)}
            />
          </div>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={isSaving || isBusy}
              onClick={() => void saveTweak()}
            >
              保存蓝图微调
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isSaving}
              onClick={() => {
                setError(null);
                setEditing(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="story-blueprint-fields">
          <div className="story-blueprint-field">
            <h4>主角设定</h4>
            <p>{story.blueprint.protagonist || '暂无主角设定'}</p>
          </div>
          <div className="story-blueprint-field">
            <h4>背景规则</h4>
            {story.blueprint.worldRules.length > 0 ? (
              <ul>{story.blueprint.worldRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
            ) : <p>暂无背景规则</p>}
          </div>
          <div className="story-blueprint-field">
            <h4>核心角色</h4>
            {story.blueprint.npcs.length > 0 ? (
              <ul>
                {story.blueprint.npcs.map((npc) => (
                  <li key={`${npc.name}-${npc.role}`}>{npc.name}{npc.role ? `（${npc.role}）` : ''}</li>
                ))}
              </ul>
            ) : <p>暂无角色档案</p>}
          </div>
          <div className="story-blueprint-field">
            <h4>禁忌条款</h4>
            {story.blueprint.taboos.length > 0 ? (
              <ul>{story.blueprint.taboos.map((taboo) => <li key={taboo}>{taboo}</li>)}</ul>
            ) : <p>暂无禁忌条款</p>}
          </div>
          <div className="story-blueprint-field">
            <h4>开场提示</h4>
            <p>{story.blueprint.openingHook || '暂无开场提示'}</p>
          </div>
        </div>
      )}

      {!editing && story.rawScript.trim() &&
        story.blueprint.extractionStatus === 'partial_fallback' && onReextractBlueprint && (
          <button
            type="button"
            className="btn btn-sm btn-primary story-blueprint-reextract"
            disabled={isBusy || isReextracting}
            onClick={onReextractBlueprint}
          >
            {isReextracting ? '补拆蓝图中…' : '补拆完整故事蓝图'}
          </button>
        )}
    </section>
  );
}
