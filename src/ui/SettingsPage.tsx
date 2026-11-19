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

interface SettingsPageProps {
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
  onExportCurrentStory: () => void;
  onImportBackupFile: (file: File) => void;
  onThemePreferenceChange: (preference: DisplayThemePreference) => void;
  onFontSizeChange: (fontSize: DisplayFontSize) => void;
}

const THEME_OPTIONS: Array<{
  value: DisplayThemePreference;
  label: string;
  swatches: readonly string[];
}> = [
  { value: 'system', label: '跟随系统', swatches: ['var(--text-primary)', 'var(--bg-canvas)'] },
  { value: 'light', label: '浅色', swatches: ['var(--bg-canvas)', 'var(--bg-surface-hover)'] },
  { value: 'dark', label: '深邃炭黑', swatches: ['var(--bg-canvas)', 'var(--accent-fiction)'] },
  { value: 'warm', label: '暖纸护眼', swatches: ['var(--bg-canvas)', 'var(--bg-user-bubble)'] },
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
  onExportCurrentStory,
  onImportBackupFile,
  onThemePreferenceChange,
  onFontSizeChange,
}: SettingsPageProps) {
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [storageStatus, setStorageStatus] = useState('正在读取本地占用…');

  useEffect(() => {
    let cancelled = false;
    if (!navigator.storage?.estimate) {
      setStorageStatus('当前浏览器未提供本地占用估算，故事仍只保存在本机。');
      return;
    }
    void navigator.storage.estimate().then((estimate) => {
      if (cancelled) return;
      const usage = formatBytes(estimate.usage ?? 0);
      const quota = estimate.quota === undefined ? null : formatBytes(estimate.quota);
      setStorageStatus(
        quota
          ? `已用约 ${usage}，可用上限约 ${quota}；由浏览器估算。`
          : `已用约 ${usage}；由浏览器估算。`,
      );
    }).catch(() => {
      if (!cancelled) {
        setStorageStatus('暂时无法读取本地占用；故事仍只保存在本机。');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <OverlayPageShell title="设置" testId="settings-page" onBack={onBack}>
      <InsetGroup
        title="模型与密钥"
        description="密钥只保存在你的设备上，应用会直接连接 DeepSeek 官方服务。"
        testId="settings-connection-group"
      >
        <section className="connected-key-card" data-testid="deepseek-connection-card" aria-label="DeepSeek 连接状态">
          <div className="connected-key-header">
            <strong>{hasCredentials ? '已连接 DeepSeek 官方' : '未连接 DeepSeek 官方'}</strong>
            <span className={`badge ${hasCredentials ? 'badge-ok' : 'badge-pending'}`}>
              {hasCredentials
                ? useDevEnvKey
                  ? '开发代理'
                  : maskApiKey(config.apiKey) || '本地已连接'
                : '待配置'}
            </span>
          </div>
          {hasCredentials && !useDevEnvKey && config.apiKey && (
            <span className="key-mask" data-testid="connected-key-mask">{maskApiKey(config.apiKey)}</span>
          )}
          <p className="wizard-privacy-note">
            模型请求会由你的设备直接发送至 DeepSeek 官方 API；API Key 只保存在本机，不会交给项目方。
          </p>
          {hasCredentials ? (
            <div className="settings-button-row">
              <button type="button" className="btn" data-testid="change-key-btn" onClick={onOpenSetupWizard}>
                更换 Key
              </button>
              <button type="button" className="btn" data-testid="clear-key-btn" onClick={onClearSavedKey}>
                清除已保存的 key
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" data-testid="open-setup-wizard-btn" onClick={onOpenSetupWizard}>
              连接 DeepSeek 钥匙
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
          <p className="appearance-player-preview" data-testid="appearance-player-preview">
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
                <span className="theme-option-canvas" aria-hidden="true">
                  {option.swatches.map((color, index) => (
                    <span key={`${option.value}-${index}`} style={{ background: color }} />
                  ))}
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

      <InsetGroup
        title="故事数据与备份"
        description="导出或恢复单个故事的 .lfh.json 备份；不会改变故事存储格式。"
        testId="settings-backup-group"
      >
        <div className="settings-data-row">
          <div>
            <strong>当前故事</strong>
            <p>{canExportCurrentStory ? currentStoryTitle : '尚未打开可备份的故事'}</p>
          </div>
          <button
            type="button"
            className="btn"
            data-testid="export-current-story"
            disabled={!canExportCurrentStory}
            onClick={onExportCurrentStory}
          >
            <Download size={18} strokeWidth={1.75} /> 导出 .lfh.json
          </button>
        </div>
        <p className="settings-storage-status" data-testid="local-storage-status">{storageStatus}</p>
        <input
          ref={backupInputRef}
          type="file"
          accept=".lfh.json,.json,application/json"
          aria-label="导入 .lfh.json 备份"
          data-testid="backup-import-input"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImportBackupFile(file);
          }}
        />
        <button type="button" className="btn" data-testid="restore-backup-btn" onClick={() => backupInputRef.current?.click()}>
          <FileUp size={18} strokeWidth={1.75} /> 从 .lfh.json 恢复故事
        </button>
      </InsetGroup>

      <InsetGroup
        title="排障与关于"
        description="脱敏诊断包只包含最近 30 分钟的运行结构信息。"
        testId="settings-diagnostics-group"
      >
        <button type="button" className="btn" data-testid="open-diagnostics" onClick={onOpenDiagnostics}>
          <LifeBuoy size={18} strokeWidth={1.75} /> 查看脱敏诊断包
        </button>
        <p className="settings-version" data-testid="settings-app-version">APP_VERSION <span>{appVersion}</span></p>
      </InsetGroup>
    </OverlayPageShell>
  );
}
