import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type TouchEvent,
  type WheelEvent,
} from 'react';
import {
  recordAutoScrollDiagnostic,
  type AutoScrollDiagnosticEvent,
  type AutoScrollDiagnosticMetrics,
  type DiagnosticCollector,
} from '../harness/index.ts';

export interface UseAutoScrollTimelineOptions {
  /** Identifies the active document/conversation/story so scroll resets to bottom on switch. */
  contextKey: string;
  /** Identifies the active branch leaf so scroll follows or stays pinned when paused. */
  activeLeafKey: string | null | undefined;
  /** Number of visible turns in the active branch. */
  turnCount: number;
  /** True while streaming a reply. */
  isStreaming: boolean;
  /** Streaming text / reasoning lengths to trigger follow-scroll during generation. */
  streamPulse?: string;
  /** Disable auto-scroll when an overlay is covering the stage. */
  paused?: boolean;
  /** Explicit ref to the actual vertical scroll container (e.g. `.main-stage`). */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** Active mode label for zero-content scroll diagnostic breadcrumbs. */
  diagnosticMode?: AutoScrollDiagnosticMetrics['scrollMode'];
  /** Optional diagnostic collector for zero-content scroll anomalies. */
  diagnostics?: DiagnosticCollector;
}

type OverflowYValue = NonNullable<AutoScrollDiagnosticMetrics['scrollOverflowY']>;

function readOverflowY(element: HTMLElement): OverflowYValue {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return 'unknown';
  }
  const value = window.getComputedStyle(element)?.overflowY;
  switch (value) {
    case 'auto':
    case 'scroll':
    case 'overlay':
    case 'visible':
    case 'hidden':
    case 'clip':
      return value;
    default:
      return 'unknown';
  }
}

function isScrollableOverflow(overflowY: OverflowYValue): boolean {
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function isNonScrollableOverflow(overflowY: OverflowYValue): boolean {
  return overflowY === 'visible' || overflowY === 'hidden' || overflowY === 'clip';
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    if (isScrollableOverflow(readOverflowY(current))) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function computeGapPx(element: HTMLElement): number {
  return Math.max(0, Math.round(element.scrollHeight - element.scrollTop - element.clientHeight));
}

/**
 * Shared auto-scroll & scroll-to-bottom state machine for all 3 mode timelines and neutral chat.
 */
export function useAutoScrollTimeline(options: UseAutoScrollTimelineOptions) {
  const {
    contextKey,
    activeLeafKey,
    turnCount,
    isStreaming,
    streamPulse = '',
    paused = false,
    scrollContainerRef,
    diagnosticMode = 'unknown',
    diagnostics,
  } = options;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const stageRef = useRef<HTMLElement | null>(null);
  const scrollContainerRefRef = useRef(scrollContainerRef);
  scrollContainerRefRef.current = scrollContainerRef;
  const diagnosticsRef = useRef(diagnostics);
  diagnosticsRef.current = diagnostics;
  const diagnosticModeRef = useRef(diagnosticMode);
  diagnosticModeRef.current = diagnosticMode;

  const contextKeyRef = useRef(contextKey);
  const leafKeyRef = useRef(activeLeafKey);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const wasPausedRef = useRef(paused);
  const shouldFollowRef = useRef(true);
  const userPausedRef = useRef(false);
  const userIntentUntilRef = useRef(0);
  const lastMetricsRef = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const pendingFrameRef = useRef<number | null>(null);
  const reportedAnomaliesRef = useRef(new Set<string>());

  const recordAnomalyOnce = (dedupeKey: string, event: AutoScrollDiagnosticEvent) => {
    const collector = diagnosticsRef.current;
    if (!collector || reportedAnomaliesRef.current.has(dedupeKey)) return;
    reportedAnomaliesRef.current.add(dedupeKey);
    recordAutoScrollDiagnostic(collector, {
      ...event,
      metrics: {
        scrollMode: diagnosticModeRef.current,
        ...event.metrics,
      },
    });
  };

  const resolveScrollCandidate = (
    element: HTMLElement,
    keyPrefix: 'explicit' | 'stage',
  ): HTMLElement => {
    const overflowY = readOverflowY(element);
    if (!isNonScrollableOverflow(overflowY)) return element;
    const ancestor = findScrollableAncestor(element);
    const reasonCode = ancestor ? 'resolved_scrollable_ancestor' : 'no_scrollable_ancestor';
    const dedupeKey =
      keyPrefix === 'explicit'
        ? ancestor
          ? 'non_scrollable:explicit_resolved_ancestor'
          : 'non_scrollable:explicit_no_ancestor'
        : `non_scrollable:${reasonCode}`;
    recordAnomalyOnce(dedupeKey, {
      level: 'warn',
      action: 'autoscroll_target_non_scrollable',
      metrics: {
        scrollState: userPausedRef.current ? 'user_paused' : 'following',
        scrollOverflowY: overflowY,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollGapPx: computeGapPx(element),
        reasonCode,
      },
    });
    return ancestor ?? element;
  };

  const resolveScrollContainer = (): HTMLElement | null => {
    const explicit = scrollContainerRefRef.current?.current ?? null;
    if (explicit) return resolveScrollCandidate(explicit, 'explicit');
    const stage = stageRef.current;
    return stage ? resolveScrollCandidate(stage, 'stage') : null;
  };

  const cancelScheduledScroll = () => {
    if (pendingFrameRef.current === null) return;
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(pendingFrameRef.current);
    }
    pendingFrameRef.current = null;
  };

  const applyScrollToBottom = (target: HTMLElement) => {
    target.scrollTop = target.scrollHeight;
    lastMetricsRef.current = {
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    };
    if (target.scrollHeight > target.clientHeight) {
      const gap = computeGapPx(target);
      if (gap > 80) {
        recordAnomalyOnce('follow_anomaly:scroll_missed_bottom', {
          level: 'warn',
          action: 'autoscroll_follow_anomaly',
          metrics: {
            scrollState: 'following',
            scrollTop: target.scrollTop,
            scrollHeight: target.scrollHeight,
            clientHeight: target.clientHeight,
            scrollGapPx: gap,
            reasonCode: 'scroll_missed_bottom',
          },
        });
      }
    }
  };

  const scheduleScroll = (expectedContextKey?: string) => {
    if (pausedRef.current || !shouldFollowRef.current || userPausedRef.current) return;
    if (pendingFrameRef.current !== null) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;

    let ranSynchronously = false;
    const frameId = window.requestAnimationFrame(() => {
      ranSynchronously = true;
      pendingFrameRef.current = null;
      if (pausedRef.current || !shouldFollowRef.current || userPausedRef.current) return;
      if (expectedContextKey !== undefined && contextKeyRef.current !== expectedContextKey) return;
      const target = resolveScrollContainer();
      if (!target) {
        recordAnomalyOnce('target_missing:raf', {
          level: 'warn',
          action: 'autoscroll_target_missing',
          metrics: {
            scrollState: 'following',
            reasonCode: 'missing_stage_ref',
          },
        });
        return;
      }
      applyScrollToBottom(target);
    });
    if (!ranSynchronously) {
      pendingFrameRef.current = frameId;
    }
  };

  useLayoutEffect(() => {
    if (paused) {
      wasPausedRef.current = true;
      cancelScheduledScroll();
      return;
    }
    const resumedFromPause = wasPausedRef.current;
    wasPausedRef.current = false;

    const target = resolveScrollContainer();
    const contextChanged = contextKeyRef.current !== contextKey;
    if (contextChanged) {
      contextKeyRef.current = contextKey;
      leafKeyRef.current = activeLeafKey;
      reportedAnomaliesRef.current.clear();
      shouldFollowRef.current = true;
      userPausedRef.current = false;
      userIntentUntilRef.current = 0;
      setShowScrollToBottom(false);
      cancelScheduledScroll();
      if (target) {
        scheduleScroll(contextKey);
      } else if (turnCount > 0 || isStreaming) {
        recordAnomalyOnce('target_missing:context_change', {
          level: 'warn',
          action: 'autoscroll_target_missing',
          metrics: {
            scrollState: 'following',
            reasonCode: 'missing_stage_ref',
          },
        });
      }
      return;
    }

    const leafChanged = leafKeyRef.current !== activeLeafKey;
    leafKeyRef.current = activeLeafKey;
    if ((leafChanged || resumedFromPause) && userPausedRef.current && target) {
      target.scrollTop = Math.min(
        lastMetricsRef.current.scrollTop,
        Math.max(0, target.scrollHeight - target.clientHeight),
      );
      lastMetricsRef.current = {
        scrollTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
      };
      return;
    }

    if (!shouldFollowRef.current || userPausedRef.current) return;
    if (!target) {
      if (turnCount > 0 || isStreaming) {
        recordAnomalyOnce('target_missing:layout', {
          level: 'warn',
          action: 'autoscroll_target_missing',
          metrics: {
            scrollState: 'following',
            reasonCode: 'missing_stage_ref',
          },
        });
      }
      return;
    }
    scheduleScroll();
  }, [contextKey, activeLeafKey, turnCount, isStreaming, streamPulse, paused]);

  useEffect(() => {
    return () => {
      cancelScheduledScroll();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const keepLatestInView = () => {
      if (pausedRef.current) return;
      const target = resolveScrollContainer();
      if (!target) return;
      if (!userPausedRef.current) {
        shouldFollowRef.current = true;
        setShowScrollToBottom(false);
        applyScrollToBottom(target);
        scheduleScroll();
      }
    };
    const viewport = window.visualViewport;
    window.addEventListener('resize', keepLatestInView);
    viewport?.addEventListener('resize', keepLatestInView);
    return () => {
      window.removeEventListener('resize', keepLatestInView);
      viewport?.removeEventListener('resize', keepLatestInView);
    };
  }, []);

  const handleScroll = () => {
    if (pausedRef.current) return;
    const target = resolveScrollContainer();
    if (!target) return;
    const prev = lastMetricsRef.current;
    const layoutChanged =
      prev.scrollHeight !== target.scrollHeight || prev.clientHeight !== target.clientHeight;
    const scrolledUp = target.scrollTop < prev.scrollTop - 1;
    const scrolledDown = target.scrollTop > prev.scrollTop + 1;
    lastMetricsRef.current = {
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    };
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    const withinFollowRange = distanceFromBottom <= 80;
    const withinResumeRange = distanceFromBottom <= 24;
    const hasRecentIntent = Date.now() < userIntentUntilRef.current;

    if (scrolledUp && hasRecentIntent && !withinFollowRange) {
      shouldFollowRef.current = false;
      userPausedRef.current = true;
      cancelScheduledScroll();
      setShowScrollToBottom(true);
      return;
    }
    if (userPausedRef.current) {
      if (scrolledDown && hasRecentIntent && withinResumeRange) {
        shouldFollowRef.current = true;
        userPausedRef.current = false;
        setShowScrollToBottom(false);
        return;
      }
      shouldFollowRef.current = false;
      setShowScrollToBottom(true);
      return;
    }
    if (layoutChanged && shouldFollowRef.current) {
      shouldFollowRef.current = true;
      scheduleScroll();
      return;
    }
    if (withinFollowRange) {
      shouldFollowRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    shouldFollowRef.current = true;
    setShowScrollToBottom(false);
    if (scrolledUp) {
      recordAnomalyOnce('follow_anomaly:unexpected_scroll_up_without_intent', {
        level: 'warn',
        action: 'autoscroll_follow_anomaly',
        metrics: {
          scrollState: 'following',
          scrollTop: target.scrollTop,
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
          scrollGapPx: Math.max(0, Math.round(distanceFromBottom)),
          reasonCode: 'unexpected_scroll_up_without_intent',
        },
      });
      scheduleScroll();
    }
  };

  const markScrollIntent = (target: EventTarget | null) => {
    if (pausedRef.current) return;
    const isEditable =
      target instanceof Element &&
      Boolean(target.closest('textarea, input, [contenteditable="true"]'));
    if (!isEditable) {
      userIntentUntilRef.current = Date.now() + 600;
    }
  };

  const handleScrollRef = useRef(handleScroll);
  handleScrollRef.current = handleScroll;
  const markScrollIntentRef = useRef(markScrollIntent);
  markScrollIntentRef.current = markScrollIntent;

  useEffect(() => {
    if (paused) return;
    const target = resolveScrollContainer();
    if (!target || target === stageRef.current || typeof target.addEventListener !== 'function') {
      return;
    }
    const onScroll = () => handleScrollRef.current();
    const onWheel = (event: Event) => {
      const wheel = event as globalThis.WheelEvent;
      if (wheel.deltaY !== 0) markScrollIntentRef.current(wheel.target);
    };
    const onTouchMove = (event: Event) => {
      markScrollIntentRef.current(event.target);
    };
    const onKeyDown = (event: Event) => {
      const kb = event as globalThis.KeyboardEvent;
      if (['ArrowUp', 'PageUp', 'Home'].includes(kb.key)) {
        markScrollIntentRef.current(kb.target);
      }
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    target.addEventListener('wheel', onWheel, { capture: true, passive: true });
    target.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    target.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      target.removeEventListener('wheel', onWheel, { capture: true });
      target.removeEventListener('touchmove', onTouchMove, { capture: true });
      target.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [paused, contextKey, scrollContainerRef]);

  const resumeFollow = () => {
    const wasUserPaused = userPausedRef.current;
    userPausedRef.current = false;
    shouldFollowRef.current = true;
    userIntentUntilRef.current = 0;
    setShowScrollToBottom(false);
    if (pausedRef.current) return;
    const target = resolveScrollContainer();
    if (wasUserPaused && target) {
      recordAutoScrollDiagnostic(diagnosticsRef.current, {
        level: 'info',
        action: 'autoscroll_follow_transition',
        metrics: {
          scrollMode: diagnosticModeRef.current,
          scrollState: 'following',
          scrollGapPx: computeGapPx(target),
          reasonCode: 'resumed_by_submit',
        },
      });
    }
    if (target) {
      applyScrollToBottom(target);
      scheduleScroll();
    } else {
      recordAnomalyOnce('target_missing:resume_follow', {
        level: 'warn',
        action: 'autoscroll_target_missing',
        metrics: {
          scrollState: 'following',
          reasonCode: 'missing_stage_ref',
        },
      });
    }
  };

  const scrollToBottom = () => {
    if (pausedRef.current) return;
    shouldFollowRef.current = true;
    userPausedRef.current = false;
    userIntentUntilRef.current = 0;
    setShowScrollToBottom(false);
    const target = resolveScrollContainer();
    if (target) {
      applyScrollToBottom(target);
      scheduleScroll();
    }
  };

  const containerHandlers = paused
    ? {}
    : {
        onScroll: handleScroll,
        onWheelCapture: (event: WheelEvent<HTMLElement>) => {
          if (event.deltaY !== 0) markScrollIntent(event.target);
        },
        onTouchMoveCapture: (event: TouchEvent<HTMLElement>) => markScrollIntent(event.target),
        onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
            markScrollIntent(event.target);
          }
        },
      };

  return {
    stageRef,
    showScrollToBottom,
    scrollToBottom,
    resumeFollow,
    containerHandlers,
    handleScroll,
    markScrollIntent,
  };
}
