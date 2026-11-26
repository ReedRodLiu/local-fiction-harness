import { createContext } from 'react';

export const OS_EDGE_GUARD_PX = 32;
export const GESTURE_LOCK_SLOP_PX = 6;
export const DRAWER_SNAP_RATIO = 0.35;
export const PAGE_BACK_SNAP_RATIO = 0.35;
export const SWIPE_VELOCITY_THRESHOLD = 0.35;
export const VELOCITY_MIN_DISTANCE_PX = 24;

const VELOCITY_WINDOW_MS = 120;
const VERTICAL_DOMINANCE_RATIO = 1.25;
const MAX_AXIS_PENDING_PX = 18;
const NON_SWIPEABLE_SELECTOR =
  'pre, table, .md-table-wrap, .md-code-block, .diff-view, .recent-story-list, .ds-filter-tabs, input, textarea, select, option, [contenteditable="true"], [role="slider"]';

export type GestureAxisLock = 'pending' | 'horizontal' | 'vertical';
export type SwipeSurface = 'drawer_open' | 'drawer_close' | 'overlay_back';

export interface SwipeDiagnosticEvent {
  action: 'swipe_gesture_canceled' | 'swipe_gesture_rejected';
  surface: SwipeSurface;
  reasonCode: 'pointer_cancel_pending' | 'pointer_cancel_horizontal' | 'below_threshold';
}

export type SwipeDiagnosticReporter = (event: SwipeDiagnosticEvent) => void;

export const SwipeDiagnosticContext = createContext<SwipeDiagnosticReporter | undefined>(undefined);

/** Report a rejected or canceled swipe gesture breadcrumb with consistent reason codes. */
export function reportSwipeOutcome(
  onDiagnostic: SwipeDiagnosticReporter | undefined,
  surface: SwipeSurface,
  outcome: 'rejected' | 'canceled',
  lock?: GestureAxisLock,
): void {
  if (!onDiagnostic) return;
  if (outcome === 'rejected') {
    onDiagnostic({
      action: 'swipe_gesture_rejected',
      surface,
      reasonCode: 'below_threshold',
    });
    return;
  }
  onDiagnostic({
    action: 'swipe_gesture_canceled',
    surface,
    reasonCode: lock === 'horizontal' ? 'pointer_cancel_horizontal' : 'pointer_cancel_pending',
  });
}

/** Acquire pointer capture once horizontal lock engages, tolerating synthetic test events. */
export function captureSwipePointer(
  target: EventTarget | null | undefined,
  pointerId: number,
): void {
  const captureTarget = target as { setPointerCapture?: (id: number) => void } | null | undefined;
  if (!captureTarget || typeof captureTarget.setPointerCapture !== 'function') return;
  try {
    captureTarget.setPointerCapture(pointerId);
  } catch {
    // Synthetic PointerEvent dispatches do not register active pointers in Chromium.
  }
}

/** Release pointer capture cleanly on swipe end or cancellation. */
export function releaseSwipePointer(
  target: EventTarget | null | undefined,
  pointerId: number,
): void {
  const releaseTarget = target as {
    hasPointerCapture?: (id: number) => boolean;
    releasePointerCapture?: (id: number) => void;
  } | null | undefined;
  if (!releaseTarget || typeof releaseTarget.releasePointerCapture !== 'function') return;
  try {
    if (
      typeof releaseTarget.hasPointerCapture === 'function' &&
      !releaseTarget.hasPointerCapture(pointerId)
    ) {
      return;
    }
    releaseTarget.releasePointerCapture(pointerId);
  } catch {
    // Ignore when capture was already released or unsupported in synthetic environments.
  }
}

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

/** Return true when any active (non-closing) native modal/sheet/drawer dialog is open in the top layer. */
export function hasOpenTopLayerDialog(): boolean {
  return (
    typeof document !== 'undefined' &&
    Boolean(document.querySelector('dialog[open]:not([data-closing="true"])'))
  );
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
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (Math.max(absX, absY) < GESTURE_LOCK_SLOP_PX) {
    return 'pending';
  }
  if (hasActiveTextSelection()) {
    return 'vertical';
  }
  const inExpectedDirection =
    (expectedDirection === 'right' && dx > 0) || (expectedDirection === 'left' && dx < 0);
  if (!inExpectedDirection && absX >= GESTURE_LOCK_SLOP_PX) {
    return 'vertical';
  }
  if (
    absY > absX * VERTICAL_DOMINANCE_RATIO ||
    (absY > absX && Math.max(absX, absY) >= MAX_AXIS_PENDING_PX)
  ) {
    return 'vertical';
  }
  if (inExpectedDirection && absX >= GESTURE_LOCK_SLOP_PX && absX >= absY) {
    return 'horizontal';
  }
  return 'pending';
}
