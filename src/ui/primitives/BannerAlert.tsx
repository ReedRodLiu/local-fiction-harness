import type { ReactNode } from 'react';

interface BannerAlertProps {
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: ReactNode;
  testId?: string;
}

export function BannerAlert({ tone = 'info', children, testId }: BannerAlertProps) {
  return (
    <div
      className={`banner-alert banner-alert-${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
