import type { ReactNode } from 'react';

interface InsetGroupProps {
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}

export function InsetGroup({ title, description, children, testId }: InsetGroupProps) {
  return (
    <section className="inset-group" aria-label={title} data-testid={testId}>
      <header className="inset-group-header">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="inset-group-content">{children}</div>
    </section>
  );
}
