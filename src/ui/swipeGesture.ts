export const OS_EDGE_GUARD_PX = 20;
export const GESTURE_LOCK_SLOP_PX = 10;
export const DRAWER_SNAP_RATIO = 0.35;
export const PAGE_BACK_SNAP_RATIO = 0.35;
export const SWIPE_VELOCITY_THRESHOLD = 0.35;
export const VELOCITY_MIN_DISTANCE_PX = 24;

const VELOCITY_WINDOW_MS = 120;
const NON_SWIPEABLE_SELECTOR =
  'pre, table, .md-table-wrap, .md-code-block, .diff-view, .recent-story-list, .ds-filter-tabs, input, textarea, select, option, [contenteditable="true"], [role="slider"]';

export type GestureAxisLock = 'pending' | 'horizontal' | 'vertical';

export interface SwipePointerLike {
  button: number;
  isPrimary?: boolean;
  clientX: number;
  target: EventTarget | null;
}

export interface VelocityTracker {
  add: (x: number, timeStamp?: number) => void;
  velocityX: () => number;
}

/** Return true when the user currently has a non-collapsed text selection. */
export function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim().length > 0);
}

/** Return true when any native modal/sheet/drawer dialog is currently open in the top layer. */
export function hasOpenTopLayerDialog(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('dialog[open]'));
}

/** Return true when an event target resides inside a horizontal scroller or interactive form control. */
export function isInsideHorizontalScroller(
  target: EventTarget | null,
  boundary?: EventTarget | null,
): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  if (target.closest(NON_SWIPEABLE_SELECTOR)) {
    return true;
  }
  const docBody = typeof document !== 'undefined' ? document.body : null;
  const docRoot = typeof document !== 'undefined' ? document.documentElement : null;
  let current: Element | null = target;
  while (current && current !== boundary && current !== docBody && current !== docRoot) {
    if (current.scrollWidth > current.clientWidth + 1) {
      const overflowX = typeof getComputedStyle === 'function'
        ? getComputedStyle(current).overflowX
        : '';
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

/** Guard pointerdown starts against OS edge zones, text selection, and horizontal scrollers. */
export function shouldIgnoreSwipeStart(
  event: SwipePointerLike,
  boundary?: EventTarget | null,
): boolean {
  if (event.button !== 0 || event.isPrimary === false) {
    return true;
  }
  if (event.clientX < OS_EDGE_GUARD_PX) {
    return true;
  }
  if (hasActiveTextSelection()) {
    return true;
  }
  return isInsideHorizontalScroller(event.target, boundary);
}

/** Track recent horizontal pointer samples to compute release velocity in px/ms. */
export function createVelocityTracker(): VelocityTracker {
  const samples: Array<{ x: number; t: number }> = [];

  const now = (timeStamp?: number) =>
    typeof timeStamp === 'number' && Number.isFinite(timeStamp) && timeStamp > 0
      ? timeStamp
      : performance.now();

  return {
    add(x: number, timeStamp?: number) {
      const t = now(timeStamp);
      samples.push({ x, t });
      while (samples.length > 2 && t - samples[0].t > VELOCITY_WINDOW_MS) {
        samples.shift();
      }
    },
    velocityX() {
      if (samples.length < 2) return 0;
      const earliest = samples[0];
      const latest = samples[samples.length - 1];
      const dt = latest.t - earliest.t;
      if (dt < 4) return 0;
      return (latest.x - earliest.x) / dt;
    },
  };
}

/** Resolve whether horizontal drag distance or release velocity satisfies commit criteria. */
export function shouldCommitHorizontalSwipe(options: {
  deltaX: number;
  width: number;
  snapRatio: number;
  velocityX: number;
  direction: 'right' | 'left';
}): boolean {
  const { deltaX, width, snapRatio, velocityX, direction } = options;
  const signedDelta = direction === 'right' ? deltaX : -deltaX;
  const signedVelocity = direction === 'right' ? velocityX : -velocityX;
  if (signedDelta <= 0) return false;
  const safeWidth = Math.max(width, 1);
  return (
    signedDelta > safeWidth * snapRatio ||
    (signedVelocity >= SWIPE_VELOCITY_THRESHOLD && signedDelta >= VELOCITY_MIN_DISTANCE_PX)
  );
}

/** Resolve initial gesture axis lock after exceeding the touch slop threshold. */
export function resolveSwipeAxisLock(
  dx: number,
  dy: number,
  expectedDirection: 'right' | 'left',
): GestureAxisLock {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < GESTURE_LOCK_SLOP_PX) {
    return 'pending';
  }
  if (hasActiveTextSelection() || Math.abs(dy) > Math.abs(dx)) {
    return 'vertical';
  }
  if ((expectedDirection === 'right' && dx <= 0) || (expectedDirection === 'left' && dx >= 0)) {
    return 'vertical';
  }
  return 'horizontal';
}
