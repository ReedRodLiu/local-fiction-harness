import { useEffect, useRef, type ReactNode } from 'react';
import { waitForExitAnimation } from './waitForExitAnimation.ts';

function isBackdropPointer(event: React.PointerEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}

interface ModalDialogProps {
  open: boolean;
  label: string;
  className?: string;
  testId?: string;
  closeDisabled?: boolean;
  children: ReactNode;
  onClose: () => void;
  onExitComplete?: () => void;
  onCancel?: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
}

export function ModalDialog({
  open,
  label,
  className = 'modal-dialog',
  testId,
  closeDisabled = false,
  children,
  onClose,
  onExitComplete,
  onCancel,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const suppressCloseEventRef = useRef(false);
  const backdropPointerRef = useRef<{ pointerId: number; startedOnBackdrop: boolean } | null>(null);
  const backdropClickRef = useRef(false);
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.removeAttribute('data-closing');
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (!dialog.open) return;

    dialog.dataset.closing = 'true';
    return waitForExitAnimation(dialog, () => {
      suppressCloseEventRef.current = true;
      dialog.close();
      onExitCompleteRef.current?.();
    });
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-label={label}
      data-testid={testId}
      onCancel={(event) => {
        onCancel?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      onPointerDown={(event) => {
        if (closeDisabled) return;
        backdropPointerRef.current = {
          pointerId: event.pointerId,
          startedOnBackdrop: isBackdropPointer(event),
        };
        backdropClickRef.current = false;
      }}
      onPointerUp={(event) => {
        if (closeDisabled) return;
        const pointer = backdropPointerRef.current;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        backdropClickRef.current = pointer.startedOnBackdrop && isBackdropPointer(event);
        backdropPointerRef.current = null;
      }}
      onPointerCancel={() => {
        backdropPointerRef.current = null;
        backdropClickRef.current = false;
      }}
      onClick={() => {
        if (closeDisabled) return;
        if (!backdropClickRef.current) return;
        backdropClickRef.current = false;
        onClose();
      }}
      onClose={() => {
        if (suppressCloseEventRef.current) {
          suppressCloseEventRef.current = false;
          return;
        }
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
