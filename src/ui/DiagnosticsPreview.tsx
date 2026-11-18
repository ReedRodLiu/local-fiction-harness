import { useEffect, useRef, useState } from 'react';
import type { DiagnosticBundle } from '../harness/index.ts';
import { toErrorMessage } from './textHelpers.ts';

interface DiagnosticsPreviewProps {
  buildBundle: () => DiagnosticBundle;
  onExport: (fileName: string, jsonContent: string) => Promise<void>;
  onClose: () => void;
}

export function DiagnosticsPreview({
  buildBundle,
  onExport,
  onClose,
}: DiagnosticsPreviewProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [jsonText] = useState(() => JSON.stringify(buildBundle(), null, 2));

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

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
    <dialog
      ref={dialogRef}
      className="modal-card"
      aria-label="脱敏诊断包预览"
      data-testid="diagnostics-preview"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="panel-header">
        <h4>脱敏诊断包预览（最近 30 分钟）</h4>
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      </header>
      <p className="status-text" style={{ margin: 0 }}>
        以下即为将导出的全部内容，不含剧本、对话正文、推理链、剧情摘要、故事标题、分支名称、附件文件名与
        API Key。私人中转域名仅以哈希显示。你可以将诊断包保存到本机、通过 Android 系统分享或复制到剪贴板。
      </p>
      <pre className="diagnostics-json" data-testid="diagnostics-json">
        {jsonText}
      </pre>
      {notice && (
        <div className="status-text" role="status">
          {notice}
        </div>
      )}
      {failure && (
        <div className="error-banner" role="alert">
          {failure}
        </div>
      )}
      <div className="btn-group">
        <button type="button" className="btn btn-primary" onClick={() => void handleExport()}>
          导出 .json
        </button>
        <button type="button" className="btn" onClick={() => void handleCopy()}>
          复制到剪贴板
        </button>
      </div>
    </dialog>
  );
}
