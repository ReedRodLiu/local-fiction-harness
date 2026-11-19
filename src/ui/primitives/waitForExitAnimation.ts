const EXIT_FALLBACK_MS = 220;

function maxAnimationTimeMs(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const values = [
    ...style.transitionDuration.split(','),
    ...style.animationDuration.split(','),
  ];
  return Math.max(
    0,
    ...values.map((value) => {
      const trimmed = value.trim();
      const amount = Number.parseFloat(trimmed);
      if (!Number.isFinite(amount)) return 0;
      return trimmed.endsWith('ms') ? amount : amount * 1000;
    }),
  );
}

export function waitForExitAnimation(element: HTMLElement, onFinish: () => void) {
  let cancelled = false;
  const startedAt = performance.now();
  const minimumDuration = maxAnimationTimeMs(element);
  const fallbackDuration = minimumDuration > 0 ? minimumDuration : EXIT_FALLBACK_MS;
  let durationTimer: number | null = null;
  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    window.clearTimeout(fallbackTimer);
    if (durationTimer !== null) window.clearTimeout(durationTimer);
    onFinish();
  };
  const finishAfterMinimumDuration = () => {
    const remaining = minimumDuration - (performance.now() - startedAt);
    if (remaining <= 0) {
      finish();
      return;
    }
    durationTimer = window.setTimeout(finish, remaining);
  };
  const fallbackTimer = window.setTimeout(finish, fallbackDuration);
  const animationFrame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(() => {
        const animations = typeof element.getAnimations === 'function'
          ? element.getAnimations()
          : [];
        if (animations.length > 0) {
          void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
            .then(finishAfterMinimumDuration);
        }
      })
    : null;

  return () => {
    cancelled = true;
    window.clearTimeout(fallbackTimer);
    if (durationTimer !== null) window.clearTimeout(durationTimer);
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  };
}
