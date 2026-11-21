import type { CreativeStorage, CreativeWorkspaceState, Story, StoryStorage } from '../harness/index.ts';

const DB_NAME = 'local-fiction-harness';
const DB_VERSION = 1;
const STORE_STORIES = 'stories';
const STORE_META = 'meta';
const ACTIVE_STORY_KEY = 'activeStoryId';
const CREATIVE_KEY = 'creativeWorkspace';

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB is not available in this browser environment.'));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_STORIES)) {
          db.createObjectStore(STORE_STORIES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to open IndexedDB.'));
    }
  });
}

/**
 * Browser IndexedDB implementation of StoryStorage for local-first persistence.
 */
export function createIndexedDbStoryStorage(): StoryStorage & { creativeStorage: CreativeStorage } {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const getDb = () => {
    if (!dbPromise) {
      const pending = openDatabase()
        .then((db) => {
          db.onclose = () => {
            if (dbPromise === pending) dbPromise = null;
          };
          db.onversionchange = () => {
            db.close();
            if (dbPromise === pending) dbPromise = null;
          };
          return db;
        })
        .catch((err) => {
          if (dbPromise === pending) dbPromise = null;
          throw err;
        });
      dbPromise = pending;
    }
    return dbPromise;
  };

  const withTransaction = async <T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> => {
    const db = await getDb();
    const tx = db.transaction(storeNames, mode);
    const done = transactionDone(tx);
    try {
      const result = await run(tx);
      await done;
      return result;
    } catch (err) {
      done.catch(() => {});
      throw err;
    }
  };

  return {
    creativeStorage: {
      load() {
        return withTransaction(STORE_META, 'readonly', async (tx) => {
          const entry = await requestToPromise(tx.objectStore(STORE_META).get(CREATIVE_KEY)) as
            { value: CreativeWorkspaceState } | undefined;
          return entry?.value ?? null;
        });
      },
      save(workspace, expected) {
        return withTransaction(STORE_META, 'readwrite', async (tx) => {
          const store = tx.objectStore(STORE_META);
          const entry = await requestToPromise(store.get(CREATIVE_KEY)) as { value: CreativeWorkspaceState } | undefined;
          if ((entry?.value.revision ?? 0) !== expected || workspace.revision !== expected + 1) {
            throw new Error('本地资料已在另一个页面变化。请重新打开后核对。');
          }
          await requestToPromise(store.put({ key: CREATIVE_KEY, value: workspace }));
        });
      },
    },

    listStories(): Promise<Story[]> {
      return withTransaction(STORE_STORIES, 'readonly', async (tx) => {
        const items = (await requestToPromise(tx.objectStore(STORE_STORIES).getAll())) as Story[];
        return items.sort((a, b) => b.updatedAt - a.updatedAt);
      });
    },

    getStory(id: string): Promise<Story | null> {
      return withTransaction(STORE_STORIES, 'readonly', async (tx) => {
        const item = (await requestToPromise(tx.objectStore(STORE_STORIES).get(id))) as
          | Story
          | undefined;
        return item ?? null;
      });
    },

    saveStory(story: Story, expectedUpdatedAt?: number): Promise<void> {
      return withTransaction(STORE_STORIES, 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_STORIES);
        if (expectedUpdatedAt !== undefined) {
          const existing = await requestToPromise(store.get(story.id)) as Story | undefined;
          if (existing?.updatedAt !== expectedUpdatedAt) throw new Error('故事版本已变化，请重新核对。');
        }
        await requestToPromise(store.put(story));
      });
    },

    deleteStory(id: string): Promise<void> {
      return withTransaction([STORE_STORIES, STORE_META], 'readwrite', async (tx) => {
        tx.objectStore(STORE_STORIES).delete(id);
        const activeMeta = (await requestToPromise(
          tx.objectStore(STORE_META).get(ACTIVE_STORY_KEY),
        )) as { key: string; value: string | null } | undefined;
        if (activeMeta?.value === id) {
          tx.objectStore(STORE_META).put({ key: ACTIVE_STORY_KEY, value: null });
        }
      });
    },

    getActiveStoryId(): Promise<string | null> {
      return withTransaction(STORE_META, 'readonly', async (tx) => {
        const entry = (await requestToPromise(
          tx.objectStore(STORE_META).get(ACTIVE_STORY_KEY),
        )) as { key: string; value: string | null } | undefined;
        return entry?.value ?? null;
      });
    },

    setActiveStoryId(id: string | null): Promise<void> {
      return withTransaction(STORE_META, 'readwrite', async (tx) => {
        tx.objectStore(STORE_META).put({ key: ACTIVE_STORY_KEY, value: id });
      });
    },

    compareAndSetActiveStoryId(expected: string | null, next: string | null): Promise<boolean> {
      return withTransaction(STORE_META, 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_META);
        const entry = (await requestToPromise(store.get(ACTIVE_STORY_KEY))) as
          { key: string; value: string | null } | undefined;
        if ((entry?.value ?? null) !== expected) return false;
        store.put({ key: ACTIVE_STORY_KEY, value: next });
        return true;
      });
    },
  };
}
