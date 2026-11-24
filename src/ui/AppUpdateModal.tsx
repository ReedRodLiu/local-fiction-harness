import { useState } from 'react';
import { Download, ExternalLink, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { AppUpdaterController } from './useAppUpdater.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

export interface AppUpdateModalProps {
  updater: AppUpdaterController;
  canExportBackup: boolean;
  onExportBackup: () => Promise<boolean | void> | boolean | void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AppUpdateModal({
  updater,
  canExportBackup,
  onExportBackup,
}: AppUpdateModalProps) {
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [exportingBackup, setExportingBackup] = useState(false);

  const release = updater.availableRelease;
  const open = updater.enabled && updater.modalOpen && release !== null;
  const isDownloading = updater.installStage === 'downloading';
  const isInstalling = updater.installStage === 'installing';
  const isBusy = isDownloading || isInstalling;

  const handleRequestClose = () => {
    if (isDownloading) {
      updater.cancelDownload();
      return;
    }
    if (isInstalling) return;
    updater.closeModalRemindLater();
  };

  useWebHistoryLayer('app-update', 85, open, handleRequestClose, !isBusy);

  if (!open || !release) return null;

  const progress = updater.downloadProgress;
  const percent =
    progress && progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : null;

  const handleBackupClick = async () => {
    if (exportingBackup) return;
    setExportingBackup(true);
    setBackupNotice(null);
    try {
      const ok = await onExportBackup();
      if (ok === false) {
        setBackupNotice('导出备份未能完成，你仍可在设置页重试导出。');
      } else {
        setBackupNotice('已触发全量备份导出（.folio.json），请确认保存完成。');
      }
    } catch {
      setBackupNotice('导出备份未能完成，你仍可在设置页重试导出。');
    } finally {
      setExportingBackup(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      label={`发现新版本 v${release.version}`}
      className="modal-dialog app-update-modal"
      testId="app-update-modal"
      closeDisabled={isBusy}
      onClose={handleRequestClose}
    >
      <div className="modal-header">
        <div>
          <h3>发现新版本 v{release.version}</h3>
          <p className="app-update-version-meta">
            当前版本 v{updater.currentVersion} · 目标版本 {release.tagName}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭更新弹窗"
          data-testid="app-update-close-btn"
          disabled={isInstalling}
          onClick={handleRequestClose}
        >
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="modal-body app-update-body">
        {updater.displayNotes && (
          <div className="app-update-notes" data-testid="app-update-notes">
            {updater.displayNotes}
          </div>
        )}

        <div className="app-update-backup-callout" data-testid="app-update-backup-callout">
          <div className="app-update-backup-copy">
            <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>正常覆盖升级会保留本地故事，仍建议升级前先导出备份。</span>
          </div>
          {canExportBackup && (
            <button
              type="button"
              className="btn btn-sm"
              data-testid="app-update-backup-btn"
              disabled={exportingBackup || isBusy}
              onClick={() => void handleBackupClick()}
            >
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{exportingBackup ? '正在导出…' : '先导出备份 (.folio.json)'}</span>
            </button>
          )}
          {backupNotice && (
            <p className="app-update-backup-status" role="status">
              {backupNotice}
            </p>
          )}
        </div>

        {isDownloading && (
          <div className="app-update-progress" data-testid="app-update-progress">
            <div className="app-update-progress-header">
              <span>正在下载并校验安装包…</span>
              <span>
                {progress
                  ? progress.totalBytes
                    ? `${formatSize(progress.downloadedBytes)} / ${formatSize(progress.totalBytes)}${percent !== null ? ` (${percent}%)` : ''}`
                    : formatSize(progress.downloadedBytes)
                  : '准备中…'}
              </span>
            </div>
            <div className="app-update-progress-track" aria-hidden="true">
              <span
                className={percent === null ? 'is-indeterminate' : undefined}
                style={percent !== null ? { width: `${percent}%` } : undefined}
              />
            </div>
          </div>
        )}

        {updater.installStage === 'permission_needed' && (
          <BannerAlert tone="warning" testId="app-update-permission-banner">
            <div className="app-update-permission-body">
              <strong>需要开启「安装未知应用」权限</strong>
              <p>
                安装包已下载并校验完成。请在接下来的系统设置中允许 Folio 安装应用，返回后将自动继续安装。
              </p>
              {updater.installError && <p>{updater.installError}</p>}
            </div>
          </BannerAlert>
        )}

        {updater.installStage === 'error' && updater.installError && (
          <BannerAlert tone="danger" testId="app-update-error-banner">
            <div className="app-update-error-body">
              <div className="app-update-error-title">
                <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>
                  {updater.installErrorCode === 'SIGNATURE_MISMATCH'
                    ? '签名校验未通过'
                    : '更新失败'}
                </span>
              </div>
              <p>{updater.installError}</p>
            </div>
          </BannerAlert>
        )}
      </div>

      <div className="modal-footer app-update-footer">
        {isDownloading ? (
          <button
            type="button"
            className="btn"
            data-testid="app-update-cancel-download-btn"
            onClick={updater.cancelDownload}
          >
            取消下载
          </button>
        ) : updater.installStage === 'permission_needed' ? (
          <>
            <button
              type="button"
              className="btn"
              data-testid="app-update-remind-later-btn"
              onClick={updater.closeModalRemindLater}
            >
              稍后安装
            </button>
            <button
              type="button"
              className="btn"
              data-testid="app-update-retry-install-btn"
              onClick={() => void updater.retryInstallAfterPermission()}
            >
              我已开启，继续安装
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="app-update-open-permission-btn"
              onClick={() => void updater.openInstallPermissionSettings()}
            >
              前往系统授权
            </button>
          </>
        ) : updater.installStage === 'error' ? (
          <>
            <button
              type="button"
              className="btn"
              data-testid="app-update-browser-fallback-btn"
              onClick={() => void updater.openReleaseInBrowser()}
            >
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>在浏览器中打开发布页</span>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="app-update-retry-btn"
              onClick={() => void updater.startDownloadAndInstall()}
            >
              重试更新
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn app-update-skip-btn"
              data-testid="app-update-skip-btn"
              disabled={isInstalling}
              onClick={updater.skipAvailableVersion}
            >
              跳过此版本
            </button>
            <button
              type="button"
              className="btn"
              data-testid="app-update-remind-later-btn"
              disabled={isInstalling}
              onClick={updater.closeModalRemindLater}
            >
              稍后提醒
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="app-update-install-btn"
              disabled={isInstalling}
              onClick={() => void updater.startDownloadAndInstall()}
            >
              {isInstalling
                ? '正在唤起安装…'
                : updater.downloadedApk?.version === release.version
                  ? '立即安装'
                  : '立即更新'}
            </button>
          </>
        )}
      </div>
    </ModalDialog>
  );
}
