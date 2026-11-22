import { useMemo, useState } from 'react';
import { CheckCircle2, Clipboard, Download, RotateCcw, ShieldCheck, X } from 'lucide-react';
import {
  formatDiagnosticBundleFileName,
  sanitizeDiagnosticText,
  type DiagnosticBundle,
} from '../harness/index.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { toErrorMessage } from './textHelpers.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

export interface DiagnosticsPreviewProps {
  open: boolean;
  buildBundle: (options?: { userNote?: string }) => DiagnosticBundle;
  onExport: (fileName: string, jsonContent: string) => Promise<void>;
  onClose: () => void;
  onExitComplete: () => void;
  reassurance?: string;
  onReload?: () => void;
  onRecordDiagnostic?: (action: 'diagnostics_exported' | 'diagnostics_shared') => void;
}

export function buildDiagnosticsExportPayload(
  rawBundle: DiagnosticBundle,
  options: { includeWorkspaceSkeleton: boolean; userNote: string },
): { bundle: DiagnosticBundle; jsonText: string } {
  const collapsedNote = options.userNote.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const sanitizedNote = collapsedNote ? sanitizeDiagnosticText(collapsedNote, 280).trim() : '';

  const base = options.includeWorkspaceSkeleton
    ? { ...rawBundle }
    : (() => {
        const {
          activeStorySkeleton: _activeStorySkeleton,
          workspaceSkeleton: _workspaceSkeleton,
          ...rest
        } = rawBundle;
        return rest;
      })();

  const bundle: DiagnosticBundle = sanitizedNote
    ? { ...base, userNote: rawBundle.userNote || sanitizedNote }
    : (() => {
        const { userNote: _ignored, ...rest } = base;
        return rest;
      })();

  return {
    bundle,
    jsonText: JSON.stringify(bundle, null, 2),
  };
}

export function DiagnosticsPreview({
  open,
  buildBundle,
  onExport,
  onClose,
  onExitComplete,
  reassurance,
  onReload,
  onRecordDiagnostic,
}: DiagnosticsPreviewProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [userNote, setUserNote] = useState('');
  const [includeWorkspaceSkeleton, setIncludeWorkspaceSkeleton] = useState(true);
  const [bundleSnapshot] = useState(() => buildBundle());

  useWebHistoryLayer('diagnostics', 1000, true, onClose);

  const { jsonText } = useMemo(
    () =>
      buildDiagnosticsExportPayload(bundleSnapshot, {
        includeWorkspaceSkeleton,
        userNote,
      }),
    [bundleSnapshot, includeWorkspaceSkeleton, userNote],
  );

  const buildFreshJson = () => {
    const trimmed = userNote.trim();
    const freshBundle = buildBundle(trimmed ? { userNote: trimmed } : undefined);
    return buildDiagnosticsExportPayload(freshBundle, {
      includeWorkspaceSkeleton,
      userNote,
    }).jsonText;
  };

  const handleExport = async () => {
    setNotice(null);
    setFailure(null);
    try {
      const payload = buildFreshJson();
      await onExport(formatDiagnosticBundleFileName(), payload);
      onRecordDiagnostic?.('diagnostics_exported');
      setNotice('已导出排障日志包。');
    } catch (err) {
      setFailure(toErrorMessage(err, '导出排障日志失败，请改用复制到剪贴板。'));
    }
  };

  const handleCopy = async () => {
    setNotice(null);
    setFailure(null);
    try {
      const payload = buildFreshJson();
      await navigator.clipboard.writeText(payload);
      setNotice('已复制到剪贴板。');
    } catch (err) {
      setFailure(toErrorMessage(err, '复制失败，请改用导出日志包。'));
    }
  };

  return (
    <ModalDialog
      open={open}
      label="导出排障日志"
      className="modal-dialog diagnostics-dialog"
      testId="diagnostics-preview"
      onClose={onClose}
      onExitComplete={onExitComplete}
    >
      <div className="diagnostics-content">
        <header className="diagnostics-header">
          <div>
            <h2>导出排障日志</h2>
            <p>用于向开发者反馈问题，导出前可先确认以下隐私清单。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭导出排障日志"
            data-testid="diagnostics-close"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <section className="diagnostics-checklist" role="note" data-testid="diagnostics-safety">
          <div className="diagnostics-checklist-item diagnostics-checklist-include">
            <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>将包含：最近 60 分钟运行记录、设备与版本信息、当前结构统计</span>
          </div>
          <div className="diagnostics-checklist-item diagnostics-checklist-exclude">
            <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>绝不包含：你的剧本、设定正文、聊天记录与 DeepSeek 密钥</span>
          </div>
        </section>

        {reassurance && <p className="diagnostics-reassurance">{reassurance}</p>}

        <div className="field diagnostics-note-field">
          <label htmlFor="diagnostics-user-note">遇到什么问题？（选填）</label>
          <input
            id="diagnostics-user-note"
            data-testid="diagnostics-user-note"
            type="text"
            maxLength={280}
            value={userNote}
            placeholder="例如：切换分支后画面卡住（请勿填写剧本正文或密钥）"
            onChange={(event) => setUserNote(event.target.value)}
          />
        </div>

        <label className="checkbox-row diagnostics-checkbox" htmlFor="diagnostics-active-story">
          <input
            id="diagnostics-active-story"
            data-testid="diagnostics-active-story"
            type="checkbox"
            checked={includeWorkspaceSkeleton}
            onChange={(event) => setIncludeWorkspaceSkeleton(event.target.checked)}
          />
          <span>附带工作区匿名结构计数</span>
        </label>

        <div className="diagnostics-action-row">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="diagnostics-export"
            onClick={() => void handleExport()}
          >
            <Download size={18} strokeWidth={1.75} />
            分享 / 导出日志包
          </button>
          <button
            type="button"
            className="btn"
            data-testid="diagnostics-copy"
            onClick={() => void handleCopy()}
          >
            <Clipboard size={18} strokeWidth={1.75} />
            复制到剪贴板
          </button>
          {onReload && (
            <button type="button" className="btn" data-testid="diagnostics-reload" onClick={onReload}>
              <RotateCcw size={18} strokeWidth={1.75} />
              重新载入界面
            </button>
          )}
        </div>

        <details className="diagnostics-raw-details" data-testid="diagnostics-raw-details">
          <summary>查看原始 JSON</summary>
          <pre className="diagnostics-json" data-testid="diagnostics-json">
            {jsonText}
          </pre>
        </details>

        {notice && <div className="status-text" role="status">{notice}</div>}
        {failure && <BannerAlert tone="danger">{failure}</BannerAlert>}
      </div>
    </ModalDialog>
  );
}
