import { ArrowLeft } from 'lucide-react';
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  PAGE_BACK_SNAP_RATIO,
  SwipeDiagnosticContext,
  captureSwipePointer,
  createVelocityTracker,
  hasOpenTopLayerDialog,
  releaseSwipePointer,
  reportSwipeOutcome,
  resolveSwipeAxisLock,
  shouldCommitHorizontalSwipe,
  shouldIgnoreSwipeStart,
  type GestureAxisLock,
  type SwipeDiagnosticReporter,
  type VelocityTracker,
} from '../swipeGesture.ts';

interface OverlayPageShellProps {
  title: string;
  testId?: string;
  step?: number;
  stepCount?: number;
  footer?: ReactNode;
  backDisabled?: boolean;
  onBack: () => void;
  children: ReactNode;
}

interface ActiveBackGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lock: GestureAxisLock;
  tracker: VelocityTracker;
}

/**
 * Create pointer handlers for interactive rightward swipe-back on overlay pages,
 * coordinating page translation, scrim fade, and mobile underlay parallax.
 */
export function createOverlaySwipeBackHandlers(options: {
  shellRef: MutableRefObject<HTMLElement | null>;
  backDisabled?: boolean;
  isBackDisabled?: () => boolean;
  onBack: () => void;
  onDiagnostic?: SwipeDiagnosticReporter;
}) {
  const { shellRef, onBack, onDiagnostic } = options;
  const checkDisabled = () =>
    options.isBackDisabled ? options.isBackDisabled() : Boolean(options.backDisabled);
  let activeGesture: ActiveBackGesture | null = null;

  const getElements = () => {
    const shell = shellRef.current;
    const stage = shell?.closest<HTMLElement>('.app-overlay-stage') ?? shell;
    const layer = shell?.closest<HTMLElement>('.app-overlay-layer') ?? null;
    const backdrop = layer?.querySelector<HTMLElement>('.app-overlay-backdrop') ?? null;
    const isSubOverlay = Boolean(layer?.classList?.contains('is-sub-overlay'));
    const underlay = isSubOverlay
      ? (layer?.previousElementSibling?.querySelector<HTMLElement>('.app-overlay-stage') ?? null)
      : (layer?.parentElement?.querySelector<HTMLElement>('.app-shell-underlay') ?? null);
    return { shell, stage, layer, backdrop, underlay };
  };

  const clearDragStyles = () => {
    const { stage, layer, backdrop, underlay } = getElements();
    if (layer) delete layer.dataset.dragging;
    stage?.style.removeProperty('transform');
    backdrop?.style.removeProperty('opacity');
    if (underlay) {
      underlay.classList?.remove('is-dragging-overlay');
      underlay.style.removeProperty('transform');
    }
  };

  const resolveWidth = (stage: HTMLElement | null) => {
    if (stage && stage.offsetWidth > 0) return stage.offsetWidth;
    return typeof window !== 'undefined' ? window.innerWidth : 390;
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const { layer } = getElements();
    if (
      checkDisabled() ||
      layer?.dataset.closing === 'true' ||
      hasOpenTopLayerDialog() ||
      shouldIgnoreSwipeStart(event, event.currentTarget)
    ) {
      activeGesture = null;
      return;
    }
    const tracker = createVelocityTracker();
    tracker.add(event.clientX, event.timeStamp);
    activeGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lock: 'pending',
      tracker,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = activeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    gesture.tracker.add(event.clientX, event.timeStamp);

    if (gesture.lock === 'pending') {
      const nextLock = resolveSwipeAxisLock(dx, dy, 'right');
      if (nextLock === 'pending') return;
      gesture.lock = nextLock;
      if (nextLock !== 'horizontal') {
        activeGesture = null;
        return;
      }
      captureSwipePointer(event.currentTarget ?? shellRef.current, event.pointerId);
    }

    const { stage, layer, backdrop, underlay } = getElements();
    if (!stage) return;
    const width = Math.max(resolveWidth(stage), 1);
    const clampedDx = Math.max(0, Math.min(dx, width));
    const progress = clampedDx / width;
    if (layer) layer.dataset.dragging = 'true';
    stage.style.transform = `translateX(${clampedDx}px)`;
    if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - progress));
    if (underlay && typeof window !== 'undefined' && window.innerWidth < 960) {
      underlay.classList?.add('is-dragging-overlay');
      underlay.style.transform = `translateX(${(-24 * (1 - progress)).toFixed(2)}px)`;
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const gesture = activeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    activeGesture = null;
    releaseSwipePointer(event.currentTarget ?? shellRef.current, event.pointerId);
    if (gesture.lock !== 'horizontal') {
      clearDragStyles();
      return;
    }

    const dx = event.clientX - gesture.startX;
    gesture.tracker.add(event.clientX, event.timeStamp);
    const velocityX = gesture.tracker.velocityX();
    const { stage, layer, backdrop, underlay } = getElements();
    const width = resolveWidth(stage);

    if (
      !checkDisabled() &&
      shouldCommitHorizontalSwipe({
        deltaX: dx,
        width,
        snapRatio: PAGE_BACK_SNAP_RATIO,
        velocityX,
        direction: 'right',
      })
    ) {
      if (layer) delete layer.dataset.dragging;
      underlay?.classList?.remove('is-dragging-overlay');
      onBack();
      const clearLater = () => {
        stage?.style.removeProperty('transform');
        backdrop?.style.removeProperty('opacity');
        underlay?.style.removeProperty('transform');
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(clearLater);
      } else {
        clearLater();
      }
      return;
    }

    reportSwipeOutcome(onDiagnostic, 'overlay_back', 'rejected');
    clearDragStyles();
  };

  const onPointerCancel = (event?: PointerEvent<HTMLElement>) => {
    const gesture = activeGesture;
    if (event && gesture && gesture.pointerId !== event.pointerId) return;
    activeGesture = null;
    if (event) {
      releaseSwipePointer(event.currentTarget ?? shellRef.current, event.pointerId);
    }
    if (gesture) {
      reportSwipeOutcome(onDiagnostic, 'overlay_back', 'canceled', gesture.lock);
    }
    clearDragStyles();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}

export function OverlayPageShell({
  title,
  testId,
  step,
  stepCount,
  footer,
  backDisabled = false,
  onBack,
  children,
}: OverlayPageShellProps) {
  const hasProgress = step !== undefined && stepCount !== undefined && stepCount > 0;
  const shellRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const backDisabledRef = useRef(backDisabled);
  backDisabledRef.current = backDisabled;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const contextOnDiagnostic = useContext(SwipeDiagnosticContext);
  const onDiagnosticRef = useRef(contextOnDiagnostic);
  onDiagnosticRef.current = contextOnDiagnostic;

  const swipeHandlers = useMemo(
    () =>
      createOverlaySwipeBackHandlers({
        shellRef,
        isBackDisabled: () => backDisabledRef.current,
        onBack: () => onBackRef.current(),
        onDiagnostic: (event) => onDiagnosticRef.current?.(event),
      }),
    [],
  );

  useLayoutEffect(() => {
    const stage = shellRef.current?.closest('.app-overlay-stage, .main-stage');
    if (stage) {
      stage.scrollTop = 0;
    }
    const focusTitleIfUnclaimed = () => {
      const active = document.activeElement;
      if (
        active === document.body ||
        active === null ||
        (active instanceof Element && active.closest('dialog:not([open])'))
      ) {
        titleRef.current?.focus({ preventScroll: true });
      }
    };
    focusTitleIfUnclaimed();
    const settleTimer = window.setTimeout(focusTitleIfUnclaimed, 260);
    return () => window.clearTimeout(settleTimer);
  }, []);

  return (
    <section
      ref={shellRef}
      className="overlay-page-shell"
      data-testid={testId}
      data-has-footer={Boolean(footer)}
      onPointerDown={swipeHandlers.onPointerDown}
      onPointerMove={swipeHandlers.onPointerMove}
      onPointerUp={swipeHandlers.onPointerUp}
      onPointerCancel={swipeHandlers.onPointerCancel}
    >
      <header className="overlay-page-header">
        <button
          type="button"
          className="icon-button"
          aria-label="返回"
          disabled={backDisabled}
          onClick={onBack}
        >
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
        <h1
          ref={titleRef}
          role="heading"
          aria-level={1}
          tabIndex={-1}
          data-testid={testId ? `${testId}-title` : undefined}
        >
          {title}
        </h1>
        <span className="overlay-header-spacer" aria-hidden="true" />
      </header>
      {hasProgress && (
        <div className="overlay-page-progress">
          <div className="overlay-page-progress-label">第 {step} 步，共 {stepCount} 步</div>
          <div
            className="overlay-page-progress-track"
            role="progressbar"
            aria-label={`${title}进度`}
            aria-valuemin={1}
            aria-valuemax={stepCount}
            aria-valuenow={step}
          >
            <span style={{ width: `${Math.min(100, Math.max(0, (step / stepCount) * 100))}%` }} />
          </div>
        </div>
      )}
      <div className="overlay-page-content">{children}</div>
      {footer && <footer className="overlay-page-footer" data-testid="overlay-page-footer">{footer}</footer>}
    </section>
  );
}
