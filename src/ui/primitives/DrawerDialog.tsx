import { useRef, type PointerEvent, type ReactNode } from 'react';
import { ModalDialog } from './ModalDialog.tsx';

interface DrawerDialogProps {
  open: boolean;
  label: string;
  testId: string;
  sheetTestId: string;
  children: ReactNode;
  onClose: () => void;
}

export function DrawerDialog({
  open,
  label,
  testId,
  sheetTestId,
  children,
  onClose,
}: DrawerDialogProps) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    swipeStart.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx < -56 && Math.abs(dx) > Math.abs(dy)) onClose();
  };

  return (
    <ModalDialog
      open={open}
      label={label}
      className="library-dialog"
      testId={testId}
      closeOnSurfaceClick
      onClose={onClose}
    >
      <div
        className="library-dialog-sheet"
        data-testid={sheetTestId}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
      >
        {children}
      </div>
    </ModalDialog>
  );
}
