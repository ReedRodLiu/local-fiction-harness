import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDbStoryStorage } from '../../src/ui/indexedDbStorage.ts';

interface FakeDbHandle {
  db: {
    objectStoreNames: { contains: () => boolean };
    createObjectStore: () => void;
    close: () => void;
    onclose: (() => void) | null;
    onversionchange: (() => void) | null;
    transaction: (stores: string | string[], mode: string) => FakeTransaction;
  };
}

interface FakeTransaction {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
  objectStore: () => {
    get: () => FakeRequest<unknown>;
    getAll: () => FakeRequest<unknown[]>;
    put: (value?: unknown) => void;
    delete: () => void;
  };
}

interface FakeRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('IndexedDB StoryStorage resilience & transaction ordering', () => {
  it('clears dbPromise when openDatabase rejects and on db.onclose / db.onversionchange', async () => {
    let openCalls = 0;
    let shouldFailOpen = true;
    let activeHandle: FakeDbHandle | null = null;
    const closeSpy = vi.fn();

    const fakeIndexedDb = {
      open: vi.fn(() => {
        openCalls += 1;
        const req: FakeRequest<unknown> & { onupgradeneeded: (() => void) | null } = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          if (shouldFailOpen) {
            req.error = new Error('Quota or private mode failure');
            req.onerror?.();
            return;
          }
          const handle: FakeDbHandle = {
            db: {
              objectStoreNames: { contains: () => true },
              createObjectStore: () => {},
              close: closeSpy,
              onclose: null,
              onversionchange: null,
              transaction: () => {
                const tx: FakeTransaction = {
                  oncomplete: null,
                  onerror: null,
                  onabort: null,
                  error: null,
                  objectStore: () => ({
                    get: () => {
                      const getReq: FakeRequest<unknown> = {
                        result: { key: 'activeStoryId', value: `story-${openCalls}` },
                        error: null,
                        onsuccess: null,
                        onerror: null,
                      };
                      queueMicrotask(() => {
                        getReq.onsuccess?.();
                        queueMicrotask(() => tx.oncomplete?.());
                      });
                      return getReq;
                    },
                    getAll: () => ({} as FakeRequest<unknown[]>),
                    put: () => {},
                    delete: () => {},
                  }),
                };
                return tx;
              },
            },
          };
          activeHandle = handle;
          req.result = handle.db;
          req.onsuccess?.();
        });
        return req;
      }),
    };

    (globalThis as { window: unknown }).window = { indexedDB: fakeIndexedDb };
    const storage = createIndexedDbStoryStorage();

    // 1. Open failure clears dbPromise so the next call retries open()
    await expect(storage.getActiveStoryId()).rejects.toThrow(/Quota/);
    shouldFailOpen = false;
    await expect(storage.getActiveStoryId()).resolves.toBe('story-2');
    expect(openCalls).toBe(2);

    // 2. onclose invalidates cached connection
    activeHandle!.db.onclose?.();
    await expect(storage.getActiveStoryId()).resolves.toBe('story-3');
    expect(openCalls).toBe(3);

    // 3. onversionchange closes DB and invalidates cached connection
    activeHandle!.db.onversionchange?.();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await expect(storage.getActiveStoryId()).resolves.toBe('story-4');
    expect(openCalls).toBe(4);
  });

  it('attaches transactionDone listener before awaiting run(tx) so early tx completion does not hang', async () => {
    const fakeIndexedDb = {
      open: vi.fn(() => {
        const req: FakeRequest<unknown> & { onupgradeneeded: (() => void) | null } = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            createObjectStore: () => {},
            close: () => {},
            onclose: null,
            onversionchange: null,
            transaction: () => {
              const tx: FakeTransaction = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
                objectStore: () => ({
                  get: () => ({} as FakeRequest<unknown>),
                  getAll: () => ({} as FakeRequest<unknown[]>),
                  put: () => {
                    // Simulate tx auto-committing immediately inside run(tx) microtask before run(tx) resolves
                    queueMicrotask(() => tx.oncomplete?.());
                  },
                  delete: () => {},
                }),
              };
              return tx;
            },
          };
          req.onsuccess?.();
        });
        return req;
      }),
    };

    (globalThis as { window: unknown }).window = { indexedDB: fakeIndexedDb };
    const storage = createIndexedDbStoryStorage();

    const result = await Promise.race([
      storage.setActiveStoryId('s1').then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed_out'), 150)),
    ]);

    expect(result).toBe('completed');
  });

  it('compares and sets the active story in one readwrite transaction', async () => {
    let active: { key: string; value: string | null } | undefined = {
      key: 'activeStoryId',
      value: 'selected',
    };
    const fakeIndexedDb = {
      open: vi.fn(() => {
        const req: FakeRequest<unknown> & { onupgradeneeded: (() => void) | null } = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            createObjectStore: () => {},
            close: () => {},
            onclose: null,
            onversionchange: null,
            transaction: () => {
              const tx: FakeTransaction = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
                objectStore: () => ({
                  get: () => {
                    const getReq: FakeRequest<unknown> = {
                      result: active,
                      error: null,
                      onsuccess: null,
                      onerror: null,
                    };
                    queueMicrotask(() => {
                      getReq.onsuccess?.();
                      queueMicrotask(() => tx.oncomplete?.());
                    });
                    return getReq;
                  },
                  getAll: () => ({} as FakeRequest<unknown[]>),
                  put: (value: unknown) => {
                    active = value as { key: string; value: string | null };
                    queueMicrotask(() => tx.oncomplete?.());
                  },
                  delete: () => {},
                }),
              };
              return tx;
            },
          };
          req.onsuccess?.();
        });
        return req;
      }),
    };

    (globalThis as { window: unknown }).window = { indexedDB: fakeIndexedDb };
    const storage = createIndexedDbStoryStorage();

    await expect(storage.compareAndSetActiveStoryId('created', 'previous')).resolves.toBe(false);
    expect(active?.value).toBe('selected');
    await expect(storage.compareAndSetActiveStoryId('selected', 'previous')).resolves.toBe(true);
    expect(active?.value).toBe('previous');
  });
});
