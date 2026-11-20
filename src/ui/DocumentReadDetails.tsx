import type { DocumentRead } from '../harness/index.ts';

export function DocumentReadDetails({ reads }: { reads?: DocumentRead[] }) {
  return (
    <details className="reasoning-details">
      <summary>资料审计</summary>
      {reads?.length ? <ul>{reads.map((read) => <li key={read.scope}>
        {read.name} · {read.scope === 'public' ? '公共' : read.scope === 'container' ? '容器' : '当前路径'} · {read.versionId} · {new Date(read.readAt).toLocaleString()}
      </li>)}</ul> : <p>旧记录未保存实际请求的资料版本。</p>}
    </details>
  );
}
