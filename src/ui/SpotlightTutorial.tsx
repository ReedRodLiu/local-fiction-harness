import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import {
  buildEvenOddPolygonClipPath,
  computeSpotlightLayout,
  padAndClampRect,
  type SpotlightCardLayout,
  type SpotlightRect,
} from './spotlightLayout.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

export interface SpotlightTutorialAction {
  label: string;
  testId?: string;
  onClick: () => void;
}

export interface SpotlightTutorialStep {
  id: string;
  /** Ordered selector groups; the first visible element in each group is highlighted. */
  targetGroups: ReadonlyArray<ReadonlyArray<string>>;
  title: string;
  description: string;
  extraAction?: SpotlightTutorialAction;
}

export interface SpotlightTutorialProps {
  open: boolean;
  label: string;
  steps: ReadonlyArray<SpotlightTutorialStep>;
  stepIndex: number;
  onStepChange: (nextIndex: number) => void;
  onSkip: () => void;
  onComplete: () => void;
}

function isElementVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function resolveStepTargets(step: SpotlightTutorialStep | undefined): HTMLElement[] {
  if (!step || typeof document === 'undefined') return [];
  const resolved: HTMLElement[] = [];
  for (const group of step.targetGroups) {
    for (const selector of group) {
      const candidate = document.querySelector(selector);
      if (isElementVisible(candidate)) {
        if (!resolved.includes(candidate)) resolved.push(candidate);
        break;
      }
    }
  }
  return resolved;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Top-layer spotlight mask tutorial overlay that highlights target UI elements,
 * scrolls off-screen targets into view, and integrates with useWebHistoryLayer.
 */
export function SpotlightTutorial({
  open,
  label,
  steps,
  stepIndex,
  onStepChange,
  onSkip,
  onComplete,
}: SpotlightTutorialProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const prevFocusedRef = useRef<HTMLElement | null>(null);
  const [targetRects, setTargetRects] = useState<SpotlightRect[]>([]);
  const [cardLayout, setCardLayout] = useState<SpotlightCardLayout | null>(null);

  const safeIndex = Math.max(0, Math.min(stepIndex, Math.max(0, steps.length - 1)));
  const activeStep = steps[safeIndex];
  const isFirstStep = safeIndex === 0;
  const isLastStep = safeIndex >= steps.length - 1;

  const dismissTutorial = useCallback(() => {
    onSkip();
  }, [onSkip]);

  useWebHistoryLayer('spotlight-tutorial', 90, open, dismissTutorial, true, undefined, undefined, false);

  const measureAndPosition = useCallback(() => {
    if (!open || !activeStep || typeof window === 'undefined') return;
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const elements = resolveStepTargets(activeStep);
    const rects = elements
      .map((element) => padAndClampRect(element.getBoundingClientRect(), viewport, 6))
      .filter((rect) => rect.width > 0 && rect.height > 0);
    setTargetRects(rects);

    const cardRect = cardRef.current?.getBoundingClientRect();
    const layout = computeSpotlightLayout({
      viewport,
      targetRects: rects,
      cardSize: {
        width: cardRect?.width || Math.min(360, viewport.width - 24),
        height: cardRect?.height || 220,
      },
    });
    setCardLayout(layout);
  }, [activeStep, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        prevFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
      const target = prevFocusedRef.current;
      prevFocusedRef.current = null;
      window.requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      const target = prevFocusedRef.current;
      prevFocusedRef.current = null;
      window.requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !activeStep) return;
    const targets = resolveStepTargets(activeStep);
    const primaryTarget = targets[0];
    if (primaryTarget && typeof primaryTarget.scrollIntoView === 'function') {
      const rect = primaryTarget.getBoundingClientRect();
      const tall = rect.height > window.innerHeight * 0.52 || targets.length > 1;
      const outOfView = rect.top < 72 || rect.bottom > window.innerHeight - 24;
      if (outOfView || tall) {
        primaryTarget.scrollIntoView({
          block: tall ? 'start' : 'center',
          inline: 'nearest',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
      }
    }

    measureAndPosition();
    let rafId = 0;
    const startedAt = performance.now();
    const settleDuration = prefersReducedMotion() ? 120 : 420;
    const tick = () => {
      measureAndPosition();
      if (performance.now() - startedAt < settleDuration) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeStep, measureAndPosition, open, safeIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    measureAndPosition();
  }, [measureAndPosition, open, safeIndex]);

  useEffect(() => {
    if (!open) return;
    const handleUpdate = () => measureAndPosition();
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    const observer =
      typeof ResizeObserver !== 'undefined' && cardRef.current
        ? new ResizeObserver(handleUpdate)
        : null;
    if (observer && cardRef.current) observer.observe(cardRef.current);
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
      observer?.disconnect();
    };
  }, [measureAndPosition, open]);

  if (!open || !activeStep) return null;

  const hasSingleRect = targetRects.length === 1;
  const hasMultipleRects = targetRects.length > 1;

  return (
    <dialog
      ref={dialogRef}
      className="spotlight-dialog"
      aria-label={label}
      data-testid="spotlight-tutorial"
      data-step-id={activeStep.id}
      onCancel={(event) => {
        event.preventDefault();
        dismissTutorial();
      }}
    >
      {!hasSingleRect && (
        <div
          className="spotlight-backdrop-full"
          style={
            hasMultipleRects
              ? { clipPath: buildEvenOddPolygonClipPath(targetRects) }
              : undefined
          }
          aria-hidden="true"
        />
      )}

      {hasSingleRect && (
        <div
          className="spotlight-cutout"
          data-testid="spotlight-cutout"
          style={{
            left: `${targetRects[0].left}px`,
            top: `${targetRects[0].top}px`,
            width: `${targetRects[0].width}px`,
            height: `${targetRects[0].height}px`,
          }}
          aria-hidden="true"
        />
      )}

      {hasMultipleRects &&
        targetRects.map((rect, index) => (
          <div
            key={`${activeStep.id}-ring-${index}`}
            className="spotlight-ring"
            data-testid={index === 0 ? 'spotlight-cutout' : `spotlight-cutout-${index}`}
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
            aria-hidden="true"
          />
        ))}

      <section
        ref={cardRef}
        className="spotlight-card"
        data-testid="spotlight-card"
        aria-labelledby="spotlight-card-title"
        style={
          cardLayout
            ? {
                left: `${cardLayout.left}px`,
                top: `${cardLayout.top}px`,
                width: `${cardLayout.width}px`,
              }
            : undefined
        }
      >
        <div className="spotlight-card-header">
          <span className="spotlight-step-counter" data-testid="spotlight-step-counter">
            {safeIndex + 1} / {steps.length}
          </span>
          <button
            type="button"
            className="icon-button spotlight-close-btn"
            aria-label="关闭引导"
            onClick={onSkip}
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <h2 id="spotlight-card-title" className="spotlight-card-title" data-testid="spotlight-step-title">
          {activeStep.title}
        </h2>
        <p className="spotlight-card-description" data-testid="spotlight-step-description">
          {activeStep.description}
        </p>

        <div className="spotlight-card-actions">
          <button
            type="button"
            className="btn btn-sm spotlight-skip-btn"
            data-testid="spotlight-skip-btn"
            onClick={onSkip}
          >
            跳过
          </button>

          <div className="spotlight-card-nav">
            {!isFirstStep && (
              <button
                type="button"
                className="btn btn-sm"
                data-testid="spotlight-prev-btn"
                onClick={() => onStepChange(safeIndex - 1)}
              >
                <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>上一步</span>
              </button>
            )}

            {isLastStep && activeStep.extraAction && (
              <button
                type="button"
                className="btn btn-sm"
                data-testid={activeStep.extraAction.testId ?? 'spotlight-extra-btn'}
                onClick={activeStep.extraAction.onClick}
              >
                <span>{activeStep.extraAction.label}</span>
              </button>
            )}

            {isLastStep ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="spotlight-finish-btn"
                onClick={onComplete}
              >
                <Check size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>完成</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="spotlight-next-btn"
                onClick={() => onStepChange(safeIndex + 1)}
              >
                <span>下一步</span>
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </section>
    </dialog>
  );
}
