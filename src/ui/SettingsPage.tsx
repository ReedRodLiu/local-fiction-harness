import { useRef } from 'react';
import { FileUp, LifeBuoy, ShieldCheck } from 'lucide-react';
import { maskApiKey, type ModelConfig } from '../harness/index.ts';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';

interface SettingsPageProps {
  appVersion: string;
  hasCredentials: boolean;
  config: ModelConfig;
  useDevEnvKey: boolean;
  showDevTestProxy: boolean;
  onBack: () => void;
  onOpenSetupWizard: () => void;
  onClearSavedKey: () => void;
  onApplyDevTestConfig: () => void;
  onOpenDiagnostics: () => void;
  onImportBackupFile: (file: File) => void;
}

export function SettingsPage({
  appVersion,
  hasCredentials,
  config,
  useDevEnvKey,
  showDevTestProxy,
  onBack,
  onOpenSetupWizard,
  onClearSavedKey,
  onApplyDevTestConfig,
  onOpenDiagnostics,
  onImportBackupFile,
}: SettingsPageProps) {
  const backupInputRef = useRef<HTMLInputElement>(null);

  return (
    <OverlayPageShell title="设置与模型密钥" testId="settings-page" onBack={onBack}>
      <InsetGroup
        title="DeepSeek 官方连接"
        description="密钥只保存在你的设备上，应用会直接连接 DeepSeek 官方服务。"
        testId="settings-connection-group"
      >
        <section className="connected-key-card" data-testid="deepseek-connection-card" aria-label="DeepSeek 连接状态">
          <div className="connected-key-header">
            <strong>{hasCredentials ? '已连接 DeepSeek 官方（DeepSeek-Flash）' : '未连接 DeepSeek 官方'}</strong>
            <span className={`badge ${hasCredentials ? 'badge-ok' : 'badge-pending'}`}>
              {hasCredentials
                ? useDevEnvKey
                  ? '开发代理'
                  : maskApiKey(config.apiKey) || '本地已连接'
                : 'DeepSeek-Flash'}
            </span>
          </div>
          {hasCredentials && !useDevEnvKey && config.apiKey && (
            <span className="key-mask" data-testid="connected-key-mask">{maskApiKey(config.apiKey)}</span>
          )}
          <p className="wizard-privacy-note">
            密钥仅保存在你的手机本地，不会上传到任何第三方服务器。
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
          {showDevTestProxy && (
            <button type="button" className="btn" data-testid="dev-proxy-toggle" onClick={onApplyDevTestConfig}>
              使用本地 .env.local 测试代理
            </button>
          )}
        </section>
        <p className="settings-privacy"><ShieldCheck size={16} strokeWidth={1.75} /> 不含项目方代理或云端存储。</p>
      </InsetGroup>

      <InsetGroup
        title="备份与恢复"
        description="选择本机的 .lfh.json 备份文件，将故事恢复到此设备。"
        testId="settings-backup-group"
      >
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
          <FileUp size={18} strokeWidth={1.75} /> 导入 .lfh.json 备份
        </button>
      </InsetGroup>

      <InsetGroup
        title="排障与诊断"
        description="预览并导出最近 30 分钟的脱敏诊断包。"
        testId="settings-diagnostics-group"
      >
        <button type="button" className="btn" data-testid="open-diagnostics" onClick={onOpenDiagnostics}>
          <LifeBuoy size={18} strokeWidth={1.75} /> 查看脱敏诊断包
        </button>
      </InsetGroup>

      <InsetGroup title="关于本地文游" testId="settings-about-group">
        <p className="settings-version">版本 <span>{appVersion}</span></p>
      </InsetGroup>
    </OverlayPageShell>
  );
}
