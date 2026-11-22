import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MANUSCRIPT_AUTOSAVE_DEBOUNCE_MS,
  DEFAULT_MANUSCRIPT_SLOW_SAVE_MS,
  createManuscriptAutosaveManager,
  flushActiveManuscripts,
  formatManuscriptStatusText,
  hasPendingManuscriptFlush,
  registerActiveManuscriptManager,
} from '../../src/ui/useManuscriptAutosave.ts';

describe('manuscript autosave & multi-step undo manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces rapid keystrokes at 400ms and serializes overlapping saves without false conflicts', async () => {
    let serverText = '初始正文';
    const saveLog: Array<{ next: string; expected: string }> = [];
    let releaseFirstSave!: () => void;
    let firstSavePending = true;

    const onSave = vi.fn(async (nextText: string, expectedPrevText: string) => {
      expect(expectedPrevText).toBe(serverText);
      saveLog.push({ next: nextText, expected: expectedPrevText });
      if (firstSavePending) {
        firstSavePending = false;
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
      }
      serverText = nextText;
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: serverText,
      onSave,
      debounceMs: 400,
    });

    manager.updateText('第一段');
    await vi.advanceTimersByTimeAsync(200);
    manager.updateText('第一段，夜雨');
    await vi.advanceTimersByTimeAsync(399);
    expect(onSave).not.toHaveBeenCalled();

    // At 400ms from last keystroke, save #1 begins
    await vi.advanceTimersByTimeAsync(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveLog[0]).toEqual({ next: '第一段，夜雨', expected: '初始正文' });

    // User keeps typing while save #1 is still in flight
    manager.updateText('第一段，夜雨落下');
    await vi.advanceTimersByTimeAsync(450);
    // Must not start concurrent save #2 while save #1 is in flight!
    expect(onSave).toHaveBeenCalledTimes(1);

    // Finish save #1 -> serialized queue automatically runs save #2 with updated baseline
    releaseFirstSave();
    await manager.waitForIdle();

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(saveLog[1]).toEqual({ next: '第一段，夜雨落下', expected: '第一段，夜雨' });
    expect(serverText).toBe('第一段，夜雨落下');
    expect(manager.getSnapshot().dirty).toBe(false);
  });

  it('flushes immediately on blur / visibilitychange hidden / pagehide', async () => {
    let persisted = '';
    const onSave = vi.fn(async (nextText: string) => {
      persisted = nextText;
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: '',
      onSave,
      debounceMs: 400,
    });

    manager.updateText('失焦前草稿');
    await manager.flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(persisted).toBe('失焦前草稿');

    manager.updateText('切后台草稿');
    await manager.flush();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(persisted).toBe('切后台草稿');
  });

  it('retains >= 10 undo steps across typing and AI suggestion adoption with a 6-second undo banner', async () => {
    let persisted = '第0版';
    const onSave = vi.fn(async (nextText: string) => {
      persisted = nextText;
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: persisted,
      onSave,
      maxUndoSteps: 12,
      undoBannerMs: 6000,
    });

    for (let step = 1; step <= 11; step += 1) {
      manager.updateText(`第${step}版`);
    }
    manager.adoptSuggestion('第11版 + AI润色段', { label: '已采纳写作建议' });

    const snapAfterAdopt = manager.getSnapshot();
    expect(snapAfterAdopt.text).toBe('第11版 + AI润色段');
    expect(snapAfterAdopt.undoCount).toBe(12);
    expect(snapAfterAdopt.undoBanner?.message).toBe('已采纳写作建议');

    // Undo AI suggestion immediately
    expect(manager.undo()).toBe(true);
    expect(manager.getSnapshot().text).toBe('第11版');
    expect(manager.getSnapshot().undoBanner).toBeNull();

    // Undo remaining 11 typing steps back to 第0版
    for (let step = 10; step >= 0; step -= 1) {
      expect(manager.undo()).toBe(true);
      expect(manager.getSnapshot().text).toBe(`第${step}版`);
    }
    expect(manager.getSnapshot().canUndo).toBe(false);

    // 6-second auto-dismiss for undo banner
    manager.adoptSuggestion('再次采纳');
    expect(manager.getSnapshot().undoBanner).not.toBeNull();
    vi.advanceTimersByTime(5999);
    expect(manager.getSnapshot().undoBanner).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(manager.getSnapshot().undoBanner).toBeNull();

    await manager.flush();
    expect(persisted).toBe('再次采纳');
  });

  it('preserves user draft on save error and allows retry without data loss', async () => {
    let shouldFail = true;
    const onSave = vi.fn(async () => {
      if (shouldFail) throw new Error('disk busy');
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: '原文',
      onSave,
    });

    manager.updateText('未保存的重要内容');
    await manager.flush();

    expect(manager.getSnapshot().saveError).toBe('disk busy');
    expect(manager.getSnapshot().text).toBe('未保存的重要内容');
    expect(manager.getSnapshot().dirty).toBe(true);

    shouldFail = false;
    await manager.flush();
    expect(manager.getSnapshot().saveError).toBeNull();
    expect(manager.getSnapshot().dirty).toBe(false);
  });

  it('uses a 1500ms-2000ms default debounce and coalesces rapid typing into one serialized write', async () => {
    expect(DEFAULT_MANUSCRIPT_AUTOSAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(1500);
    expect(DEFAULT_MANUSCRIPT_AUTOSAVE_DEBOUNCE_MS).toBeLessThanOrEqual(2000);

    let persisted = '起稿';
    const onSave = vi.fn(async (nextText: string, expectedPrevText: string) => {
      expect(expectedPrevText).toBe(persisted);
      persisted = nextText;
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: persisted,
      onSave,
    });

    manager.updateText('起稿，夜色');
    await vi.advanceTimersByTimeAsync(1000);
    manager.updateText('起稿，夜色渐浓');
    await vi.advanceTimersByTimeAsync(DEFAULT_MANUSCRIPT_AUTOSAVE_DEBOUNCE_MS - 1);
    expect(onSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await manager.waitForIdle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(persisted).toBe('起稿，夜色渐浓');
    expect(manager.getSnapshot().slowSaving).toBe(false);
  });

  it('keeps slowSaving false during normal saves and exposes it only when an active save stalls past 5s', async () => {
    expect(DEFAULT_MANUSCRIPT_SLOW_SAVE_MS).toBe(5000);
    let releaseSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );

    const manager = createManuscriptAutosaveManager({
      workId: 'w1',
      persistedText: '原文',
      onSave,
      debounceMs: 1500,
      slowSaveMs: 5000,
    });

    manager.updateText('连续输入第1句');
    await vi.advanceTimersByTimeAsync(1400);
    expect(manager.getSnapshot().slowSaving).toBe(false);

    // Trigger save at 1500ms
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.getSnapshot().saving).toBe(true);
    expect(manager.getSnapshot().slowSaving).toBe(false);

    // Still under 5s threshold -> remains quiet
    await vi.advanceTimersByTimeAsync(4999);
    expect(manager.getSnapshot().slowSaving).toBe(false);

    // Crosses 5s -> slowSaving turns true
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getSnapshot().slowSaving).toBe(true);

    releaseSave();
    await manager.waitForIdle();
    expect(manager.getSnapshot().saving).toBe(false);
    expect(manager.getSnapshot().slowSaving).toBe(false);
  });

  it('flushes active and in-flight unmount managers through flushActiveManuscripts', async () => {
    let persisted = '旧稿';
    let releaseSave!: () => void;
    const onSave = vi.fn(async (nextText: string) => {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      persisted = nextText;
    });

    const manager = createManuscriptAutosaveManager({
      workId: 'w-flush',
      persistedText: persisted,
      onSave,
      debounceMs: 1800,
    });
    const unregister = registerActiveManuscriptManager(manager);

    expect(hasPendingManuscriptFlush()).toBe(false);
    manager.updateText('尚未落盘的正文');
    expect(hasPendingManuscriptFlush()).toBe(true);

    // Simulate transition/unmount starting a flush and unregistering before save finishes
    const flushPromise = flushActiveManuscripts();
    unregister();
    manager.dispose();

    expect(hasPendingManuscriptFlush()).toBe(true);
    await Promise.resolve();
    releaseSave();
    await flushPromise;

    expect(persisted).toBe('尚未落盘的正文');
    expect(hasPendingManuscriptFlush()).toBe(false);
  });

  it('keeps manuscript status text quiet during typing/normal saves and surfaces slow/error states', () => {
    expect(
      formatManuscriptStatusText({
        text: '纸月照进车站。',
        dirty: true,
        saving: false,
        slowSaving: false,
        saveError: null,
      }),
    ).toBe('7 字 · 已本地保存');

    expect(
      formatManuscriptStatusText({
        text: '纸月照进车站。',
        dirty: true,
        saving: true,
        slowSaving: false,
        saveError: null,
      }),
    ).toBe('7 字 · 已本地保存');

    expect(
      formatManuscriptStatusText({
        text: '纸月照进车站。',
        dirty: true,
        saving: true,
        slowSaving: true,
        saveError: null,
      }),
    ).toBe('7 字 · 正在保存…');

    expect(
      formatManuscriptStatusText({
        text: '纸月照进车站。',
        dirty: true,
        saving: false,
        slowSaving: false,
        saveError: '写入失败',
      }),
    ).toBe('7 字 · 保存失败');
  });
});
