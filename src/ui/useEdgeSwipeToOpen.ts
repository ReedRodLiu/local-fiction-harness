import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { waitForExitAnimation } from './primitives/waitForExitAnimation.ts';
import {
  DRAWER_SNAP_RATIO,
  captureSwipePointer,
  createVelocityTracker,
  hasOpenTopLayerDialog,
  releaseSwipePointer,
  reportSwipeOutcome,
  resolveSwipeAxisLock,
  shouldCommitHorizontalSwipe,
  shouldIgnoreSwipeStart,
  type GestureAxisLock,
  type SwipeDiagnosticReporter,
  type VelocityTracker,
} from './swipeGesture.ts';

interface ActiveOpenGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastDx: number;
  lock: GestureAxisLock;
  tracker: VelocityTracker;
}

function resolveDrawerWidth(dialog: HTMLDialogElement | null): number {
  const sheet = dialog?.querySelector<HTMLElement>('.library-dialog-sheet');
  if (sheet && sheet.offsetWidth > 0) return sheet.offsetWidth;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 390;
  return Math.min(viewportWidth * 0.82, 312);
}

function applyOpenDragVisual(dialog: HTMLDialogElement | null, dx: number): void {
  if (!dialog) return;
  const width = resolveDrawerWidth(dialog);
  const clampedDx = Math.max(0, Math.min(dx, width));
  const progress = clampedDx / Math.max(width, 1);
  const offset = clampedDx - width;
  const sheet = dialog.querySelector<HTMLElement>('.library-dialog-sheet');
  const scrim = dialog.querySelector<HTMLElement>('.library-dialog-scrim');

  dialog.dataset.dragging = 'true';
  if (sheet) sheet.style.transform = `translateX(${offset}px)`;
  if (scrim) scrim.style.opacity = String(progress);
}

function clearDrawerInlineStyles(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  const sheet = dialog.querySelector<HTMLElement>('.library-dialog-sheet');
  const scrim = dialog.querySelector<HTMLElement>('.library-dialog-scrim');
  delete dialog.dataset.dragging;
  delete dialog.dataset.swipeSettling;
  sheet?.style.removeProperty('transform');
  scrim?.style.removeProperty('opacity');
}

/**
 * Interactive canvas-wide right-swipe controller for opening the mobile library drawer.
 * Yields the left OS edge zone, horizontal scrollers, form controls, and text selection.
 */
export function useEdgeSwipeToOpen(
  enabled: boolean,
  onOpen: () => void,
  onDiagnostic?: SwipeDiagnosticReporter,
) {
  const gestureRef = useRef<ActiveOpenGesture | null>(null);
  const drawerDialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelExitRef = useRef<(() => void) | null>(null);
  const pendingDxRef = useRef(0);
  const [previewOpen, setPreviewOpen] = useState(false);

  useLayoutEffect(() => {
    if (previewOpen && gestureRef.current?.lock === 'horizontal') {
      applyOpenDragVisual(drawerDialogRef.current, pendingDxRef.current);
    }
  }, [previewOpen]);

  useEffect(() => {
    if (enabled) return;
    gestureRef.current = null;
    pendingDxRef.current = 0;
    cancelExitRef.current?.();
    cancelExitRef.current = null;
    clearDrawerInlineStyles(drawerDialogRef.current);
    setPreviewOpen(false);
  }, [enabled]);

  useEffect(() => {
    return () => {
      cancelExitRef.current?.();
      cancelExitRef.current = null;
    };
  }, []);

  const cancelSwipe = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    pendingDxRef.current = 0;
    if (!gesture || gesture.lock !== 'horizontal') return;

    const dialog = drawerDialogRef.current;
    const sheet = dialog?.querySelector<HTMLElement>('.library-dialog-sheet');
    const scrim = dialog?.querySelector<HTMLElement>('.library-dialog-scrim');
    if (!dialog || !sheet) {
      clearDrawerInlineStyles(dialog);
      setPreviewOpen(false);
      return;
    }

    cancelExitRef.current?.();
    delete dialog.dataset.dragging;
    void sheet.offsetWidth;
    sheet.style.transform = 'translateX(-100%)';
    if (scrim) scrim.style.opacity = '0';
    cancelExitRef.current = waitForExitAnimation(sheet, () => {
      cancelExitRef.current = null;
      clearDrawerInlineStyles(dialog);
      setPreviewOpen(false);
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (
      !enabled ||
      typeof window === 'undefined' ||
      window.innerWidth >= 960 ||
      hasOpenTopLayerDialog() ||
      shouldIgnoreSwipeStart(event, event.currentTarget)
    ) {
      gestureRef.current = null;
      return;
    }
    cancelExitRef.current?.();
    cancelExitRef.current = null;
    clearDrawerInlineStyles(drawerDialogRef.current);
    const tracker = createVelocityTracker();
    tracker.add(event.clientX, event.timeStamp);
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastDx: 0,
      lock: 'pending',
      tracker,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    gesture.tracker.add(event.clientX, event.timeStamp);

    if (gesture.lock === 'pending') {
      const nextLock = resolveSwipeAxisLock(dx, dy, 'right');
      if (nextLock === 'pending') return;
      gesture.lock = nextLock;
      if (nextLock !== 'horizontal') {
        gestureRef.current = null;
        return;
      }
      captureSwipePointer(event.currentTarget, event.pointerId);
      pendingDxRef.current = dx;
      setPreviewOpen(true);
    }

    if (gesture.lock === 'horizontal') {
      gesture.lastDx = dx;
      pendingDxRef.current = dx;
      applyOpenDragVisual(drawerDialogRef.current, dx);
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    releaseSwipePointer(event.currentTarget, event.pointerId);
    if (gesture.lock !== 'horizontal') {
      gestureRef.current = null;
      return;
    }

    const dx = event.clientX - gesture.startX;
    gesture.tracker.add(event.clientX, event.timeStamp);
    const velocityX = gesture.tracker.velocityX();
    const dialog = drawerDialogRef.current;
    const width = resolveDrawerWidth(dialog);

    if (
      shouldCommitHorizontalSwipe({
        deltaX: dx,
        width,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX,
        direction: 'right',
      })
    ) {
      gestureRef.current = null;
      pendingDxRef.current = 0;
      if (dialog) {
        delete dialog.dataset.dragging;
        dialog.dataset.swipeSettling = 'true';
      }
      setPreviewOpen(false);
      onOpen();
      if (dialog && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => clearDrawerInlineStyles(dialog));
      } else {
        clearDrawerInlineStyles(dialog);
      }
      return;
    }

    reportSwipeOutcome(onDiagnostic, 'drawer_open', 'rejected');
    cancelSwipe();
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    releaseSwipePointer(event.currentTarget, event.pointerId);
    reportSwipeOutcome(onDiagnostic, 'drawer_open', 'canceled', gesture.lock);
    cancelSwipe();
  };

  return {
    containerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    previewOpen,
    drawerDialogRef,
  };
}
