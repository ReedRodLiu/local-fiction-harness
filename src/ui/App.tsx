import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Square } from 'lucide-react';
import {
  DEFAULT_MODEL_CONFIG,
  computeActiveReviewState,
  createAsyncModelConfigStore,
  createFictionHarness,
  exportStoryBackup,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getSiblingBranchInfo,
  importDeepSeekSessions,
  importStoryBackup,
  isAbortError,
  maskApiKey,
  normalizeOfficialModelConfig,
  projectStoryTreeSpine,
  type DeepSeekImportBatchResult,
  type DiagnosticBundleTrigger,
  type ModelConfig,
  type PlatformRuntime,
  type ScriptTurnRange,
  type Story,
  type StoryBlueprint,
  type TurnCallbacks,
  type TurnExecutionResult,
} from '../harness/index.ts';
import { APP_VERSION } from '../appVersion.ts';
import {
  clearDevSessionProxy,
  fetchDevTestConfig,
  isDevProxyBaseUrl,
  readDevSessionProxy,
  writeDevSessionProxy,
  type DevTestConfigResponse,
} from '../platform/runtime.ts';
import { CompanionSheet } from './CompanionSheet.tsx';
import { LibraryDrawer } from './LibraryDrawer.tsx';
import { setCrashDiagnosticBundleBuilder } from './crashDiagnosticContext.ts';
import { DiagnosticsPreview } from './DiagnosticsPreview.tsx';
import {
  mergeBranchRenameResult,
  mergeBranchSummaryResult,
} from './storyConcurrency.ts';
import { DeepSeekSetupWizard } from './DeepSeekSetupWizard.tsx';
import { ImportPanel, type ImportMode } from './ImportPanel.tsx';
import { MessageContent } from './MessageContent.tsx';
import { StoryLibrary } from './StoryLibrary.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { TopBar } from './TopBar.tsx';
import { TurnCard } from './TurnCard.tsx';
import { toErrorMessage } from './textHelpers.ts';
import { useEdgeSwipeToOpen } from './useEdgeSwipeToOpen.ts';
import { useAppOverlayHistory } from './useAppOverlayHistory.ts';
import { useDisplayPreferences } from './useDisplayPreferences.ts';
import { useLibraryCollapsedPreference } from './useLibraryCollapsedPreference.ts';
import { usePresentationOverlayState } from './usePresentationOverlayState.ts';
import { WelcomeView } from './WelcomeView.tsx';

const FIRST_ACT_PROMPT = '开始故事，请按照剧本开场规则生成第一幕与初始状态栏。';

function hasModelCredentials(config: ModelConfig, useDevEnvKey: boolean): boolean {
  if (
    config.apiKey.trim() ||
    (import.meta.env.DEV && (useDevEnvKey || isDevProxyBaseUrl(config.baseUrl)))
  ) {
    return true;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.baseUrl.trim());
}

function mergeLoadedConfig(
  loaded: ModelConfig,
  isWebDev: boolean,
): { initialConfig: ModelConfig; initialUseDevEnvKey: boolean } {
  if (import.meta.env.DEV && isWebDev) {
    const devProxy = readDevSessionProxy(true);
    if (devProxy) {
      return {
        initialConfig: {
          ...loaded,
          baseUrl: devProxy.baseUrl,
          model: devProxy.model ?? loaded.model,
          apiKey: devProxy.hasEnvKey ? '' : loaded.apiKey,
        },
        initialUseDevEnvKey: devProxy.hasEnvKey,
      };
    }
  }
  return {
    initialConfig: normalizeOfficialModelConfig(loaded),
    initialUseDevEnvKey: false,
  };
}

export interface AppProps {
  runtime: PlatformRuntime;
}

export function App({ runtime }: AppProps) {
  const isWebDev = runtime.platform === 'web' && import.meta.env.DEV;

  const configStore = useMemo(
    () => createAsyncModelConfigStore(runtime.secretStore),
    [runtime],
  );
  const harness = useMemo(
    () =>
      createFictionHarness({
        transport: runtime.transport,
        storage: runtime.storyStorage,
      }),
    [runtime],
  );

  const [config, setConfig] = useState<ModelConfig>(() => {
    const devProxy = import.meta.env.DEV ? readDevSessionProxy(isWebDev) : null;
    if (devProxy) {
      return {
        ...DEFAULT_MODEL_CONFIG,
        baseUrl: devProxy.baseUrl,
        model: devProxy.model ?? DEFAULT_MODEL_CONFIG.model,
      };
    }
    return DEFAULT_MODEL_CONFIG;
  });
  const [useDevEnvKey, setUseDevEnvKey] = useState(() =>
    Boolean(import.meta.env.DEV && readDevSessionProxy(isWebDev)?.hasEnvKey),
  );
  const [devTestInfo, setDevTestInfo] = useState<DevTestConfigResponse | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [story, setStory] = useState<Story>(() => harness.createStory({ title: '新故事' }));
  const {
    showImport,
    setShowImport,
    showSettings,
    setShowSettings,
    mobileLibraryOpen,
    setMobileLibraryOpen,
    storyTreeOpen,
    setStoryTreeOpen,
  } = usePresentationOverlayState();
  const [importMode, setImportMode] = useState<ImportMode>('deepseek');
  const [importResetKey, setImportResetKey] = useState(0);
  const [libraryCollapsed, setLibraryCollapsed] = useLibraryCollapsedPreference();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMounted, setWizardMounted] = useState(false);
  const [wizardVerifying, setWizardVerifying] = useState(false);
  const [pendingByok, setPendingByok] = useState<{
    label: string;
    resume: (resolvedConfig: ModelConfig) => void;
    onCancel?: () => void;
  } | null>(null);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSummaryComputationInProgress, setIsSummaryComputationInProgress] = useState(false);
  const [isBlueprintReextracting, setIsBlueprintReextracting] = useState(false);
  const [isBranchSwitchSummarizing, setIsBranchSwitchSummarizing] = useState(false);
  const [isBranchSwitching, setIsBranchSwitching] = useState(false);
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [streamingNodeId, setStreamingNodeId] = useState<string | null>(null);
  const [reasoningDurations, setReasoningDurations] = useState<Record<string, number>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsMounted, setDiagnosticsMounted] = useState(false);
  const [diagnosticsRevision, setDiagnosticsRevision] = useState(0);
  const [diagnosticTrigger, setDiagnosticTrigger] = useState<DiagnosticBundleTrigger>('settings_manual');
  const {
    displayPreferences,
    setThemePreference,
    setDisplayFontSize,
  } = useDisplayPreferences();
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const wizardReturnFocusRef = useRef<HTMLElement | null>(null);
  const wizardCloseReasonRef = useRef<'success' | 'cancel' | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamSeqRef = useRef(0);
  const storyOpSeqRef = useRef(0);
  const summarySeqRef = useRef(0);
  const storyCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const storyRef = useRef<Story | null>(story);
  storyRef.current = story;
  const branchSwitchBusyRef = useRef(false);
  const branchSwitchTransitionRef = useRef(false);
  const mainStageRef = useRef<HTMLElement | null>(null);
  const mainStageStoryIdRef = useRef(story.id);
  const mainStageLeafIdRef = useRef(story.activeLeafNodeId);
  const shouldFollowMainStageRef = useRef(true);
  const userPausedMainStageRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const lastMainStageMetricsRef = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const configEditSeqRef = useRef(0);
  const configSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const suppressedAbortRef = useRef<WeakSet<AbortController>>(new WeakSet());
  const isSummaryInProgress = isBranchSwitchSummarizing || isSummaryComputationInProgress;
  const edgeSwipeHandlers = useEdgeSwipeToOpen(
    !showImport && !showSettings && !mobileLibraryOpen,
    () => setMobileLibraryOpen(true),
  );

  const captureOverlayTrigger = () => {
    overlayReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  };

  const openDiagnostics = (trigger: DiagnosticBundleTrigger = 'error_banner') => {
    captureOverlayTrigger();
    setDiagnosticTrigger(trigger);
    setDiagnosticsRevision((revision) => revision + 1);
    setDiagnosticsMounted(true);
    setDiagnosticsOpen(true);
  };

  const closeDiagnostics = () => {
    setDiagnosticsOpen(false);
  };

  const finishDiagnosticsExit = () => {
    setDiagnosticsMounted(false);
    window.requestAnimationFrame(() => overlayReturnFocusRef.current?.focus());
  };

  const buildDiagnosticBundle = useCallback(
    (trigger: DiagnosticBundleTrigger) =>
      runtime.diagnostics.buildBundle(
        {
          ...config,
          isDevProxy: import.meta.env.DEV && isDevProxyBaseUrl(config.baseUrl),
        },
        {
          trigger,
          activeStory: story,
          appEnv: {
            appVersion: APP_VERSION,
            viewport:
              typeof window === 'undefined'
                ? 'unknown'
                : `${window.innerWidth}x${window.innerHeight}`,
            activeView: showImport ? 'import' : 'story',
            storyCount: stories.length,
          },
        },
      ),
    [runtime, config, story, showImport, stories.length],
  );

  const abortActiveStream = useCallback((suppressNotice = true) => {
    const controller = abortRef.current;
    if (controller) {
      if (suppressNotice) {
        suppressedAbortRef.current.add(controller);
      }
      abortRef.current = null;
      controller.abort();
    }
    streamSeqRef.current += 1;
    setIsStreaming(false);
    setStreamReasoning('');
    setStreamContent('');
    setStreamingNodeId(null);
  }, []);

  const refreshStories = useCallback(async () => {
    const list = await harness.listStories();
    setStories(list);
    return list;
  }, [harness]);

  const commitStoryState = useCallback(
    async (nextStory: Story) => {
      storyRef.current = nextStory;
      setStory(nextStory);
      await refreshStories();
    },
    [refreshStories],
  );

  const enqueueStoryCommit = useCallback(
    (merge: (latestStory: Story | null) => Story | null): Promise<Story | null> => {
      const commit = storyCommitQueueRef.current.then(async () => {
        const updated = merge(storyRef.current);
        if (!updated) return null;
        storyRef.current = updated;
        setStory(updated);
        await harness.saveStory(updated);
        await refreshStories();
        return updated;
      });
      storyCommitQueueRef.current = commit.then(
        () => undefined,
        () => undefined,
      );
      return commit;
    },
    [harness, refreshStories],
  );

  const invalidateSummaryTask = useCallback(() => {
    summarySeqRef.current += 1;
    setIsSummarizing(false);
    setIsSummaryComputationInProgress(false);
    setIsBranchSwitchSummarizing(false);
  }, []);

  useEffect(() => {
    return () => {
      abortActiveStream(true);
    };
  }, [abortActiveStream]);

  useEffect(() => {
    let cancelled = false;
    const editSeqAtStart = configEditSeqRef.current;
    (async () => {
      try {
        const loaded = await configStore.load();
        if (cancelled || configEditSeqRef.current !== editSeqAtStart) return;
        const merged = mergeLoadedConfig(loaded, isWebDev);
        setConfig(merged.initialConfig);
        setUseDevEnvKey(merged.initialUseDevEnvKey);
      } catch (err) {
        if (!cancelled && configEditSeqRef.current === editSeqAtStart) {
          setErrorMsg(toErrorMessage(err, '读取模型配置失败。'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configStore, isWebDev]);

  useEffect(() => {
    let cancelled = false;
    const loadSeq = storyOpSeqRef.current;
    (async () => {
      try {
        const [list, active] = await Promise.all([
          harness.listStories(),
          harness.loadActiveStory(),
        ]);
        if (cancelled || storyOpSeqRef.current !== loadSeq) return;
        setStories(list);
        if (active) {
          setStory(active);
        }
      } catch (err) {
        if (!cancelled && storyOpSeqRef.current === loadSeq) {
          setErrorMsg(toErrorMessage(err, '读取本地故事失败。'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harness]);

  useEffect(() => {
    // This callback stays in process memory only; the collector projects the Story before serialization.
    setCrashDiagnosticBundleBuilder(runtime, () => buildDiagnosticBundle('crash_boundary'));
  }, [runtime, buildDiagnosticBundle]);

  useEffect(() => {
    if (!import.meta.env.DEV || !isWebDev) {
      return;
    }
    let cancelled = false;
    void fetchDevTestConfig().then((data) => {
      if (!cancelled && data) {
        setDevTestInfo(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isWebDev]);

  useAppOverlayHistory({
    wizardOpen,
    wizardVerifying,
    onWizardBack: () => {
      const cancel = pendingByok?.onCancel;
      wizardCloseReasonRef.current = 'cancel';
      setPendingByok(null);
      setWizardOpen(false);
      cancel?.();
    },
    storyTreeOpen,
    onStoryTreeBack: () => setStoryTreeOpen(false),
    mobileLibraryOpen,
    onMobileLibraryBack: () => setMobileLibraryOpen(false),
    showSettings,
    onSettingsBack: () => setShowSettings(false),
    showImport,
    onImportBack: () => setShowImport(false),
    returnFocus: () => overlayReturnFocusRef.current,
  });

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b' &&
        window.matchMedia('(min-width: 960px)').matches &&
        !showImport &&
        !showSettings
      ) {
        event.preventDefault();
        setLibraryCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [showImport, showSettings]);

  const enqueueConfigSave = (task: () => Promise<void>) => {
    configSaveQueueRef.current = configSaveQueueRef.current
      .then(task)
      .catch((err) => {
        setErrorMsg(toErrorMessage(err, '保存模型配置失败。'));
      });
  };

  const updateConfig = (next: ModelConfig, nextUseDevEnvKey = useDevEnvKey) => {
    configEditSeqRef.current += 1;
    const effectiveUseDevEnvKey =
      import.meta.env.DEV && isWebDev && nextUseDevEnvKey && isDevProxyBaseUrl(next.baseUrl);
    setConfig(next);
    setUseDevEnvKey(effectiveUseDevEnvKey);
    if (import.meta.env.DEV && isWebDev) {
      if (effectiveUseDevEnvKey) {
        writeDevSessionProxy({
          baseUrl: next.baseUrl,
          model: next.model,
          hasEnvKey: true,
        });
        const saveSeq = configEditSeqRef.current;
        enqueueConfigSave(async () => {
          if (configEditSeqRef.current !== saveSeq) return;
          const persisted = await configStore.load();
          await configStore.save({
            ...next,
            baseUrl: isDevProxyBaseUrl(persisted.baseUrl)
              ? DEFAULT_MODEL_CONFIG.baseUrl
              : persisted.baseUrl,
          });
        });
        return;
      }
      clearDevSessionProxy();
    }
    enqueueConfigSave(() => configStore.save(next));
  };

  const applyDevTestConfig = () => {
    if (!import.meta.env.DEV || !devTestInfo || !isWebDev) return;
    configEditSeqRef.current += 1;
    const devModel = devTestInfo.model || config.model;
    writeDevSessionProxy({
      baseUrl: devTestInfo.proxyBaseUrl,
      model: devModel,
      hasEnvKey: devTestInfo.hasEnvKey,
    });
    setConfig({
      baseUrl: devTestInfo.proxyBaseUrl,
      model: devModel,
      apiKey: devTestInfo.hasEnvKey ? '' : config.apiKey,
      memoryOnly: config.memoryOnly,
    });
    setUseDevEnvKey(devTestInfo.hasEnvKey);
    setErrorMsg(null);
  };

  const activeNodes = getActiveBranchNodes(story);
  const activeSummary = getActiveSummarySnapshot(story);
  const contextPreview = useMemo(
    () => harness.assembleContext(story, story.activeLeafNodeId),
    [harness, story],
  );

  useLayoutEffect(() => {
    if (showImport || showSettings) return;
    const stage = mainStageRef.current;
    const storyChanged = mainStageStoryIdRef.current !== story.id;
    if (storyChanged) {
      mainStageStoryIdRef.current = story.id;
      mainStageLeafIdRef.current = story.activeLeafNodeId;
      shouldFollowMainStageRef.current = true;
      userPausedMainStageRef.current = false;
      userScrollIntentUntilRef.current = 0;
      setShowScrollToBottom(false);
      if (stage) {
        const frame = window.requestAnimationFrame(() => {
          const currentStage = mainStageRef.current;
          if (!currentStage || mainStageStoryIdRef.current !== story.id) return;
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMainStageMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        });
        return () => window.cancelAnimationFrame(frame);
      }
      return;
    }
    const activeLeafChanged = mainStageLeafIdRef.current !== story.activeLeafNodeId;
    mainStageLeafIdRef.current = story.activeLeafNodeId;
    if (activeLeafChanged && userPausedMainStageRef.current && stage) {
      stage.scrollTop = Math.min(
        lastMainStageMetricsRef.current.scrollTop,
        Math.max(0, stage.scrollHeight - stage.clientHeight),
      );
      lastMainStageMetricsRef.current = {
        scrollTop: stage.scrollTop,
        scrollHeight: stage.scrollHeight,
        clientHeight: stage.clientHeight,
      };
      return;
    }
    if (!stage || !shouldFollowMainStageRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (shouldFollowMainStageRef.current) {
        stage.scrollTop = stage.scrollHeight;
        lastMainStageMetricsRef.current = {
          scrollTop: stage.scrollTop,
          scrollHeight: stage.scrollHeight,
          clientHeight: stage.clientHeight,
        };
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    story.id,
    story.activeLeafNodeId,
    activeNodes.length,
    isStreaming,
    streamReasoning,
    streamContent,
    showImport,
    showSettings,
  ]);

  useEffect(() => {
    const keepLatestInView = () => {
      const stage = mainStageRef.current;
      if (!stage) return;
      if (!userPausedMainStageRef.current) {
        shouldFollowMainStageRef.current = true;
        setShowScrollToBottom(false);
        stage.scrollTop = stage.scrollHeight;
      }
    };
    window.addEventListener('resize', keepLatestInView);
    return () => window.removeEventListener('resize', keepLatestInView);
  }, []);

  const handleMainStageScroll = () => {
    const stage = mainStageRef.current;
    if (!stage) return;
    const previousMetrics = lastMainStageMetricsRef.current;
    const layoutChanged =
      previousMetrics.scrollHeight !== stage.scrollHeight ||
      previousMetrics.clientHeight !== stage.clientHeight;
    const scrolledUp = stage.scrollTop < previousMetrics.scrollTop - 1;
    const scrolledDown = stage.scrollTop > previousMetrics.scrollTop + 1;
    lastMainStageMetricsRef.current = {
      scrollTop: stage.scrollTop,
      scrollHeight: stage.scrollHeight,
      clientHeight: stage.clientHeight,
    };
    const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
    const withinFollowRange = distanceFromBottom <= 80;
    const withinResumeRange = distanceFromBottom <= 24;
    const hasRecentScrollIntent = Date.now() < userScrollIntentUntilRef.current;
    const isManualScrollUp = scrolledUp && hasRecentScrollIntent;
    const isManualScrollDown = scrolledDown && hasRecentScrollIntent;
    if (isManualScrollUp && !withinFollowRange) {
      shouldFollowMainStageRef.current = false;
      userPausedMainStageRef.current = true;
      setShowScrollToBottom(true);
      return;
    }
    if (userPausedMainStageRef.current) {
      if (isManualScrollDown && withinResumeRange) {
        shouldFollowMainStageRef.current = true;
        userPausedMainStageRef.current = false;
        setShowScrollToBottom(false);
        return;
      }
      shouldFollowMainStageRef.current = false;
      setShowScrollToBottom(true);
      return;
    }
    if (layoutChanged && shouldFollowMainStageRef.current) {
      shouldFollowMainStageRef.current = true;
      window.requestAnimationFrame(() => {
        const currentStage = mainStageRef.current;
        if (currentStage) {
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMainStageMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        }
      });
      return;
    }
    if (withinFollowRange) {
      shouldFollowMainStageRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    shouldFollowMainStageRef.current = true;
    setShowScrollToBottom(false);
    if (scrolledUp) {
      window.requestAnimationFrame(() => {
        const currentStage = mainStageRef.current;
        if (currentStage) {
          currentStage.scrollTop = currentStage.scrollHeight;
          lastMainStageMetricsRef.current = {
            scrollTop: currentStage.scrollTop,
            scrollHeight: currentStage.scrollHeight,
            clientHeight: currentStage.clientHeight,
          };
        }
      });
    }
  };

  const isEditableScrollTarget = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest('textarea, input, [contenteditable="true"]'));

  const markMainStageScrollIntent = (target: EventTarget | null) => {
    if (!isEditableScrollTarget(target)) {
      userScrollIntentUntilRef.current = Date.now() + 600;
    }
  };

  const handleScrollToBottom = () => {
    shouldFollowMainStageRef.current = true;
    userPausedMainStageRef.current = false;
    setShowScrollToBottom(false);
    window.requestAnimationFrame(() => {
      const stage = mainStageRef.current;
      if (stage) stage.scrollTop = stage.scrollHeight;
    });
  };

  const runStreamingExecution = async (
    execute: (callbacks: TurnCallbacks) => Promise<TurnExecutionResult>,
    onErrorRestore?: () => void,
  ) => {
    if (branchSwitchBusyRef.current || abortRef.current || isStreaming) return;
    const streamStartedAt = performance.now();
    setErrorMsg(null);
    setIsStreaming(true);
    setStreamReasoning('');
    setStreamContent('');
    setStreamingNodeId(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const streamSeq = ++streamSeqRef.current;
    const storySeqAtStart = storyOpSeqRef.current;

    const isStale = () =>
      controller.signal.aborted ||
      abortRef.current !== controller ||
      streamSeqRef.current !== streamSeq ||
      storyOpSeqRef.current !== storySeqAtStart;

    try {
      const result = await execute({
        signal: controller.signal,
        onReasoningDelta: (delta) => {
          if (!isStale()) {
            setStreamReasoning((prev) => prev + delta);
          }
        },
        onContentDelta: (delta) => {
          if (!isStale()) {
            setStreamContent((prev) => prev + delta);
          }
        },
      });
      if (isStale()) {
        return;
      }
      setReasoningDurations((durations) => ({
        ...durations,
        [result.assistantNode.id]: Math.max(1, Math.round((performance.now() - streamStartedAt) / 1000)),
      }));
      setStreamingNodeId(result.assistantNode.id);
      setStory(result.story);
      await refreshStories();
      if (!isStale()) {
        setStreamReasoning('');
        setStreamContent('');
      }
    } catch (err) {
      if (suppressedAbortRef.current.has(controller) || storyOpSeqRef.current !== storySeqAtStart) {
        return;
      }
      if (isAbortError(err)) {
        setErrorMsg('已中止本次生成。');
      } else {
        setErrorMsg(toErrorMessage(err, '生成失败，请检查模型端点与配置。'));
      }
      onErrorRestore?.();
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
        setStreamingNodeId(null);
      }
    }
  };

  const runStoryTransition = async (
    transition: () => Promise<Story>,
    fallbackError: string,
    opts?: {
      blockBusy?: boolean;
      trackSummarizing?: boolean;
      preserveSummaryTask?: boolean;
      allowBranchSwitch?: boolean;
      mergeWithLatest?: (latestStory: Story | null, transitionedStory: Story) => Story | null;
    },
  ): Promise<Story | null> => {
    if (
      branchSwitchBusyRef.current &&
      !opts?.allowBranchSwitch &&
      !(opts?.preserveSummaryTask && !branchSwitchTransitionRef.current)
    ) {
      return null;
    }
    if (opts?.blockBusy !== false && (abortRef.current || isStreaming || isSummarizing)) {
      return null;
    }
    const opSeq = ++storyOpSeqRef.current;
    const summarySeq = opts?.preserveSummaryTask ? summarySeqRef.current : ++summarySeqRef.current;
    setErrorMsg(null);
    if (opts?.trackSummarizing) {
      setIsSummarizing(true);
      setIsSummaryComputationInProgress(false);
      setIsBranchSwitchSummarizing(false);
    } else if (!opts?.preserveSummaryTask) {
      setIsSummarizing(false);
      setIsSummaryComputationInProgress(false);
      setIsBranchSwitchSummarizing(false);
    }
    try {
      const updated = await transition();
      if (storyOpSeqRef.current !== opSeq) return null;
      if (opts?.mergeWithLatest) {
        return await enqueueStoryCommit((latest) =>
          storyOpSeqRef.current === opSeq
            ? opts.mergeWithLatest!(latest, updated)
            : null,
        );
      }
      await commitStoryState(updated);
      return updated;
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, fallbackError));
      }
      return null;
    } finally {
      if (opts?.trackSummarizing && summarySeqRef.current === summarySeq) {
        setIsSummarizing(false);
      }
    }
  };

  const hasCredentials = hasModelCredentials(config, useDevEnvKey);
  const useDevProxyForSetup = import.meta.env.DEV && isWebDev && isDevProxyBaseUrl(config.baseUrl);

  const openByokPrompt = (
    label: string,
    resume: (resolvedConfig: ModelConfig) => void,
    onCancel?: () => void,
  ) => {
    wizardReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    wizardCloseReasonRef.current = null;
    setPendingByok({ label, resume, onCancel });
    setWizardMounted(true);
    setWizardOpen(true);
  };

  const openSetupWizard = () => {
    wizardReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    wizardCloseReasonRef.current = null;
    setPendingByok(null);
    setWizardMounted(true);
    setWizardOpen(true);
  };

  const finishWizardExit = () => {
    setWizardMounted(false);
    const preferred = wizardCloseReasonRef.current === 'success'
      ? document.querySelector<HTMLElement>('[data-testid="change-key-btn"]')
      : wizardReturnFocusRef.current;
    wizardCloseReasonRef.current = null;
    wizardReturnFocusRef.current = null;
    window.requestAnimationFrame(() => preferred?.focus());
  };

  const handleClearSavedKey = () => {
    const cleared = normalizeOfficialModelConfig({ ...config, apiKey: '' });
    updateConfig(cleared, false);
  };

  const openImportView = (mode: ImportMode) => {
    if (branchSwitchBusyRef.current) return;
    captureOverlayTrigger();
    abortActiveStream(true);
    setShowSettings(false);
    setStoryTreeOpen(false);
    setMobileLibraryOpen(false);
    setImportMode(mode);
    setImportResetKey((k) => k + 1);
    setShowImport(true);
  };

  const openSettings = () => {
    if (branchSwitchBusyRef.current) return;
    captureOverlayTrigger();
    setShowImport(false);
    setMobileLibraryOpen(false);
    setStoryTreeOpen(false);
    setShowSettings(true);
  };

  const toggleLibraryCollapsed = () => {
    setLibraryCollapsed((collapsed) => !collapsed);
  };

  const withCredentials = (
    label: string,
    action: (resolvedConfig: ModelConfig) => void,
    overrideConfig?: ModelConfig,
  ) => {
    const activeCfg = overrideConfig ?? config;
    if (!overrideConfig && !hasCredentials) {
      openByokPrompt(label, (resolved) => action(resolved));
      return;
    }
    action(activeCfg);
  };

  const sendAction = (
    userPrompt: string,
    restoreOnError = false,
    overrideConfig?: ModelConfig,
  ) => {
    const trimmed = userPrompt.trim();
    if (
      !trimmed ||
      branchSwitchBusyRef.current ||
      abortRef.current ||
      isStreaming ||
      isSummarizing
    ) return;
    withCredentials(
      '发送下一轮行动并继续故事',
      (activeCfg) => {
        if (branchSwitchBusyRef.current) return;
        if (restoreOnError) {
          setInput('');
        }
        void runStreamingExecution(
          (callbacks) => harness.runTurn(story, trimmed, activeCfg, callbacks),
          restoreOnError
            ? () => setInput((current) =>
              current.length === 0 || current === trimmed ? trimmed : current,
            )
            : undefined,
        );
      },
      overrideConfig,
    );
  };

  const handleEditAndBranch = (
    targetUserNodeId: string,
    newContent: string,
    overrideConfig?: ModelConfig,
  ) => {
    const trimmed = newContent.trim();
    if (!trimmed || branchSwitchBusyRef.current || isSummarizing) return;
    withCredentials(
      '编辑行动并生成新分支',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.editAndBranch(story, targetUserNodeId, trimmed, activeCfg, callbacks),
        );
      },
      overrideConfig,
    );
  };

  const handleRegenerateNode = (
    targetAssistantNodeId: string,
    overrideConfig?: ModelConfig,
  ) => {
    if (branchSwitchBusyRef.current || isSummarizing) return;
    withCredentials(
      '重新生成分支回复',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.regenerateNode(story, targetAssistantNodeId, activeCfg, callbacks),
        );
      },
      overrideConfig,
    );
  };

  const runBackgroundSummary = async (
    targetStory: Story,
    targetLeafId: string,
    activeCfg: ModelConfig,
    fallbackError: string,
    allowRenameDuringSummary = false,
  ) => {
    const summarySeq = ++summarySeqRef.current;
    setIsSummarizing(true);
    setIsSummaryComputationInProgress(!allowRenameDuringSummary);
    setIsBranchSwitchSummarizing(allowRenameDuringSummary);
    try {
      const summarized = await harness.calculateActiveBranchSummary(targetStory, activeCfg);
      if (summarySeqRef.current !== summarySeq) return;
      await enqueueStoryCommit((latest) =>
        summarySeqRef.current === summarySeq && latest
          ? mergeBranchSummaryResult(latest, summarized, targetLeafId)
          : null,
      );
    } catch (err) {
      if (summarySeqRef.current === summarySeq) {
        setErrorMsg(toErrorMessage(err, fallbackError));
      }
    } finally {
      if (summarySeqRef.current === summarySeq) {
        setIsSummarizing(false);
        setIsSummaryComputationInProgress(false);
        setIsBranchSwitchSummarizing(false);
      }
    }
  };

  const handleSwitchBranch = async (targetNodeId: string) => {
    if (branchSwitchBusyRef.current || abortRef.current || isStreaming || isSummarizing) return;
    branchSwitchBusyRef.current = true;
    branchSwitchTransitionRef.current = true;
    setIsBranchSwitching(true);
    const switchStartedAt = Date.now();
    try {
      const switched = await runStoryTransition(
        () => harness.switchBranch(storyRef.current!, targetNodeId),
        '切换分支失败。',
        { allowBranchSwitch: true },
      );
      // The story commit is complete. Branch renaming may now use the existing
      // exception while an automatic post-switch summary runs.
      branchSwitchTransitionRef.current = false;
      setIsBranchSwitching(false);
      runtime.diagnostics.recordEvent({
        level: switched ? 'info' : 'warn',
        category: 'branch',
        action: switched ? 'switch_branch' : 'switch_branch_failed',
        durationMs: Date.now() - switchStartedAt,
      });
      const targetLeafId = switched?.activeLeafNodeId ?? null;
      if (
        switched &&
        targetLeafId &&
        computeActiveReviewState(switched).needsSummaryCompression &&
        hasModelCredentials(config, useDevEnvKey)
      ) {
        await runBackgroundSummary(
          switched,
          targetLeafId,
          config,
          '补算支线剧情摘要失败，可稍后重试。',
          true,
        );
      }
    } finally {
      branchSwitchTransitionRef.current = false;
      branchSwitchBusyRef.current = false;
      setIsBranchSwitching(false);
    }
  };

  const handleRenameBranch = async (branchEntryNodeId: string, name: string) => {
    if (branchSwitchTransitionRef.current) return;
    await runStoryTransition(
      async () =>
        harness.calculateBranchRename(storyRef.current!, branchEntryNodeId, name),
      '重命名分支失败。',
      {
        blockBusy: false,
        preserveSummaryTask: true,
        mergeWithLatest: (latest, renamed) =>
          latest ? mergeBranchRenameResult(latest, renamed, branchEntryNodeId) : null,
      },
    );
  };

  const handleExtractBranchGist = (
    branchEntryNodeId: string,
    overrideConfig?: ModelConfig,
  ) => {
    if (branchSwitchBusyRef.current) return;
    withCredentials(
      'AI 提炼分支梗概',
      (activeCfg) => {
        void runStoryTransition(
          () => harness.extractBranchGist(story, branchEntryNodeId, activeCfg),
          '提炼分支梗概失败。',
          { trackSummarizing: true },
        );
      },
      overrideConfig,
    );
  };

  const handleComputeActiveSummary = (overrideConfig?: ModelConfig) => {
    if (branchSwitchBusyRef.current) return;
    withCredentials(
      '补算当前支线剧情摘要',
      (activeCfg) => {
        const current = storyRef.current;
        const targetLeafId = current?.activeLeafNodeId ?? null;
        if (!current || !targetLeafId) return;
        setErrorMsg(null);
        void runBackgroundSummary(current, targetLeafId, activeCfg, '补算剧情摘要失败。');
      },
      overrideConfig,
    );
  };

  const handleReextractBlueprint = (overrideConfig?: ModelConfig) => {
    if (branchSwitchBusyRef.current) return;
    if (!story.rawScript.trim()) return;
    withCredentials(
      '补拆故事蓝图',
      (activeCfg) => {
        setIsBlueprintReextracting(true);
        void runStoryTransition(
          async () => {
            const extracted = await harness.extractStoryBlueprint(
              story.rawScript,
              activeCfg,
              story.title,
            );
            return harness.updateStoryBlueprint(story, extracted);
          },
          '补拆故事蓝图失败。',
          { trackSummarizing: true },
        ).finally(() => setIsBlueprintReextracting(false));
      },
      overrideConfig,
    );
  };

  const handleRewindToNode = (targetNodeId: string) =>
    runStoryTransition(() => harness.rewindToNode(story, targetNodeId), '回溯节点失败。');

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendAction(input, true);
  };

  const startFirstAct = (targetStory: Story, overrideConfig?: ModelConfig) => {
    withCredentials(
      '开启第一幕',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.runTurn(targetStory, FIRST_ACT_PROMPT, activeCfg, callbacks),
        );
      },
      overrideConfig,
    );
  };

  const handleConfirmImportedStory = async (imported: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => {
    if (branchSwitchBusyRef.current) return;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const created = await harness.createAndSaveStory({
        ...imported,
        sourceKind: 'manual_script',
      });
      if (storyOpSeqRef.current !== opSeq) return;
      await commitStoryState(created);
      setShowImport(false);
      setShowSettings(false);
      startFirstAct(created);
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '保存导入故事失败。'));
      }
    }
  };

  const handleImportDeepSeekBatch = async (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptRangeOverrides: Record<string, ScriptTurnRange>,
  ): Promise<DeepSeekImportBatchResult> => {
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    const result = await importDeepSeekSessions(zipBytes, selectedSessionIds, harness, {
      scriptRangeOverrides,
      modelConfig: hasCredentials ? config : undefined,
    });
    if (storyOpSeqRef.current === opSeq && result.stories[0]) {
      await commitStoryState(result.stories[0]);
    }
    return result;
  };

  const handleContinueImportedStory = async (storyId: string) => {
    if (branchSwitchBusyRef.current) return;
    await handleSelectStory(storyId);
    setShowImport(false);
    setShowSettings(false);
  };

  const handleSelectStory = async (id: string) => {
    if (branchSwitchBusyRef.current) return;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const switched = await harness.setActiveStory(id);
      if (storyOpSeqRef.current !== opSeq) return;
      if (switched) {
        storyRef.current = switched;
        setStory(switched);
        setShowImport(false);
        setShowSettings(false);
        setMobileLibraryOpen(false);
      }
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '切换故事失败。'));
      }
    }
  };

  const handleRenameStory = async (id: string, title: string) => {
    if (branchSwitchBusyRef.current) return;
    setErrorMsg(null);
    try {
      const updated = await harness.renameStory(id, title);
      if (updated) {
        setStory((prev) => (prev.id === id ? updated : prev));
        await refreshStories();
      }
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '重命名故事失败。'));
    }
  };

  const handleDeleteStory = async (id: string) => {
    if (branchSwitchBusyRef.current) return;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    const deletedActiveStory = story.id === id;
    setErrorMsg(null);
    try {
      await harness.deleteStory(id);
      if (storyOpSeqRef.current !== opSeq) return;
      const remaining = await refreshStories();
      if (storyOpSeqRef.current !== opSeq) return;
      if (deletedActiveStory) {
        const next = remaining[0] ?? harness.createStory({ title: '新故事' });
        setStory(next);
        if (remaining[0]) {
          await harness.setActiveStory(remaining[0].id);
        }
      }
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '删除故事失败。'));
      }
    }
  };

  const handleSaveBlueprintTweak = async (updatedBlueprint: StoryBlueprint): Promise<boolean> => {
    setErrorMsg(null);
    const opSeq = storyOpSeqRef.current;
    try {
      const updated = await harness.updateStoryBlueprint(story, updatedBlueprint);
      if (storyOpSeqRef.current !== opSeq) return false;
      setStory(updated);
      await refreshStories();
      return true;
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '保存蓝图微调失败。'));
      }
      return false;
    }
  };

  const handleExportBackup = async (storyId: string) => {
    setErrorMsg(null);
    try {
      const targetStory = stories.find((item) => item.id === storyId) ?? (story.id === storyId ? story : null);
      if (!targetStory) return;
      const json = exportStoryBackup(targetStory);
      const fileName = `${targetStory.title.replace(/[\\/:*?"<>|]+/g, '_') || 'story'}.lfh.json`;
      await runtime.backupExporter.exportJsonFile(fileName, json);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '导出 JSON 备份失败。'));
    }
  };

  const handleImportBackupFile = async (file: File) => {
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const jsonText = await file.text();
      if (storyOpSeqRef.current !== opSeq) return;
      const existing = await harness.listStories();
      if (storyOpSeqRef.current !== opSeq) return;
      const restored = importStoryBackup(
        jsonText,
        existing.map((s) => s.id),
      );
      await harness.saveStory(restored);
      await harness.setActiveStory(restored.id);
      if (storyOpSeqRef.current !== opSeq) return;
      await commitStoryState(restored);
      setShowImport(false);
      setShowSettings(false);
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '导入 JSON 备份失败。'));
      }
    }
  };

  const storyExists =
    stories.some((item) => item.id === story.id) ||
    Boolean(story.rawScript.trim()) ||
    activeNodes.length > 0;
  const isWelcome = !storyExists;
  const reviewState = computeActiveReviewState(story);
  const branchLabel = reviewState.activeBranchLabel === '当前主干路线'
    ? '主线'
    : reviewState.activeBranchLabel;
  const forkCount = projectStoryTreeSpine(story).forkCount;
  const activeLeafNode = story.activeLeafNodeId ? story.nodes[story.activeLeafNodeId] : undefined;
  const latestTurnNodeIds = new Set(
    [
      activeLeafNode?.id,
      activeLeafNode?.role === 'assistant' ? activeLeafNode.parentId : null,
    ].filter((id): id is string => Boolean(id)),
  );
  const isCommittedStreamingReply =
    isStreaming &&
    activeLeafNode?.role === 'assistant' &&
    activeLeafNode.content === streamContent;

  return (
    <div className="app-root">
      {!showImport && !showSettings && (
        <TopBar
          title={storyExists ? story.title : '本地文游播放器'}
          hasStory={storyExists}
          branchLabel={branchLabel}
          forkCount={forkCount}
          isSummaryInProgress={isSummaryInProgress}
          libraryCollapsed={libraryCollapsed}
          onOpenLibrary={() => setMobileLibraryOpen(true)}
          onToggleLibrary={toggleLibraryCollapsed}
          onOpenStoryTree={() => setStoryTreeOpen(true)}
        />
      )}

      <div
        className={`app-workspace ${libraryCollapsed ? 'is-library-collapsed' : ''} ${showImport || showSettings ? 'is-overlay' : ''}`}
        data-testid="app-workspace"
      >
        <LibraryDrawer
          stories={stories}
          activeStoryId={story.id}
          collapsed={libraryCollapsed}
          mobileOpen={mobileLibraryOpen && !showImport && !showSettings}
          hasCredentials={hasCredentials}
          onClose={() => setMobileLibraryOpen(false)}
          onOpenSettings={openSettings}
          onStartDeepSeekImport={() => openImportView('deepseek')}
          onStartScriptImport={() => openImportView('script')}
          onSelectStory={(id) => void handleSelectStory(id)}
          onRenameStory={(id, title) => void handleRenameStory(id, title)}
          onDeleteStory={(id) => void handleDeleteStory(id)}
          onExportStoryBackup={(id) => void handleExportBackup(id)}
        />

        <main
          ref={mainStageRef}
          className={`main-stage${storyExists && !showSettings && !showImport ? ' is-playing' : ''}`}
          data-testid="main-stage"
          {...edgeSwipeHandlers}
          onScroll={handleMainStageScroll}
          onWheelCapture={(event) => {
            if (event.deltaY !== 0) markMainStageScrollIntent(event.target);
          }}
          onTouchMoveCapture={(event) => markMainStageScrollIntent(event.target)}
          onKeyDownCapture={(event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
              markMainStageScrollIntent(event.target);
            }
          }}
        >
          {errorMsg && (showSettings || showImport || isWelcome) && (
            <BannerAlert tone="danger" testId="main-error-banner">
              <span>{errorMsg}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openDiagnostics('error_banner')}
              >
                打包排障日志
              </button>
            </BannerAlert>
          )}

          {showSettings ? (
            <SettingsPage
              appVersion={APP_VERSION}
              hasCredentials={hasCredentials}
              config={config}
              useDevEnvKey={useDevEnvKey}
              showDevTestProxy={import.meta.env.DEV && isWebDev && Boolean(devTestInfo?.available)}
              themePreference={displayPreferences.theme}
              fontSize={displayPreferences.fontSize}
              canExportCurrentStory={storyExists}
              currentStoryTitle={story.title}
              onBack={() => setShowSettings(false)}
              onOpenSetupWizard={openSetupWizard}
              onClearSavedKey={handleClearSavedKey}
              onApplyDevTestConfig={applyDevTestConfig}
              onOpenDiagnostics={() => openDiagnostics('settings_manual')}
              onExportCurrentStory={() => void handleExportBackup(story.id)}
              onImportBackupFile={(file) => void handleImportBackupFile(file)}
              onThemePreferenceChange={setThemePreference}
              onFontSizeChange={setDisplayFontSize}
            />
          ) : showImport ? (
            <ImportPanel
              initialMode={importMode}
              resetKey={importResetKey}
              config={config}
              transport={runtime.transport}
              binaryDownloader={runtime.binaryDownloader}
              hasCredentials={hasCredentials}
              byokOpen={wizardOpen}
              onRequireByok={openByokPrompt}
              extractBlueprint={(raw, cfg, title, signal) =>
                harness.extractStoryBlueprint(raw, cfg, title, signal)
              }
              onConfirmStory={handleConfirmImportedStory}
              onImportDeepSeekBatch={handleImportDeepSeekBatch}
              diagnostics={runtime.diagnostics}
              onPackageDiagnostics={() => openDiagnostics('error_banner')}
              onContinueStory={(storyId) => void handleContinueImportedStory(storyId)}
              onCancel={() => setShowImport(false)}
            />
          ) : (
            <>
              {isWelcome ? (
                <WelcomeView
                  stories={stories}
                  onStartDeepSeekImport={() => openImportView('deepseek')}
                  onStartScriptImport={() => openImportView('script')}
                  onSelectStory={(id) => void handleSelectStory(id)}
                />
              ) : (
                <>
                  <section className="timeline" data-testid="story-timeline" aria-label="故事对话记录">
                    {activeNodes.length === 0 && !isStreaming && (
                      <div className="turn-card empty-story-card">
                        <div className="turn-role">开场引导</div>
                        <div className="turn-body">
                          {story.blueprint.openingHook
                            ? story.blueprint.openingHook
                            : '可从「从 DeepSeek 继续」导入长对话存档，或点击「导入剧本 / 新建故事」载入自由格式剧本后开始演绎。'}
                        </div>
                        {!story.blueprint.openingHook && (
                          <div className="btn-group" style={{ marginTop: '0.75rem' }}>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => openImportView('deepseek')}
                            >
                              从 DeepSeek 继续（.zip）
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => openImportView('script')}
                            >
                              导入自由剧本
                            </button>
                          </div>
                        )}
                        {story.blueprint.openingHook && (
                          <div className="composer-actions" style={{ marginTop: '0.75rem' }}>
                            <span className="status-text">已保留原始剧本全文锚定</span>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => startFirstAct(story)}
                            >
                              开启第一幕
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {activeNodes.map((node, index) => {
                      const parentNode =
                        node.role === 'assistant' && node.parentId
                          ? story.nodes[node.parentId]
                          : undefined;
                      const editableUserNode = parentNode?.role === 'user' ? parentNode : undefined;
                      return (
                        <TurnCard
                          key={node.id}
                          node={node}
                          isActiveLeaf={node.id === story.activeLeafNodeId}
                          isLatestTurn={latestTurnNodeIds.has(node.id)}
                          isSetupNode={story.setupNodeIds?.includes(node.id) ?? false}
                          turnNumber={Math.max(1, Math.ceil((index + 1) / 2))}
                          reasoningDurationSeconds={reasoningDurations[node.id]}
                          editableUserNode={editableUserNode}
                          isBusy={isStreaming || isSummarizing || isBranchSwitching}
                          isStreaming={streamingNodeId === node.id}
                          siblings={getSiblingBranchInfo(story, node.id)}
                          onSelectChoice={(choiceText) => void sendAction(choiceText)}
                          onSwitchBranch={(targetId) => void handleSwitchBranch(targetId)}
                          onEditAndBranch={(nodeId, text) => void handleEditAndBranch(nodeId, text)}
                          onRegenerate={(nodeId) => void handleRegenerateNode(nodeId)}
                          onRewindToNode={(nodeId) => void handleRewindToNode(nodeId)}
                        />
                      );
                    })}

                    {isStreaming && !isCommittedStreamingReply && (
                      <article className="turn-card assistant turn-streaming" data-testid="turn-assistant" aria-live="polite">
                        <div className="turn-role">叙事 AI（生成中…）</div>
                        {streamReasoning && (
                          <details className="reasoning-details" data-testid="reasoning-details" open>
                            <summary data-testid="reasoning-toggle">
                              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                              <span>思考中…</span>
                            </summary>
                            <div className="reasoning-content">{streamReasoning}</div>
                          </details>
                        )}
                        {streamContent ? (
                          <MessageContent content={streamContent} />
                        ) : (
                          <div className="turn-body">正在等待响应…</div>
                        )}
                      </article>
                    )}
                  </section>

                </>
              )}

              <form className="composer" data-testid="stage-composer" onSubmit={handleSubmit}>
                {errorMsg && !showSettings && !showImport && !isWelcome && (
                  <BannerAlert tone="danger" testId="main-error-banner">
                    <span>{errorMsg}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openDiagnostics('error_banner')}
                    >
                      打包排障日志
                    </button>
                  </BannerAlert>
                )}
                {showScrollToBottom && (
                  <button
                    type="button"
                    className="scroll-to-bottom"
                    data-testid="scroll-to-bottom"
                    onClick={handleScrollToBottom}
                  >
                    回到底部 ↓
                  </button>
                )}
                <label className="visually-hidden" htmlFor="turn-input">输入你的行动或对话</label>
                <textarea
                  id="turn-input"
                  name="playerInput"
                  rows={1}
                  value={input}
                  placeholder={isWelcome
                    ? '导入故事后即可开始行动…'
                    : '输入你的抉择、对话或行动（Enter 发送，Shift+Enter 换行）…'}
                  disabled={isWelcome}
                  onChange={(event) => {
                    const textarea = event.currentTarget;
                    setInput(textarea.value);
                    if (!CSS.supports('field-sizing', 'content')) {
                      textarea.style.height = 'auto';
                      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      event.nativeEvent.keyCode !== 229
                    ) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
                <div className="composer-actions">
                  <span className="status-text">
                    {isWelcome ? '先导入一部故事，再开始游玩' : `已保存轮次：${Math.floor(activeNodes.length / 2)}`}
                  </span>
                  <div>
                    {isStreaming ? (
                      <button
                        key="stop-generation-btn"
                        type="button"
                        className="btn composer-send"
                        aria-label="停止生成"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          abortRef.current?.abort();
                        }}
                      >
                        <Square size={17} strokeWidth={1.75} aria-hidden="true" />
                        <span className="visually-hidden">停止生成</span>
                      </button>
                    ) : (
                      <button
                        key="send-action-btn"
                        type="submit"
                        className="btn btn-primary composer-send"
                        aria-label="发送行动"
                        disabled={!input.trim() || isSummarizing || isBranchSwitching || isWelcome}
                      >
                        <ArrowUp size={19} strokeWidth={1.75} aria-hidden="true" />
                        <span className="visually-hidden">发送行动</span>
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </>
          )}

          {wizardMounted && (
            <DeepSeekSetupWizard
              open={wizardOpen}
              initialKey={config.apiKey}
              pendingLabel={pendingByok?.label ?? null}
              verifyUrlBase={
                useDevProxyForSetup ? config.baseUrl : DEFAULT_MODEL_CONFIG.baseUrl
              }
              onComplete={(verifiedKey) => {
                const nextCfg: ModelConfig = useDevProxyForSetup
                  ? { ...config, apiKey: verifiedKey, memoryOnly: false }
                  : normalizeOfficialModelConfig({ ...config, apiKey: verifiedKey });
                const resume = pendingByok?.resume;
                wizardCloseReasonRef.current = 'success';
                setPendingByok(null);
                setWizardOpen(false);
                updateConfig(nextCfg, false);
                if (resume) resume(nextCfg);
              }}
              onVerifyingChange={setWizardVerifying}
              onExitComplete={finishWizardExit}
              onCancel={() => {
                const cancel = pendingByok?.onCancel;
                wizardCloseReasonRef.current = 'cancel';
                setPendingByok(null);
                setWizardOpen(false);
                cancel?.();
              }}
            />
          )}
        </main>
      </div>

      {diagnosticsMounted && (
        <DiagnosticsPreview
          key={diagnosticsRevision}
          open={diagnosticsOpen}
          buildBundle={() => buildDiagnosticBundle(diagnosticTrigger)}
          onExport={(fileName, json) => runtime.backupExporter.exportJsonFile(fileName, json)}
          onReload={() => window.location.reload()}
          onClose={closeDiagnostics}
          onExitComplete={finishDiagnosticsExit}
        />
      )}

      <CompanionSheet
        open={storyTreeOpen && storyExists && !showImport && !showSettings}
        story={story}
        summarySnapshot={activeSummary}
        metrics={contextPreview.metrics}
        hasCredentials={hasCredentials}
        isStreaming={isStreaming}
        isSummarizing={isSummarizing}
        isSummaryInProgress={isSummaryInProgress}
        isBlueprintReextracting={isBlueprintReextracting}
        isBranchSwitchSummarizing={isBranchSwitchSummarizing}
        onSwitchBranch={(id) => void handleSwitchBranch(id)}
        onRenameBranch={handleRenameBranch}
        onExtractBranchGist={handleExtractBranchGist}
        onComputeSummary={() => void handleComputeActiveSummary()}
        onSaveBlueprintTweak={handleSaveBlueprintTweak}
        onReextractBlueprint={() => handleReextractBlueprint()}
        isBranchSwitching={isBranchSwitching}
        onClose={() => setStoryTreeOpen(false)}
      />
    </div>
  );
}
