import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, LifeBuoy, ShieldCheck } from 'lucide-react';
import { maskApiKey, type ModelConfig } from '../harness/index.ts';
import {
  DISPLAY_FONT_SIZES,
  type DisplayFontSize,
  type DisplayThemePreference,
} from './displayPreferences.ts';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';

export interface SettingsPageProps {
  appVersion: string;
  hasCredentials: boolean;
  config: ModelConfig;
  useDevEnvKey: boolean;
  showDevTestProxy: boolean;
  themePreference: DisplayThemePreference;
  fontSize: DisplayFontSize;
  canExportCurrentStory: boolean;
  currentStoryTitle: string;
  onBack: () => void;
  onOpenSetupWizard: () => void;
  onClearSavedKey: () => void;
  onApplyDevTestConfig: () => void;
  onOpenDiagnostics: () => void;
  onOpenPublicMemory: () => void;
  onExportCurrentStory: () => void;
  onExportFullBackup?: () => void;
  canExportFullBackup?: boolean;
  backupSummaryText?: string;
  onImportBackupFile: (file: File) => void;
  onThemePreferenceChange: (preference: DisplayThemePreference) => void;
  onFontSizeChange: (fontSize: DisplayFontSize) => void;
}

const THEME_OPTIONS: Array<{
  value: DisplayThemePreference;
  label: string;
}> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深邃炭黑' },
  { value: 'warm', label: '暖纸护眼' },
];

const FONT_SIZE_OPTIONS: readonly DisplayFontSize[] = DISPLAY_FONT_SIZES;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsPage({
  appVersion,
  hasCredentials,
  config,
  useDevEnvKey,
  showDevTestProxy,
  themePreference,
  fontSize,
  canExportCurrentStory,
  currentStoryTitle,
  onBack,
  onOpenSetupWizard,
  onClearSavedKey,
  onApplyDevTestConfig,
  onOpenDiagnostics,
  onOpenPublicMemory,
  onExportCurrentStory,
  onExportFullBackup,
  canExportFullBackup,
  backupSummaryText,
  onImportBackupFile,
  onThemePreferenceChange,
  onFontSizeChange,
}: SettingsPageProps) {
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [storageStatus, setStorageStatus] = useState('正在读取本地占用…');

  const handleBackupExport = onExportFullBackup ?? onExportCurrentStory;
  const exportEnabled = canExportFullBackup ?? (Boolean(onExportFullBackup) || canExportCurrentStory);

  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      setStorageStatus('当前浏览器未提供本地占用估算，数据仍只保存在本机。');
      return;
    }
    void navigator.storage
      .estimate()
      .then((estimate) => {
        if (cancelled) return;
        const usage = formatBytes(estimate.usage ?? 0);
        const quota = estimate.quota === undefined ? null : formatBytes(estimate.quota);
        setStorageStatus(
          quota
            ? `已用约 ${usage}，可用上限约 ${quota}；由浏览器估算。`
            : `已用约 ${usage}；由浏览器估算。`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setStorageStatus('暂时无法读取本地占用；数据仍只保存在本机。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <OverlayPageShell title="设置" testId="settings-page" onBack={onBack}>
      <InsetGroup
        title="连接 DeepSeek"
        description="API Key 只保存在你的设备上，应用会直接连接 DeepSeek 官方服务。"
        testId="settings-connection-group"
      >
        <section className="connected-key-card" data-testid="deepseek-connection-card" aria-label="DeepSeek 连接状态">
          <div className="connected-key-header">
            <strong>{hasCredentials ? '已连接 DeepSeek' : '未连接 DeepSeek'}</strong>
            <span
              className={`badge ${hasCredentials ? 'badge-ok' : 'badge-pending'}`}
              data-testid={hasCredentials && !useDevEnvKey && config.apiKey ? 'connected-key-mask' : undefined}
            >
              {hasCredentials
                ? useDevEnvKey
                  ? '开发代理'
                  : maskApiKey(config.apiKey) || '本地已连接'
                : '未连接'}
            </span>
          </div>
          <p className="wizard-privacy-note">
            请求会由你的设备直接发送至 DeepSeek 官方 API；API Key 仅保存在本机，不会上传至第三方。
          </p>
          {hasCredentials ? (
            <div className="settings-button-row">
              <button type="button" className="btn" data-testid="change-key-btn" onClick={onOpenSetupWizard}>
                更换 API Key
              </button>
              <button type="button" className="btn" data-testid="clear-key-btn" onClick={onClearSavedKey}>
                断开连接
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" data-testid="open-setup-wizard-btn" onClick={onOpenSetupWizard}>
              连接 DeepSeek
            </button>
          )}
          {import.meta.env.DEV && showDevTestProxy && (
            <button type="button" className="btn" data-testid="dev-proxy-toggle" onClick={onApplyDevTestConfig}>
              使用本地 .env.local 测试代理
            </button>
          )}
        </section>
        <p className="settings-privacy"><ShieldCheck size={16} strokeWidth={1.75} /> 不含项目方代理或云端存储。</p>
      </InsetGroup>

      <InsetGroup
        title="阅读与外观"
        description="主题与字号会立即应用到当前设备，重启后仍会保留。"
        testId="settings-appearance-group"
      >
        <section className="appearance-preview" data-testid="settings-appearance-preview" aria-label="阅读效果预览">
          <p className="appearance-preview-kicker">实时预览</p>
          <p className="settings-reading-preview-user" data-testid="appearance-player-preview">
            我推开窗，决定沿着微亮的走廊继续前行。
          </p>
          <p className="appearance-narrative-preview" data-testid="appearance-narrative-preview">
            夜风穿过半开的窗，远处的钟声缓慢落下。你听见门外传来脚步声，故事仍在等待你的选择。
          </p>
        </section>

        <div className="settings-control-block">
          <h3>主题</h3>
          <div className="theme-option-grid" role="group" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="theme-option"
                data-testid={`theme-option-${option.value}`}
                aria-pressed={themePreference === option.value}
                onClick={() => onThemePreferenceChange(option.value)}
              >
                <span
                  className="settings-theme-swatches"
                  data-theme={option.value === 'system' ? 'light' : option.value}
                  aria-hidden="true"
                >
                  <span className="settings-theme-preview-bubble" />
                  <span className="settings-theme-preview-lines">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-control-block">
          <h3>正文字号</h3>
          <div className="font-size-segmented" role="group" aria-label="正文字号">
            {FONT_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                type="button"
                data-testid={`font-size-option-${size}`}
                aria-pressed={fontSize === size}
                onClick={() => onFontSizeChange(size)}
              >
                {size}px
              </button>
            ))}
          </div>
        </div>
      </InsetGroup>

      <InsetGroup title="我的记忆" description="管理跨故事、作品与角色共用的个人偏好与长期记忆。">
        <button type="button" className="btn" data-testid="open-my-memory" onClick={onOpenPublicMemory}>
          管理我的记忆
        </button>
      </InsetGroup>

      <InsetGroup
        title="全量数据备份与恢复"
        description="导出全部文游、写故事、角色互动、我的记忆与显示偏好；支持从 .folio.json 或旧版 .lfh.json 恢复。"
        testId="settings-backup-group"
      >
        <div className="settings-data-row">
          <div>
            <strong>工作区数据</strong>
            <p>
              {backupSummaryText ||
                (canExportCurrentStory ? `当前包含「${currentStoryTitle}」等本地内容（不含密钥）` : '包含全部本地创作内容与偏好（不含密钥）')}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            data-testid="export-current-story"
            disabled={!exportEnabled}
            onClick={handleBackupExport}
          >
            <Download size={18} strokeWidth={1.75} /> 导出全量备份 (.folio.json)
          </button>
        </div>
        <input
          ref={backupInputRef}
          type="file"
          accept=".folio.json,.lfh.json,.json,application/json"
          aria-label="从备份恢复"
          data-testid="backup-import-input"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImportBackupFile(file);
          }}
        />
        <button type="button" className="btn" data-testid="restore-backup-btn" onClick={() => backupInputRef.current?.click()}>
          <FileUp size={18} strokeWidth={1.75} /> 从备份恢复
        </button>
      </InsetGroup>

      <InsetGroup
        title="问题反馈与日志"
        description="遇到异常时可导出脱敏排障日志，严禁包含剧本正文、设定或密钥。"
        testId="settings-diagnostics-group"
      >
        <button type="button" className="btn" data-testid="open-diagnostics" onClick={onOpenDiagnostics}>
          <LifeBuoy size={18} strokeWidth={1.75} /> 导出排障日志
        </button>
        <details className="settings-advanced-details" data-testid="settings-advanced-diagnostics">
          <summary>高级排障</summary>
          <div className="settings-advanced-body">
            <p className="settings-storage-status" data-testid="local-storage-status">{storageStatus}</p>
            <p className="settings-version" data-testid="settings-app-version">
              应用版本 <span>Folio v{appVersion}</span>
            </p>
          </div>
        </details>
      </InsetGroup>
    </OverlayPageShell>
  );
}
