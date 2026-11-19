import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ModalDialog } from './ModalDialog.tsx';

interface SheetDialogProps {
  open: boolean;
  title: string;
  label: string;
  testId?: string;
  status?: string;
  statusTestId?: string;
  children: ReactNode;
  onClose: () => void;
  onExitComplete?: () => void;
}

type PointerListenerSet = {
  onMove: (event: globalThis.PointerEvent) => void;
  onUp: (event: globalThis.PointerEvent) => void;
  onCancel: (event: globalThis.PointerEvent) => void;
};

export function SheetDialog({
  open,
  title,
  label,
  testId,
  status,
  statusTestId,
  children,
  onClose,
  onExitComplete,
}: SheetDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const pointerStart = useRef<number | null>(null);
  const pointerId = useRef<number | null>(null);
  const dragDialog = useRef<HTMLDialogElement | null>(null);
  const fallbackListeners = useRef<PointerListenerSet | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  const requestClose = () => {
    setExpanded(false);
    onClose();
  };

  const removeFallbackListeners = () => {
    const listeners = fallbackListeners.current;
    if (!listeners) return;
    document.removeEventListener('pointermove', listeners.onMove);
    document.removeEventListener('pointerup', listeners.onUp);
    document.removeEventListener('pointercancel', listeners.onCancel);
    fallbackListeners.current = null;
  };

  const clearDragVisual = (dialog: HTMLDialogElement | null) => {
    if (!dialog) return;
    delete dialog.dataset.dragging;
    dialog.style.removeProperty('--sheet-base-height');
    dialog.style.removeProperty('--sheet-grow-by');
    dialog.style.removeProperty('--sheet-drag-offset');
  };

  const updateDragVisual = (clientY: number) => {
    if (pointerStart.current === null || window.innerWidth >= 768) return;
    const dialog = dragDialog.current;
    if (!dialog) return;
    const delta = clientY - pointerStart.current;
    dialog.dataset.dragging = 'true';
    const heightUnit = window.CSS?.supports('height: 1dvh') ? 'dvh' : 'vh';
    dialog.style.setProperty('--sheet-base-height', expanded ? `92${heightUnit}` : `74${heightUnit}`);
    dialog.style.removeProperty('--sheet-grow-by');
    dialog.style.removeProperty('--sheet-drag-offset');
    if (delta < 0) {
      dialog.style.setProperty('--sheet-grow-by', `${Math.min(-delta, window.innerHeight * 0.18)}px`);
    } else {
      dialog.style.setProperty('--sheet-drag-offset', `${Math.min(delta, window.innerHeight * 0.5)}px`);
    }
  };

  const cancelDrag = (event?: globalThis.PointerEvent) => {
    if (event && pointerId.current !== event.pointerId) return;
    removeFallbackListeners();
    pointerStart.current = null;
    pointerId.current = null;
    suppressClick.current = false;
    clearDragVisual(dragDialog.current);
    dragDialog.current = null;
  };

  const finishDrag = (clientY: number, finishedPointerId: number) => {
    if (pointerStart.current === null || pointerId.current !== finishedPointerId) return;
    const delta = clientY - pointerStart.current;
    const shouldExpand = delta < -28;
    const shouldClose = delta > 72;
    const shouldCollapse = delta > 28;
    const dialog = dragDialog.current;
    const heightUnit = window.CSS?.supports('height: 1dvh') ? 'dvh' : 'vh';
    const settledHeight = shouldExpand
      ? `92${heightUnit}`
      : shouldCollapse
        ? `74${heightUnit}`
        : expanded
          ? `92${heightUnit}`
          : `74${heightUnit}`;

    removeFallbackListeners();
    pointerStart.current = null;
    pointerId.current = null;
    dragDialog.current = null;
    suppressClick.current = Math.abs(delta) > 8;
    if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 0);

    if (dialog?.dataset.dragging === 'true') {
      dialog.style.setProperty('--sheet-base-height', settledHeight);
      dialog.style.removeProperty('--sheet-grow-by');
      dialog.style.removeProperty('--sheet-drag-offset');
      const clearOnNextFrame = () => clearDragVisual(dialog);
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(clearOnNextFrame);
      else window.setTimeout(clearOnNextFrame, 0);
    }

    if (shouldExpand) setExpanded(true);
    if (shouldClose) requestClose();
    else if (shouldCollapse) setExpanded(false);
  };

  const onHandlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const dialog = event.currentTarget.closest('dialog');
    if (!dialog) return;
    pointerStart.current = event.clientY;
    pointerId.current = event.pointerId;
    dragDialog.current = dialog;
    suppressClick.current = false;
    dialog.dataset.dragging = 'true';
    const heightUnit = window.CSS?.supports('height: 1dvh') ? 'dvh' : 'vh';
    dialog.style.setProperty('--sheet-base-height', expanded ? `92${heightUnit}` : `74${heightUnit}`);

    let captured = false;
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        captured = true;
      } catch {
        captured = false;
      }
    }
    if (captured) return;

    const onMove = (nativeEvent: globalThis.PointerEvent) => {
      if (nativeEvent.pointerId === pointerId.current) updateDragVisual(nativeEvent.clientY);
    };
    const onUp = (nativeEvent: globalThis.PointerEvent) => {
      if (nativeEvent.pointerId === pointerId.current) finishDrag(nativeEvent.clientY, nativeEvent.pointerId);
    };
    const onCancel = (nativeEvent: globalThis.PointerEvent) => cancelDrag(nativeEvent);
    fallbackListeners.current = { onMove, onUp, onCancel };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  const onHandlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerId === pointerId.current) updateDragVisual(event.clientY);
  };

  const onHandlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    finishDrag(event.clientY, event.pointerId);
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setExpanded(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      label={label}
      className={`sheet-dialog${expanded ? ' is-expanded' : ''}`}
      testId={testId}
      onClose={requestClose}
      onExitComplete={onExitComplete}
    >
      <div className="sheet-handlebar">
        <button
          type="button"
          className="sheet-drag-handle"
          aria-label={expanded ? '收起剧情面板' : '展开剧情面板'}
          aria-expanded={expanded}
          data-testid="sheet-drag-handle"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={(event) => cancelDrag(event.nativeEvent)}
          onLostPointerCapture={(event) => cancelDrag(event.nativeEvent)}
          onKeyDown={onHandleKeyDown}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setExpanded((current) => !current);
          }}
        >
          <span className="sheet-grabber" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button sheet-close"
          aria-label="关闭剧情面板"
          onClick={requestClose}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>
      <header className="sheet-header">
        <h2>{title}</h2>
        {status && <span className="sheet-status" role="status" data-testid={statusTestId}>{status}</span>}
      </header>
      <div className="sheet-content" data-expanded={expanded}>
        {children}
      </div>
    </ModalDialog>
  );
}
