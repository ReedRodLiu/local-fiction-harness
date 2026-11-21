import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export interface BannerAlertAction {
  label: string;
  onClick: () => void;
  testId?: string;
}

export interface BannerAlertProps {
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: ReactNode;
  testId?: string;
  action?: BannerAlertAction;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function BannerAlert({
  tone = 'info',
  children,
  testId,
  action,
  onDismiss,
  dismissLabel = '关闭提示',
}: BannerAlertProps) {
  return (
    <div
      className={`banner-alert banner-alert-${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
    >
      <div className="banner-alert-body">{children}</div>
      {action && (
        <button
          type="button"
          className="banner-alert-action"
          data-testid={action.testId ?? (testId ? `${testId}-action` : undefined)}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="banner-alert-dismiss"
          aria-label={dismissLabel}
          data-testid={testId ? `${testId}-dismiss` : undefined}
          onClick={onDismiss}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
