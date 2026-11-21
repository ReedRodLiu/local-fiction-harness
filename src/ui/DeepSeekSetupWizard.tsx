import { useEffect, useRef, useState } from 'react';
import {
  DEEPSEEK_OFFICIAL_KEYS_URL,
  sanitizeApiKeyInput,
  validateApiKeyFormat,
  verifyDeepSeekApiKey,
} from '../harness/index.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';

export interface DeepSeekSetupWizardProps {
  open: boolean;
  initialKey?: string;
  pendingLabel?: string | null;
  verifyUrlBase: string;
  onComplete: (apiKey: string) => void;
  onCancel: () => void;
  onExitComplete: () => void;
  onVerifyingChange?: (isVerifying: boolean) => void;
}

export function DeepSeekSetupWizard({
  open,
  initialKey = '',
  pendingLabel,
  verifyUrlBase,
  onComplete,
  onCancel,
  onExitComplete,
  onVerifyingChange,
}: DeepSeekSetupWizardProps) {
  const [keyDraft, setKeyDraft] = useState(initialKey);
  const [showKey, setShowKey] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allowFallbackSave, setAllowFallbackSave] = useState(false);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const verifySeqRef = useRef(0);

  useEffect(() => {
    onVerifyingChange?.(isVerifying);
    return () => {
      if (isVerifying) onVerifyingChange?.(false);
    };
  }, [isVerifying, onVerifyingChange]);

  const handleOpenPlatform = () => {
    window.open(DEEPSEEK_OFFICIAL_KEYS_URL, '_blank', 'noopener,noreferrer');
  };

  const handleOneClickPaste = async () => {
    setErrorMsg(null);
    setAllowFallbackSave(false);
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('clipboard_unavailable');
      }
      const clipText = await navigator.clipboard.readText();
      const cleaned = sanitizeApiKeyInput(clipText);
      if (!cleaned) {
        setClipboardHint('剪贴板里暂时没有内容，请长按下方输入框选择「粘贴」。');
        inputRef.current?.focus();
        return;
      }
      setKeyDraft(cleaned);
      setClipboardHint('已为你自动粘贴并清理空格。');
    } catch {
      setClipboardHint('请长按下方输入框选择「粘贴」。');
      inputRef.current?.focus();
    }
  };

  const handleVerifyAndSave = async () => {
    if (isVerifying) return;
    const formatCheck = validateApiKeyFormat(keyDraft);
    if (!formatCheck.ok) {
      setErrorMsg(formatCheck.message);
      setAllowFallbackSave(false);
      return;
    }

    const seq = ++verifySeqRef.current;
    setKeyDraft(formatCheck.key);
    setIsVerifying(true);
    setErrorMsg(null);
    setAllowFallbackSave(false);

    const result = await verifyDeepSeekApiKey({
      apiKey: formatCheck.key,
      baseUrl: verifyUrlBase,
    });

    if (verifySeqRef.current !== seq) return;
    setIsVerifying(false);

    if (result.status === 'valid') {
      onComplete(result.key);
      return;
    }

    setErrorMsg(result.message);
    setAllowFallbackSave(result.status === 'network_error');
  };

  const handleFallbackSave = () => {
    const formatCheck = validateApiKeyFormat(keyDraft);
    if (!formatCheck.ok) {
      setErrorMsg(formatCheck.message);
      setAllowFallbackSave(false);
      return;
    }
    onComplete(formatCheck.key);
  };

  return (
    <ModalDialog
      open={open}
      label="连接 DeepSeek 官方"
      className="modal-dialog wizard-dialog"
      testId="deepseek-setup-wizard"
      closeDisabled={isVerifying}
      onClose={onCancel}
      onExitComplete={onExitComplete}
      onCancel={(event) => {
        if (isVerifying) event.preventDefault();
      }}
    >
      <div className="wizard-dialog-content" data-verifying={isVerifying ? 'true' : 'false'}>
        <div className="wizard-header">
          <div>
            <h3 id="wizard-title">连接 DeepSeek</h3>
            <p className="wizard-subtitle">只需 3 步连接官方服务，API Key 仅保存在本机</p>
          </div>
          <button
            type="button"
            className="btn"
            aria-label="关闭引导"
            disabled={isVerifying}
            onClick={onCancel}
          >
            关闭
          </button>
        </div>

        {pendingLabel && (
          <div className="wizard-pending-banner">
            完成连接后将自动继续：<strong>{pendingLabel}</strong>
          </div>
        )}

        <ol className="wizard-steps">
          <li className="wizard-step-card">
            <div className="wizard-step-title">
              <span className="wizard-step-num">1</span>
              <strong>前往 DeepSeek 开放平台</strong>
            </div>
            <p className="wizard-step-desc">
              前往 DeepSeek 开放平台获取 API Key：
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="wizard-open-platform-btn"
              onClick={handleOpenPlatform}
            >
              打开 DeepSeek 开放平台
            </button>
          </li>

          <li className="wizard-step-card">
            <div className="wizard-step-title">
              <span className="wizard-step-num">2</span>
              <strong>创建并复制 API Key</strong>
            </div>
            <ul className="wizard-mini-list">
              <li>使用手机号或微信登录开放平台；</li>
              <li>点左侧菜单「API keys」→「创建 API key」（名称随便填）；</li>
              <li>点击「复制」（密钥只显示一次，请当场复制）。</li>
            </ul>
          </li>

          <li className="wizard-step-card">
            <div className="wizard-step-title">
              <span className="wizard-step-num">3</span>
              <strong>回到这里粘贴并验证</strong>
            </div>
            <div className="wizard-paste-row">
              <button
                type="button"
                className="btn"
                data-testid="wizard-paste-btn"
                disabled={isVerifying}
                onClick={() => void handleOneClickPaste()}
              >
                一键粘贴
              </button>
              {clipboardHint && <span className="status-text">{clipboardHint}</span>}
            </div>

            <div className="field" style={{ marginTop: '8px' }}>
              <label htmlFor="byok-api-key">DeepSeek API Key</label>
              <div className="key-input-row">
                <input
                  ref={inputRef}
                  id="byok-api-key"
                  name="apiKey"
                  type={showKey ? 'text' : 'password'}
                  placeholder="sk-..."
                  value={keyDraft}
                  disabled={isVerifying}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => {
                    setKeyDraft(e.target.value);
                    setErrorMsg(null);
                    setAllowFallbackSave(false);
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  aria-pressed={showKey}
                  disabled={isVerifying}
                  onClick={() => setShowKey((prev) => !prev)}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <p className="wizard-privacy-note">
              模型请求会由你的设备直接发送至 DeepSeek 官方 API；API Key 只保存在本机，不会交给项目方。
            </p>
          </li>
        </ol>

        {errorMsg && <BannerAlert tone="danger" testId="wizard-error">{errorMsg}</BannerAlert>}

        <div className="wizard-footer">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="wizard-verify-save-btn"
            disabled={isVerifying}
            onClick={() => void handleVerifyAndSave()}
          >
            {isVerifying ? '正在验证连接...' : '验证并保存'}
          </button>
          {allowFallbackSave && (
            <button
              type="button"
              className="btn"
              data-testid="wizard-fallback-save-btn"
              disabled={isVerifying}
              onClick={handleFallbackSave}
            >
              先保存，稍后再试
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={isVerifying}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
