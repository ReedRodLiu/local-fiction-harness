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
  const sheetRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    swipeStart.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    sheetRef.current?.style.removeProperty('transform');
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx < -56 && Math.abs(dx) > Math.abs(dy)) onClose();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx < 0 && Math.abs(dx) > Math.abs(dy)) {
      if (sheetRef.current) sheetRef.current.style.transform = `translateX(${dx}px)`;
    } else {
      sheetRef.current?.style.removeProperty('transform');
    }
  };

  const cancelPointer = () => {
    swipeStart.current = null;
    sheetRef.current?.style.removeProperty('transform');
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
        ref={sheetRef}
        className="library-dialog-sheet"
        data-testid={sheetTestId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelPointer}
      >
        {children}
      </div>
    </ModalDialog>
  );
}
