import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type TouchEvent, type WheelEvent } from 'react';

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
}

/**
 * Shared auto-scroll & scroll-to-bottom state machine for all 3 mode timelines and neutral chat.
 */
export function useAutoScrollTimeline(options: UseAutoScrollTimelineOptions) {
  const { contextKey, activeLeafKey, turnCount, isStreaming, streamPulse = '', paused = false } = options;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const stageRef = useRef<HTMLElement | null>(null);
  const contextKeyRef = useRef(contextKey);
  const leafKeyRef = useRef(activeLeafKey);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const wasPausedRef = useRef(paused);
  const shouldFollowRef = useRef(true);
  const userPausedRef = useRef(false);
  const userIntentUntilRef = useRef(0);
  const lastMetricsRef = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  useLayoutEffect(() => {
    if (paused) {
      wasPausedRef.current = true;
      return;
    }
    const resumedFromPause = wasPausedRef.current;
    wasPausedRef.current = false;

    const stage = stageRef.current;
    const contextChanged = contextKeyRef.current !== contextKey;
    if (contextChanged) {
      contextKeyRef.current = contextKey;
      leafKeyRef.current = activeLeafKey;
      shouldFollowRef.current = true;
      userPausedRef.current = false;
      userIntentUntilRef.current = 0;
      setShowScrollToBottom(false);
      if (stage) {
        const frame = window.requestAnimationFrame(() => {
          const currentStage = stageRef.current;
          if (!currentStage || pausedRef.current || contextKeyRef.current !== contextKey) return;
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        });
        return () => window.cancelAnimationFrame(frame);
      }
      return;
    }

    const leafChanged = leafKeyRef.current !== activeLeafKey;
    leafKeyRef.current = activeLeafKey;
    if ((leafChanged || resumedFromPause) && userPausedRef.current && stage) {
      stage.scrollTop = Math.min(
        lastMetricsRef.current.scrollTop,
        Math.max(0, stage.scrollHeight - stage.clientHeight),
      );
      lastMetricsRef.current = {
        scrollTop: stage.scrollTop,
        scrollHeight: stage.scrollHeight,
        clientHeight: stage.clientHeight,
      };
      return;
    }

    if (!stage || !shouldFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!pausedRef.current && shouldFollowRef.current) {
        stage.scrollTop = stage.scrollHeight;
        lastMetricsRef.current = {
          scrollTop: stage.scrollTop,
          scrollHeight: stage.scrollHeight,
          clientHeight: stage.clientHeight,
        };
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextKey, activeLeafKey, turnCount, isStreaming, streamPulse, paused]);

  useEffect(() => {
    const keepLatestInView = () => {
      if (pausedRef.current) return;
      const stage = stageRef.current;
      if (!stage) return;
      if (!userPausedRef.current) {
        shouldFollowRef.current = true;
        setShowScrollToBottom(false);
        stage.scrollTop = stage.scrollHeight;
      }
    };
    window.addEventListener('resize', keepLatestInView);
    return () => window.removeEventListener('resize', keepLatestInView);
  }, []);

  const handleScroll = () => {
    if (pausedRef.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const prev = lastMetricsRef.current;
    const layoutChanged =
      prev.scrollHeight !== stage.scrollHeight || prev.clientHeight !== stage.clientHeight;
    const scrolledUp = stage.scrollTop < prev.scrollTop - 1;
    const scrolledDown = stage.scrollTop > prev.scrollTop + 1;
    lastMetricsRef.current = {
      scrollTop: stage.scrollTop,
      scrollHeight: stage.scrollHeight,
      clientHeight: stage.clientHeight,
    };
    const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
    const withinFollowRange = distanceFromBottom <= 80;
    const withinResumeRange = distanceFromBottom <= 24;
    const hasRecentIntent = Date.now() < userIntentUntilRef.current;

    if (scrolledUp && hasRecentIntent && !withinFollowRange) {
      shouldFollowRef.current = false;
      userPausedRef.current = true;
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
      window.requestAnimationFrame(() => {
        const currentStage = stageRef.current;
        if (currentStage && !pausedRef.current) {
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        }
      });
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
      window.requestAnimationFrame(() => {
        const currentStage = stageRef.current;
        if (currentStage && !pausedRef.current) {
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        }
      });
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

  const scrollToBottom = () => {
    if (pausedRef.current) return;
    shouldFollowRef.current = true;
    userPausedRef.current = false;
    setShowScrollToBottom(false);
    window.requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (stage && !pausedRef.current) stage.scrollTop = stage.scrollHeight;
    });
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
    containerHandlers,
    handleScroll,
    markScrollIntent,
  };
}
