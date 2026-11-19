import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { ModalDialog } from './ModalDialog.tsx';

interface SheetDialogProps {
  open: boolean;
  title: string;
  label: string;
  testId?: string;
  status?: string;
  children: ReactNode;
  onClose: () => void;
}

export function SheetDialog({ open, title, label, testId, status, children, onClose }: SheetDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const pointerStart = useRef<number | null>(null);

  const onHandlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    pointerStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHandlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerStart.current === null) return;
    const delta = event.clientY - pointerStart.current;
    pointerStart.current = null;
    if (delta < -28) setExpanded(true);
    if (delta > 72) onClose();
    else if (delta > 28) setExpanded(false);
  };

  return (
    <ModalDialog
      open={open}
      label={label}
      className="sheet-dialog"
      testId={testId}
      onClose={onClose}
    >
      <div className="sheet-handlebar" onPointerDown={onHandlePointerDown} onPointerUp={onHandlePointerUp}>
        <span className="sheet-grabber" aria-hidden="true" />
        <button
          type="button"
          className="icon-button sheet-size-toggle"
          aria-label={expanded ? '收起剧情面板' : '展开剧情面板'}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={18} strokeWidth={1.75} /> : <ChevronUp size={18} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          className="icon-button sheet-close"
          aria-label="关闭剧情面板"
          onClick={onClose}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
      </div>
      <header className="sheet-header">
        <h2>{title}</h2>
        {status && <span className="sheet-status" role="status">{status}</span>}
      </header>
      <div className="sheet-content" data-expanded={expanded}>
        {children}
      </div>
    </ModalDialog>
  );
}
