export const OS_EDGE_GUARD_CSS_PX = 32;

function toNonEmptyRect(left, top, right, bottom) {
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

function pointInRect(x, y, rect) {
  if (!rect) return false;
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function parseRotation(dumpsysOutput) {
  const rotToken = dumpsysOutput.match(/ROTATION_(0|90|180|270)/);
  if (rotToken) {
    return Number(rotToken[1]);
  }
  const numRot = dumpsysOutput.match(/\brotation\s*=?\s*([0-3])\b/) ?? dumpsysOutput.match(/\bDisplayFrames\b[^\n]*\br=([0-3])\b/);
  if (numRot) {
    return Number(numRot[1]) * 90;
  }
  return 0;
}

function parseWmSize(wmSizeOutput) {
  if (!wmSizeOutput) return null;
  const overrideMatch = wmSizeOutput.match(/Override size:\s*(\d+)x(\d+)/i);
  const physicalMatch = wmSizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i);
  const match = overrideMatch ?? physicalMatch;
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseDensity(dumpsysOutput, wmDensityOutput) {
  if (wmDensityOutput) {
    const overrideMatch = wmDensityOutput.match(/Override density:\s*(\d+)/i);
    const physicalMatch = wmDensityOutput.match(/Physical density:\s*(\d+)/i);
    const match = overrideMatch ?? physicalMatch;
    if (match) return Number(match[1]);
  }
  const infoDensity = dumpsysOutput.match(/\bdensity\s+(\d+)\b/);
  if (infoDensity) return Number(infoDensity[1]);
  const dpiMatch = dumpsysOutput.match(/\b(\d+)dpi\b/);
  if (dpiMatch) return Number(dpiMatch[1]);
  return null;
}

function applyRectToEdgeDepth(edges, rect, displayW, displayH) {
  if (!rect) return;
  if (rect.top === 0 && rect.bottom < displayH / 2) {
    edges.top = Math.max(edges.top, rect.bottom);
  }
  if (rect.bottom === displayH && rect.top > displayH / 2) {
    edges.bottom = Math.max(edges.bottom, displayH - rect.top);
  }
  if (rect.left === 0 && rect.right < displayW / 2) {
    edges.left = Math.max(edges.left, rect.right);
  }
  if (rect.right === displayW && rect.left > displayW / 2) {
    edges.right = Math.max(edges.right, displayW - rect.left);
  }
}

/**
 * Parses `adb shell dumpsys window displays` (plus optional `wm size` / `wm density`)
 * into effective rotated display dimensions, InsetsState rects, safe insets, and system gesture edges.
 */
export function parseDisplayMetrics(dumpsysWindowOutput, wmSizeOutput = '', wmDensityOutput = '') {
  if (typeof dumpsysWindowOutput !== 'string' || !dumpsysWindowOutput.trim()) {
    throw new Error('dumpsysWindowOutput must be a non-empty string.');
  }

  const rotation = parseRotation(dumpsysWindowOutput);

  let displayW = 0;
  let displayH = 0;
  const framesMatch = dumpsysWindowOutput.match(/\bDisplayFrames\s+w=(\d+)\s+h=(\d+)/);
  const curMatch = dumpsysWindowOutput.match(/\bcur=(\d+)x(\d+)/);
  const realMatch = dumpsysWindowOutput.match(/\breal\s+(\d+)\s*x\s*(\d+)/);

  if (curMatch) {
    displayW = Number(curMatch[1]);
    displayH = Number(curMatch[2]);
  } else if (framesMatch) {
    displayW = Number(framesMatch[1]);
    displayH = Number(framesMatch[2]);
  } else if (realMatch) {
    displayW = Number(realMatch[1]);
    displayH = Number(realMatch[2]);
  } else {
    const wmSize = parseWmSize(wmSizeOutput);
    if (!wmSize) {
      throw new Error('Unable to extract display dimensions from dumpsys window displays or wm size.');
    }
    const isRotated = rotation === 90 || rotation === 270;
    displayW = isRotated && wmSize.width < wmSize.height ? wmSize.height : wmSize.width;
    displayH = isRotated && wmSize.width < wmSize.height ? wmSize.width : wmSize.height;
  }

  const densityDpi = parseDensity(dumpsysWindowOutput, wmDensityOutput);

  const insets = {
    statusBars: null,
    navigationBars: null,
    ime: null,
    systemGestures: [],
    mandatorySystemGestures: [],
    displayCutout: [],
  };

  const sourceRegex =
    /InsetsSource\b[^\n]*?\btype=([A-Za-z0-9_]+)[^\n]*?\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]([^\n]*)/g;
  for (const match of dumpsysWindowOutput.matchAll(sourceRegex)) {
    const type = match[1];
    const rect = toNonEmptyRect(
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
    );
    const tail = match[6] ?? '';
    const visibleMatch = tail.match(/\bvisible=(true|false)\b/);
    const visible = visibleMatch ? visibleMatch[1] === 'true' : true;

    if (!rect || !visible) continue;

    switch (type) {
      case 'statusBars':
      case 'ITYPE_STATUS_BAR':
        insets.statusBars = rect;
        break;
      case 'navigationBars':
      case 'ITYPE_NAVIGATION_BAR':
        insets.navigationBars = rect;
        break;
      case 'ime':
      case 'ITYPE_IME':
        insets.ime = rect;
        break;
      case 'systemGestures':
      case 'ITYPE_LEFT_GESTURES':
      case 'ITYPE_RIGHT_GESTURES':
      case 'ITYPE_TOP_GESTURES':
      case 'ITYPE_BOTTOM_GESTURES':
        insets.systemGestures.push(rect);
        break;
      case 'mandatorySystemGestures':
      case 'ITYPE_LEFT_MANDATORY_GESTURES':
      case 'ITYPE_RIGHT_MANDATORY_GESTURES':
      case 'ITYPE_TOP_MANDATORY_GESTURES':
      case 'ITYPE_BOTTOM_MANDATORY_GESTURES':
        insets.mandatorySystemGestures.push(rect);
        break;
      case 'displayCutout':
        insets.displayCutout.push(rect);
        break;
      default:
        break;
    }
  }

  const safeInsetsPx = { top: 0, bottom: 0, left: 0, right: 0 };
  applyRectToEdgeDepth(safeInsetsPx, insets.statusBars, displayW, displayH);
  applyRectToEdgeDepth(safeInsetsPx, insets.navigationBars, displayW, displayH);
  applyRectToEdgeDepth(safeInsetsPx, insets.ime, displayW, displayH);
  for (const cutoutRect of insets.displayCutout) {
    applyRectToEdgeDepth(safeInsetsPx, cutoutRect, displayW, displayH);
  }

  const cutoutInsetsMatch = dumpsysWindowOutput.match(
    /DisplayCutout\{insets=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/,
  );
  if (cutoutInsetsMatch) {
    safeInsetsPx.left = Math.max(safeInsetsPx.left, Math.max(0, Number(cutoutInsetsMatch[1])));
    safeInsetsPx.top = Math.max(safeInsetsPx.top, Math.max(0, Number(cutoutInsetsMatch[2])));
    safeInsetsPx.right = Math.max(safeInsetsPx.right, Math.max(0, Number(cutoutInsetsMatch[3])));
    safeInsetsPx.bottom = Math.max(safeInsetsPx.bottom, Math.max(0, Number(cutoutInsetsMatch[4])));
  }

  const systemGestureEdgePx = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const gestureRect of insets.systemGestures) {
    applyRectToEdgeDepth(systemGestureEdgePx, gestureRect, displayW, displayH);
  }

  return {
    displayW,
    displayH,
    rotation,
    densityDpi,
    insets,
    safeInsetsPx,
    systemGestureEdgePx,
  };
}

/**
 * Computes physical pixel safe bounds for in-app swipe gestures,
 * strictly clearing OS_EDGE_GUARD_PX (32 CSS px) and OS system gesture edges.
 */
export function computeSafeSwipeBounds({
  display,
  webViewBounds,
  dpr,
  safeAreaCss = {},
  osEdgeGuardPx = OS_EDGE_GUARD_CSS_PX,
  marginCss = 4,
}) {
  if (!display || !Number.isFinite(display.displayW) || !Number.isFinite(display.displayH)) {
    throw new Error('display metrics with displayW and displayH are required.');
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error(`dpr must be a positive number, got: ${dpr}`);
  }

  const wv = webViewBounds ?? {
    left: 0,
    top: 0,
    right: display.displayW,
    bottom: display.displayH,
  };
  const edgeGuardPx = Math.ceil((osEdgeGuardPx + marginCss) * dpr);
  const gestureMarginPx = Math.ceil(marginCss * dpr);

  const safeLeftPx = Math.max(
    (display.systemGestureEdgePx?.left ?? 0) + gestureMarginPx,
    display.safeInsetsPx?.left ?? 0,
    wv.left + edgeGuardPx,
    wv.left + Math.ceil((safeAreaCss.left ?? 0) * dpr),
  );
  const safeRightPx = Math.min(
    display.displayW - (display.systemGestureEdgePx?.right ?? 0) - gestureMarginPx,
    display.displayW - (display.safeInsetsPx?.right ?? 0),
    wv.right - edgeGuardPx,
    wv.right - Math.ceil((safeAreaCss.right ?? 0) * dpr),
  );
  const safeTopPx = Math.max(
    display.safeInsetsPx?.top ?? 0,
    wv.top + Math.ceil((safeAreaCss.top ?? 0) * dpr),
  );
  const safeBottomPx = Math.min(
    display.displayH - (display.safeInsetsPx?.bottom ?? 0),
    wv.bottom - Math.ceil((safeAreaCss.bottom ?? 0) * dpr),
  );

  if (safeLeftPx >= safeRightPx || safeTopPx >= safeBottomPx) {
    throw new Error(
      `Computed swipe bounds are empty: left=${safeLeftPx}, right=${safeRightPx}, top=${safeTopPx}, bottom=${safeBottomPx}`,
    );
  }

  return {
    safeLeftPx,
    safeRightPx,
    safeTopPx,
    safeBottomPx,
    widthPx: safeRightPx - safeLeftPx,
    heightPx: safeBottomPx - safeTopPx,
  };
}

function assertUnitFraction(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be within [0, 1], got: ${value}`);
  }
}

/**
 * Resolves normalized [0..1] percentage coordinates inside safe swipe bounds to rounded physical pixels.
 */
export function resolvePercentageSwipe({ bounds, fromPct, toPct }) {
  if (!bounds) {
    throw new Error('bounds is required.');
  }
  assertUnitFraction(fromPct?.x, 'fromPct.x');
  assertUnitFraction(fromPct?.y, 'fromPct.y');
  assertUnitFraction(toPct?.x, 'toPct.x');
  assertUnitFraction(toPct?.y, 'toPct.y');

  const spanX = bounds.safeRightPx - bounds.safeLeftPx;
  const spanY = bounds.safeBottomPx - bounds.safeTopPx;
  const clampX = (x) => Math.max(bounds.safeLeftPx, Math.min(bounds.safeRightPx, Math.round(x)));
  const clampY = (y) => Math.max(bounds.safeTopPx, Math.min(bounds.safeBottomPx, Math.round(y)));

  return {
    x1: clampX(bounds.safeLeftPx + spanX * fromPct.x),
    y1: clampY(bounds.safeTopPx + spanY * fromPct.y),
    x2: clampX(bounds.safeLeftPx + spanX * toPct.x),
    y2: clampY(bounds.safeTopPx + spanY * toPct.y),
  };
}

/**
 * Generates an intentional OS system edge-back swipe starting inside the left (or right) system gesture hotzone.
 */
export function resolveOsEdgeBackSwipe({
  display,
  systemGestureLeftPx,
  edge = 'left',
  yPct = 0.5,
  distancePx,
}) {
  if (!display || !Number.isFinite(display.displayW) || !Number.isFinite(display.displayH)) {
    throw new Error('display metrics are required.');
  }
  assertUnitFraction(yPct, 'yPct');

  const safeTop = display.safeInsetsPx?.top ?? 0;
  const safeBottom = display.displayH - (display.safeInsetsPx?.bottom ?? 0);
  if (safeTop >= safeBottom) {
    throw new Error('No vertical safe area available for OS edge back swipe.');
  }
  const y = Math.round(safeTop + (safeBottom - safeTop) * yPct);
  const travel = distancePx ?? Math.max(120, Math.round(display.displayW * 0.3));

  if (edge === 'right') {
    const rightWidth = display.systemGestureEdgePx?.right ?? 0;
    if (rightWidth <= 0) {
      throw new Error('Right system gesture edge inset is not available on this display.');
    }
    const offsetFromEdge = Math.max(1, Math.min(rightWidth - 1, Math.floor(rightWidth / 2)));
    const x1 = display.displayW - offsetFromEdge;
    const x2 = Math.max(1, x1 - travel);
    return { x1, y1: y, x2, y2: y };
  }

  const leftWidth = systemGestureLeftPx ?? display.systemGestureEdgePx?.left ?? 0;
  if (leftWidth <= 0) {
    throw new Error('Left system gesture edge inset is not available on this display.');
  }
  const x1 = Math.max(1, Math.min(leftWidth - 1, Math.floor(leftWidth / 2)));
  const x2 = Math.min(display.displayW - 1, x1 + travel);
  return { x1, y1: y, x2, y2: y };
}

/**
 * Maps a DOM element BoundingClientRect + visualViewport + dpr to physical ADB tap coordinates,
 * asserting the tap target is inside screen/WebView bounds and unobscured by system bars, cutout, or IME.
 */
export function resolveDomTapPoint({
  rect,
  visualViewport = { offsetLeft: 0, offsetTop: 0 },
  dpr,
  webViewBounds,
  display,
  safeBounds,
}) {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Target DOM rect must have positive width and height.');
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error(`dpr must be a positive number, got: ${dpr}`);
  }
  if (!display || !Number.isFinite(display.displayW) || !Number.isFinite(display.displayH)) {
    throw new Error('display metrics are required.');
  }

  const wv = webViewBounds ?? {
    left: 0,
    top: 0,
    right: display.displayW,
    bottom: display.displayH,
  };
  const offsetLeft = visualViewport?.offsetLeft ?? 0;
  const offsetTop = visualViewport?.offsetTop ?? 0;
  const scale = visualViewport?.scale ?? 1;

  const tapX = Math.round(wv.left + (offsetLeft + (rect.left + rect.width / 2) * scale) * dpr);
  const tapY = Math.round(wv.top + (offsetTop + (rect.top + rect.height / 2) * scale) * dpr);

  if (tapX < 0 || tapX >= display.displayW || tapY < 0 || tapY >= display.displayH) {
    throw new Error(
      `Tap point (${tapX}, ${tapY}) is outside display screen bounds (${display.displayW}x${display.displayH}).`,
    );
  }
  if (tapX < wv.left || tapX > wv.right || tapY < wv.top || tapY > wv.bottom) {
    throw new Error(
      `Tap point (${tapX}, ${tapY}) is outside WebView bounds [${wv.left},${wv.top}][${wv.right},${wv.bottom}].`,
    );
  }

  if (pointInRect(tapX, tapY, display.insets?.statusBars)) {
    throw new Error(`Tap point (${tapX}, ${tapY}) is occluded by statusBars.`);
  }
  if (pointInRect(tapX, tapY, display.insets?.navigationBars)) {
    throw new Error(`Tap point (${tapX}, ${tapY}) is occluded by navigationBars.`);
  }
  if (pointInRect(tapX, tapY, display.insets?.ime)) {
    throw new Error(`Tap point (${tapX}, ${tapY}) is occluded by active IME keyboard.`);
  }
  for (const cutout of display.insets?.displayCutout ?? []) {
    if (pointInRect(tapX, tapY, cutout)) {
      throw new Error(`Tap point (${tapX}, ${tapY}) is occluded by displayCutout.`);
    }
  }

  const minSafeY = Math.max(display.safeInsetsPx?.top ?? 0, safeBounds?.safeTopPx ?? 0);
  const maxSafeY = Math.min(
    display.displayH - (display.safeInsetsPx?.bottom ?? 0),
    safeBounds?.safeBottomPx ?? display.displayH,
  );
  if (tapY < minSafeY || tapY > maxSafeY) {
    throw new Error(
      `Tap point (${tapX}, ${tapY}) is occluded outside vertical safe range [${minSafeY}, ${maxSafeY}].`,
    );
  }

  const minSafeX = display.safeInsetsPx?.left ?? 0;
  const maxSafeX = display.displayW - (display.safeInsetsPx?.right ?? 0);
  if (tapX < minSafeX || tapX > maxSafeX) {
    throw new Error(
      `Tap point (${tapX}, ${tapY}) is occluded outside horizontal safe range [${minSafeX}, ${maxSafeX}].`,
    );
  }

  return { x: tapX, y: tapY };
}
