export interface SpotlightRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SpotlightViewport {
  width: number;
  height: number;
}

export interface SpotlightCardLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Expand a DOMRect-like box by padding and clamp it inside the current viewport. */
export function padAndClampRect(
  rect: Pick<SpotlightRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  viewport: SpotlightViewport,
  padding = 6,
): SpotlightRect {
  const left = Math.max(0, Math.round(rect.left - padding));
  const top = Math.max(0, Math.round(rect.top - padding));
  const right = Math.min(viewport.width, Math.round(rect.right + padding));
  const bottom = Math.min(viewport.height, Math.round(rect.bottom + padding));
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Build an evenodd polygon clip-path punching one or more rectangular holes out of a scrim. */
export function buildEvenOddPolygonClipPath(rects: readonly SpotlightRect[]): string {
  const segments = ['0px 0px', '100% 0px', '100% 100%', '0px 100%', '0px 0px'];
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    segments.push(
      `0px ${rect.top}px`,
      `${rect.left}px ${rect.top}px`,
      `${rect.left}px ${rect.bottom}px`,
      `${rect.right}px ${rect.bottom}px`,
      `${rect.right}px ${rect.top}px`,
      `${rect.left}px ${rect.top}px`,
      `0px ${rect.top}px`,
      '0px 0px',
    );
  }
  return `polygon(evenodd, ${segments.join(', ')})`;
}

function overlapArea(a: SpotlightCardLayout, b: SpotlightRect): number {
  const xOverlap = Math.max(0, Math.min(a.left + a.width, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.top + a.height, b.bottom) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

/** Compute a viewport-clamped position for the tutorial card that minimizes target occlusion. */
export function computeSpotlightLayout(options: {
  viewport: SpotlightViewport;
  targetRects: readonly SpotlightRect[];
  cardSize: { width: number; height: number };
}): SpotlightCardLayout {
  const { viewport, targetRects, cardSize } = options;
  const margin = viewport.width < 560 ? 12 : 16;
  const gap = 12;
  const usableWidth = Math.max(200, viewport.width - margin * 2);
  const usableHeight = Math.max(120, viewport.height - margin * 2);
  const width = Math.min(360, usableWidth, Math.max(200, cardSize.width || 360));
  const height = Math.min(usableHeight, Math.max(120, cardSize.height || 210));
  const minX = margin;
  const maxX = Math.max(margin, viewport.width - margin - width);
  const minY = margin;
  const maxY = Math.max(margin, viewport.height - margin - height);
  const clampX = (x: number) => Math.round(Math.min(maxX, Math.max(minX, x)));
  const clampY = (y: number) => Math.round(Math.min(maxY, Math.max(minY, y)));

  const centered: SpotlightCardLayout = {
    left: clampX((viewport.width - width) / 2),
    top: clampY((viewport.height - height) / 2),
    width,
    height,
  };

  const primary = targetRects[0];
  if (!primary) return centered;

  const primaryCenterX = primary.left + primary.width / 2;
  const primaryCenterY = primary.top + primary.height / 2;
  const candidates: SpotlightCardLayout[] = [
    { left: clampX(primaryCenterX - width / 2), top: clampY(primary.top - gap - height), width, height },
    { left: clampX(primaryCenterX - width / 2), top: clampY(primary.bottom + gap), width, height },
    { left: clampX(primary.right + gap), top: clampY(primaryCenterY - height / 2), width, height },
    { left: clampX(primary.left - gap - width), top: clampY(primaryCenterY - height / 2), width, height },
  ];

  for (const extra of targetRects.slice(1)) {
    candidates.push(
      { left: clampX(extra.right + gap), top: clampY(primary.top - gap - height), width, height },
      { left: clampX(extra.right + gap), top: clampY(primary.bottom + gap), width, height },
    );
  }
  candidates.push(centered);

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = targetRects.reduce((sum, rect) => sum + overlapArea(candidate, rect), 0);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      if (score === 0) break;
    }
  }
  return best;
}
