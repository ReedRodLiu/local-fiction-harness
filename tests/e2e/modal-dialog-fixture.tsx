import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModalDialog } from '../../src/ui/primitives/ModalDialog.tsx';

function ModalDialogFixture() {
  const [open, setOpen] = useState(true);
  const [closeCount, setCloseCount] = useState(0);
  const close = () => {
    setCloseCount((count) => count + 1);
    setOpen(false);
  };

  return (
    <>
      <output data-testid="close-count">{closeCount}</output>
      <ModalDialog open={open} label="Fixture dialog" onClose={close}>
        <p>Dialog content</p>
        <button type="button" onClick={close}>Request close</button>
      </ModalDialog>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<ModalDialogFixture />);
