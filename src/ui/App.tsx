import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, FilePlus2, PenLine, Plus, Sparkles, Square } from 'lucide-react';
import {
  DEFAULT_MODEL_CONFIG,
  EMPTY_SUMMARY_SNAPSHOT,
  buildTurnProposalRecords,
  computeActiveReviewState,
  conversationExport,
  convertActiveAssetMode,
  createAsyncModelConfigStore,
  createDefaultBlueprint,
  createDefaultId,
  createFictionHarness,
  detectNaturalModeSwitchIntent,
  documentLineage,
  documentVersion,
  editStoryDocument,
  emptyWorkspace,
  exportFolioBackupV3,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getSiblingBranchInfo,
  importDeepSeekSessions,
  isAbortError,
  materializeAssetFromNodes,
  mergeRestoredBackup,
  migrateStoryDocuments,
  migrateStoryToV02,
  newDocument,
  newWork,
  normalizeOfficialDeepSeekModel,
  normalizeOfficialModelConfig,
  normalizeProposalTarget,
  normalizeReasoningEffort,
  parseAndValidateFolioBackup,
  projectStoryTreeSpine,
  resolveEffectiveModelConfig,
  routeEntryMessage,
  storyDocumentState,
  storyExportMarkdown,
  writeDocument,
  type DeepSeekImportBatchResult,
  type DiagnosticActiveView,
  type DiagnosticBundleTrigger,
  type ModelConfig,
  type PlatformRuntime,
  type ScriptTurnRange,
  type StageAssetMode,
  type Story,
  type StoryDocuments,
  type TurnCallbacks,
  type TurnExecutionResult,
  type TurnNode,
  type TurnProposalRecord,
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
import { useAppAsyncError } from './AppErrorBoundary.tsx';
import { CompanionSheet } from './CompanionSheet.tsx';
import { CreativeWorkspace } from './CreativeWorkspace.tsx';
import { DeepSeekSetupWizard } from './DeepSeekSetupWizard.tsx';
import { DiagnosticsPreview } from './DiagnosticsPreview.tsx';
import { DocumentDialog, type DocumentEdit } from './DocumentDialog.tsx';
import { ImportPanel, type ImportMode } from './ImportPanel.tsx';
import { LibraryDrawer } from './LibraryDrawer.tsx';
import { MarkdownView } from './MarkdownView.tsx';
import { MessageContent } from './MessageContent.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { TopBar } from './TopBar.tsx';
import { TurnCard, type ResolvedProposalTargetState } from './TurnCard.tsx';
import { WelcomeView } from './WelcomeView.tsx';
import { setCrashDiagnosticBundleBuilder } from './crashDiagnosticContext.ts';
import type { DisplayFontSize, DisplayThemePreference } from './displayPreferences.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import {
  createDerivedAssetInWorkspace,
  recordProposalCreationBreadcrumbs,
  recordProposalDiagnostic,
  revertDocumentToVersion,
  updateTurnNodeProposal,
} from './proposalActions.ts';
import { mergeBranchRenameResult } from './storyConcurrency.ts';
import { toErrorMessage } from './textHelpers.ts';
import { useAppOverlayHistory } from './useAppOverlayHistory.ts';
import { useAutoScrollTimeline } from './useAutoScrollTimeline.ts';
import { useCreativeWorkspace } from './useCreativeWorkspace.ts';
import { useDisplayPreferences } from './useDisplayPreferences.ts';
import { useEdgeSwipeToOpen } from './useEdgeSwipeToOpen.ts';
import { useLibraryCollapsedPreference } from './useLibraryCollapsedPreference.ts';
import { usePresentationOverlayState } from './usePresentationOverlayState.ts';

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
          model: devProxy.model ?? normalizeOfficialDeepSeekModel(loaded.model),
          reasoningEffort: normalizeReasoningEffort(loaded.reasoningEffort),
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

function detectEnvironmentVersions(): { osVersion?: string; webviewVersion?: string } {
  if (typeof navigator === 'undefined') return {};
  const ua = navigator.userAgent;
  const androidMatch = /Android\s+([0-9.]+)/i.exec(ua);
  const iosMatch = /OS\s+([0-9_]+)\s+like\s+Mac/i.exec(ua);
  const macMatch = /Mac\s+OS\s+X\s+([0-9_]+)/i.exec(ua);
  const chromeMatch = /(?:Chrome|CriOS|Edg)\/([0-9.]+)/i.exec(ua);
  const safariMatch = /Version\/([0-9.]+)\s+Safari/i.exec(ua);
  const osVersion = androidMatch
    ? `Android ${androidMatch[1]}`
    : iosMatch
      ? `iOS ${iosMatch[1].replaceAll('_', '.')}`
      : macMatch
        ? `macOS ${macMatch[1].replaceAll('_', '.')}`
        : undefined;
  const webviewVersion = chromeMatch
    ? `Chromium/${chromeMatch[1]}`
    : safariMatch
      ? `Safari/${safariMatch[1]}`
      : undefined;
  return {
    ...(osVersion ? { osVersion } : {}),
    ...(webviewVersion ? { webviewVersion } : {}),
  };
}

export interface AppProps {
  runtime: PlatformRuntime;
}

export function App({ runtime }: AppProps) {
  const isWebDev = runtime.platform === 'web' && import.meta.env.DEV;
  const creative = useCreativeWorkspace(runtime.creativeStorage);
  const [creativePage, setCreativePage] = useState<'writing' | 'character' | null>(null);
  const [newCreationOpen, setNewCreationOpen] = useState(false);
  const [neutralTurns, setNeutralTurns] = useState<TurnNode[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [writingView, setWritingView] = useState<{ id: string; manuscript: boolean } | null>(null);
  const [initialCreativeTurn, setInitialCreativeTurn] = useState<{ id: string; prompt: string } | null>(null);
  const creationPending = useRef(false);
  const focusNewCreation = useRef(false);
  const [creating, setCreating] = useState(false);
  const [creativeCompanionOpen, setCreativeCompanionOpen] = useState(false);
  const [documentEdit, setDocumentEdit] = useState<DocumentEdit | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [createdAssetNotice, setCreatedAssetNotice] = useState<{
    kind: 'character' | 'work';
    id: string;
    label: string;
  } | null>(null);
  const { asyncError, dismissAsyncError } = useAppAsyncError();

  const configStore = useMemo(
    () => createAsyncModelConfigStore(runtime.secretStore),
    [runtime],
  );
  const harness = useMemo(
    () =>
      createFictionHarness({
        transport: runtime.transport,
        storage: runtime.storyStorage,
        loadPublicDocument: async () => (await runtime.creativeStorage?.load())?.publicDocument ?? emptyWorkspace().publicDocument,
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
  const deepSeekImportBusyRef = useRef(false);
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
  const [isBranchSwitching, setIsBranchSwitching] = useState(false);
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [streamingNodeId, setStreamingNodeId] = useState<string | null>(null);
  const [reasoningDurations, setReasoningDurations] = useState<Record<string, number>>({});
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
  const overlayNavigationSeqRef = useRef(0);
  const summarySeqRef = useRef(0);
  const storyCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const storyRef = useRef<Story | null>(story);
  storyRef.current = story;
  const branchSwitchBusyRef = useRef(false);
  const branchSwitchTransitionRef = useRef(false);
  const configEditSeqRef = useRef(0);
  const configSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const suppressedAbortRef = useRef<WeakSet<AbortController>>(new WeakSet());

  const isNavigationCurrent = (storySeq: number, overlaySeq: number) =>
    storyOpSeqRef.current === storySeq && overlayNavigationSeqRef.current === overlaySeq;
  const edgeSwipeHandlers = useEdgeSwipeToOpen(
    !showImport && !showSettings && !mobileLibraryOpen,
    () => setMobileLibraryOpen(true),
  );

  useEffect(() => {
    if (!plusMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.composer-plus-wrap')) {
        setPlusMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlusMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [plusMenuOpen]);

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

  const activeNodes = getActiveBranchNodes(story);
  const storyExists =
    stories.some((item) => item.id === story.id) ||
    Boolean(story.rawScript.trim()) ||
    activeNodes.length > 0;
  const isWelcome = !creativePage && (newCreationOpen || !storyExists);

  const currentActiveView: DiagnosticActiveView = showSettings
    ? 'settings'
    : showImport
      ? 'import'
      : creativePage === 'writing'
        ? 'writing'
        : creativePage === 'character'
          ? 'character'
          : isWelcome
            ? 'welcome'
            : 'story';

  const buildDiagnosticBundle = useCallback(
    (trigger: DiagnosticBundleTrigger, extra?: { userNote?: string }) => {
      const envVersions = detectEnvironmentVersions();
      return runtime.diagnostics.buildBundle(
        {
          ...config,
          isDevProxy: import.meta.env.DEV && isDevProxyBaseUrl(config.baseUrl),
        },
        {
          trigger,
          ...(extra?.userNote ? { userNote: extra.userNote } : {}),
          ...(storyExists && !isWelcome ? { activeStory: story } : {}),
          workspace: {
            stories,
            creativeWorkspace: creative.workspace,
          },
          appEnv: {
            appVersion: APP_VERSION,
            ...envVersions,
            theme: displayPreferences.theme,
            viewport:
              typeof window === 'undefined'
                ? 'unknown'
                : `${window.innerWidth}x${window.innerHeight}`,
            activeView: currentActiveView,
            storyCount: stories.length,
            workCount: creative.workspace.works.length,
            characterCount: creative.workspace.characters.length,
          },
        },
      );
    },
    [
      runtime,
      config,
      story,
      storyExists,
      isWelcome,
      stories,
      creative.workspace,
      displayPreferences.theme,
      currentActiveView,
    ],
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
    const rawList = await harness.listStories();
    const list = rawList.map(migrateStoryToV02);
    setStories(list);
    return list;
  }, [harness]);

  const commitStoryState = useCallback(
    async (nextStory: Story) => {
      const migrated = migrateStoryToV02(nextStory);
      storyRef.current = migrated;
      setStory(migrated);
      await refreshStories();
    },
    [refreshStories],
  );

  const enqueueStoryCommit = useCallback(
    (merge: (latestStory: Story | null) => Story | null): Promise<Story | null> => {
      const commit = storyCommitQueueRef.current.then(async () => {
        const selected = storyRef.current;
        const saved = selected ? await runtime.storyStorage.getStory(selected.id) : null;
        if (!saved || storyRef.current?.id !== saved.id) return null;
        const updated = merge(migrateStoryToV02(saved));
        if (!updated) return null;
        const committed = await harness.saveStory(
          { ...updated, updatedAt: Math.max(updated.updatedAt, saved.updatedAt + 1) },
          saved.updatedAt,
        );
        if (storyRef.current?.id === committed.id) {
          storyRef.current = committed;
          setStory(committed);
        }
        await refreshStories();
        return committed;
      });
      storyCommitQueueRef.current = commit.then(
        () => undefined,
        () => undefined,
      );
      return commit;
    },
    [harness, refreshStories, runtime.storyStorage],
  );

  const invalidateSummaryTask = useCallback(() => {
    summarySeqRef.current += 1;
    setIsSummarizing(false);
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
          setErrorMsg(toErrorMessage(err, '读取连接配置失败。'));
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
        const [rawList, rawActive] = await Promise.all([
          harness.listStories(),
          harness.loadActiveStory(),
        ]);
        if (cancelled || storyOpSeqRef.current !== loadSeq) return;
        let migratedCount = 0;
        const list = rawList.map((item) => {
          const next = migrateStoryToV02(item);
          if (next !== item) migratedCount += 1;
          return next;
        });
        // Persist migrated stories idempotently so future loads are already V0.2.
        for (let i = 0; i < list.length; i += 1) {
          if (list[i] !== rawList[i]) {
            void harness.saveStory(list[i], rawList[i].updatedAt).catch(() => undefined);
          }
        }
        setStories(list);
        if (rawActive) {
          const active = list.find((s) => s.id === rawActive.id) ?? migrateStoryToV02(rawActive);
          setStory(active);
        }
        if (migratedCount > 0) {
          try {
            runtime.diagnostics.recordEvent({
              level: 'info',
              category: 'storage',
              action: 'migration_v02_done',
              meta: { migratedCount },
            });
          } catch {
            // Ignore diagnostics failures.
          }
        }
      } catch (err) {
        try {
          runtime.diagnostics.recordError({
            category: 'storage',
            action: 'migration_v02_error',
            error: err,
          });
        } catch {
          // Ignore diagnostics failures.
        }
        if (!cancelled && storyOpSeqRef.current === loadSeq) {
          setErrorMsg(toErrorMessage(err, '读取本地故事失败。'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harness, runtime.diagnostics]);

  useEffect(() => {
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
    canCloseImport: () => !deepSeekImportBusyRef.current,
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
        setErrorMsg(toErrorMessage(err, '保存连接配置失败。'));
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
      reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
      apiKey: devTestInfo.hasEnvKey ? '' : config.apiKey,
      memoryOnly: config.memoryOnly,
    });
    setUseDevEnvKey(devTestInfo.hasEnvKey);
    setErrorMsg(null);
  };

  const activeSummary = getActiveSummarySnapshot(story);

  const autoScroll = useAutoScrollTimeline({
    contextKey: isWelcome ? 'welcome-neutral' : story.id,
    activeLeafKey: isWelcome ? String(neutralTurns.length) : story.activeLeafNodeId,
    turnCount: isWelcome ? neutralTurns.length : activeNodes.length,
    isStreaming,
    streamPulse: `${streamContent.length}:${streamReasoning.length}`,
    paused: showImport || showSettings || Boolean(creativePage),
  });

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
      const migratedResult = migrateStoryToV02(result.story);
      setStory(migratedResult);
      if (result.assistantNode.proposals && result.assistantNode.proposals.length > 0) {
        recordProposalCreationBreadcrumbs(runtime.diagnostics, result.assistantNode.proposals);
      }
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
        setErrorMsg(toErrorMessage(err, '生成失败，请检查网络连接或 API Key。'));
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
    } else if (!opts?.preserveSummaryTask) {
      setIsSummarizing(false);
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
    ++overlayNavigationSeqRef.current;
    captureOverlayTrigger();
    abortActiveStream(true);
    setPlusMenuOpen(false);
    setCreativePage(null);
    setShowSettings(false);
    setStoryTreeOpen(false);
    setMobileLibraryOpen(false);
    setImportMode(mode);
    setImportResetKey((k) => k + 1);
    setShowImport(true);
  };

  const openSettings = () => {
    if (branchSwitchBusyRef.current) return;
    ++overlayNavigationSeqRef.current;
    captureOverlayTrigger();
    setPlusMenuOpen(false);
    setCreativeCompanionOpen(false);
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

  const persistMaterializedAsset = async (
    targetMode: StageAssetMode,
    materialized: ReturnType<typeof materializeAssetFromNodes>,
    guard?: { storySeqAtStart: number; overlaySeqAtStart: number },
  ) => {
    const stillCurrent = () =>
      !guard || isNavigationCurrent(guard.storySeqAtStart, guard.overlaySeqAtStart);

    if (targetMode === 'story' && materialized.story) {
      const saved = await harness.saveStory(migrateStoryToV02(materialized.story));
      await refreshStories();
      if (!stillCurrent()) return;
      const prevSel = await runtime.storyStorage.getActiveStorySelection();
      const activeBeforeActivation = prevSel.status === 'present' ? prevSel.id : null;
      if (!stillCurrent()) return;
      const activated = await harness.setActiveStory(saved.id);
      if (!stillCurrent()) {
        await runtime.storyStorage.compareAndSetActiveStoryId(saved.id, activeBeforeActivation);
        return;
      }
      const active = migrateStoryToV02(activated ?? saved);
      storyRef.current = active;
      setStory(active);
      setCreativePage(null);
      setNewCreationOpen(false);
      setNeutralTurns([]);
      return;
    }
    if (targetMode === 'writing' && materialized.work) {
      const work = materialized.work;
      await creative.save((state) => ({
        ...state,
        works: [...state.works, work],
        activeWorkId: stillCurrent() ? work.id : state.activeWorkId,
      }));
      if (!stillCurrent()) return;
      setNeutralTurns([]);
      setWritingView({ id: work.id, manuscript: Boolean(work.body.trim()) });
      openCreativePage('writing');
      return;
    }
    if (targetMode === 'character' && materialized.character) {
      const ch = materialized.character;
      await creative.save((state) => ({
        ...state,
        characters: [...state.characters, ch],
        activeCharacterId: stillCurrent() ? ch.id : state.activeCharacterId,
      }));
      if (!stillCurrent()) return;
      setNeutralTurns([]);
      openCreativePage('character');
    }
  };

  const handleConvertStageMode = async (targetMode: StageAssetMode) => {
    if (isStreaming || branchSwitchBusyRef.current) return;
    const fromMode: StageAssetMode = creativePage ?? 'story';
    if (fromMode === targetMode) return;
    setErrorMsg(null);
    const activeWorkNow = creative.workspace.works.find((item) => item.id === creative.workspace.activeWorkId);
    const activeCharacterNow = creative.workspace.characters.find((item) => item.id === creative.workspace.activeCharacterId);

    try {
      const converted = convertActiveAssetMode({
        fromMode,
        toMode: targetMode,
        story,
        work: activeWorkNow,
        character: activeCharacterNow,
        workspace: creative.workspace,
      });
      await persistMaterializedAsset(targetMode, converted);
      try {
        runtime.diagnostics.recordEvent({
          level: 'info',
          category: 'ui',
          action: 'entry_misroute_corrected',
          meta: { routeMode: targetMode },
        });
      } catch {
        // Ignore diagnostics failure.
      }
      const modeName = targetMode === 'story' ? '文游' : targetMode === 'writing' ? '写故事' : '角色互动';
      setStatusNotice(`已切换为「${modeName}」，原有设定与对话已完整保留。`);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '模式切换失败。'));
    }
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

    const switchTarget = detectNaturalModeSwitchIntent(trimmed);
    if (switchTarget && switchTarget !== 'story') {
      if (restoreOnError) setInput('');
      void handleConvertStageMode(switchTarget);
      return;
    }

    withCredentials(
      '继续互动对话',
      (activeCfg) => {
        if (branchSwitchBusyRef.current) return;
        if (restoreOnError) {
          setInput('');
        }
        void runStreamingExecution(
          (callbacks) =>
            harness.runTurn(
              story,
              trimmed,
              resolveEffectiveModelConfig(activeCfg, story.generationPreference),
              callbacks,
            ),
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
      '编辑内容并生成新分支',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.editAndBranch(
            story,
            targetUserNodeId,
            trimmed,
            resolveEffectiveModelConfig(activeCfg, story.generationPreference),
            callbacks,
          ),
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
      '重新生成回复',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.regenerateNode(
            story,
            targetAssistantNodeId,
            resolveEffectiveModelConfig(activeCfg, story.generationPreference),
            callbacks,
          ),
        );
      },
      overrideConfig,
    );
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
      runtime.diagnostics.recordEvent({
        level: switched ? 'info' : 'warn',
        category: 'branch',
        action: switched ? 'switch_branch' : 'switch_branch_failed',
        durationMs: Date.now() - switchStartedAt,
      });
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

  const handleRewindToNode = (targetNodeId: string) =>
    runStoryTransition(() => harness.rewindToNode(story, targetNodeId), '回溯节点失败。');

  const handleWelcomeEntrySubmit = (rawPrompt: string) => {
    const trimmed = rawPrompt.trim();
    if (!trimmed || creationPending.current || isStreaming || creating) return;

    if (neutralTurns.length > 0) {
      const switchTarget = detectNaturalModeSwitchIntent(trimmed);
      if (switchTarget) {
        const materialized = materializeAssetFromNodes({
          targetMode: switchTarget,
          title: neutralTurns[0]?.content.slice(0, 20) || '新创作',
          settingMarkdown: neutralTurns.map((t) => t.content).join('\n\n'),
          turns: neutralTurns,
        });
        setInput('');
        void persistMaterializedAsset(switchTarget, materialized)
          .then(() => {
            try {
              runtime.diagnostics.recordEvent({
                level: 'info',
                category: 'ui',
                action: 'entry_neutral_persisted',
                meta: { routeMode: switchTarget },
              });
            } catch {
              // Ignore diagnostics error.
            }
          })
          .catch((err) => setErrorMsg(toErrorMessage(err, '转换模式失败。')));
        return;
      }
    }

    withCredentials('开始新的创作', (activeCfg) => {
      if (creationPending.current || abortRef.current || isStreaming) return;
      const storySeqAtStart = ++storyOpSeqRef.current;
      const overlaySeqAtStart = overlayNavigationSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      creationPending.current = true;
      setCreating(true);
      setIsStreaming(true);
      setStreamContent('');
      setStreamReasoning('');
      setErrorMsg(null);
      setInput('');

      const publicMem = documentVersion(creative.workspace.publicDocument).markdown;
      void routeEntryMessage(
        trimmed,
        neutralTurns,
        runtime.transport,
        activeCfg,
        {
          signal: controller.signal,
          onReasoningDelta: (delta) => {
            if (!controller.signal.aborted) setStreamReasoning((prev) => prev + delta);
          },
          onContentDelta: (delta) => {
            if (!controller.signal.aborted) setStreamContent((prev) => prev + delta);
          },
        },
        publicMem,
      )
        .then(async (routed) => {
          if (controller.signal.aborted || !isNavigationCurrent(storySeqAtStart, overlaySeqAtStart)) {
            return;
          }
          const now = Date.now();
          const prevLeaf = neutralTurns.at(-1)?.id ?? null;
          const userNode: TurnNode = {
            id: createDefaultId(),
            parentId: prevLeaf,
            role: 'user',
            content: trimmed,
            createdAt: now,
            summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          };
          const proposalRecords = buildTurnProposalRecords({
            proposals: routed.proposals,
            unparsedBlocks: routed.unparsedBlocks,
          });
          const assistantNode: TurnNode = {
            id: createDefaultId(),
            parentId: userNode.id,
            role: 'assistant',
            content: routed.assistantReply,
            ...(routed.turnSummary ? { turnSummary: routed.turnSummary } : {}),
            ...(routed.reasoningContent ? { reasoningContent: routed.reasoningContent } : {}),
            model: routed.model ?? activeCfg.model,
            reasoningEffort: routed.reasoningEffort ?? normalizeReasoningEffort(activeCfg.reasoningEffort),
            createdAt: now + 1,
            summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
            ...(proposalRecords.length > 0 ? { proposals: proposalRecords } : {}),
          };

          if (routed.mode === 'ambiguous') {
            setNeutralTurns((prev) => [...prev, userNode, assistantNode]);
            try {
              runtime.diagnostics.recordEvent({
                level: 'info',
                category: 'ui',
                action: 'entry_route_ambiguous',
                meta: { routeMode: 'ambiguous' },
              });
            } catch {
              // Ignore diagnostics error.
            }
            return;
          }

          const allTurns = [...neutralTurns, userNode, assistantNode];
          const hadNeutralHistory = neutralTurns.length > 0;
          const materialized = materializeAssetFromNodes({
            targetMode: routed.mode,
            title: routed.title,
            settingMarkdown: routed.settingMarkdown,
            turns: allTurns,
            characterName: routed.characterName,
          });
          await persistMaterializedAsset(routed.mode, materialized, {
            storySeqAtStart,
            overlaySeqAtStart,
          });

          try {
            runtime.diagnostics.recordEvent({
              level: 'info',
              category: 'ui',
              action: 'entry_route_classified',
              meta: { routeMode: routed.mode },
            });
            if (hadNeutralHistory) {
              runtime.diagnostics.recordEvent({
                level: 'info',
                category: 'ui',
                action: 'entry_neutral_persisted',
                meta: { routeMode: routed.mode },
              });
            }
          } catch {
            // Ignore diagnostics error.
          }
        })
        .catch((err) => {
          if (suppressedAbortRef.current.has(controller)) return;
          if (isAbortError(err)) {
            setErrorMsg('已中止本次响应。');
          } else {
            setErrorMsg(toErrorMessage(err, '发送失败，请检查网络连接或 API Key。'));
          }
          setInput((curr) => (curr.length === 0 ? trimmed : curr));
        })
        .finally(() => {
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
          creationPending.current = false;
          setCreating(false);
          setIsStreaming(false);
          setStreamContent('');
          setStreamReasoning('');
        });
    });
  };

  const handleStartBlankManuscript = async () => {
    if (creationPending.current) return;
    const storySeqAtStart = ++storyOpSeqRef.current;
    const overlaySeqAtStart = overlayNavigationSeqRef.current;
    setPlusMenuOpen(false);
    creationPending.current = true;
    setCreating(true);
    setErrorMsg(null);
    try {
      const work = { ...newWork('未命名作品'), writingStarted: true };
      await creative.save((state) => ({
        ...state,
        works: [...state.works, work],
        activeWorkId: isNavigationCurrent(storySeqAtStart, overlaySeqAtStart) ? work.id : state.activeWorkId,
      }));
      if (!isNavigationCurrent(storySeqAtStart, overlaySeqAtStart)) return;
      setNeutralTurns([]);
      setInput('');
      setWritingView({ id: work.id, manuscript: true });
      openCreativePage('writing');
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '创建空白正文失败。'));
    } finally {
      creationPending.current = false;
      setCreating(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isWelcome) {
      handleWelcomeEntrySubmit(input);
    } else {
      sendAction(input, true);
    }
  };

  const startFirstAct = (targetStory: Story, overrideConfig?: ModelConfig) => {
    withCredentials(
      '开启第一幕',
      (activeCfg) => {
        void runStreamingExecution((callbacks) =>
          harness.runTurn(
            targetStory,
            '请按照当前故事设定开始第一幕。',
            resolveEffectiveModelConfig(activeCfg, targetStory.generationPreference),
            callbacks,
          ),
        );
      },
      overrideConfig,
    );
  };

  const handleCreateSettingStory = async (imported: {
    title: string;
    settingMarkdown: string;
  }) => {
    if (branchSwitchBusyRef.current) return;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const now = Date.now();
      const containerDoc = newDocument(imported.settingMarkdown, 'user', 'story-original');
      const localDoc = newDocument('', 'migration', 'path-original');
      const created: Story = {
        id: createDefaultId(),
        title: imported.title.trim() || '新故事',
        sourceKind: 'manual_script',
        v2Migrated: true,
        rawScript: '',
        blueprint: createDefaultBlueprint(imported.title.trim() || '新故事'),
        documents: {
          container: containerDoc,
          local: localDoc,
          edits: {},
        },
        nodes: {},
        rootNodeIds: [],
        activeLeafNodeId: null,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await harness.saveStory(created);
      await refreshStories();
      if (storyOpSeqRef.current !== opSeq) return;
      const activated = await harness.setActiveStory(saved.id);
      if (storyOpSeqRef.current !== opSeq) return;
      await commitStoryState(activated ?? saved);
      setNewCreationOpen(false);
      setNeutralTurns([]);
      setShowImport(false);
      setShowSettings(false);
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
      const migrated = migrateStoryToV02(result.stories[0]);
      if (migrated !== result.stories[0]) {
        await harness.saveStory(migrated);
      }
      await commitStoryState(migrated);
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
    const overlaySeqAtStart = overlayNavigationSeqRef.current;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const switched = await harness.setActiveStory(id);
      if (storyOpSeqRef.current !== opSeq) return;
      if (switched) {
        const migrated = migrateStoryToV02(switched);
        storyRef.current = migrated;
        setStory(migrated);
        if (isNavigationCurrent(opSeq, overlaySeqAtStart)) {
          setNewCreationOpen(false);
          setNeutralTurns([]);
          setShowImport(false);
          setShowSettings(false);
          setCreativePage(null);
          setMobileLibraryOpen(false);
        }
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
        setStory((prev) => (prev.id === id ? migrateStoryToV02(updated) : prev));
        await refreshStories();
      }
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '重命名故事失败。'));
    }
  };

  const handleDeleteStory = async (id: string) => {
    if (branchSwitchBusyRef.current) return;
    const overlaySeqAtStart = overlayNavigationSeqRef.current;
    abortActiveStream(true);
    invalidateSummaryTask();
    const opSeq = ++storyOpSeqRef.current;
    const deletedActiveStory = story.id === id;
    setErrorMsg(null);
    try {
      await harness.deleteStory(id);
      await refreshStories();
      if (deletedActiveStory && storyOpSeqRef.current === opSeq) {
        const next = harness.createStory({ title: '新故事' });
        storyRef.current = next;
        setStory(next);
        convergeToWelcomeStage(overlayNavigationSeqRef.current === overlaySeqAtStart);
      }
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '删除故事失败。'));
      }
    }
  };

  const handleExportStoryMarkdown = async (storyId: string) => {
    setErrorMsg(null);
    try {
      const targetStory = stories.find((item) => item.id === storyId) ?? (story.id === storyId ? story : null);
      if (!targetStory) return;
      if (!runtime.backupExporter.exportMarkdown) {
        throw new Error('当前设备暂不支持导出 Markdown。');
      }
      const markdown = storyExportMarkdown(targetStory);
      const fileName = `${targetStory.title.replace(/[\\/:*?"<>|]+/g, '_').trim() || '故事'}.md`;
      await runtime.backupExporter.exportMarkdown(fileName, markdown);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '导出 Markdown 失败。'));
    }
  };

  const handleExportFullBackup = async () => {
    setErrorMsg(null);
    try {
      const latestWorkspace = await creative.read();
      const latestStories = (await harness.listStories()).map(migrateStoryToV02);
      const json = exportFolioBackupV3({
        stories: latestStories,
        workspace: latestWorkspace,
        appVersion: APP_VERSION,
        displayPreferences: {
          themePreference: displayPreferences.theme,
          fontSize: displayPreferences.fontSize,
        },
      });
      const dateTag = new Date().toISOString().slice(0, 10);
      await runtime.backupExporter.exportJsonFile(`folio-backup-${dateTag}.folio.json`, json);
      try {
        runtime.diagnostics.recordEvent({
          level: 'info',
          category: 'storage',
          action: 'backup_export_v3',
        });
      } catch {
        // Ignore diagnostics failure.
      }
      setStatusNotice('已导出全量工作区备份 (.folio.json)。');
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '导出全量备份失败。'));
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
      const incoming = parseAndValidateFolioBackup(jsonText);
      const isLegacy = file.name.toLowerCase().endsWith('.lfh.json') || incoming.appVersion === '0.1.0';
      const existingStories = (await harness.listStories()).map(migrateStoryToV02);
      const existingWorkspace = await creative.read();
      if (storyOpSeqRef.current !== opSeq) return;

      const merged = mergeRestoredBackup(
        {
          stories: existingStories,
          workspace: existingWorkspace,
          displayPreferences: {
            themePreference: displayPreferences.theme,
            fontSize: displayPreferences.fontSize,
          },
        },
        incoming,
      );

      for (const s of merged.stories) {
        await harness.saveStory(s);
      }
      await creative.save(() => merged.workspace);
      if (incoming.displayPreferences?.themePreference) {
        const pref = incoming.displayPreferences.themePreference as DisplayThemePreference;
        if (pref === 'system' || pref === 'light' || pref === 'dark' || pref === 'warm') {
          setThemePreference(pref);
        }
      }
      if (incoming.displayPreferences?.fontSize) {
        const size = incoming.displayPreferences.fontSize as DisplayFontSize;
        if (size === 14 || size === 16 || size === 18 || size === 20) {
          setDisplayFontSize(size);
        }
      }

      if (storyOpSeqRef.current !== opSeq) return;
      await refreshStories();
      const firstAdded = merged.stories.find(
        (s) => !existingStories.some((e) => e.id === s.id),
      );
      if (firstAdded) {
        const activated = await harness.setActiveStory(firstAdded.id);
        await commitStoryState(activated ?? firstAdded);
      }

      try {
        runtime.diagnostics.recordEvent({
          level: 'info',
          category: 'storage',
          action: isLegacy ? 'backup_import_legacy' : 'backup_import_v3',
        });
      } catch {
        // Ignore diagnostics failure.
      }

      const { report } = merged;
      setStatusNotice(
        `备份已安全合入：新增 ${report.addedStories + report.renamedStories} 个故事、${report.addedWorks + report.renamedWorks} 部作品、${report.addedCharacters + report.renamedCharacters} 位角色。`,
      );
      setNewCreationOpen(false);
      setNeutralTurns([]);
      setCreativePage(null);
      setCreativeCompanionOpen(false);
      setShowImport(false);
      setShowSettings(false);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '恢复备份失败，请确认文件为 .folio.json 或 .lfh.json。'));
    }
  };

  function openCreativePage(mode: 'writing' | 'character') {
    if (deepSeekImportBusyRef.current) return;
    ++storyOpSeqRef.current;
    captureOverlayTrigger();
    setCreativeCompanionOpen(false);
    abortActiveStream(true);
    setPlusMenuOpen(false);
    setShowSettings(false);
    setShowImport(false);
    setStoryTreeOpen(false);
    setMobileLibraryOpen(false);
    setNewCreationOpen(false);
    setCreativePage(mode);
  }

  function convergeToWelcomeStage(closeOverlays: boolean) {
    setCreativePage(null);
    setCreativeCompanionOpen(false);
    setWritingView(null);
    setInitialCreativeTurn(null);
    setNeutralTurns([]);
    setNewCreationOpen(true);
    setInput('');
    setErrorMsg(null);
    const shouldFocus = closeOverlays && !mobileLibraryOpen;
    focusNewCreation.current = shouldFocus;
    if (closeOverlays) {
      setShowSettings(false);
      setShowImport(false);
      setStoryTreeOpen(false);
      if (shouldFocus) window.requestAnimationFrame(focusCreationInput);
    }
  }

  function focusCreationInput() {
    if (!focusNewCreation.current) return;
    focusNewCreation.current = false;
    document.getElementById('turn-input')?.focus();
  }

  function openNewCreation() {
    if (deepSeekImportBusyRef.current) return;
    ++storyOpSeqRef.current;
    abortActiveStream(true);
    invalidateSummaryTask();
    setPlusMenuOpen(false);
    setCreativePage(null);
    setCreativeCompanionOpen(false);
    setShowSettings(false);
    setShowImport(false);
    setStoryTreeOpen(false);
    setMobileLibraryOpen(false);
    setNeutralTurns([]);
    setNewCreationOpen(true);
    setInput('');
    setErrorMsg(null);
    focusNewCreation.current = true;
    if (!mobileLibraryOpen) window.requestAnimationFrame(focusCreationInput);
  }

  async function changeCreativeItem(
    mode: 'writing' | 'character',
    id: string,
    action: 'select' | 'rename' | 'delete' | 'export',
    title = '',
  ) {
    const opSeq = action === 'select' ? ++storyOpSeqRef.current : null;
    const storySeqAtStart = storyOpSeqRef.current;
    const overlaySeqAtStart = overlayNavigationSeqRef.current;
    const deletingVisibleActive = action === 'delete' && creativePage === mode &&
      (mode === 'writing'
        ? creative.workspace.activeWorkId === id
        : creative.workspace.activeCharacterId === id);
    setErrorMsg(null);
    try {
      if (action === 'export') {
        const state = await creative.read();
        if (mode === 'writing') {
          const work = state.works.find((item) => item.id === id);
          if (work) {
            const safeTitle = work.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名作品';
            await runtime.backupExporter.exportMarkdown?.(`${safeTitle}.md`, work.body);
          }
        } else {
          const character = state.characters.find((item) => item.id === id);
          const conversation = character?.conversations.find((item) => item.id === character.activeConversationId);
          if (character) {
            const safeName = character.name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名角色';
            await runtime.backupExporter.exportMarkdown?.(
              `${safeName}.md`,
              conversation ? conversationExport(character, conversation) : documentVersion(character.document).markdown,
            );
          }
        }
        return;
      }
      await creative.save((state) => {
        if (mode === 'writing') {
          return {
            ...state,
            activeWorkId: action === 'select' ? id : action === 'delete' && state.activeWorkId === id ? undefined : state.activeWorkId,
            works: action === 'rename' ? state.works.map((item) => item.id === id ? { ...item, title } : item)
              : action === 'delete' ? state.works.filter((item) => item.id !== id) : state.works,
          };
        }
        return {
          ...state,
          activeCharacterId: action === 'select' ? id : action === 'delete' && state.activeCharacterId === id ? undefined : state.activeCharacterId,
          characters: action === 'rename' ? state.characters.map((item) => item.id === id ? { ...item, name: title } : item)
            : action === 'delete' ? state.characters.filter((item) => item.id !== id) : state.characters,
        };
      });
      if (action === 'select' && storyOpSeqRef.current === opSeq &&
        overlayNavigationSeqRef.current === overlaySeqAtStart) {
        openCreativePage(mode);
      }
      if (deletingVisibleActive && storyOpSeqRef.current === storySeqAtStart) {
        convergeToWelcomeStage(overlayNavigationSeqRef.current === overlaySeqAtStart);
      }
    } catch (error) {
      if (opSeq === null || storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(error, '书架操作失败。'));
      }
    }
  }

  function openPublicDocument(proposal?: string, expected?: string) {
    void creative.read().then(({ publicDocument }) => {
      const latest = documentVersion(publicDocument);
      setDocumentEdit({
        title: '我的记忆',
        mode: creativePage ?? 'story',
        description: '跨文游、写故事与角色互动共享的个人偏好与长期记忆。',
        base: expected && Object.hasOwn(publicDocument.versions, expected) ? documentVersion(publicDocument, expected) : latest,
        history: documentLineage(publicDocument),
        proposal,
        reload: async () => {
          const { publicDocument: current } = await creative.read();
          return { base: documentVersion(current), history: documentLineage(current) };
        },
        apply: async (base: string, markdown: string) => {
          if (expected && !Object.hasOwn(publicDocument.versions, expected) && base === latest.id) {
            throw new Error('我的记忆已更新，请重新载入后再试。');
          }
          await creative.save((current) => {
            const doc = current.publicDocument;
            if (doc.head !== base) throw new Error('我的记忆已变化，请重新载入。');
            return { ...current, publicDocument: writeDocument(doc, base, markdown) };
          });
        },
      });
    }).catch((err) => setErrorMsg(toErrorMessage(err, '读取我的记忆失败。')));
  }

  function openStoryDocument(source: Story, target: 'container' | 'local', proposal?: string, expected?: string) {
    const anchor = source.activeLeafNodeId;
    function loadEdit(current: Story) {
      const scoped = migrateStoryDocuments(current) as Story & { documents: StoryDocuments };
      const doc = scoped.documents[target];
      const head = storyDocumentState(scoped, anchor, true)[target];
      return { doc, head };
    }
    const { doc, head } = loadEdit(source);
    setDocumentEdit({
      title: target === 'container' ? '故事设定' : '分支笔记',
      mode: 'story',
      description: target === 'container'
        ? '当前故事的单一 Markdown 设定，修改后立即用于后续演绎。'
        : '当前故事分支的局部进展与备忘。',
      base: documentVersion(doc, expected ?? head),
      history: documentLineage(doc, head),
      proposal,
      reload: async () => {
        const latest = await runtime.storyStorage.getStory(source.id);
        if (!latest || latest.activeLeafNodeId !== anchor) throw new Error('当前分支已变化，请返回后重试。');
        const refreshed = loadEdit(latest);
        return { base: documentVersion(refreshed.doc, refreshed.head), history: documentLineage(refreshed.doc, refreshed.head) };
      },
      apply: async (base: string, markdown: string) => {
        const latest = await runtime.storyStorage.getStory(source.id);
        if (!latest || latest.activeLeafNodeId !== anchor) {
          throw new Error('当前分支已变化，请返回后重试。');
        }
        const updated = migrateStoryToV02(editStoryDocument(latest, target, base, markdown));
        await runtime.storyStorage.saveStory(updated, latest.updatedAt);
        if (storyRef.current?.id === updated.id) {
          storyRef.current = updated;
          setStory(updated);
        }
        await refreshStories();
      },
    });
  }

  // Story-mode ProposalCard handlers
  const resolveStoryProposalTargetState = (proposal: TurnProposalRecord): ResolvedProposalTargetState => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      const mem = documentVersion(creative.workspace.publicDocument);
      return { currentMarkdown: mem.markdown, currentVersionId: mem.id, targetLabel: '我的记忆' };
    }
    if (normalized === 'note') {
      const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
      const state = storyDocumentState(scoped, scoped.activeLeafNodeId, true);
      const note = documentVersion(scoped.documents.local, state.local);
      return { currentMarkdown: note.markdown, currentVersionId: note.id, targetLabel: '分支笔记' };
    }
    if (normalized === 'character' || normalized === 'draft') {
      return { currentMarkdown: '', targetLabel: normalized === 'character' ? '新建角色' : '新开写故事' };
    }
    const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
    const state = storyDocumentState(scoped, scoped.activeLeafNodeId, true);
    const settingVer = documentVersion(scoped.documents.container, state.container);
    return { currentMarkdown: settingVer.markdown, currentVersionId: settingVer.id, targetLabel: '故事设定' };
  };

  const handleApplyStoryProposal = async (
    nodeId: string,
    proposal: TurnProposalRecord,
    resolvedMarkdown: string,
  ) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      let prevId = '';
      let nextHead = '';
      await creative.save((state) => {
        prevId = state.publicDocument.head;
        const nextDoc = writeDocument(state.publicDocument, prevId, resolvedMarkdown, 'user');
        nextHead = nextDoc.head;
        return { ...state, publicDocument: nextDoc };
      });
      await enqueueStoryCommit((latest) => {
        if (!latest) return null;
        return {
          ...latest,
          nodes: updateTurnNodeProposal(latest.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'applied',
            previousVersionId: prevId,
            appliedVersionId: nextHead,
          })),
        };
      });
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_applied', proposal);
      return;
    }

    if (normalized === 'character' || normalized === 'draft') {
      let createdAsset: { kind: 'character' | 'work'; id: string; label: string } | null = null;
      await creative.save((state) => {
        const derived = createDerivedAssetInWorkspace(state, proposal, resolvedMarkdown);
        createdAsset = { kind: derived.createdKind, id: derived.createdId, label: derived.label };
        return derived.nextState;
      });
      await enqueueStoryCommit((latest) => {
        if (!latest) return null;
        return {
          ...latest,
          nodes: updateTurnNodeProposal(latest.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'applied',
          })),
        };
      });
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_applied', proposal);
      if (createdAsset) setCreatedAssetNotice(createdAsset);
      return;
    }

    const docTarget = normalized === 'note' ? 'local' : 'container';
    await enqueueStoryCommit((latest) => {
      if (!latest) return null;
      const scoped = migrateStoryDocuments(latest) as Story & { documents: StoryDocuments };
      const anchor = scoped.activeLeafNodeId;
      const currentState = storyDocumentState(scoped, anchor, true);
      const prevId = currentState[docTarget];
      const revised = editStoryDocument(scoped, docTarget, prevId, resolvedMarkdown) as Story & {
        documents: StoryDocuments;
      };
      const appliedHead = storyDocumentState(revised, anchor, true)[docTarget];
      return {
        ...revised,
        nodes: updateTurnNodeProposal(revised.nodes, nodeId, proposal.id, (p) => ({
          ...p,
          status: 'applied',
          previousVersionId: prevId,
          appliedVersionId: appliedHead,
        })),
      };
    });
    if (proposal.baseVersionId && proposal.baseVersionId !== resolveStoryProposalTargetState(proposal).currentVersionId) {
      recordProposalDiagnostic(runtime.diagnostics, 'patch_reapplied', proposal);
    }
    recordProposalDiagnostic(runtime.diagnostics, 'proposal_applied', proposal);
  };

  const handleDismissStoryProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    await enqueueStoryCommit((latest) => {
      if (!latest) return null;
      return {
        ...latest,
        nodes: updateTurnNodeProposal(latest.nodes, nodeId, proposal.id, (p) => ({
          ...p,
          status: 'dismissed',
        })),
      };
    });
    recordProposalDiagnostic(runtime.diagnostics, 'proposal_dismissed', proposal);
  };

  const handleRevertStoryProposal = async (nodeId: string, proposal: TurnProposalRecord) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      await creative.save((state) => {
        const { nextDocument } = revertDocumentToVersion(state.publicDocument, proposal);
        return { ...state, publicDocument: nextDocument };
      });
      await enqueueStoryCommit((latest) => {
        if (!latest) return null;
        return {
          ...latest,
          nodes: updateTurnNodeProposal(latest.nodes, nodeId, proposal.id, (p) => ({
            ...p,
            status: 'reverted',
          })),
        };
      });
      recordProposalDiagnostic(runtime.diagnostics, 'proposal_reverted', proposal);
      return;
    }

    const docTarget = normalized === 'note' ? 'local' : 'container';
    await enqueueStoryCommit((latest) => {
      if (!latest) return null;
      const scoped = migrateStoryDocuments(latest) as Story & { documents: StoryDocuments };
      const anchor = scoped.activeLeafNodeId;
      const currentHead = storyDocumentState(scoped, anchor, true)[docTarget];
      const prevId = proposal.previousVersionId;
      if (!prevId || !Object.hasOwn(scoped.documents[docTarget].versions, prevId)) {
        throw new Error('找不到可用于撤销的历史版本。');
      }
      const prevMd = documentVersion(scoped.documents[docTarget], prevId).markdown;
      const revised = editStoryDocument(scoped, docTarget, currentHead, prevMd);
      return {
        ...revised,
        nodes: updateTurnNodeProposal(revised.nodes, nodeId, proposal.id, (p) => ({
          ...p,
          status: 'reverted',
        })),
      };
    });
    recordProposalDiagnostic(runtime.diagnostics, 'proposal_reverted', proposal);
  };

  const handleOpenStoryProposalEditor = (proposal: TurnProposalRecord) => {
    const normalized = normalizeProposalTarget(proposal.target) ?? 'setting';
    if (normalized === 'memory') {
      openPublicDocument(proposal.status === 'needs_review' ? proposal.body : undefined);
      return;
    }
    const target = normalized === 'note' ? 'local' : 'container';
    openStoryDocument(story, target, proposal.status === 'needs_review' ? proposal.body : undefined);
  };

  const activeWork = creative.workspace.works.find((item) => item.id === creative.workspace.activeWorkId);
  const activeCharacter = creative.workspace.characters.find((item) => item.id === creative.workspace.activeCharacterId);
  const showManuscript = Boolean(activeWork && (writingView?.id === activeWork.id
    ? writingView.manuscript
    : activeWork.writingStarted || activeWork.body || activeWork.source));
  const selectWritingView = (manuscript: boolean) => {
    if (activeWork) setWritingView({ id: activeWork.id, manuscript });
  };

  const creativeActions = (mode: 'writing' | 'character') => ({
    onSelect: (id: string) => void changeCreativeItem(mode, id, 'select'),
    onRename: (id: string, title: string) => void changeCreativeItem(mode, id, 'rename', title),
    onDelete: (id: string) => void changeCreativeItem(mode, id, 'delete'),
    onExport: (id: string) => void changeCreativeItem(mode, id, 'export'),
  });

  const recentCreative = [
    ...creative.workspace.works.map((work, index) => ({
      id: `work-${work.id}`,
      title: work.title,
      kindLabel: '写故事',
      recency: Math.max(
        work.discussion.at(-1)?.createdAt ?? 0,
        ...Object.values(work.document.versions).map((version) => version.savedAt),
      ) + (work.id === activeWork?.id ? 1 : 0),
      order: index,
      activate: () => void changeCreativeItem('writing', work.id, 'select'),
    })),
    ...creative.workspace.characters.map((character, index) => ({
      id: `character-${character.id}`,
      title: character.name,
      kindLabel: '角色',
      recency: Math.max(
        ...character.conversations.flatMap((conv) => Object.values(conv.nodes).map((node) => node.createdAt)),
        ...Object.values(character.document.versions).map((version) => version.savedAt),
      ) + (character.id === activeCharacter?.id ? 1 : 0),
      order: index,
      activate: () => void changeCreativeItem('character', character.id, 'select'),
    })),
  ]
    .sort((a, b) => (b.recency - a.recency) || (b.order - a.order))
    .slice(0, 3)
    .map(({ id, title, kindLabel, activate }) => ({ id, title, kindLabel, activate }));

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
    activeLeafNode.id === streamingNodeId;

  const activeCategory: 'story' | 'work' | 'character' =
    creativePage === 'writing'
      ? 'work'
      : creativePage === 'character'
        ? 'character'
        : 'story';

  const storySettingPreview = story.documents
    ? documentVersion(
        story.documents.container,
        storyDocumentState(story as Story & { documents: StoryDocuments }, story.activeLeafNodeId, true).container,
      ).markdown
    : '';

  const canExportFullBackup =
    stories.length > 0 ||
    creative.workspace.works.length > 0 ||
    creative.workspace.characters.length > 0 ||
    Boolean(documentVersion(creative.workspace.publicDocument).markdown.trim());

  const backupSummaryText = `包含 ${stories.length} 个故事、${creative.workspace.works.length} 部作品、${creative.workspace.characters.length} 位角色与我的记忆（不含 API Key）`;

  return (
    <div className="app-root">
      {!showImport && !showSettings && (
        <TopBar
          title={creativePage === 'writing'
            ? (activeWork?.title ?? 'Folio')
            : creativePage === 'character'
              ? (activeCharacter?.name ?? 'Folio')
              : !isWelcome ? story.title : 'Folio'}
          stageMode={creativePage ?? 'story'}
          showModeSwitcher={!isWelcome && (Boolean(creativePage) || storyExists)}
          onSwitchStageMode={(targetMode) => void handleConvertStageMode(targetMode)}
          modeSwitchDisabled={isStreaming || isSummarizing || isBranchSwitching}
          hasStory={storyExists && !isWelcome && !creativePage}
          hideStoryTools={Boolean(creativePage)}
          stageControls={creativePage === 'writing' && activeWork ? (
            <div className="topbar-stage-controls" role="group" aria-label="作品视图">
              <button
                type="button"
                className="topbar-segment-btn"
                aria-pressed={!showManuscript}
                onClick={() => selectWritingView(false)}
              >
                聊天
              </button>
              <button
                type="button"
                className="topbar-segment-btn"
                aria-pressed={showManuscript}
                onClick={() => selectWritingView(true)}
              >
                正文
              </button>
            </div>
          ) : undefined}
          onOpenCreativeCompanion={() => setCreativeCompanionOpen(true)}
          canOpenCreativeCompanion={creativePage === 'writing'
            ? Boolean(activeWork)
            : Boolean(activeCharacter)}
          branchLabel={branchLabel}
          forkCount={forkCount}
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
          activeCategory={activeCategory}
          activeStoryId={!creativePage && !isWelcome ? story.id : ''}
          works={creative.workspace.works.map(({ id, title, body }) => ({
            id,
            title,
            subtitle: body ? `正文 ${body.length} 字` : '聊天中',
          }))}
          characters={creative.workspace.characters.map((item) => ({
            id: item.id,
            title: item.name,
            subtitle: `${item.conversations.length} 段对话`,
          }))}
          activeWorkId={creativePage === 'writing' ? activeWork?.id : undefined}
          activeCharacterId={creativePage === 'character' ? activeCharacter?.id : undefined}
          workActions={creativeActions('writing')}
          characterActions={creativeActions('character')}
          onNewCreation={openNewCreation}
          onMobileExitComplete={focusCreationInput}
          collapsed={libraryCollapsed}
          mobileOpen={mobileLibraryOpen && !showImport && !showSettings}
          hasCredentials={hasCredentials}
          onClose={() => setMobileLibraryOpen(false)}
          onCollapse={() => setLibraryCollapsed(true)}
          onOpenSettings={openSettings}
          onStartDeepSeekImport={() => openImportView('deepseek')}
          onStartScriptImport={() => openImportView('script')}
          onSelectStory={(id) => void handleSelectStory(id)}
          onRenameStory={(id, title) => void handleRenameStory(id, title)}
          onDeleteStory={(id) => void handleDeleteStory(id)}
          onExportStoryBackup={(id) => void handleExportStoryMarkdown(id)}
        />

        <main
          ref={autoScroll.stageRef}
          className={`main-stage${storyExists && !isWelcome && !showSettings && !showImport && !creativePage ? ' is-playing' : ''}${creativePage && !showSettings && !showImport ? ' is-creative' : ''}`}
          data-testid="main-stage"
          {...edgeSwipeHandlers}
          {...autoScroll.containerHandlers}
        >
          {asyncError && (
            <BannerAlert
              tone="danger"
              testId="async-error-banner"
              action={{
                label: '导出日志',
                onClick: () => openDiagnostics('error_banner'),
              }}
              onDismiss={dismissAsyncError}
            >
              <span>{asyncError.message}</span>
            </BannerAlert>
          )}

          {statusNotice && (
            <BannerAlert
              tone="info"
              testId="status-notice-banner"
              onDismiss={() => setStatusNotice(null)}
            >
              <span>{statusNotice}</span>
            </BannerAlert>
          )}

          {errorMsg && (showSettings || showImport || isWelcome) && (
            <BannerAlert
              tone="danger"
              testId="main-error-banner"
              action={{
                label: '导出日志',
                onClick: () => openDiagnostics('error_banner'),
              }}
              onDismiss={() => setErrorMsg(null)}
            >
              <span>{errorMsg}</span>
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
              canExportFullBackup={canExportFullBackup}
              backupSummaryText={backupSummaryText}
              onBack={() => setShowSettings(false)}
              onOpenSetupWizard={openSetupWizard}
              onClearSavedKey={handleClearSavedKey}
              onApplyDevTestConfig={applyDevTestConfig}
              onOpenDiagnostics={() => openDiagnostics('settings_manual')}
              onOpenPublicMemory={() => openPublicDocument()}
              onExportCurrentStory={() => void handleExportFullBackup()}
              onExportFullBackup={() => void handleExportFullBackup()}
              onImportBackupFile={(file) => void handleImportBackupFile(file)}
              onThemePreferenceChange={setThemePreference}
              onFontSizeChange={setDisplayFontSize}
              onDefaultModelChange={(model) => updateConfig({ ...config, model })}
              onDefaultReasoningEffortChange={(reasoningEffort) =>
                updateConfig({ ...config, reasoningEffort })}
            />
          ) : creativePage ? (
            <>
              <CreativeWorkspace
                key={creativePage}
                mode={creativePage}
                workspace={creative.workspace}
                ready={creative.ready}
                storageError={creative.error}
                save={creative.save}
                read={creative.read}
                runtime={runtime}
                requestModel={withCredentials}
                openPublic={openPublicDocument}
                openDocument={setDocumentEdit}
                companionOpen={creativeCompanionOpen}
                setCompanionOpen={setCreativeCompanionOpen}
                manuscript={showManuscript}
                onStartManuscript={() => selectWritingView(true)}
                onSwitchToChat={() => selectWritingView(false)}
                onSwitchStageMode={(targetMode) => void handleConvertStageMode(targetMode)}
                onNavigateCreatedAsset={(kind, id) => void changeCreativeItem(kind === 'character' ? 'character' : 'writing', id, 'select')}
                initialTurn={initialCreativeTurn}
                onConsumeInitialTurn={() => setInitialCreativeTurn(null)}
              />
              {errorMsg && (
                <BannerAlert
                  tone="danger"
                  action={{
                    label: '导出日志',
                    onClick: () => openDiagnostics('error_banner'),
                  }}
                >
                  {errorMsg}
                </BannerAlert>
              )}
            </>
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
              onCreateSettingStory={handleCreateSettingStory}
              onImportDeepSeekBatch={handleImportDeepSeekBatch}
              onDeepSeekImportBusyChange={(busy) => { deepSeekImportBusyRef.current = busy; }}
              diagnostics={runtime.diagnostics}
              onPackageDiagnostics={() => openDiagnostics('error_banner')}
              onContinueStory={(storyId) => void handleContinueImportedStory(storyId)}
              onCancel={() => setShowImport(false)}
              existingStories={stories}
            />
          ) : (
            <>
              {isWelcome ? (
                <WelcomeView
                  stories={stories}
                  recentCreative={recentCreative}
                  neutralTurns={neutralTurns}
                  isStreaming={isStreaming}
                  streamContent={streamContent}
                  streamReasoning={streamReasoning}
                  onSelectStory={(id) => void handleSelectStory(id)}
                />
              ) : (
                <section className="timeline" data-testid="story-timeline" aria-label="故事对话记录">
                  {activeNodes.length === 0 && !isStreaming && (
                    <div className="turn-card empty-story-card">
                      <div className="turn-role">故事设定</div>
                      <div className="turn-body">
                        {storySettingPreview.trim() ? (
                          <MarkdownView content={storySettingPreview} mode="story" />
                        ) : (
                          '输入第一句话即可开始这段互动故事，也可以从左下或设置导入外部设定。'
                        )}
                      </div>
                      {storySettingPreview.trim() && (
                        <div className="composer-actions" style={{ marginTop: '0.75rem' }}>
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
                        mode="story"
                        userLabel="玩家行动"
                        assistantLabel="AI 叙事"
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
                        attachments={node.attachmentIds?.flatMap((id) => story.attachments?.[id] ?? [])}
                        onExportAttachment={runtime.backupExporter.exportAttachment ? (file) => {
                          void runtime.backupExporter.exportAttachment!(file.fileName, file.base64)
                            .catch((err) => setErrorMsg(toErrorMessage(err, '保存附件失败。')));
                        } : undefined}
                        onRewindToNode={(nodeId) => void handleRewindToNode(nodeId)}
                        resolveProposalTargetState={resolveStoryProposalTargetState}
                        onApplyProposal={handleApplyStoryProposal}
                        onDismissProposal={handleDismissStoryProposal}
                        onRevertProposal={handleRevertStoryProposal}
                        onOpenProposalEditor={handleOpenStoryProposalEditor}
                        onAskAiReorganizeProposal={(p) =>
                          sendAction(`我刚刚调整了设定，请结合最新内容重新整理这条建议：${p.summary}`)
                        }
                      />
                    );
                  })}

                  {isStreaming && !isCommittedStreamingReply && (
                    <article className="turn-card assistant turn-streaming" data-testid="turn-assistant" aria-live="polite">
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
                        <MessageContent content={streamContent} mode="story" />
                      ) : (
                        <div className="turn-body">正在等待响应…</div>
                      )}
                    </article>
                  )}
                </section>
              )}

              {isWelcome && !hasCredentials && neutralTurns.length === 0 && (
                <div className="welcome-key-hint-row">
                  <button
                    type="button"
                    className="welcome-key-hint"
                    data-testid="welcome-key-hint"
                    onClick={openSetupWizard}
                  >
                    点击先连接 DeepSeek，或直接输入开始
                  </button>
                </div>
              )}

              <form className="composer" data-testid="stage-composer" onSubmit={handleSubmit}>
                <div className="composer-notices">
                  {errorMsg && !showSettings && !showImport && !isWelcome && (
                    <BannerAlert
                      tone="danger"
                      testId="main-error-banner"
                      action={{
                        label: '导出日志',
                        onClick: () => openDiagnostics('error_banner'),
                      }}
                    >
                      <span>{errorMsg}</span>
                    </BannerAlert>
                  )}
                  {createdAssetNotice && (
                    <div className="manuscript-undo-toast" role="status">
                      <span>{createdAssetNotice.label}</span>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => {
                          const { kind, id } = createdAssetNotice;
                          setCreatedAssetNotice(null);
                          void changeCreativeItem(kind === 'character' ? 'character' : 'writing', id, 'select');
                        }}
                      >
                        去看看
                      </button>
                    </div>
                  )}
                  {autoScroll.showScrollToBottom && (
                    <button
                      type="button"
                      className="scroll-to-bottom"
                      data-testid="scroll-to-bottom"
                      onClick={autoScroll.scrollToBottom}
                    >
                      回到底部 ↓
                    </button>
                  )}
                </div>

                {isWelcome && (
                  <div className="composer-plus-wrap">
                    <button
                      type="button"
                      className="icon-button composer-plus-btn"
                      data-testid="welcome-plus-menu-trigger"
                      aria-label="导入或直接写正文"
                      aria-haspopup="menu"
                      aria-expanded={plusMenuOpen}
                      disabled={isStreaming || creating}
                      onClick={() => setPlusMenuOpen((open) => !open)}
                    >
                      <Plus size={19} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    {plusMenuOpen && (
                      <div
                        className="composer-plus-menu"
                        role="menu"
                        aria-label="更多开始方式"
                        data-testid="welcome-plus-menu"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="welcome-deepseek-import"
                          onClick={() => openImportView('deepseek')}
                        >
                          <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>从 DeepSeek 导入</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="welcome-script-import"
                          onClick={() => openImportView('script')}
                        >
                          <FilePlus2 size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>导入设定文件 (.docx / .md / .txt)</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="welcome-blank-manuscript"
                          onClick={() => void handleStartBlankManuscript()}
                        >
                          <PenLine size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>直接写空白正文</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <label className="visually-hidden" htmlFor="turn-input">
                  {isWelcome ? '说说你想写什么、玩什么或聊什么' : '输入你的行动或对话'}
                </label>
                <textarea
                  id="turn-input"
                  name="playerInput"
                  rows={1}
                  value={input}
                  placeholder={isWelcome
                    ? '说说你想玩的故事、想写的小说，或想找谁聊聊…'
                    : '输入你的行动或对话…'}
                  disabled={creating && !isStreaming}
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
                  <span className="status-text visually-hidden">
                    {isWelcome ? '输入内容开始新的创作' : `已保存轮次：${Math.floor(activeNodes.length / 2)}`}
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
                        disabled={!input.trim() || isSummarizing || isBranchSwitching || creating}
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
                  : normalizeOfficialModelConfig({ ...config, baseUrl: DEFAULT_MODEL_CONFIG.baseUrl, apiKey: verifiedKey });
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
          buildBundle={(options) => buildDiagnosticBundle(diagnosticTrigger, options)}
          onExport={(fileName, json) => runtime.backupExporter.exportJsonFile(fileName, json)}
          onRecordDiagnostic={(action) => {
            try {
              runtime.diagnostics.recordEvent({ level: 'info', category: 'ui', action });
            } catch {
              // Ignore diagnostics error.
            }
          }}
          onReload={() => window.location.reload()}
          onClose={closeDiagnostics}
          onExitComplete={finishDiagnosticsExit}
        />
      )}

      <CompanionSheet
        open={storyTreeOpen && storyExists && !isWelcome && !creativePage && !showImport && !showSettings}
        story={story}
        summarySnapshot={activeSummary}
        isStreaming={isStreaming}
        isSummarizing={isSummarizing}
        isBranchSwitching={isBranchSwitching}
        onSwitchBranch={(id) => void handleSwitchBranch(id)}
        onRenameBranch={handleRenameBranch}
        onEditSetting={() => openStoryDocument(story, 'container')}
        onOpenMyMemory={() => openPublicDocument()}
        onEditBranchNote={() => openStoryDocument(story, 'local')}
        onExportMarkdown={() => void handleExportStoryMarkdown(story.id)}
        onClose={() => setStoryTreeOpen(false)}
      />
      <DocumentDialog edit={documentEdit} onClose={() => setDocumentEdit(null)} />
    </div>
  );
}
