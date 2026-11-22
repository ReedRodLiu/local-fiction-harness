import { useEffect, useState } from 'react';
import type { AssistantMode, MarkdownVersion } from '../harness/index.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import { toErrorMessage } from './textHelpers.ts';

export interface DocumentEdit {
  title: string;
  description?: string;
  mode?: AssistantMode;
  base: MarkdownVersion;
  history?: MarkdownVersion[];
  proposal?: string;
  apply: (expected: string, markdown: string) => Promise<void>;
  reload?: () => Promise<Pick<DocumentEdit, 'base' | 'history'>>;
}

export function DocumentDialog({ edit, onClose }: { edit: DocumentEdit | null; onClose: () => void }) {
  const [base, setBase] = useState<MarkdownVersion | null>(() => edit?.base ?? null);
  const [history, setHistory] = useState<MarkdownVersion[]>(() => edit?.history ?? []);
  const [draft, setDraft] = useState(() => edit?.proposal ?? edit?.base.markdown ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(() => edit?.proposal !== undefined);
  const [olderDraft, setOlderDraft] = useState<string | null>(null);
  useWebHistoryLayer('markdown-edit', 62, Boolean(edit), onClose, !saving);

  useEffect(() => {
    setBase(edit?.base ?? null);
    setHistory(edit?.history ?? []);
    setDraft(edit?.proposal ?? edit?.base.markdown ?? '');
    setPreview(edit?.proposal !== undefined);
    setError('');
    setOlderDraft(null);
  }, [edit]);

  async function save() {
    if (!edit || !base || saving) return;
    setSaving(true);
    try {
      await edit.apply(base.id, draft);
      onClose();
    } catch (err) {
      setError(toErrorMessage(err, '保存失败。'));
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    if (!edit?.reload || saving) return;
    setSaving(true);
    try {
      const fresh = await edit.reload();
      setOlderDraft(draft);
      setBase(fresh.base);
      setHistory(fresh.history ?? []);
      setDraft(fresh.base.markdown);
      setPreview(false);
      setError('已载入最新版本。请在这份内容上重新编辑。');
    } catch (err) {
      setError(toErrorMessage(err, '读取内容失败。'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog open={Boolean(edit)} label={edit?.title ?? '设定'} testId="markdown-document"
      closeDisabled={saving} onClose={() => { if (!saving) onClose(); }}>
      {edit && (
        <div className="local-document-dialog">
          <h2>{edit.title}</h2>
          {edit.description && <p className="status-text">{edit.description}</p>}
          {error && <BannerAlert tone="danger">{error}</BannerAlert>}
          {error && edit.reload && <button type="button" className="btn" disabled={saving} onClick={() => void reload()}>重新载入</button>}
          <div className="proposal-detail-tabs" role="tablist" aria-label="编辑与预览切换">
            <button
              type="button"
              role="tab"
              aria-selected={!preview}
              className="proposal-detail-tab"
              disabled={saving}
              onClick={() => setPreview(false)}
            >
              编辑
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={preview}
              className="proposal-detail-tab"
              disabled={saving}
              onClick={() => setPreview(true)}
            >
              预览
            </button>
          </div>
          {preview && base ? (
            <section className="document-proposal-preview" data-testid="document-proposal-preview">
              <MarkdownView content={draft || '（暂无内容）'} mode={edit.mode ?? 'writing'} />
            </section>
          ) : (
            <label className="field">
              Markdown 内容
              <textarea value={draft} rows={10} disabled={saving} onChange={(event) => setDraft(event.target.value)} />
            </label>
          )}
          <div className="btn-group">
            <button type="button" className="btn btn-primary" disabled={saving || !base || draft === base.markdown}
              onClick={() => void save()}>确认保存</button>
            <button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button>
          </div>
          {(() => {
            const priorHistory = history.filter((version) => version.id !== base?.id);
            return (priorHistory.length > 0 || olderDraft !== null) && <details className="reasoning-details">
              <summary>历史版本</summary>
              {olderDraft !== null && <div className="local-document-history">
                <span>重新载入前未保存的内容</span>
                <button type="button" className="btn" disabled={saving} onClick={() => { setDraft(olderDraft); setPreview(true); }}>
                  查看并恢复草稿
                </button>
              </div>}
              {priorHistory.map((version) => <div className="local-document-history" key={version.id}>
                <span>{new Date(version.savedAt).toLocaleString()} · {version.source === 'automatic' ? '自动更新' : version.source === 'migration' ? '版本迁移' : '手动保存'}</span>
                <button type="button" className="btn" disabled={saving} onClick={() => { setDraft(version.markdown); setPreview(true); }}>
                  查看并恢复此版
                </button>
              </div>)}
            </details>;
          })()}
        </div>
      )}
    </ModalDialog>
  );
}
