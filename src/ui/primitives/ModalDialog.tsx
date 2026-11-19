import { useEffect, useRef, type ReactNode } from 'react';
import { waitForExitAnimation } from './waitForExitAnimation.ts';

interface ModalDialogProps {
  open: boolean;
  label: string;
  className?: string;
  testId?: string;
  children: ReactNode;
  onClose: () => void;
  onCancel?: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
}

export function ModalDialog({
  open,
  label,
  className = 'modal-dialog',
  testId,
  children,
  onClose,
  onCancel,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const suppressCloseEventRef = useRef(false);

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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
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
