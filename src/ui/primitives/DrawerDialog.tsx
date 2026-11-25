import { useMemo, useRef, type MutableRefObject, type PointerEvent, type ReactNode } from 'react';
import {
  DRAWER_SNAP_RATIO,
  createVelocityTracker,
  hasActiveTextSelection,
  isInsideHorizontalScroller,
  resolveSwipeAxisLock,
  shouldCommitHorizontalSwipe,
  type GestureAxisLock,
  type VelocityTracker,
} from '../swipeGesture.ts';
import { ModalDialog } from './ModalDialog.tsx';

interface DrawerDialogProps {
  open: boolean;
  label: string;
  testId: string;
  sheetTestId: string;
  swipePreview?: boolean;
  dialogRef?: MutableRefObject<HTMLDialogElement | null>;
  children: ReactNode;
  onClose: () => void;
  onExitComplete?: () => void;
}

interface ActiveCloseGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lock: GestureAxisLock;
  tracker: VelocityTracker;
}

/**
 * Create pointer handlers for interactive leftward drawer-close drag with velocity snap
 * and synchronized scrim opacity interpolation.
 */
export function createDrawerCloseSwipeHandlers(options: {
  sheetRef: MutableRefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { sheetRef, onClose } = options;
  let activeGesture: ActiveCloseGesture | null = null;

  const getParts = () => {
    const sheet = sheetRef.current;
    const dialog = sheet?.closest('dialog') ?? null;
    const scrim = dialog?.querySelector<HTMLElement>('.library-dialog-scrim') ?? null;
    return { sheet, dialog, scrim };
  };

  const clearDragVisual = () => {
    const { sheet, dialog, scrim } = getParts();
    if (dialog) delete dialog.dataset.dragging;
    sheet?.style.removeProperty('transform');
    scrim?.style.removeProperty('opacity');
  };

  const resolveWidth = (sheet: HTMLElement | null) =>
    sheet && sheet.offsetWidth > 0 ? sheet.offsetWidth : 312;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      hasActiveTextSelection() ||
      isInsideHorizontalScroller(event.target, event.currentTarget)
    ) {
      activeGesture = null;
      return;
    }
    const tracker = createVelocityTracker();
    tracker.add(event.clientX, event.timeStamp);
    activeGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lock: 'pending',
      tracker,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = activeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    gesture.tracker.add(event.clientX, event.timeStamp);

    if (gesture.lock === 'pending') {
      const nextLock = resolveSwipeAxisLock(dx, dy, 'left');
      if (nextLock === 'pending') return;
      gesture.lock = nextLock;
      if (nextLock !== 'horizontal') {
        activeGesture = null;
        return;
      }
    }

    const { sheet, dialog, scrim } = getParts();
    if (!sheet) return;
    const width = resolveWidth(sheet);
    const clampedDx = Math.max(-width, Math.min(0, dx));
    const progress = Math.max(0, Math.min(1, 1 + clampedDx / Math.max(width, 1)));
    if (dialog) dialog.dataset.dragging = 'true';
    sheet.style.transform = `translateX(${clampedDx}px)`;
    if (scrim) scrim.style.opacity = String(progress);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = activeGesture;
    activeGesture = null;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.lock !== 'horizontal') {
      clearDragVisual();
      return;
    }

    const dx = event.clientX - gesture.startX;
    gesture.tracker.add(event.clientX, event.timeStamp);
    const velocityX = gesture.tracker.velocityX();
    const { sheet, dialog, scrim } = getParts();
    const width = resolveWidth(sheet);

    if (
      shouldCommitHorizontalSwipe({
        deltaX: dx,
        width,
        snapRatio: DRAWER_SNAP_RATIO,
        velocityX,
        direction: 'left',
      })
    ) {
      if (dialog) delete dialog.dataset.dragging;
      onClose();
      const clearLater = () => {
        sheet?.style.removeProperty('transform');
        scrim?.style.removeProperty('opacity');
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(clearLater);
      } else {
        clearLater();
      }
      return;
    }

    clearDragVisual();
  };

  const onPointerCancel = () => {
    activeGesture = null;
    clearDragVisual();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}

export function DrawerDialog({
  open,
  label,
  testId,
  sheetTestId,
  swipePreview = false,
  dialogRef,
  children,
  onClose,
  onExitComplete,
}: DrawerDialogProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const swipeHandlers = useMemo(
    () =>
      createDrawerCloseSwipeHandlers({
        sheetRef,
        onClose: () => onCloseRef.current(),
      }),
    [],
  );

  return (
    <ModalDialog
      open={open}
      label={label}
      className="library-dialog"
      testId={testId}
      closeOnSurfaceClick
      swipePreview={swipePreview}
      dialogRef={dialogRef}
      onClose={onClose}
      onExitComplete={onExitComplete}
    >
      <div className="library-dialog-scrim" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="library-dialog-sheet"
        data-testid={sheetTestId}
        onPointerDown={swipeHandlers.onPointerDown}
        onPointerMove={swipeHandlers.onPointerMove}
        onPointerUp={swipeHandlers.onPointerUp}
        onPointerCancel={swipeHandlers.onPointerCancel}
      >
        {children}
      </div>
    </ModalDialog>
  );
}
