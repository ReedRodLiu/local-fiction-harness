import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

interface OverlayPageShellProps {
  title: string;
  testId?: string;
  onBack: () => void;
  children: ReactNode;
}

export function OverlayPageShell({ title, testId, onBack, children }: OverlayPageShellProps) {
  return (
    <section className="overlay-page-shell" data-testid={testId}>
      <header className="overlay-page-header">
        <button type="button" className="icon-button" aria-label="返回" onClick={onBack}>
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
        <h1>{title}</h1>
        <span className="overlay-header-spacer" aria-hidden="true" />
      </header>
      <div className="overlay-page-content">{children}</div>
    </section>
  );
}
