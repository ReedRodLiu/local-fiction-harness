import { useEffect, useRef, type ReactNode } from 'react';

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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
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
      onClose={onClose}
    >
      {children}
    </dialog>
  );
}
