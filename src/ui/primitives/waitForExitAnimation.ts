const EXIT_FALLBACK_MS = 220;

export function waitForExitAnimation(element: HTMLElement, onFinish: () => void) {
  let cancelled = false;
  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    window.clearTimeout(fallbackTimer);
    onFinish();
  };
  const fallbackTimer = window.setTimeout(finish, EXIT_FALLBACK_MS);
  const animationFrame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(() => {
        const animations = typeof element.getAnimations === 'function'
          ? element.getAnimations()
          : [];
        if (animations.length > 0) {
          void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
            .then(finish);
        }
      })
    : null;

  return () => {
    cancelled = true;
    window.clearTimeout(fallbackTimer);
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  };
}
