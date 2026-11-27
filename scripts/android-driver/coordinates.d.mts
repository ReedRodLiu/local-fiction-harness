export const OS_EDGE_GUARD_CSS_PX: 32;

export interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EdgeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DisplayMetrics {
  displayW: number;
  displayH: number;
  rotation: number;
  densityDpi: number | null;
  insets: {
    statusBars: PixelRect | null;
    navigationBars: PixelRect | null;
    ime: PixelRect | null;
    systemGestures: PixelRect[];
    mandatorySystemGestures: PixelRect[];
    displayCutout: PixelRect[];
  };
  safeInsetsPx: EdgeInsets;
  systemGestureEdgePx: EdgeInsets;
}

export interface SafeSwipeBounds {
  safeLeftPx: number;
  safeRightPx: number;
  safeTopPx: number;
  safeBottomPx: number;
  widthPx: number;
  heightPx: number;
}

export interface SwipeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function parseDisplayMetrics(
  dumpsysWindowOutput: string,
  wmSizeOutput?: string,
  wmDensityOutput?: string,
): DisplayMetrics;

export function computeSafeSwipeBounds(options: {
  display: DisplayMetrics;
  webViewBounds?: PixelRect;
  dpr: number;
  safeAreaCss?: Partial<EdgeInsets>;
  osEdgeGuardPx?: number;
  marginCss?: number;
}): SafeSwipeBounds;

export function resolvePercentageSwipe(options: {
  bounds: SafeSwipeBounds;
  fromPct: { x: number; y: number };
  toPct: { x: number; y: number };
}): SwipeSegment;

export function resolveOsEdgeBackSwipe(options: {
  display: DisplayMetrics;
  systemGestureLeftPx?: number;
  edge?: 'left' | 'right';
  yPct?: number;
  distancePx?: number;
}): SwipeSegment;

export function resolveDomTapPoint(options: {
  rect: { left: number; top: number; width: number; height: number };
  visualViewport?: { offsetLeft?: number; offsetTop?: number; scale?: number };
  dpr: number;
  webViewBounds?: PixelRect;
  display: DisplayMetrics;
  safeBounds?: Partial<SafeSwipeBounds>;
}): { x: number; y: number };
