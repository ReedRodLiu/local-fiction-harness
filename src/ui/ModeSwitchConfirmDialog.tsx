import { ArrowRight, ArrowLeftRight } from 'lucide-react';
import { STAGE_MODE_LABELS, type StageAssetMode } from '../harness/index.ts';
import { ModalDialog } from './primitives/ModalDialog.tsx';

export interface ModeSwitchConfirmRequest {
  sourceMode: StageAssetMode;
  targetMode: StageAssetMode;
  targetTitle?: string;
  reasonLabel?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
}

export interface ModeSwitchConfirmDialogProps {
  request: ModeSwitchConfirmRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ModeSwitchConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: ModeSwitchConfirmDialogProps) {
  const sourceLabel = request ? STAGE_MODE_LABELS[request.sourceMode] : '';
  const targetLabel = request ? STAGE_MODE_LABELS[request.targetMode] : '';

  return (
    <ModalDialog
      open={Boolean(request)}
      label="确认切换模式"
      className="modal-dialog mode-switch-confirm-modal"
      testId="mode-switch-confirm-dialog"
      closeDisabled={Boolean(request?.busy)}
      onClose={onCancel}
    >
      {request && (
        <div className="mode-switch-confirm-content">
          <div className="mode-switch-confirm-header">
            <span className="mode-switch-confirm-icon" aria-hidden="true">
              <ArrowLeftRight size={18} strokeWidth={1.75} />
            </span>
            <div>
              <h2>确认切换模式</h2>
              {request.reasonLabel && (
                <p className="mode-switch-confirm-meta">{request.reasonLabel}</p>
              )}
            </div>
          </div>

          <div className="mode-switch-route-row" aria-label="模式变更方向">
            <span className="mode-switch-pill is-source" data-testid="mode-switch-source">
              {sourceLabel}
            </span>
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="mode-switch-pill is-target" data-testid="mode-switch-target">
              {targetLabel}
            </span>
          </div>

          <p className="mode-switch-confirm-desc">{request.description}</p>

          {request.targetTitle && (
            <div className="mode-switch-target-preview">
              目标名称：<strong>{request.targetTitle}</strong>
            </div>
          )}

          <div className="mode-switch-confirm-actions">
            <button
              type="button"
              className="btn"
              data-testid="mode-switch-cancel-btn"
              disabled={Boolean(request.busy)}
              onClick={onCancel}
            >
              {request.cancelLabel ?? `取消（留在${sourceLabel}）`}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="mode-switch-confirm-btn"
              disabled={Boolean(request.busy)}
              onClick={onConfirm}
            >
              {request.confirmLabel ?? `确认切换到${targetLabel}`}
            </button>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
