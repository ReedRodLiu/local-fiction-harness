import type { ReactNode } from 'react';
import type { DocumentRead } from '../harness/index.ts';

export interface DocumentReadEntry {
  id: string;
  label: string;
  reads: readonly DocumentRead[];
  createdAt?: number;
}

export function DocumentReadDetails({
  entries,
  children,
  testId,
}: {
  entries: readonly DocumentReadEntry[];
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <details id={testId} className="reasoning-details" data-testid={testId}>
      <summary>三区上下文与资料版本详情</summary>
      {children}
      <div className="context-document-reads" aria-label="资料版本读取记录">
        {entries.length ? entries.map((entry) => (
          <section className="context-document-read" key={entry.id}>
            <p>{entry.label}{entry.createdAt === undefined ? '' : ` · ${new Date(entry.createdAt).toLocaleString()}`}</p>
            <ul>{entry.reads.map((read, index) => <li key={`${entry.id}-${read.scope}-${read.versionId}-${index}`}>
              {read.name} · {read.scope === 'public' ? '公共' : read.scope === 'container' ? '容器' : '当前路径'} · {read.versionId} · {new Date(read.readAt).toLocaleString()}
            </li>)}</ul>
          </section>
        )) : <p>暂无已记录的资料版本读取。</p>}
      </div>
    </details>
  );
}
