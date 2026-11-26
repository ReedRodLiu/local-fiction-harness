import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = {
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  layoutEffects: [] as Array<{ fn: () => void | (() => void); deps?: unknown[]; prevDeps?: unknown[]; cleanup?: () => void }>,
  effects: [] as Array<{ fn: () => void | (() => void); deps?: unknown[]; prevDeps?: unknown[]; cleanup?: () => void }>,
  stateIdx: 0,
  refIdx: 0,
  layoutIdx: 0,
  effectIdx: 0,
};

function depsEqual(a?: unknown[], b?: unknown[]): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, i) => Object.is(item, b[i]));
}

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const idx = hookState.stateIdx++;
    if (!(idx in hookState.states)) {
      hookState.states[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const setState = (next: unknown) => {
      hookState.states[idx] =
        typeof next === 'function' ? (next as (prev: unknown) => unknown)(hookState.states[idx]) : next;
    };
    return [hookState.states[idx], setState];
  },
  useRef: (initial: unknown) => {
    const idx = hookState.refIdx++;
    if (!(idx in hookState.refs)) {
      hookState.refs[idx] = { current: initial };
    }
    return hookState.refs[idx];
  },
  useLayoutEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const idx = hookState.layoutIdx++;
    const existing = hookState.layoutEffects[idx];
    hookState.layoutEffects[idx] = { fn, deps, prevDeps: existing?.deps, cleanup: existing?.cleanup };
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const idx = hookState.effectIdx++;
    const existing = hookState.effects[idx];
    hookState.effects[idx] = { fn, deps, prevDeps: existing?.deps, cleanup: existing?.cleanup };
  },
}));

import { createDiagnosticCollector } from '../../src/harness/index.ts';
import { useAutoScrollTimeline, type UseAutoScrollTimelineOptions } from '../../src/ui/useAutoScrollTimeline.ts';

interface MockElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  parentElement: MockElement | null;
  listeners: Map<string, Set<(event: unknown) => void>>;
  addEventListener: (event: string, fn: (event: unknown) => void) => void;
  removeEventListener: (event: string, fn: (event: unknown) => void) => void;
  dispatch: (event: string, payload?: unknown) => void;
  closest: (selector: string) => Element | null;
}

class FakeElement {}

function createMockElement(overrides?: Partial<MockElement>): MockElement {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const el: MockElement = {
    scrollTop: 0,
    scrollHeight: 1600,
    clientHeight: 800,
    overflowY: 'auto',
    parentElement: null,
    listeners,
    addEventListener: (event, fn) => {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    removeEventListener: (event, fn) => {
      listeners.get(event)?.delete(fn);
    },
    dispatch: (event, payload = {}) => {
      for (const fn of listeners.get(event) ?? []) {
        fn(payload);
      }
    },
    closest: () => null,
    ...overrides,
  };
  Object.setPrototypeOf(el, FakeElement.prototype);
  return el;
}

describe('useAutoScrollTimeline regression suite (Issue #146)', () => {
  const windowListeners = new Map<string, Set<() => void>>();
  const viewportListeners = new Map<string, Set<() => void>>();
  let rafQueue: Array<{ id: number; cb: () => void }> = [];
  let nextRafId = 1;
  let cancelSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hookState.states = [];
    hookState.refs = [];
    hookState.layoutEffects = [];
    hookState.effects = [];
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.layoutIdx = 0;
    hookState.effectIdx = 0;
    windowListeners.clear();
    viewportListeners.clear();
    rafQueue = [];
    nextRafId = 1;
    cancelSpy = vi.fn((id: number) => {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    });

    (globalThis as Record<string, unknown>).Element = FakeElement;
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (event: string, fn: () => void) => {
        const set = windowListeners.get(event) ?? new Set();
        set.add(fn);
        windowListeners.set(event, set);
      },
      removeEventListener: (event: string, fn: () => void) => {
        windowListeners.get(event)?.delete(fn);
      },
      visualViewport: {
        addEventListener: (event: string, fn: () => void) => {
          const set = viewportListeners.get(event) ?? new Set();
          set.add(fn);
          viewportListeners.set(event, set);
        },
        removeEventListener: (event: string, fn: () => void) => {
          viewportListeners.get(event)?.delete(fn);
        },
      },
      getComputedStyle: (el: MockElement) => ({ overflowY: el.overflowY }),
      requestAnimationFrame: (cb: () => void) => {
        const id = nextRafId++;
        rafQueue.push({ id, cb });
        return id;
      },
      cancelAnimationFrame: cancelSpy,
    };
  });

  afterEach(() => {
    for (const entry of [...hookState.layoutEffects, ...hookState.effects]) {
      entry.cleanup?.();
    }
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).Element;
    vi.restoreAllMocks();
  });

  function flushRaf() {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const item of batch) item.cb();
  }

  function renderHook(options: UseAutoScrollTimelineOptions, stage: MockElement | null) {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.layoutIdx = 0;
    hookState.effectIdx = 0;
    const result = useAutoScrollTimeline(options);
    result.stageRef.current = stage as unknown as HTMLElement | null;
    for (const entry of hookState.layoutEffects) {
      if (!entry.prevDeps || !depsEqual(entry.prevDeps, entry.deps)) {
        entry.cleanup?.();
        entry.cleanup = entry.fn() ?? undefined;
      }
    }
    for (const entry of hookState.effects) {
      if (!entry.prevDeps || !depsEqual(entry.prevDeps, entry.deps)) {
        entry.cleanup?.();
        entry.cleanup = entry.fn() ?? undefined;
      }
    }
    return result;
  }

  it('resolves nearest scrollable ancestor when stageRef points to non-scrolling .timeline and wires parent scroll events', () => {
    const diagnostics = createDiagnosticCollector({ platform: 'web' });
    const mainStage = createMockElement({ overflowY: 'auto', scrollTop: 0, scrollHeight: 2400, clientHeight: 800 });
    const timeline = createMockElement({
      overflowY: 'visible',
      scrollTop: 0,
      scrollHeight: 2400,
      clientHeight: 2400,
      parentElement: mainStage,
    });

    renderHook(
      {
        contextKey: 'work-1:chat',
        activeLeafKey: 'leaf-1',
        turnCount: 6,
        isStreaming: true,
        streamPulse: '10:0::',
        diagnosticMode: 'writing',
        diagnostics,
      },
      timeline,
    );

    flushRaf();
    expect(mainStage.scrollTop).toBe(2400);
    expect(timeline.scrollTop).toBe(0);

    // Scrolling upward on mainStage (the resolved ancestor) pauses auto-follow
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    mainStage.dispatch('wheel', { deltaY: -40, target: timeline });
    mainStage.scrollTop = 400;
    mainStage.dispatch('scroll');
    expect(hookState.states[0]).toBe(true);

    const bundle = diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    expect(bundle.events.some((e) => e.action === 'autoscroll_target_non_scrollable')).toBe(true);
    const nonScrollEvent = bundle.events.find((e) => e.action === 'autoscroll_target_non_scrollable');
    expect(nonScrollEvent?.meta).toMatchObject({
      scrollMode: 'writing',
      scrollOverflowY: 'visible',
      reasonCode: 'resolved_scrollable_ancestor',
    });
  });

  it('uses explicit scrollContainerRef directly without recording a non-scrollable warning', () => {
    const diagnostics = createDiagnosticCollector({ platform: 'web' });
    const mainStage = createMockElement({ overflowY: 'auto', scrollTop: 0, scrollHeight: 2200, clientHeight: 800 });
    const timeline = createMockElement({
      overflowY: 'visible',
      scrollTop: 0,
      scrollHeight: 2200,
      clientHeight: 2200,
      parentElement: mainStage,
    });
    const scrollContainerRef = { current: mainStage as unknown as HTMLElement };

    renderHook(
      {
        contextKey: 'char-1:conv-1',
        activeLeafKey: 'leaf-1',
        turnCount: 4,
        isStreaming: true,
        streamPulse: '12:0::',
        scrollContainerRef,
        diagnosticMode: 'character',
        diagnostics,
      },
      timeline,
    );

    flushRaf();
    expect(mainStage.scrollTop).toBe(2200);
    const bundle = diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    expect(bundle.events.some((e) => e.action === 'autoscroll_target_non_scrollable')).toBe(false);
  });

  it('coalesces rapid streamPulse updates without canceling pending requestAnimationFrame', () => {
    const mainStage = createMockElement({ overflowY: 'auto', scrollTop: 0, scrollHeight: 1200, clientHeight: 800 });

    const baseOpts: UseAutoScrollTimelineOptions = {
      contextKey: 'story-1',
      activeLeafKey: 'leaf-1',
      turnCount: 4,
      isStreaming: true,
      streamPulse: '10:0::',
    };
    renderHook(baseOpts, mainStage);
    expect(rafQueue).toHaveLength(1);

    mainStage.scrollHeight = 1800;
    renderHook({ ...baseOpts, streamPulse: '20:0::' }, mainStage);
    mainStage.scrollHeight = 2400;
    renderHook({ ...baseOpts, streamPulse: '30:0::' }, mainStage);
    mainStage.scrollHeight = 3000;
    renderHook({ ...baseOpts, streamPulse: '40:0::' }, mainStage);

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(rafQueue).toHaveLength(1);

    flushRaf();
    expect(mainStage.scrollTop).toBe(3000);
  });

  it('resumes auto-follow on resumeFollow() after user had paused by scrolling up', () => {
    const mainStage = createMockElement({ overflowY: 'auto', scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });
    const opts: UseAutoScrollTimelineOptions = {
      contextKey: 'story-1',
      activeLeafKey: 'leaf-1',
      turnCount: 4,
      isStreaming: false,
      streamPulse: '0:0::',
    };
    const hook = renderHook(opts, mainStage);
    flushRaf();
    expect(mainStage.scrollTop).toBe(2000);

    // User scrolls up intentionally
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    hook.markScrollIntent(null);
    mainStage.scrollTop = 300;
    hook.handleScroll();
    expect(hookState.states[0]).toBe(true);

    // Streaming delta while paused must NOT scroll
    mainStage.scrollHeight = 2200;
    renderHook({ ...opts, isStreaming: true, streamPulse: '15:0::' }, mainStage);
    flushRaf();
    expect(mainStage.scrollTop).toBe(300);

    // Submitting a new message calls resumeFollow()
    hook.resumeFollow();
    expect(hookState.states[0]).toBe(false);
    expect(mainStage.scrollTop).toBe(2200);

    // Subsequent streaming delta keeps following to the bottom
    mainStage.scrollHeight = 2600;
    renderHook({ ...opts, turnCount: 5, isStreaming: true, streamPulse: '45:0::' }, mainStage);
    flushRaf();
    expect(mainStage.scrollTop).toBe(2600);
  });

  it('keeps bottom pinned on visualViewport resize when following, and stays put when user-paused', () => {
    const mainStage = createMockElement({ overflowY: 'auto', scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });
    const opts: UseAutoScrollTimelineOptions = {
      contextKey: 'writing-1',
      activeLeafKey: 'leaf-1',
      turnCount: 4,
      isStreaming: false,
    };
    const hook = renderHook(opts, mainStage);
    flushRaf();
    expect(mainStage.scrollTop).toBe(2000);

    // Virtual keyboard opens -> clientHeight shrinks, scrollTop was at 1200 (2000 - 800)
    mainStage.scrollTop = 1200;
    mainStage.clientHeight = 450;
    for (const fn of viewportListeners.get('resize') ?? []) fn();
    flushRaf();
    expect(mainStage.scrollTop).toBe(2000);

    // User pauses by scrolling up
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    hook.markScrollIntent(null);
    mainStage.scrollTop = 300;
    hook.handleScroll();

    // Virtual keyboard closes -> clientHeight grows back, must NOT snap to bottom
    mainStage.clientHeight = 800;
    for (const fn of viewportListeners.get('resize') ?? []) fn();
    flushRaf();
    expect(mainStage.scrollTop).toBe(300);
  });

  it('records zero-content diagnostics for missing target and failed scroll-to-bottom without duplicating', () => {
    const diagnostics = createDiagnosticCollector({ platform: 'web' });
    renderHook(
      {
        contextKey: 'story-missing',
        activeLeafKey: 'leaf-1',
        turnCount: 1,
        isStreaming: true,
        streamPulse: '1:0::',
        diagnosticMode: 'story',
        diagnostics,
      },
      null,
    );
    renderHook(
      {
        contextKey: 'story-missing',
        activeLeafKey: 'leaf-1',
        turnCount: 1,
        isStreaming: true,
        streamPulse: '2:0::',
        diagnosticMode: 'story',
        diagnostics,
      },
      null,
    );

    const bundle1 = diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    const missingEvents = bundle1.events.filter((e) => e.action === 'autoscroll_target_missing');
    expect(missingEvents).toHaveLength(1);
    expect(missingEvents[0].meta).toMatchObject({ scrollMode: 'story' });

    // Non-scrollable target with no scrollable ancestor & stuck scrollTop=0
    const stuckEl = createMockElement({
      overflowY: 'visible',
      scrollHeight: 2000,
      clientHeight: 800,
      parentElement: null,
    });
    Object.defineProperty(stuckEl, 'scrollTop', {
      get: () => 0,
      set: () => undefined,
      configurable: true,
    });
    renderHook(
      {
        contextKey: 'story-stuck',
        activeLeafKey: 'leaf-1',
        turnCount: 2,
        isStreaming: true,
        streamPulse: '5:0::',
        diagnosticMode: 'writing',
        diagnostics,
      },
      stuckEl,
    );
    flushRaf();

    const bundle2 = diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    expect(
      bundle2.events.some(
        (e) =>
          e.action === 'autoscroll_target_non_scrollable' &&
          e.meta?.reasonCode === 'no_scrollable_ancestor',
      ),
    ).toBe(true);
    expect(
      bundle2.events.some(
        (e) =>
          e.action === 'autoscroll_follow_anomaly' &&
          e.meta?.reasonCode === 'scroll_missed_bottom',
      ),
    ).toBe(true);
  });

  it('wires main-stage scrollContainerRef, diagnostics, and resumeFollow across App, CreativeWorkspace, DraftPane, and CharacterPane', () => {
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const appSource = readFileSync(join(repoRoot, 'src', 'ui', 'App.tsx'), 'utf8');
    const workspaceSource = readFileSync(join(repoRoot, 'src', 'ui', 'CreativeWorkspace.tsx'), 'utf8');
    const draftSource = readFileSync(join(repoRoot, 'src', 'ui', 'DraftPane.tsx'), 'utf8');
    const charSource = readFileSync(join(repoRoot, 'src', 'ui', 'CharacterPane.tsx'), 'utf8');

    expect(appSource).toContain('mainStageRef');
    expect(appSource).toContain('scrollContainerRef={mainStageRef}');
    expect(appSource).toContain("diagnosticMode: isWelcome ? 'welcome' : 'story'");
    expect(appSource).toContain('diagnostics: runtime.diagnostics');
    expect(appSource).toContain('autoScroll.resumeFollow()');

    expect(workspaceSource).toContain('scrollContainerRef?: RefObject<HTMLElement | null>');

    expect(draftSource).toContain('scrollContainerRef?: RefObject<HTMLElement | null>');
    expect(draftSource).toContain('scrollContainerRef: props.scrollContainerRef');
    expect(draftSource).toContain("diagnosticMode: 'writing'");
    expect(draftSource).toContain('diagnostics: runtime.diagnostics');
    expect(draftSource).toContain('autoScroll.resumeFollow()');

    expect(charSource).toContain('scrollContainerRef?: RefObject<HTMLElement | null>');
    expect(charSource).toContain('scrollContainerRef: props.scrollContainerRef');
    expect(charSource).toContain("diagnosticMode: 'character'");
    expect(charSource).toContain('diagnostics: runtime.diagnostics');
    expect(charSource).toContain('autoScroll.resumeFollow()');

    const extractBlock = (source: string, marker: string) => {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, start + 900);
    };
    expect(extractBlock(appSource, 'const handleContinueNeutralPartialRefusal')).toContain(
      'autoScroll.resumeFollow()',
    );
    expect(extractBlock(appSource, 'const handleContinuePartialRefusal')).toContain(
      'autoScroll.resumeFollow()',
    );
    expect(extractBlock(draftSource, 'const continuePartialDiscussion')).toContain(
      'autoScroll.resumeFollow()',
    );
    expect(extractBlock(charSource, 'const continuePartialCharacter')).toContain(
      'autoScroll.resumeFollow()',
    );
  });
});
