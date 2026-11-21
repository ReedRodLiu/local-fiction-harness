import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptyWorkspace,
  migrateWorkspaceToV02,
  type CreativeStorage,
  type CreativeWorkspaceState,
} from '../harness/index.ts';

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
      const migrated = saved ? migrateWorkspaceToV02(saved) : emptyWorkspace();
      current.current = migrated;
      setWorkspace(migrated);
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
      const next = migrateWorkspaceToV02({ ...changed, revision: previous.revision + 1 });
      try {
        await storage.save(next, previous.revision);
      } catch (err) {
        const updated = await storage.load().catch(() => null);
        if (updated && updated.revision !== previous.revision) {
          const migratedUpdated = migrateWorkspaceToV02(updated);
          current.current = migratedUpdated;
          setWorkspace(migratedUpdated);
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
      const migrated = migrateWorkspaceToV02(latest);
      current.current = migrated;
      setWorkspace(migrated);
    }
    return current.current;
  }, [storage]);

  return { workspace, ready, error, save, read };
}
