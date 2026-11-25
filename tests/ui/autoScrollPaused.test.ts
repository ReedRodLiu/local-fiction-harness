import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = {
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  layoutEffects: [] as Array<() => void | (() => void)>,
  effects: [] as Array<() => void | (() => void)>,
  stateIdx: 0,
  refIdx: 0,
  rerender: () => undefined,
};

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
  useLayoutEffect: (fn: () => void | (() => void)) => {
    hookState.layoutEffects.push(fn);
  },
  useEffect: (fn: () => void | (() => void)) => {
    hookState.effects.push(fn);
  },
}));

import { useAutoScrollTimeline, type UseAutoScrollTimelineOptions } from '../../src/ui/useAutoScrollTimeline.ts';

interface MockStage {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function createMockStage(overrides?: Partial<MockStage>): MockStage {
  return {
    scrollTop: 0,
    scrollHeight: 1600,
    clientHeight: 800,
    ...overrides,
  };
}

describe('useAutoScrollTimeline paused behavior for overlay pages', () => {
  const listeners = new Map<string, Set<() => void>>();
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    hookState.states = [];
    hookState.refs = [];
    hookState.layoutEffects = [];
    hookState.effects = [];
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    listeners.clear();
    cleanups = [];

    (globalThis as Record<string, unknown>).Element = class {};
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (event: string, fn: () => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
      },
      removeEventListener: (event: string, fn: () => void) => {
        listeners.get(event)?.delete(fn);
      },
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      cancelAnimationFrame: () => undefined,
    };
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).Element;
  });

  function renderHook(options: UseAutoScrollTimelineOptions, stage: MockStage) {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.layoutEffects = [];
    hookState.effects = [];
    const result = useAutoScrollTimeline(options);
    result.stageRef.current = stage as unknown as HTMLElement;
    for (const fn of hookState.layoutEffects) {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    }
    for (const fn of hookState.effects) {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    }
    return result;
  }

  it('detaches containerHandlers and ignores scroll, resize, intent, and scrollToBottom when paused', () => {
    const stage = createMockStage({ scrollTop: 320, scrollHeight: 1800, clientHeight: 844 });
    const result = renderHook(
      {
        contextKey: 'story-1',
        activeLeafKey: 'leaf-1',
        turnCount: 4,
        isStreaming: false,
        paused: true,
      },
      stage,
    );

    expect(result.containerHandlers).toEqual({});

    // Simulate scrolling SettingsPage down and back up, plus layout changes and window resize
    stage.scrollTop = 600;
    result.handleScroll();
    stage.scrollTop = 250;
    result.handleScroll();
    stage.scrollHeight = 2100;
    result.handleScroll();
    result.markScrollIntent(null);
    result.scrollToBottom();
    for (const handler of listeners.get('resize') ?? []) {
      handler();
    }

    // Must not snap scrollTop to scrollHeight (bottom) while paused!
    expect(stage.scrollTop).toBe(250);
    expect(hookState.states[0]).toBe(false);
  });

  it('restores a paused reading position when resuming from overlay pause', () => {
    const stage = createMockStage({ scrollTop: 800, scrollHeight: 1600, clientHeight: 800 });
    const active = renderHook(
      {
        contextKey: 'story-1',
        activeLeafKey: 'leaf-1',
        turnCount: 4,
        isStreaming: false,
        paused: false,
      },
      stage,
    );

    // User scrolls up intentionally in story mode to pause follow-scroll at scrollTop=300
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    active.markScrollIntent(null);
    stage.scrollTop = 300;
    active.handleScroll();
    expect(hookState.states[0]).toBe(true);

    // User opens Settings (paused=true), which resets stage scrollTop to 0 and scrolls Settings
    renderHook(
      {
        contextKey: 'story-1',
        activeLeafKey: 'leaf-1',
        turnCount: 4,
        isStreaming: false,
        paused: true,
      },
      stage,
    );
    stage.scrollTop = 0;

    // User closes Settings (paused=false) -> story reading scrollTop=300 is restored
    renderHook(
      {
        contextKey: 'story-1',
        activeLeafKey: 'leaf-1',
        turnCount: 4,
        isStreaming: false,
        paused: false,
      },
      stage,
    );
    expect(stage.scrollTop).toBe(300);
    vi.restoreAllMocks();
  });
});
