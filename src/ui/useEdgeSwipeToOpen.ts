import { useRef, type PointerEvent } from 'react';

const EDGE_WIDTH_PX = 24;
const OPEN_DISTANCE_PX = 56;

export function useEdgeSwipeToOpen(enabled: boolean, onOpen: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (
      !enabled ||
      event.button !== 0 ||
      window.innerWidth >= 960 ||
      event.clientX > EDGE_WIDTH_PX
    ) {
      start.current = null;
      return;
    }
    start.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const origin = start.current;
    start.current = null;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (dx >= OPEN_DISTANCE_PX && Math.abs(dx) > Math.abs(dy)) onOpen();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => {
      start.current = null;
    },
  };
}
