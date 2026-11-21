import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorMessage } from './textHelpers.ts';

export type ManuscriptSaveDiagnosticAction =
  | 'manuscript_save_queued'
  | 'manuscript_save_flushed'
  | 'manuscript_save_error'
  | 'manuscript_suggestion_adopted'
  | 'manuscript_undo';

export interface ManuscriptSnapshot {
  text: string;
  selectionStart?: number;
  selectionEnd?: number;
  source: 'typing' | 'suggestion' | 'undo' | 'redo';
  label?: string;
  timestamp: number;
}

export interface ManuscriptUndoBanner {
  id: string;
  message: string;
  expiresAt: number;
}

export interface ManuscriptAutosaveSnapshot {
  workId: string;
  text: string;
  persistedText: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  undoBanner: ManuscriptUndoBanner | null;
}

export interface ManuscriptAutosaveOptions {
  workId: string;
  persistedText: string;
  onSave: (nextText: string, expectedPrevText: string) => Promise<void>;
  debounceMs?: number;
  maxUndoSteps?: number;
  undoBannerMs?: number;
  onDiagnosticEvent?: (action: ManuscriptSaveDiagnosticAction) => void;
  onSaveError?: (error: unknown) => void;
}

export interface ManuscriptAutosaveManager {
  getSnapshot(): ManuscriptAutosaveSnapshot;
  subscribe(listener: () => void): () => void;
  updateText(
    nextText: string,
    meta?: { selectionStart?: number; selectionEnd?: number; recordUndo?: boolean },
  ): void;
  adoptSuggestion(
    nextText: string,
    meta?: { label?: string; selectionStart?: number; selectionEnd?: number },
  ): void;
  undo(): boolean;
  redo(): boolean;
  dismissUndoBanner(): void;
  flush(): Promise<void>;
  waitForIdle(): Promise<void>;
  syncExternal(nextWorkId: string, nextPersistedText: string): void;
  activate(): void;
  dispose(): void;
}

export function createManuscriptAutosaveManager(
  options: ManuscriptAutosaveOptions,
): ManuscriptAutosaveManager {
  const debounceMs = options.debounceMs ?? 400;
  const maxUndoSteps = Math.max(10, options.maxUndoSteps ?? 20);
  const undoBannerMs = options.undoBannerMs ?? 6000;

  let currentWorkId = options.workId;
  let currentText = options.persistedText;
  let lastPersistedText = options.persistedText;
  let saving = false;
  let saveError: string | null = null;
  let undoStack: ManuscriptSnapshot[] = [];
  let redoStack: ManuscriptSnapshot[] = [];
  let undoBanner: ManuscriptUndoBanner | null = null;
  let bannerSeq = 0;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  let disposed = false;

  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const clearDebounce = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const clearBannerTimer = () => {
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  };

  const pushUndoEntry = (entry: ManuscriptSnapshot) => {
    undoStack = [...undoStack, entry];
    if (undoStack.length > maxUndoSteps) {
      undoStack = undoStack.slice(undoStack.length - maxUndoSteps);
    }
    redoStack = [];
  };

  const drainSaveQueue = (reason: 'debounce' | 'flush'): Promise<void> => {
    const workIdAtEnqueue = currentWorkId;
    const runNext = async (): Promise<void> => {
      if ((disposed && reason === 'debounce') || currentWorkId !== workIdAtEnqueue) return;
      if (currentText === lastPersistedText) return;

      const targetText = currentText;
      const expectedPrev = lastPersistedText;
      saving = true;
      saveError = null;
      if (!disposed) emit();

      try {
        await options.onSave(targetText, expectedPrev);
        if (currentWorkId === workIdAtEnqueue) {
          lastPersistedText = targetText;
          saveError = null;
          if (reason === 'flush') {
            options.onDiagnosticEvent?.('manuscript_save_flushed');
          }
        }
      } catch (err) {
        if (currentWorkId === workIdAtEnqueue) {
          saveError = toErrorMessage(err, '正文保存失败，请重试。');
          options.onDiagnosticEvent?.('manuscript_save_error');
          options.onSaveError?.(err);
        }
      } finally {
        saving = false;
        if (!disposed) emit();
      }

      if (
        (!disposed || reason === 'flush') &&
        currentWorkId === workIdAtEnqueue &&
        !saveError &&
        currentText !== lastPersistedText
      ) {
        await runNext();
      }
    };

    const chained = saveQueue.then(runNext, runNext);
    saveQueue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  };

  const scheduleSave = () => {
    clearDebounce();
    options.onDiagnosticEvent?.('manuscript_save_queued');
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drainSaveQueue('debounce');
    }, debounceMs);
  };

  return {
    getSnapshot(): ManuscriptAutosaveSnapshot {
      return {
        workId: currentWorkId,
        text: currentText,
        persistedText: lastPersistedText,
        dirty: currentText !== lastPersistedText,
        saving,
        saveError,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoCount: undoStack.length,
        undoBanner,
      };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    updateText(nextText, meta) {
      if (nextText === currentText) return;
      if (meta?.recordUndo !== false) {
        pushUndoEntry({
          text: currentText,
          selectionStart: meta?.selectionStart,
          selectionEnd: meta?.selectionEnd,
          source: 'typing',
          timestamp: Date.now(),
        });
      }
      currentText = nextText;
      saveError = null;
      emit();
      scheduleSave();
    },

    adoptSuggestion(nextText, meta) {
      if (nextText === currentText) return;
      pushUndoEntry({
        text: currentText,
        selectionStart: meta?.selectionStart,
        selectionEnd: meta?.selectionEnd,
        source: 'suggestion',
        label: meta?.label ?? '已采纳写作建议',
        timestamp: Date.now(),
      });
      currentText = nextText;
      saveError = null;

      clearBannerTimer();
      bannerSeq += 1;
      undoBanner = {
        id: `undo-banner-${bannerSeq}`,
        message: meta?.label ?? '已采纳写作建议',
        expiresAt: Date.now() + undoBannerMs,
      };
      bannerTimer = setTimeout(() => {
        bannerTimer = null;
        undoBanner = null;
        emit();
      }, undoBannerMs);

      options.onDiagnosticEvent?.('manuscript_suggestion_adopted');
      emit();
      scheduleSave();
    },

    undo(): boolean {
      const previous = undoStack.at(-1);
      if (!previous) return false;
      undoStack = undoStack.slice(0, -1);
      redoStack = [
        ...redoStack,
        {
          text: currentText,
          source: 'undo',
          timestamp: Date.now(),
        },
      ];
      currentText = previous.text;
      saveError = null;
      clearBannerTimer();
      undoBanner = null;
      options.onDiagnosticEvent?.('manuscript_undo');
      emit();
      scheduleSave();
      return true;
    },

    redo(): boolean {
      const next = redoStack.at(-1);
      if (!next) return false;
      redoStack = redoStack.slice(0, -1);
      undoStack = [
        ...undoStack,
        {
          text: currentText,
          source: 'redo',
          timestamp: Date.now(),
        },
      ];
      currentText = next.text;
      saveError = null;
      emit();
      scheduleSave();
      return true;
    },

    dismissUndoBanner() {
      clearBannerTimer();
      if (undoBanner !== null) {
        undoBanner = null;
        emit();
      }
    },

    flush(): Promise<void> {
      clearDebounce();
      if (currentText === lastPersistedText && !saveError) {
        return saveQueue;
      }
      return drainSaveQueue('flush');
    },

    waitForIdle(): Promise<void> {
      return saveQueue;
    },

    syncExternal(nextWorkId: string, nextPersistedText: string) {
      if (nextWorkId !== currentWorkId) {
        clearDebounce();
        clearBannerTimer();
        currentWorkId = nextWorkId;
        currentText = nextPersistedText;
        lastPersistedText = nextPersistedText;
        saving = false;
        saveError = null;
        undoStack = [];
        redoStack = [];
        undoBanner = null;
        emit();
        return;
      }

      if (currentText === lastPersistedText && !saving) {
        lastPersistedText = nextPersistedText;
        if (currentText !== nextPersistedText) {
          currentText = nextPersistedText;
          emit();
        }
      }
    },

    activate() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      clearDebounce();
      clearBannerTimer();
      listeners.clear();
    },
  };
}

export interface UseManuscriptAutosaveResult extends ManuscriptAutosaveSnapshot {
  updateText: ManuscriptAutosaveManager['updateText'];
  adoptSuggestion: ManuscriptAutosaveManager['adoptSuggestion'];
  undo: ManuscriptAutosaveManager['undo'];
  redo: ManuscriptAutosaveManager['redo'];
  dismissUndoBanner: ManuscriptAutosaveManager['dismissUndoBanner'];
  flush: ManuscriptAutosaveManager['flush'];
  handleBlur: () => void;
}

export function useManuscriptAutosave(
  options: ManuscriptAutosaveOptions,
): UseManuscriptAutosaveResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const managerRef = useRef<ManuscriptAutosaveManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = createManuscriptAutosaveManager({
      workId: options.workId,
      persistedText: options.persistedText,
      debounceMs: options.debounceMs,
      maxUndoSteps: options.maxUndoSteps,
      undoBannerMs: options.undoBannerMs,
      onSave: (nextText, expectedPrev) => optionsRef.current.onSave(nextText, expectedPrev),
      onDiagnosticEvent: (action) => optionsRef.current.onDiagnosticEvent?.(action),
      onSaveError: (err) => optionsRef.current.onSaveError?.(err),
    });
  }

  const [snapshot, setSnapshot] = useState<ManuscriptAutosaveSnapshot>(() =>
    managerRef.current!.getSnapshot(),
  );

  useEffect(() => {
    const manager = managerRef.current!;
    // React StrictMode runs cleanup + re-setup on the same ref instance; reactivate before subscribing.
    manager.activate();
    setSnapshot(manager.getSnapshot());
    const unsubscribe = manager.subscribe(() => {
      setSnapshot(manager.getSnapshot());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    managerRef.current?.syncExternal(options.workId, options.persistedText);
  }, [options.workId, options.persistedText]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        void managerRef.current?.flush();
      }
    };
    const handlePageHide = () => {
      void managerRef.current?.flush();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', handlePageHide);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', handlePageHide);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      void managerRef.current?.flush();
      managerRef.current?.dispose();
    };
  }, []);

  const updateText = useCallback<ManuscriptAutosaveManager['updateText']>((nextText, meta) => {
    managerRef.current?.updateText(nextText, meta);
  }, []);

  const adoptSuggestion = useCallback<ManuscriptAutosaveManager['adoptSuggestion']>(
    (nextText, meta) => {
      managerRef.current?.adoptSuggestion(nextText, meta);
    },
    [],
  );

  const undo = useCallback(() => managerRef.current?.undo() ?? false, []);
  const redo = useCallback(() => managerRef.current?.redo() ?? false, []);
  const dismissUndoBanner = useCallback(() => {
    managerRef.current?.dismissUndoBanner();
  }, []);
  const flush = useCallback(() => managerRef.current?.flush() ?? Promise.resolve(), []);
  const handleBlur = useCallback(() => {
    void managerRef.current?.flush();
  }, []);

  return {
    ...snapshot,
    updateText,
    adoptSuggestion,
    undo,
    redo,
    dismissUndoBanner,
    flush,
    handleBlur,
  };
}
