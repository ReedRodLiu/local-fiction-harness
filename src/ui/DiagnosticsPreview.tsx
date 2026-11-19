import { useState } from 'react';
import { Clipboard, Download, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { DiagnosticBundle } from '../harness/index.ts';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { toErrorMessage } from './textHelpers.ts';

interface DiagnosticsPreviewProps {
  buildBundle: () => DiagnosticBundle;
  onExport: (fileName: string, jsonContent: string) => Promise<void>;
  onClose: () => void;
  reassurance?: string;
  onReload?: () => void;
}

export function DiagnosticsPreview({
  buildBundle,
  onExport,
  onClose,
  reassurance,
  onReload,
}: DiagnosticsPreviewProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [includeActiveStory, setIncludeActiveStory] = useState(true);
  const [bundleSnapshot] = useState(() => buildBundle());
  const { activeStorySkeleton: _activeStorySkeleton, ...bundleWithoutSkeleton } = bundleSnapshot;
  const jsonText = JSON.stringify(
    includeActiveStory ? bundleSnapshot : bundleWithoutSkeleton,
    null,
    2,
  );

  const handleExport = async () => {
    setNotice(null);
    setFailure(null);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await onExport(`lfh-diagnostics-${stamp}.json`, jsonText);
      setNotice('已导出脱敏诊断包。');
    } catch (err) {
      setFailure(toErrorMessage(err, '导出脱敏诊断包失败。'));
    }
  };

  const handleCopy = async () => {
    setNotice(null);
    setFailure(null);
    try {
      await navigator.clipboard.writeText(jsonText);
      setNotice('已复制到剪贴板。');
    } catch (err) {
      setFailure(toErrorMessage(err, '复制失败，请改用导出文件。'));
    }
  };

  return (
    <ModalDialog
      open
      label="脱敏诊断包预览"
      className="modal-dialog diagnostics-dialog"
      testId="diagnostics-preview"
      onClose={onClose}
    >
      <div className="diagnostics-content">
        <header className="diagnostics-header">
          <div>
            <h2>脱敏诊断包</h2>
            <p>最近 30 分钟运行摘要，可先预览再导出。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭诊断预览"
            data-testid="diagnostics-close"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="diagnostics-safe" role="note" data-testid="diagnostics-safety">
          <ShieldCheck size={20} strokeWidth={1.75} aria-hidden="true" />
          <span><strong>零正文、零剧本、零密钥</strong>，只保留运行结构与计数。</span>
        </div>
        {reassurance && <p className="diagnostics-reassurance">{reassurance}</p>}

        <div className="diagnostics-action-row">
          {onReload && (
            <button type="button" className="btn" data-testid="diagnostics-reload" onClick={onReload}>
              <RotateCcw size={18} strokeWidth={1.75} />
              重新载入界面
            </button>
          )}
          <button
            type="button"
            className="btn"
            data-testid="diagnostics-copy"
            onClick={() => void handleCopy()}
          >
            <Clipboard size={18} strokeWidth={1.75} />
            复制到剪贴板
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="diagnostics-export"
            onClick={() => void handleExport()}
          >
            <Download size={18} strokeWidth={1.75} />
            导出 .json
          </button>
        </div>

        <label className="checkbox-row diagnostics-checkbox" htmlFor="diagnostics-active-story">
          <input
            id="diagnostics-active-story"
            data-testid="diagnostics-active-story"
            type="checkbox"
            checked={includeActiveStory}
            onChange={(event) => setIncludeActiveStory(event.target.checked)}
          />
          <span>附带当前故事匿名树骨架</span>
        </label>
        <p className="diagnostics-note">
          不含剧本、对话正文、推理链、剧情摘要、故事标题、分支名称、附件文件名与 API Key。私人中转域名仅以哈希显示。
        </p>

        <pre className="diagnostics-json" data-testid="diagnostics-json">
          {jsonText}
        </pre>

        {notice && <div className="status-text" role="status">{notice}</div>}
        {failure && <div className="error-banner" role="alert">{failure}</div>}
      </div>
    </ModalDialog>
  );
}
