import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyWorkspace, type CreativeStorage, type CreativeWorkspaceState } from '../harness/index.ts';

export type SaveWorkspace = (
  change: (current: CreativeWorkspaceState) => CreativeWorkspaceState,
) => Promise<CreativeWorkspaceState>;

export function useCreativeWorkspace(storage?: CreativeStorage) {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(workspace);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    void (storage?.load() ?? Promise.resolve(null)).then((saved) => {
      if (cancelled) return;
      current.current = saved ?? emptyWorkspace();
      setWorkspace(current.current);
      setReady(true);
    }).catch(() => {
      if (!cancelled) setError('读取本地工作台失败。请重新打开应用。');
    });
    return () => { cancelled = true; };
  }, [storage]);

  const save: SaveWorkspace = useCallback((change) => {
    const operation = queue.current.then(async () => {
      if (!storage) throw new Error('当前客户端没有可用的工作台存储。');
      const previous = current.current;
      const changed = change(previous);
      if (changed === previous) return previous;
      const next = { ...changed, revision: previous.revision + 1 };
      try {
        await storage.save(next, previous.revision);
      } catch (err) {
        const updated = await storage.load().catch(() => null);
        if (updated && updated.revision !== previous.revision) {
          current.current = updated;
          setWorkspace(updated);
        }
        throw err;
      }
      current.current = next;
      setWorkspace(next);
      return next;
    });
    queue.current = operation.catch(() => undefined);
    return operation;
  }, [storage]);

  const read = useCallback(async () => {
    await queue.current;
    const latest = await storage?.load();
    if (latest && latest.revision > current.current.revision) {
      current.current = latest;
      setWorkspace(latest);
    }
    return current.current;
  }, [storage]);

  return { workspace, ready, error, save, read };
}
