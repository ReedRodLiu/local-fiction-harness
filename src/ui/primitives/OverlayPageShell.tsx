import { ArrowLeft } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface OverlayPageShellProps {
  title: string;
  testId?: string;
  step?: number;
  stepCount?: number;
  footer?: ReactNode;
  backDisabled?: boolean;
  onBack: () => void;
  children: ReactNode;
}

export function OverlayPageShell({
  title,
  testId,
  step,
  stepCount,
  footer,
  backDisabled = false,
  onBack,
  children,
}: OverlayPageShellProps) {
  const hasProgress = step !== undefined && stepCount !== undefined && stepCount > 0;
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const focusTitleIfUnclaimed = () => {
      const active = document.activeElement;
      if (
        active === document.body ||
        active === null ||
        (active instanceof Element && active.closest('dialog:not([open])'))
      ) {
        titleRef.current?.focus();
      }
    };
    focusTitleIfUnclaimed();
    const settleTimer = window.setTimeout(focusTitleIfUnclaimed, 260);
    return () => window.clearTimeout(settleTimer);
  }, []);

  return (
    <section className="overlay-page-shell" data-testid={testId} data-has-footer={Boolean(footer)}>
      <header className="overlay-page-header">
        <button
          type="button"
          className="icon-button"
          aria-label="返回"
          disabled={backDisabled}
          onClick={onBack}
        >
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
        <h1
          ref={titleRef}
          role="heading"
          aria-level={1}
          tabIndex={-1}
          data-testid={testId ? `${testId}-title` : undefined}
        >
          {title}
        </h1>
        <span className="overlay-header-spacer" aria-hidden="true" />
      </header>
      {hasProgress && (
        <div className="overlay-page-progress">
          <div className="overlay-page-progress-label">第 {step} 步，共 {stepCount} 步</div>
          <div
            className="overlay-page-progress-track"
            role="progressbar"
            aria-label={`${title}进度`}
            aria-valuemin={1}
            aria-valuemax={stepCount}
            aria-valuenow={step}
          >
            <span style={{ width: `${Math.min(100, Math.max(0, (step / stepCount) * 100))}%` }} />
          </div>
        </div>
      )}
      <div className="overlay-page-content">{children}</div>
      {footer && <footer className="overlay-page-footer" data-testid="overlay-page-footer">{footer}</footer>}
    </section>
  );
}
