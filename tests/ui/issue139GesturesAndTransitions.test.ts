import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = {
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  layoutEffects: [] as Array<() => void | (() => void)>,
  effects: [] as Array<() => void | (() => void)>,
  stateIdx: 0,
  refIdx: 0,
};

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
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
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  };
});

import {
  DRAWER_SNAP_RATIO,
  GESTURE_LOCK_SLOP_PX,
  OS_EDGE_GUARD_PX,
  SWIPE_VELOCITY_THRESHOLD,
  createVelocityTracker,
  resolveSwipeAxisLock,
  shouldCommitHorizontalSwipe,
  shouldIgnoreSwipeStart,
} from '../../src/ui/swipeGesture.ts';
import { useEdgeSwipeToOpen } from '../../src/ui/useEdgeSwipeToOpen.ts';
import { createDrawerCloseSwipeHandlers } from '../../src/ui/primitives/DrawerDialog.tsx';
import { createOverlaySwipeBackHandlers } from '../../src/ui/primitives/OverlayPageShell.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readFile = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

class MockElement {
  tagName: string;
  className: string;
  parentElement: MockElement | null = null;
  children: MockElement[] = [];
  dataset: Record<string, string> = {};
  scrollWidth = 300;
  clientWidth = 300;
  offsetWidth = 312;
  private styles = new Map<string, string>();
  private attributes = new Map<string, string>();
  overflowX = 'visible';
  capturedPointers = new Set<number>();

  setPointerCapture(pointerId: number) {
    this.capturedPointers.add(pointerId);
  }
  hasPointerCapture(pointerId: number) {
    return this.capturedPointers.has(pointerId);
  }
  releasePointerCapture(pointerId: number) {
    this.capturedPointers.delete(pointerId);
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }

  constructor(tagName = 'div', className = '') {
    this.tagName = tagName.toUpperCase();
    this.className = className;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    const parts = selector.split(',').map((item) => item.trim());
    return parts.some((part) => {
      if (part === '[contenteditable="true"]') return this.attributes.get('contenteditable') === 'true';
      if (part === '[role="slider"]') return this.attributes.get('role') === 'slider';
      if (part.startsWith('.')) return this.className.split(/\s+/).includes(part.slice(1));
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }

  closest(selector: string): MockElement | null {
    let current: MockElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector<T = MockElement>(selector: string): T | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child as unknown as T;
      const nested = child.querySelector<T>(selector);
      if (nested) return nested;
    }
    return null;
  }

  style = {
    setProperty: (prop: string, value: string) => {
      this.styles.set(prop, value);
    },
    removeProperty: (prop: string) => {
      this.styles.delete(prop);
    },
    getPropertyValue: (prop: string) => this.styles.get(prop) ?? '',
    set transform(val: string) {
      this._owner.styles.set('transform', val);
    },
    get transform() {
      return this._owner.styles.get('transform') ?? '';
    },
    set opacity(val: string) {
      this._owner.styles.set('opacity', val);
    },
    get opacity() {
      return this._owner.styles.get('opacity') ?? '';
    },
    _owner: undefined as unknown as MockElement,
  };
}

function makeElement(tagName = 'div', className = '') {
  const el = new MockElement(tagName, className);
  el.style._owner = el;
  return el;
}

describe('Issue #139: motion tokens, reduced-motion, swipe guards, drawer swipe, and overlay transitions', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
  const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');

  let selectionState = { isCollapsed: true, text: '' };
  let hasOpenDialog = false;

  beforeEach(() => {
    hookState.states = [];
    hookState.refs = [];
    hookState.layoutEffects = [];
    hookState.effects = [];
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    selectionState = { isCollapsed: true, text: '' };
    hasOpenDialog = false;

    (globalThis as Record<string, unknown>).Element = MockElement;
    (globalThis as Record<string, unknown>).getComputedStyle = (el: MockElement) => ({
      overflowX: el.overflowX,
      transitionDuration: '0.26s',
      animationDuration: '0s',
    });
    (globalThis as Record<string, unknown>).window = {
      innerWidth: 390,
      innerHeight: 844,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      getSelection: () => ({
        isCollapsed: selectionState.isCollapsed,
        toString: () => selectionState.text,
      }),
    };
    (globalThis as Record<string, unknown>).document = {
      body: makeElement('body'),
      documentElement: makeElement('html'),
      querySelector: (selector: string) => (selector.startsWith('dialog[open]') && hasOpenDialog ? makeElement('dialog') : null),
    };
  });

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as Record<string, unknown>).window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as Record<string, unknown>).document;
    if (originalElement) Object.defineProperty(globalThis, 'Element', originalElement);
    else delete (globalThis as Record<string, unknown>).Element;
    if (originalGetComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', originalGetComputedStyle);
    else delete (globalThis as Record<string, unknown>).getComputedStyle;
  });

  it('defines tiered cross-platform motion tokens and reduced-motion opacity fallbacks in CSS', () => {
    const tokensCss = readFile('src/ui/styles/tokens.css');
    const shellCss = readFile('src/ui/styles/shell.css');

    expect(tokensCss).toContain('--motion-duration-fast: 150ms;');
    expect(tokensCss).toContain('--motion-duration: 220ms;');
    expect(tokensCss).toContain('--motion-duration-drawer: 260ms;');
    expect(tokensCss).toContain('--motion-duration-page: 300ms;');
    expect(tokensCss).toContain('--motion-easing-page: cubic-bezier(0.32, 0.72, 0, 1);');

    expect(shellCss).toContain('.library-dialog-scrim');
    expect(shellCss).toContain('.app-overlay-layer');
    expect(shellCss).toContain('.app-overlay-stage');
    expect(shellCss).toContain('.app-overlay-backdrop');
    expect(shellCss).toContain('.app-shell-underlay.is-covered');
    expect(shellCss).toContain('@keyframes stage-enter');
    expect(shellCss).toContain('@keyframes stage-enter-reduced');

    expect(shellCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.app-overlay-stage[\s\S]*transform:\s*none\s*!important;/,
    );
    expect(shellCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*stage-enter-reduced/,
    );
  });

  it('guards OS predictive-back edge, horizontal scrollers, inputs/ranges, and active text selection', () => {
    const boundary = makeElement('main', 'main-stage');

    // OS edge zone (< 20px) is always ignored
    expect(
      shouldIgnoreSwipeStart({ button: 0, clientX: OS_EDGE_GUARD_PX - 1, target: boundary }, boundary),
    ).toBe(true);
    expect(
      shouldIgnoreSwipeStart({ button: 0, clientX: OS_EDGE_GUARD_PX, target: boundary }, boundary),
    ).toBe(false);

    // Non-swipeable semantic targets
    for (const [tag, cls, attrs] of [
      ['pre', 'md-code-block', {}],
      ['table', 'md-table', {}],
      ['div', 'recent-story-list', {}],
      ['div', 'ds-filter-tabs', {}],
      ['input', 'settings-reasoning-slider', {}],
      ['textarea', '', {}],
      ['select', '', {}],
      ['div', '', { contenteditable: 'true' }],
      ['div', '', { role: 'slider' }],
    ] as const) {
      const el = makeElement(tag, cls);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      boundary.appendChild(el);
      const child = makeElement('span');
      el.appendChild(child);
      expect(shouldIgnoreSwipeStart({ button: 0, clientX: 80, target: child }, boundary), `${tag}.${cls}`).toBe(true);
    }

    // Generic dynamically overflowing horizontal scroller
    const scroller = makeElement('div', 'custom-scroll');
    scroller.overflowX = 'auto';
    scroller.scrollWidth = 640;
    scroller.clientWidth = 320;
    boundary.appendChild(scroller);
    const scrollerText = makeElement('span');
    scroller.appendChild(scrollerText);
    expect(shouldIgnoreSwipeStart({ button: 0, clientX: 80, target: scrollerText }, boundary)).toBe(true);

    // Active non-collapsed text selection
    selectionState = { isCollapsed: false, text: '已选中的文字' };
    expect(shouldIgnoreSwipeStart({ button: 0, clientX: 80, target: boundary }, boundary)).toBe(true);
  });

  it('computes velocity and distance thresholds accurately for swipe open/close/back', () => {
    const tracker = createVelocityTracker();
    tracker.add(100, 1000);
    tracker.add(160, 1100);
    expect(tracker.velocityX()).toBeCloseTo(0.6, 2);

    // Below distance threshold (35% of 300 = 105) and slow velocity -> false
    expect(
      shouldCommitHorizontalSwipe({
        deltaX: 80,
        width: 300,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX: 0.1,
        direction: 'right',
      }),
    ).toBe(false);

    // Past distance threshold (> 35% of 300) even with slow velocity -> true
    expect(
      shouldCommitHorizontalSwipe({
        deltaX: 110,
        width: 300,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX: 0.05,
        direction: 'right',
      }),
    ).toBe(true);

    // Fast velocity flick (>= 0.35 px/ms and >= 24px) -> true
    expect(
      shouldCommitHorizontalSwipe({
        deltaX: 36,
        width: 300,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX: SWIPE_VELOCITY_THRESHOLD,
        direction: 'right',
      }),
    ).toBe(true);

    // Leftward close flick
    expect(
      shouldCommitHorizontalSwipe({
        deltaX: -40,
        width: 300,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX: -0.5,
        direction: 'left',
      }),
    ).toBe(true);
  });

  it('drives drawer live transform & scrim opacity on canvas right-swipe and commits on distance or velocity', () => {
    const stage = makeElement('main', 'main-stage');
    const dialog = makeElement('dialog', 'library-dialog');
    const scrim = makeElement('div', 'library-dialog-scrim');
    const sheet = makeElement('div', 'library-dialog-sheet');
    sheet.offsetWidth = 300;
    dialog.appendChild(scrim);
    dialog.appendChild(sheet);

    const onOpen = vi.fn();
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    const controller = useEdgeSwipeToOpen(true, onOpen);
    controller.drawerDialogRef.current = dialog as unknown as HTMLDialogElement;

    // 1. Canvas-wide right swipe starting at clientX = 140 (> 24px!) tracks live progress
    controller.containerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 140,
      clientY: 300,
      timeStamp: 1000,
      target: stage,
      currentTarget: stage,
    } as never);

    controller.containerHandlers.onPointerMove({
      pointerId: 1,
      clientX: 260, // dx = 120 (> 35% of 300)
      clientY: 304,
      timeStamp: 1400,
    } as never);

    expect(dialog.dataset.dragging).toBe('true');
    expect(sheet.style.transform).toBe('translateX(-180px)');
    expect(Number(scrim.style.opacity)).toBeCloseTo(0.4, 2);

    controller.containerHandlers.onPointerUp({
      pointerId: 1,
      clientX: 260,
      clientY: 304,
      timeStamp: 1400,
    } as never);

    expect(onOpen).toHaveBeenCalledTimes(1);

    // 2. Vertical scroll on canvas does NOT open drawer
    const onOpenVertical = vi.fn();
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    const verticalController = useEdgeSwipeToOpen(true, onOpenVertical);
    verticalController.drawerDialogRef.current = dialog as unknown as HTMLDialogElement;

    verticalController.containerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 2,
      clientX: 140,
      clientY: 200,
      timeStamp: 2000,
      target: stage,
      currentTarget: stage,
    } as never);
    verticalController.containerHandlers.onPointerMove({
      pointerId: 2,
      clientX: 155,
      clientY: 280,
      timeStamp: 2100,
    } as never);
    verticalController.containerHandlers.onPointerUp({
      pointerId: 2,
      clientX: 260,
      clientY: 320,
      timeStamp: 2200,
    } as never);

    expect(onOpenVertical).not.toHaveBeenCalled();

    // 3. Open top-layer <dialog open> blocks canvas swipe-to-open
    hasOpenDialog = true;
    const onOpenBlocked = vi.fn();
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    const blockedController = useEdgeSwipeToOpen(true, onOpenBlocked);
    blockedController.containerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 3,
      clientX: 140,
      clientY: 200,
      timeStamp: 3000,
      target: stage,
      currentTarget: stage,
    } as never);
    blockedController.containerHandlers.onPointerMove({
      pointerId: 3,
      clientX: 300,
      clientY: 202,
      timeStamp: 3100,
    } as never);
    blockedController.containerHandlers.onPointerUp({
      pointerId: 3,
      clientX: 300,
      clientY: 202,
      timeStamp: 3100,
    } as never);
    expect(onOpenBlocked).not.toHaveBeenCalled();
  });

  it('supports DrawerDialog close swipe with velocity check and synchronized scrim opacity', () => {
    const dialog = makeElement('dialog', 'library-dialog');
    const scrim = makeElement('div', 'library-dialog-scrim');
    const sheet = makeElement('div', 'library-dialog-sheet');
    sheet.offsetWidth = 300;
    dialog.appendChild(scrim);
    dialog.appendChild(sheet);

    const onClose = vi.fn();
    const handlers = createDrawerCloseSwipeHandlers({
      sheetRef: { current: sheet as unknown as HTMLDivElement },
      onClose,
    });

    handlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 10,
      clientX: 240,
      clientY: 200,
      timeStamp: 1000,
      target: sheet,
      currentTarget: sheet,
    } as never);

    handlers.onPointerMove({
      pointerId: 10,
      clientX: 180, // dx = -60 (20% width, below 35% distance, but fast velocity!)
      clientY: 202,
      timeStamp: 1080, // vx = -60 / 80 = -0.75 px/ms
    } as never);

    expect(sheet.style.transform).toBe('translateX(-60px)');
    expect(Number(scrim.style.opacity)).toBeCloseTo(0.8, 2);

    handlers.onPointerUp({
      pointerId: 10,
      clientX: 180,
      clientY: 202,
      timeStamp: 1080,
    } as never);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports OverlayPageShell interactive swipe-back and App.tsx keeps overlay mounted during exit', () => {
    const layer = makeElement('div', 'app-overlay-layer');
    const backdrop = makeElement('div', 'app-overlay-backdrop');
    const stage = makeElement('div', 'app-overlay-stage');
    stage.offsetWidth = 390;
    const shell = makeElement('section', 'overlay-page-shell');
    const slider = makeElement('input', 'settings-reasoning-slider');
    layer.appendChild(backdrop);
    layer.appendChild(stage);
    stage.appendChild(shell);
    shell.appendChild(slider);

    const onBack = vi.fn();
    const handlers = createOverlaySwipeBackHandlers({
      shellRef: { current: shell as unknown as HTMLElement },
      backDisabled: false,
      onBack,
    });

    // Swiping on range slider does NOT trigger onBack
    handlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 20,
      clientX: 80,
      clientY: 200,
      timeStamp: 1000,
      target: slider,
      currentTarget: shell,
    } as never);
    handlers.onPointerMove({
      pointerId: 20,
      clientX: 260,
      clientY: 200,
      timeStamp: 1100,
    } as never);
    handlers.onPointerUp({
      pointerId: 20,
      clientX: 260,
      clientY: 200,
      timeStamp: 1100,
    } as never);
    expect(onBack).not.toHaveBeenCalled();

    // Swiping right on page body tracks drag and triggers onBack past threshold
    handlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 21,
      clientX: 60,
      clientY: 300,
      timeStamp: 2000,
      target: shell,
      currentTarget: shell,
    } as never);
    handlers.onPointerMove({
      pointerId: 21,
      clientX: 220, // dx = 160 (> 35% of 390)
      clientY: 304,
      timeStamp: 2500,
    } as never);

    expect(layer.dataset.dragging).toBe('true');
    expect(stage.style.transform).toBe('translateX(160px)');
    expect(Number(backdrop.style.opacity)).toBeCloseTo(1 - 160 / 390, 2);

    handlers.onPointerUp({
      pointerId: 21,
      clientX: 220,
      clientY: 304,
      timeStamp: 2500,
    } as never);
    expect(onBack).toHaveBeenCalledTimes(1);

    const appSource = readFile('src/ui/App.tsx');
    expect(appSource).toContain('waitForExitAnimation');
    expect(appSource).toContain('app-overlay-layer');
    expect(appSource).toContain('data-closing');
  });

  it('Issue #144: aligns touch-action CSS rules, slop/edge-guard thresholds, and axis lock for Android WebView', () => {
    expect(OS_EDGE_GUARD_PX).toBeGreaterThanOrEqual(28);
    expect(OS_EDGE_GUARD_PX).toBeLessThanOrEqual(32);
    expect(GESTURE_LOCK_SLOP_PX).toBeGreaterThanOrEqual(6);
    expect(GESTURE_LOCK_SLOP_PX).toBeLessThanOrEqual(8);

    // Slightly diagonal initial movement does not prematurely abort before horizontal lock
    expect(resolveSwipeAxisLock(-4, 4, 'left')).toBe('pending');
    expect(resolveSwipeAxisLock(-5, 6, 'left')).toBe('pending');
    expect(resolveSwipeAxisLock(-8, 6, 'left')).toBe('horizontal');
    expect(resolveSwipeAxisLock(7, 4, 'right')).toBe('horizontal');
    // Vertical dominance yields cleanly to native vertical scroll
    expect(resolveSwipeAxisLock(2, 8, 'right')).toBe('vertical');
    expect(resolveSwipeAxisLock(-2, 8, 'left')).toBe('vertical');
    // Wrong horizontal direction yields cleanly
    expect(resolveSwipeAxisLock(8, 1, 'left')).toBe('vertical');
    expect(resolveSwipeAxisLock(-8, 1, 'right')).toBe('vertical');

    const shellCss = readFile('src/ui/styles/shell.css');
    const importCss = readFile('src/ui/styles/import-wizard.css');
    const baseCss = readFile('src/ui/styles/base.css');

    expect(shellCss).toMatch(/\.main-stage\s*\{[^}]*touch-action:\s*pan-y;/);
    expect(shellCss).toMatch(/\.library-dialog-sheet\s*\{[^}]*touch-action:\s*pan-y;/);
    expect(shellCss).toMatch(/\.library-list-scroll\s*\{[^}]*touch-action:\s*pan-y;/);
    expect(shellCss).toMatch(/\.overlay-page-shell\s*\{[^}]*touch-action:\s*pan-y;/);
    expect(shellCss).toMatch(/\.app-overlay-stage\s*\{[^}]*touch-action:\s*pan-y;/);
    expect(shellCss).toMatch(/\.sheet-drag-handle\s*\{[^}]*touch-action:\s*none;/);
    expect(shellCss).toMatch(/\.recent-story-list\s*\{[^}]*touch-action:\s*pan-x pan-y;/);
    expect(importCss).toMatch(
      /\.overlay-page-shell\[data-has-footer='true'\]\s*\.overlay-page-content\s*\{[^}]*touch-action:\s*pan-y;/,
    );
    expect(baseCss).toMatch(/\.md-view\s*\.md-code-block\s*\{[^}]*touch-action:\s*pan-x pan-y;/);
    expect(baseCss).toMatch(/\.md-view\s*\.md-table-wrap\s*\{[^}]*touch-action:\s*pan-x pan-y;/);
  });

  it('Issue #144: captures and releases pointer across all 3 swipe controllers, supports drawer list close drag, and emits zero-content diagnostics', () => {
    // 1. DrawerDialog close drag starting from a button inside .library-list-scroll
    const dialog = makeElement('dialog', 'library-dialog');
    const scrim = makeElement('div', 'library-dialog-scrim');
    const sheet = makeElement('div', 'library-dialog-sheet');
    sheet.offsetWidth = 300;
    const listScroll = makeElement('div', 'library-list-scroll');
    const row = makeElement('li', 'story-list-item');
    const storyBtn = makeElement('button', 'story-select-button');
    dialog.appendChild(scrim);
    dialog.appendChild(sheet);
    sheet.appendChild(listScroll);
    listScroll.appendChild(row);
    row.appendChild(storyBtn);

    const drawerDiagnostics: unknown[] = [];
    const onClose = vi.fn();
    const drawerHandlers = createDrawerCloseSwipeHandlers({
      sheetRef: { current: sheet as unknown as HTMLDivElement },
      onClose,
      onDiagnostic: (ev) => drawerDiagnostics.push(ev),
    });

    drawerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 31,
      clientX: 250,
      clientY: 220,
      timeStamp: 1000,
      target: storyBtn,
      currentTarget: sheet,
    } as never);

    // Slightly diagonal initial move stays pending and does not yet capture
    drawerHandlers.onPointerMove({
      pointerId: 31,
      clientX: 245,
      clientY: 226,
      timeStamp: 1016,
      currentTarget: sheet,
    } as never);
    expect(sheet.capturedPointers.has(31)).toBe(false);

    // Clear horizontal follow-through locks horizontal and acquires pointer capture
    drawerHandlers.onPointerMove({
      pointerId: 31,
      clientX: 240,
      clientY: 226,
      timeStamp: 1032,
      currentTarget: sheet,
    } as never);
    expect(sheet.capturedPointers.has(31)).toBe(true);
    expect(dialog.dataset.dragging).toBe('true');

    // Secondary stray pointer up does not abort active primary drag
    drawerHandlers.onPointerUp({
      pointerId: 99,
      clientX: 100,
      clientY: 200,
      timeStamp: 1040,
      currentTarget: sheet,
    } as never);
    expect(dialog.dataset.dragging).toBe('true');

    drawerHandlers.onPointerMove({
      pointerId: 31,
      clientX: 190,
      clientY: 228,
      timeStamp: 1080,
      currentTarget: sheet,
    } as never);
    drawerHandlers.onPointerUp({
      pointerId: 31,
      clientX: 190,
      clientY: 228,
      timeStamp: 1080,
      currentTarget: sheet,
    } as never);
    expect(sheet.capturedPointers.has(31)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Canceled drawer drag releases capture and records diagnostic breadcrumb
    drawerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 32,
      clientX: 240,
      clientY: 220,
      timeStamp: 2000,
      target: storyBtn,
      currentTarget: sheet,
    } as never);
    drawerHandlers.onPointerMove({
      pointerId: 32,
      clientX: 225,
      clientY: 221,
      timeStamp: 2020,
      currentTarget: sheet,
    } as never);
    expect(sheet.capturedPointers.has(32)).toBe(true);
    drawerHandlers.onPointerCancel({
      pointerId: 32,
      currentTarget: sheet,
    } as never);
    expect(sheet.capturedPointers.has(32)).toBe(false);
    expect(sheet.style.transform).toBe('');
    expect(drawerDiagnostics).toEqual([
      {
        action: 'swipe_gesture_canceled',
        surface: 'drawer_close',
        reasonCode: 'pointer_cancel_horizontal',
      },
    ]);

    // 2. Canvas swipe-to-open acquires/releases capture (and survives throwing setPointerCapture)
    const stage = makeElement('main', 'main-stage');
    stage.setPointerCapture = () => {
      throw new Error('InvalidStateError');
    };
    const openDiagnostics: unknown[] = [];
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    const openController = useEdgeSwipeToOpen(true, vi.fn(), (ev) => openDiagnostics.push(ev));
    openController.drawerDialogRef.current = dialog as unknown as HTMLDialogElement;

    openController.containerHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 41,
      clientX: 80,
      clientY: 300,
      timeStamp: 3000,
      target: stage,
      currentTarget: stage,
    } as never);
    openController.containerHandlers.onPointerMove({
      pointerId: 41,
      clientX: 110,
      clientY: 301,
      timeStamp: 3040,
      currentTarget: stage,
    } as never);
    openController.containerHandlers.onPointerUp({
      pointerId: 41,
      clientX: 110,
      clientY: 301,
      timeStamp: 3400,
      currentTarget: stage,
    } as never);
    expect(openDiagnostics).toEqual([
      {
        action: 'swipe_gesture_rejected',
        surface: 'drawer_open',
        reasonCode: 'below_threshold',
      },
    ]);

    // 3. OverlayPageShell swipe-back acquires/releases capture and records cancel breadcrumb
    const layer = makeElement('div', 'app-overlay-layer');
    const overlayStage = makeElement('div', 'app-overlay-stage');
    overlayStage.offsetWidth = 390;
    const shell = makeElement('section', 'overlay-page-shell');
    layer.appendChild(overlayStage);
    overlayStage.appendChild(shell);

    const overlayDiagnostics: unknown[] = [];
    const overlayHandlers = createOverlaySwipeBackHandlers({
      shellRef: { current: shell as unknown as HTMLElement },
      backDisabled: false,
      onBack: vi.fn(),
      onDiagnostic: (ev) => overlayDiagnostics.push(ev),
    });

    overlayHandlers.onPointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 51,
      clientX: 60,
      clientY: 200,
      timeStamp: 4000,
      target: shell,
      currentTarget: shell,
    } as never);
    overlayHandlers.onPointerMove({
      pointerId: 51,
      clientX: 90,
      clientY: 202,
      timeStamp: 4020,
      currentTarget: shell,
    } as never);
    expect(shell.capturedPointers.has(51)).toBe(true);
    overlayHandlers.onPointerCancel({
      pointerId: 51,
      currentTarget: shell,
    } as never);
    expect(shell.capturedPointers.has(51)).toBe(false);
    expect(overlayDiagnostics).toEqual([
      {
        action: 'swipe_gesture_canceled',
        surface: 'overlay_back',
        reasonCode: 'pointer_cancel_horizontal',
      },
    ]);
  });
});
