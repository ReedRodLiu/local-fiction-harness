import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, FileUp, GitBranch, Link2, Sparkles, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_ZIP_MAX_BYTES,
  UnsupportedDeepSeekExportVersionError,
  assistFilterDeepSeekSessions,
  isAbortError,
  markDuplicateImportSessions,
  previewDeepSeekSessions,
  scanDeepSeekExportZip,
  type BinaryDownloader,
  type DeepSeekAttachmentResult,
  type DeepSeekImportBatchResult,
  type DeepSeekSessionIndexItem,
  type DeepSeekStructureStats,
  type DeepSeekZipScanResult,
  type DiagnosticCollector,
  type ImportSummaryStatus,
  type LlmTransport,
  type MarkedDeepSeekSession,
  type ModelConfig,
  type ScriptTurnRange,
  type Story,
  type TurnNode,
} from '../harness/index.ts';
import { StoryTree } from './StoryTree.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import { toErrorMessage } from './textHelpers.ts';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';
import { useRotatingWaitingPhrase } from './waitingPhrases.ts';

const SUMMARY_STATUS_LABELS: Record<ImportSummaryStatus, string> = {
  pending_summary: '续写时自动整理前情',
  within_window: '可直接继续',
  pending_key: '连接 DeepSeek 后可续写',
};

export type DeepSeekFilterMode = 'likely' | 'all' | 'ai';

const FILTER_TABS: ReadonlyArray<{ id: DeepSeekFilterMode; label: string }> = [
  { id: 'likely', label: '推荐导入' },
  { id: 'all', label: '全部' },
  { id: 'ai', label: 'AI 帮你挑' },
];

export function selectDefaultImportSessionIds(sessions: readonly MarkedDeepSeekSession[]): string[] {
  const firstUnimported =
    sessions.find((session) => !session.alreadyImported && session.isLikelyFiction) ??
    sessions.find((session) => !session.alreadyImported);
  return firstUnimported ? [firstUnimported.sessionId] : [];
}

export function shouldOpenImportedStoryDirectly(result: DeepSeekImportBatchResult): boolean {
  return result.stories.length === 1;
}

export function filterMarkedImportSessions(
  sessions: readonly MarkedDeepSeekSession[],
  filterMode: DeepSeekFilterMode,
  searchQuery: string,
  aiMatchedIds: ReadonlySet<string> | null,
): MarkedDeepSeekSession[] {
  const q = searchQuery.trim().toLowerCase();
  return sessions.filter((s) => {
    if (filterMode === 'likely' && !s.isLikelyFiction) return false;
    if (filterMode === 'ai' && !aiMatchedIds?.has(s.sessionId)) return false;
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.firstSnippet.toLowerCase().includes(q) ||
      s.latestSnippet.toLowerCase().includes(q)
    );
  });
}

function stripDiagnosticsForPreviewTree(story: Story): Story {
  const nodes: Record<string, TurnNode> = {};
  for (const [id, node] of Object.entries(story.nodes)) {
    if (node.diagnostics) {
      const { diagnostics: _omitted, ...rest } = node;
      nodes[id] = rest;
    } else {
      nodes[id] = node;
    }
  }
  return { ...story, nodes };
}

function summarizeSkippedAttachments(attachments: readonly DeepSeekAttachmentResult[]): {
  hasMedia: boolean;
  otherItems: DeepSeekAttachmentResult[];
} {
  let hasMedia = false;
  const otherItems: DeepSeekAttachmentResult[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'media') {
      hasMedia = true;
    } else {
      otherItems.push(attachment);
    }
  }
  return { hasMedia, otherItems };
}

function moveTabSelection<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  currentId: T,
  tabs: ReadonlyArray<{ id: T }>,
  onSelect: (id: T) => void,
  idPrefix: string,
) {
  const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
  if (currentIndex < 0) return;
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : -1;
  if (nextIndex < 0) return;
  event.preventDefault();
  const nextTab = tabs[nextIndex];
  onSelect(nextTab.id);
  document.getElementById(`${idPrefix}${nextTab.id}`)?.focus();
}

type DeepSeekImportErrorKind =
  | 'url_fetch'
  | 'zip_read'
  | 'zip_scan'
  | 'empty_zip'
  | 'ai_filter'
  | 'import';

interface DeepSeekImportError {
  kind: DeepSeekImportErrorKind;
  message: string;
}

export interface DeepSeekImportPanelInitialState {
  scanResult?: DeepSeekZipScanResult | null;
  zipBytes?: Uint8Array | null;
  selectedIds?: string[];
  filterMode?: DeepSeekFilterMode;
  aiQuery?: string;
  aiMatchedIds?: ReadonlySet<string> | null;
  previewSessionId?: string | null;
  receipt?: DeepSeekImportBatchResult | null;
}

export interface DeepSeekImportPanelProps {
  config: ModelConfig;
  transport: LlmTransport;
  binaryDownloader: BinaryDownloader;
  hasCredentials: boolean;
  byokOpen: boolean;
  onRequireByok: (
    actionLabel: string,
    resume: (resolvedConfig: ModelConfig) => void,
    onCancel?: () => void,
  ) => void;
  onImportBatch: (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptRangeOverrides: Record<string, ScriptTurnRange>,
  ) => Promise<DeepSeekImportBatchResult>;
  onImportBusyChange: (busy: boolean) => void;
  onContinueStory: (storyId: string) => void;
  diagnostics: DiagnosticCollector;
  onPackageDiagnostics: () => void;
  onCancel?: () => void;
  existingSessionIds?: readonly string[];
  existingStories?: readonly Pick<Story, 'id' | 'title' | 'sourceSessionId'>[];
  initialState?: DeepSeekImportPanelInitialState;
}

export function DeepSeekImportPanel({
  config,
  transport,
  binaryDownloader,
  hasCredentials,
  byokOpen,
  onRequireByok,
  onImportBatch,
  onImportBusyChange,
  onContinueStory,
  diagnostics,
  onPackageDiagnostics,
  onCancel,
  existingSessionIds,
  existingStories,
  initialState,
}: DeepSeekImportPanelProps) {
  const [urlSectionOpen, setUrlSectionOpen] = useState(false);
  const [zipUrl, setZipUrl] = useState('');
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const urlAbortRef = useRef<AbortController | null>(null);
  const [loadedSource, setLoadedSource] = useState<'zip_file' | 'url'>('zip_file');
  const [zipBytes, setZipBytes] = useState<Uint8Array | null>(initialState?.zipBytes ?? null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [scanResult, setScanResult] = useState<DeepSeekZipScanResult | null>(
    initialState?.scanResult ?? null,
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(initialState?.selectedIds ?? []);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(
    initialState?.previewSessionId ?? null,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [aiQuery, setAiQuery] = useState(initialState?.aiQuery ?? '');
  const [filterMode, setFilterMode] = useState<DeepSeekFilterMode>(
    initialState?.filterMode ?? 'all',
  );
  const [aiMatchedIds, setAiMatchedIds] = useState<Set<string> | null>(
    initialState?.aiMatchedIds ? new Set(initialState.aiMatchedIds) : null,
  );
  const [isAiFiltering, setIsAiFiltering] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [receipt, setReceipt] = useState<DeepSeekImportBatchResult | null>(
    initialState?.receipt ?? null,
  );
  const [importError, setImportError] = useState<DeepSeekImportError | null>(null);
  const [completedImportSessionIds, setCompletedImportSessionIds] = useState<string[]>([]);
  const completedImportResultsRef = useRef<DeepSeekImportBatchResult[]>([]);
  const zipGenerationRef = useRef(0);
  const zipReadSeqRef = useRef(0);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiPreviousFilterRef = useRef<DeepSeekFilterMode | null>(null);
  const aiByokPreviousFilterRef = useRef<DeepSeekFilterMode | null>(null);
  const pendingFilterTabFocusRef = useRef<DeepSeekFilterMode | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);

  useWebHistoryLayer(
    'deepseek-preview',
    60,
    Boolean(previewSessionId && !receipt),
    () => setPreviewSessionId(null),
    true,
    undefined,
    undefined,
    false,
  );

  useEffect(() => {
    return () => {
      zipReadSeqRef.current += 1;
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      zipGenerationRef.current += 1;
      urlAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (byokOpen) return;
    const mode = pendingFilterTabFocusRef.current;
    if (!mode) return;
    const tab = document.getElementById(`deepseek-filter-tab-${mode}`);
    if (
      !tab ||
      tab.getAttribute('aria-selected') !== 'true' ||
      tab.getAttribute('tabindex') !== '0'
    ) {
      return;
    }
    tab.focus();
    if (document.activeElement === tab) {
      pendingFilterTabFocusRef.current = null;
    }
  }, [aiMatchedIds, byokOpen, filterMode, isAiFiltering]);

  const existingSessionRefs = useMemo(() => {
    const refs: Array<Pick<Story, 'sourceSessionId'> | string> = [...(existingSessionIds ?? [])];
    for (const story of existingStories ?? []) {
      if (story.sourceSessionId) refs.push(story);
    }
    return refs;
  }, [existingSessionIds, existingStories]);

  const markedSessions = useMemo<MarkedDeepSeekSession[]>(() => {
    if (!scanResult) return [];
    return markDuplicateImportSessions(scanResult.sessions, existingSessionRefs);
  }, [scanResult, existingSessionRefs]);

  const recordImportRadar = (
    structure: Partial<DeepSeekStructureStats> | undefined,
    source: 'zip_file' | 'url',
    status: 'success' | 'error',
    selectedSessions: number,
    durationMs: number,
    confidenceCounts = { strong: 0, ambiguous: 0 },
  ) => {
    diagnostics.recordImportRadar({
      exportFormatVersion: structure?.exportFormatVersion ?? null,
      sourceMode: source,
      totalSessions: structure?.totalSessions ?? 0,
      selectedSessions,
      danglingParentCount: structure?.danglingParentCount ?? 0,
      emptyTitleCount: structure?.emptyTitleCount ?? 0,
      unknownFragmentTypes: structure?.unknownFragmentTypes ?? [],
      attachmentExtensions: structure?.attachmentExtensions ?? {},
      scriptConfidenceCounts: confidenceCounts,
      status,
      durationMs,
    });
  };

  const recordScanFailure = (
    error: unknown,
    source: 'zip_file' | 'url',
    durationMs: number,
    structure?: Partial<DeepSeekStructureStats>,
  ) => {
    const scanVersion = error instanceof UnsupportedDeepSeekExportVersionError
      ? { exportFormatVersion: error.exportFormatVersion }
      : undefined;
    recordImportRadar(structure ?? scanVersion, source, 'error', 0, durationMs);
    diagnostics.recordError({
      category: 'import',
      action: source === 'zip_file' ? 'deepseek_scan_error' : 'deepseek_url_error',
      error,
      durationMs,
    });
  };

  const invalidateAiFilter = () => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    aiPreviousFilterRef.current = null;
    aiByokPreviousFilterRef.current = null;
    zipGenerationRef.current += 1;
    setAiMatchedIds(null);
    setIsAiFiltering(false);
    setFilterMode('all');
  };

  const resetImportProgress = () => {
    completedImportResultsRef.current = [];
    setCompletedImportSessionIds([]);
  };

  const urlFetchPhrase = useRotatingWaitingPhrase({
    scene: 'import_fetch',
    active: isFetchingUrl,
  });
  const aiFilterPhrase = useRotatingWaitingPhrase({
    scene: 'import_filter',
    active: isAiFiltering,
  });
  const importOrganizePhrase = useRotatingWaitingPhrase({
    scene: 'import_organize',
    active: isImporting,
  });

  const combineCompletedImports = (): DeepSeekImportBatchResult => {
    const completed = completedImportResultsRef.current;
    return {
      stories: completed.flatMap((result) => result.stories),
      previews: completed.flatMap((result) => result.previews),
      summaryStatuses: Object.assign({}, ...completed.map((result) => result.summaryStatuses)),
    };
  };

  const loadZipBytes = (bytes: Uint8Array, source: 'zip_file' | 'url', startedAt: number) => {
    invalidateAiFilter();
    resetImportProgress();
    const scanned = scanDeepSeekExportZip(bytes);
    if (scanned.sessions.length === 0) {
      recordScanFailure(
        new Error('DeepSeek 导出包中没有可导入的对话。'),
        source,
        Date.now() - startedAt,
        scanned.structure,
      );
      setImportError({
        kind: 'empty_zip',
        message: '这个 .zip 文件中没有可导入的对话。请换一个 DeepSeek 数据导出包，或改用文本导入。',
      });
    } else {
      setImportError(null);
    }
    const marked = markDuplicateImportSessions(scanned.sessions, existingSessionRefs);
    setLoadedSource(source);
    setZipBytes(bytes);
    setScanResult(scanned);
    setSelectedIds(selectDefaultImportSessionIds(marked));
    setPreviewSessionId(null);
  };

  const resetLoadedZip = () => {
    zipReadSeqRef.current += 1;
    invalidateAiFilter();
    resetImportProgress();
    setZipBytes(null);
    setScanResult(null);
    setSelectedIds([]);
    setPreviewSessionId(null);
    if (zipInputRef.current) zipInputRef.current.value = '';
  };

  const handleZipFile = async (file: File) => {
    const readSeq = ++zipReadSeqRef.current;
    invalidateAiFilter();
    resetImportProgress();
    const startedAt = Date.now();
    setImportError(null);
    setReceipt(null);
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (err) {
      if (zipReadSeqRef.current !== readSeq) return;
      resetLoadedZip();
      recordScanFailure(err, 'zip_file', Date.now() - startedAt);
      setImportError({
        kind: 'zip_read',
        message: toErrorMessage(err, '读取 DeepSeek 导出 .zip 文件失败。'),
      });
      return;
    }
    if (zipReadSeqRef.current !== readSeq) return;
    try {
      loadZipBytes(new Uint8Array(buffer), 'zip_file', startedAt);
    } catch (err) {
      if (zipReadSeqRef.current !== readSeq) return;
      resetLoadedZip();
      recordScanFailure(err, 'zip_file', Date.now() - startedAt);
      setImportError({
        kind: 'zip_scan',
        message: toErrorMessage(err, '解析 DeepSeek 导出 .zip 文件失败。'),
      });
    }
  };

  const handleFetchZipUrl = async () => {
    if (isFetchingUrl) return;
    zipReadSeqRef.current += 1;
    invalidateAiFilter();
    resetImportProgress();
    const startedAt = Date.now();
    setImportError(null);
    setReceipt(null);
    const controller = new AbortController();
    urlAbortRef.current = controller;
    setIsFetchingUrl(true);
    try {
      const result = await binaryDownloader.downloadZipBytes(
        zipUrl,
        DEFAULT_ZIP_MAX_BYTES,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      try {
        loadZipBytes(result.bytes, 'url', startedAt);
      } catch (err) {
        if (controller.signal.aborted) return;
        resetLoadedZip();
        recordScanFailure(err, 'url', Date.now() - startedAt);
        setImportError({
          kind: 'zip_scan',
          message: toErrorMessage(err, '解析下载的 DeepSeek 导出 .zip 文件失败。'),
        });
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      resetLoadedZip();
      recordScanFailure(err, 'url', Date.now() - startedAt);
      setImportError({
        kind: 'url_fetch',
        message: toErrorMessage(err, '拉取 DeepSeek 导出链接失败，请改用本地 .zip 文件导入。'),
      });
    } finally {
      if (urlAbortRef.current === controller) {
        urlAbortRef.current = null;
        setIsFetchingUrl(false);
      }
    }
  };

  const filteredSessions = useMemo<MarkedDeepSeekSession[]>(
    () => filterMarkedImportSessions(markedSessions, filterMode, searchQuery, aiMatchedIds),
    [markedSessions, filterMode, searchQuery, aiMatchedIds],
  );

  const preview = useMemo(() => {
    if (!zipBytes || !previewSessionId) return null;
    try {
      return previewDeepSeekSessions(zipBytes, [previewSessionId])[0] ?? null;
    } catch {
      return null;
    }
  }, [zipBytes, previewSessionId]);

  const previewTreeStory = useMemo(
    () => (preview ? stripDiagnosticsForPreviewTree(preview.story) : null),
    [preview],
  );

  const toggleSelect = (sessionId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(sessionId)) {
        return prev.filter((id) => id !== sessionId);
      }
      return [...prev, sessionId];
    });
  };

  const runAiAssistFilter = async (
    cfg: ModelConfig,
    zipGeneration: number,
    sessions: readonly DeepSeekSessionIndexItem[],
    queryText: string,
  ) => {
    if (zipGeneration !== zipGenerationRef.current || isAiFiltering) return;
    setImportError(null);
    setIsAiFiltering(true);
    aiPreviousFilterRef.current = filterMode;
    setFilterMode('ai');
    const controller = new AbortController();
    aiAbortRef.current = controller;
    try {
      const ids = await assistFilterDeepSeekSessions(
        sessions,
        transport,
        cfg,
        controller.signal,
        queryText,
      );
      if (controller.signal.aborted || zipGeneration !== zipGenerationRef.current) return;
      setAiMatchedIds(new Set(ids));
      setFilterMode('ai');
      aiPreviousFilterRef.current = null;
    } catch (err) {
      if (
        controller.signal.aborted ||
        isAbortError(err) ||
        zipGeneration !== zipGenerationRef.current
      ) {
        return;
      }
      setFilterMode(aiPreviousFilterRef.current ?? 'all');
      aiPreviousFilterRef.current = null;
      setImportError({
        kind: 'ai_filter',
        message: toErrorMessage(err, 'AI 帮你挑暂未成功，请确认已连接 DeepSeek。'),
      });
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        if (zipGeneration === zipGenerationRef.current) setIsAiFiltering(false);
      }
    }
  };

  const handleRunAiFilter = (queryText = aiQuery) => {
    if (!scanResult || isAiFiltering) return;
    const zipGeneration = zipGenerationRef.current;
    const sessions = scanResult.sessions;
    if (!hasCredentials) {
      const previousMode = filterMode;
      aiByokPreviousFilterRef.current = previousMode;
      pendingFilterTabFocusRef.current = null;
      setFilterMode('ai');
      onRequireByok(
        '连接 DeepSeek',
        (cfg) => {
          aiByokPreviousFilterRef.current = null;
          pendingFilterTabFocusRef.current = 'ai';
          setFilterMode('ai');
          void runAiAssistFilter(cfg, zipGeneration, sessions, queryText);
        },
        () => {
          const restoreMode = aiByokPreviousFilterRef.current ?? previousMode;
          aiByokPreviousFilterRef.current = null;
          pendingFilterTabFocusRef.current = restoreMode;
          setFilterMode(restoreMode);
        },
      );
      return;
    }
    void runAiAssistFilter(config, zipGeneration, sessions, queryText);
  };

  const selectFilterMode = (nextMode: DeepSeekFilterMode) => {
    if (nextMode === 'ai') {
      setImportError((current) => (current?.kind === 'ai_filter' ? null : current));
      setFilterMode('ai');
      return;
    }
    const activeAiFilter = aiAbortRef.current;
    if (activeAiFilter) {
      aiAbortRef.current = null;
      activeAiFilter.abort();
      aiPreviousFilterRef.current = null;
      zipGenerationRef.current += 1;
      setIsAiFiltering(false);
    }
    setImportError((current) => (current?.kind === 'ai_filter' ? null : current));
    setFilterMode(nextMode);
  };

  const handleConfirmImport = async () => {
    const pendingSessionIds = selectedIds.filter(
      (sessionId) => !completedImportSessionIds.includes(sessionId),
    );
    if (!zipBytes || pendingSessionIds.length === 0 || isImporting) return;
    const startedAt = Date.now();
    setImportError(null);
    setIsImporting(true);
    onImportBusyChange(true);
    try {
      for (const sessionId of pendingSessionIds) {
        const result = await onImportBatch(zipBytes, [sessionId], {});
        completedImportResultsRef.current.push(result);
        setCompletedImportSessionIds((current) => [...current, sessionId]);
      }
      const result = combineCompletedImports();
      const confidenceCounts = { strong: 0, ambiguous: 0 };
      for (const p of result.previews) confidenceCounts[p.scriptConfidence] += 1;
      recordImportRadar(
        scanResult?.structure, loadedSource, 'success', result.previews.length,
        Date.now() - startedAt, confidenceCounts,
      );
      if (shouldOpenImportedStoryDirectly(result)) {
        onContinueStory(result.stories[0].id);
        return;
      }
      setReceipt(result);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const savedCount = completedImportResultsRef.current.length;
      recordImportRadar(
        scanResult?.structure,
        loadedSource,
        'error',
        pendingSessionIds.length,
        durationMs,
      );
      diagnostics.recordError({
        category: 'import',
        action: 'deepseek_import_error',
        error: err,
        durationMs,
      });
      setImportError({
        kind: 'import',
        message: savedCount > 0
          ? `已保存 ${savedCount} 个故事。${toErrorMessage(err, '其余对话导入失败。')} 重试只会处理未完成部分。`
          : toErrorMessage(err, '导入所选对话失败。'),
      });
    } finally {
      setIsImporting(false);
      onImportBusyChange(false);
    }
  };

  const step = scanResult ? 2 : 1;
  const primaryStory = receipt?.stories[0];
  const pendingImportCount = selectedIds.filter(
    (sessionId) => !completedImportSessionIds.includes(sessionId),
  ).length;
  const handleBack = () => {
    if (isImporting) return;
    if (receipt) {
      setReceipt(null);
      return;
    }
    if (scanResult) {
      resetLoadedZip();
      setImportError(null);
      return;
    }
    onCancel?.();
  };

  const footer = receipt ? (
    primaryStory ? (
      <button
        type="button"
        className="btn btn-primary import-primary-action"
        onClick={() => onContinueStory(primaryStory.id)}
      >
        进入《{primaryStory.title}》
      </button>
    ) : (
      <button
        type="button"
        className="btn import-primary-action"
        onClick={() => {
          setReceipt(null);
          resetLoadedZip();
        }}
      >
        重新选择导出包
      </button>
    )
  ) : scanResult ? (
    <button
      type="button"
      className="btn btn-primary import-primary-action"
      data-testid="ds-confirm-import-btn"
      disabled={pendingImportCount === 0 || isImporting}
      onClick={() => void handleConfirmImport()}
    >
      {isImporting
        ? importOrganizePhrase
        : completedImportSessionIds.length > 0
          ? `重试导入剩余 ${pendingImportCount} 条`
          : selectedIds.length > 1
            ? `导入并开始（已选 ${selectedIds.length} 条）`
            : '导入并开始'}
    </button>
  ) : isFetchingUrl ? (
    <button
      type="button"
      className="btn import-primary-action"
      onClick={() => {
        urlAbortRef.current?.abort();
        setImportError({
          kind: 'url_fetch',
          message: '已取消拉取导出压缩包。',
        });
      }}
    >
      取消拉取
    </button>
  ) : (
    <button
      type="button"
      className="btn btn-primary import-primary-action import-file-submit"
      data-testid="deepseek-footer-zip-picker"
      onClick={() => zipInputRef.current?.click()}
    >
      选择本地 .zip 文件
    </button>
  );

  return (
    <OverlayPageShell
      title="从 DeepSeek 导入"
      testId="deepseek-import-panel"
      step={step}
      stepCount={2}
      backDisabled={isImporting}
      onBack={handleBack}
      footer={<div className="import-footer-actions">{footer}</div>}
    >
      {importError && (
        <BannerAlert tone="danger" testId="import-error">
          <div className="import-error-copy">
            <span>{importError.message}</span>
            {importError.kind === 'url_fetch' && (
              <>
                <button
                  type="button"
                  className="text-action"
                  data-testid="import-error-action-local-zip"
                  onClick={() => {
                    setUrlSectionOpen(false);
                    setImportError(null);
                  }}
                >
                  改用本地 .zip 文件
                </button>
                <button
                  type="button"
                  className="text-action"
                  data-testid="import-error-action-retry-url"
                  onClick={() => void handleFetchZipUrl()}
                >
                  重试拉取
                </button>
              </>
            )}
            {(importError.kind === 'zip_read' ||
              importError.kind === 'zip_scan' ||
              importError.kind === 'empty_zip') && (
              <button
                type="button"
                className="text-action"
                data-testid="import-error-action-replace-zip"
                onClick={() => {
                  resetLoadedZip();
                  setImportError(null);
                }}
              >
                重新选择导出包
              </button>
            )}
            {importError.kind === 'ai_filter' && (
              <button
                type="button"
                className="text-action"
                data-testid="import-error-action-retry-ai-filter"
                onClick={() => handleRunAiFilter()}
              >
                重试 AI 帮你挑
              </button>
            )}
            {importError.kind === 'import' && pendingImportCount > 0 && (
              <button
                type="button"
                className="text-action"
                data-testid="import-error-action-retry-import"
                onClick={() => void handleConfirmImport()}
              >
                重试 {pendingImportCount} 条未完成导入
              </button>
            )}
            <button type="button" className="text-action" onClick={onPackageDiagnostics}>
              导出排障日志
            </button>
          </div>
        </BannerAlert>
      )}

      {receipt ? (
        <div className="import-step-content" data-testid="deepseek-import-receipt">
          <div className="import-intro">
            <h2>已导入 {receipt.stories.length} 个故事</h2>
            <p>历史对话已整理进「故事设定」并保留全部历史分支，点选任一条即可直接开始。</p>
          </div>
          <div className="import-receipt-summary">
            <strong>共新增 {receipt.stories.length} 个独立故事</strong>
            <span className="badge badge-ok">已保存在本机</span>
          </div>
          <ul className="ds-receipt-list">
            {receipt.previews.map((item, index) => {
              const savedStory = receipt.stories[index] ?? item.story;
              const status = receipt.summaryStatuses[savedStory.id] ?? 'within_window';
              const skippedSummary = summarizeSkippedAttachments(item.skippedAttachments);
              return (
                <li key={savedStory.id} className="ds-receipt-item">
                  <div className="ds-receipt-heading">
                    <strong>{savedStory.title}</strong>
                    <span className="badge">{SUMMARY_STATUS_LABELS[status]}</span>
                  </div>
                  <span className="status-text">{item.turnCount} 轮 · {item.forkCount} 条分支</span>
                  {item.recoveredAttachments.length > 0 && (
                    <span className="status-text">
                      已整理进故事设定：{item.recoveredAttachments.map((attachment) => attachment.fileName).join('、')}
                    </span>
                  )}
                  {skippedSummary.hasMedia && (
                    <span className="status-text">图片与 PDF 仅保留原文件备查</span>
                  )}
                  {skippedSummary.otherItems.length > 0 && (
                    <div className="turn-diagnostics" role="note">
                      {skippedSummary.otherItems
                        .map((attachment) => `${attachment.fileName}${attachment.hint ? `（${attachment.hint}）` : ''}`)
                        .join('；')}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm ds-receipt-open-btn"
                    data-testid={`ds-receipt-open-${savedStory.id}`}
                    onClick={() => onContinueStory(savedStory.id)}
                  >
                    进入《{savedStory.title}》
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="text-action import-receipt-restart"
            onClick={() => {
              setReceipt(null);
              resetLoadedZip();
            }}
          >
            继续导入其他 .zip
          </button>
        </div>
      ) : step === 1 ? (
        <div className="import-step-content">
          <div className="import-intro">
            <span className="import-privacy-pill">本机解析，无需连接模型</span>
            <h2>选择 DeepSeek 导出包</h2>
            <p>从本地挑选 DeepSeek 导出的 .zip 压缩包，整理出故事设定与全部剧情分支后直接续写。</p>
          </div>

          <div className="import-file-card ds-file-card">
            <button
              type="button"
              className="import-file-picker"
              data-testid="deepseek-zip-picker"
              onClick={() => zipInputRef.current?.click()}
            >
              <FileUp size={24} strokeWidth={1.6} aria-hidden="true" />
              <span className="import-file-title">选择 DeepSeek 数据导出包</span>
              <span className="import-file-description">从 DeepSeek「设置 → 数据管理」导出的 .zip 文件</span>
              <span className="import-file-action">浏览本地文件</span>
            </button>
            <input
              ref={zipInputRef}
              id="deepseek-zip-input"
              name="deepseekZip"
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              accept=".zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleZipFile(file);
              }}
            />
          </div>

          <details
            className="import-url-details"
            data-testid="deepseek-url-details"
            open={urlSectionOpen}
            onToggle={(event) => setUrlSectionOpen(event.currentTarget.open)}
          >
            <summary data-testid="deepseek-url-toggle">
              <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
              通过 HTTPS 下载链接导入
            </summary>
            <div className="import-url-card">
              <div className="field">
                <label htmlFor="deepseek-zip-url-input">粘贴 DeepSeek 数据管理生成的 HTTPS 下载链接</label>
                <input
                  id="deepseek-zip-url-input"
                  name="deepseekZipUrl"
                  type="url"
                  placeholder="https://..."
                  value={zipUrl}
                  disabled={isFetchingUrl}
                  onChange={(event) => setZipUrl(event.target.value)}
                />
              </div>
              <p className="status-text">
                下载链接会由浏览器直接拉取。若链接需要登录或来源站点受限，可直接使用上方本地 .zip 文件。
              </p>
              <div className="import-url-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="deepseek-fetch-zip"
                  disabled={!zipUrl.trim() || isFetchingUrl}
                  onClick={() => void handleFetchZipUrl()}
                >
                  {isFetchingUrl ? urlFetchPhrase : '拉取并查看对话'}
                </button>
              </div>
            </div>
          </details>
        </div>
      ) : (
        <div className="import-step-content">
          <div className="import-intro">
            <h2>选择想继续的历史对话</h2>
            <p>文本附件与初始设定会自动整理进「故事设定」，并完整保留所有分支。点右侧箭头可提前预览。</p>
          </div>
          {scanResult && scanResult.sessions.length > 0 ? (
            <>
              {isImporting && (
                <p className="status-text" role="status" data-testid="deepseek-import-busy">
                  {importOrganizePhrase}
                </p>
              )}
              <div className="ds-toolbar">
                <input
                  type="search"
                  aria-label="搜索历史对话"
                  placeholder="搜索标题或对话片段…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <div className="ds-filter-tabs" role="tablist" aria-label="筛选历史对话">
                  {FILTER_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      id={`deepseek-filter-tab-${tab.id}`}
                      type="button"
                      role="tab"
                      data-testid={`ds-filter-tab-${tab.id}`}
                      aria-selected={filterMode === tab.id}
                      aria-controls="deepseek-filter-panel"
                      tabIndex={filterMode === tab.id ? 0 : -1}
                      aria-disabled={tab.id === 'ai' && isAiFiltering}
                      onClick={() => selectFilterMode(tab.id)}
                      onKeyDown={(event) =>
                        moveTabSelection(
                          event,
                          filterMode,
                          FILTER_TABS,
                          selectFilterMode,
                          'deepseek-filter-tab-',
                        )}
                    >
                      {tab.id === 'ai' && isAiFiltering ? 'AI 挑选中…' : tab.label}
                    </button>
                  ))}
                </div>
                {filterMode === 'ai' && (
                  <div className="ds-ai-filter-bar" data-testid="ds-ai-filter-bar">
                    <div className="ds-ai-filter-row">
                      <input
                        type="text"
                        data-testid="ds-ai-filter-input"
                        aria-label="描述你想找回的对话"
                        placeholder="用自然语言描述，例如：找回上个月写的哨兵向导文游"
                        value={aiQuery}
                        disabled={isAiFiltering}
                        onChange={(event) => setAiQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            handleRunAiFilter(aiQuery);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        data-testid="ds-ai-filter-submit"
                        disabled={isAiFiltering}
                        onClick={() => handleRunAiFilter(aiQuery)}
                      >
                        <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
                        {isAiFiltering ? aiFilterPhrase : hasCredentials ? '开始挑选' : '连接 DeepSeek'}
                      </button>
                    </div>
                    {!aiMatchedIds && !isAiFiltering && (
                      <p className="status-text">
                        {hasCredentials
                          ? '可输入关键词、题材或时间线索让 AI 帮你挑出对话；留空则自动识别文游对话。'
                          : '需要连接 DeepSeek 才能使用「AI 帮你挑」；筛选仅在本次导入时进行。'}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div
                id="deepseek-filter-panel"
                role="tabpanel"
                aria-labelledby={`deepseek-filter-tab-${filterMode}`}
                tabIndex={0}
              >
                <div className="ds-selection-toolbar">
                  <span className="status-text">已选 {selectedIds.length} / 共 {scanResult.sessions.length} 条</span>
                  <div className="ds-selection-actions">
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => {
                        const unimported = filteredSessions
                          .filter((session) => !session.alreadyImported)
                          .map((session) => session.sessionId);
                        const targets = unimported.length > 0
                          ? unimported
                          : filteredSessions.map((session) => session.sessionId);
                        setSelectedIds((current) => [...new Set([...current, ...targets])]);
                      }}
                    >
                      全选
                    </button>
                    <button type="button" className="text-action" onClick={() => setSelectedIds([])}>
                      清空
                    </button>
                  </div>
                </div>
                <ul className="ds-session-list" data-testid="ds-session-list" aria-label="历史对话列表">
                  {filteredSessions.map((session) => {
                    const checked = selectedIds.includes(session.sessionId);
                    const sessionChips = [
                      session.alreadyImported && (
                        <span
                          key="already-imported"
                          className="badge ds-imported-pill"
                          data-testid="ds-session-already-imported"
                        >
                          已导入过
                        </span>
                      ),
                      session.diagnosticCount > 0 && (
                        <span
                          key="diagnostics"
                          className="badge badge-warn"
                          data-testid="ds-session-diagnostic-chip"
                          aria-label={`${session.diagnosticCount} 处原平台未完整生成`}
                        >
                          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
                          原平台未完整生成
                        </span>
                      ),
                      session.attachments.length > 0 && (
                        <span
                          key="attachments"
                          className="badge"
                          data-testid="ds-session-attachment-chip"
                          aria-label={`${session.attachments.length} 个附件`}
                        >
                          {session.attachments.length} 附件
                        </span>
                      ),
                      <span
                        key="turn-fork"
                        className="badge"
                        data-testid="ds-session-turn-fork-chip"
                        aria-label={session.forkCount > 0
                          ? `${session.turnCount} 轮，${session.forkCount} 条分支`
                          : `${session.turnCount} 轮`}
                      >
                        {session.turnCount} 轮
                        {session.forkCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <GitBranch size={12} strokeWidth={1.75} aria-hidden="true" />
                            {session.forkCount} 分支
                          </>
                        )}
                      </span>,
                    ].filter(Boolean);
                    return (
                      <li key={session.sessionId} className="ds-session-item" data-testid="ds-session-item">
                        <div className="ds-session-row">
                          <label className="ds-session-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelect(session.sessionId)}
                            />
                            <span className="ds-session-title">{session.title}{session.hasNullTitle ? '（自动命名）' : ''}</span>
                          </label>
                          <button
                            type="button"
                            className="ds-session-preview-trigger"
                            aria-label={`预览《${session.title}》`}
                            aria-haspopup="dialog"
                            data-testid="ds-session-preview-trigger"
                            onClick={(event) => {
                              previewTriggerRef.current = event.currentTarget;
                              setPreviewSessionId(session.sessionId);
                            }}
                          >
                            <ChevronRight size={19} strokeWidth={1.75} />
                          </button>
                        </div>
                        <p className="ds-session-latest">{session.latestSnippet || session.firstSnippet || '暂无剧情片段'}</p>
                        <div className="ds-session-chips" data-testid="ds-session-chips">
                          {sessionChips}
                        </div>
                      </li>
                    );
                  })}
                  {filteredSessions.length === 0 && (
                    <li className="ds-session-empty">
                      {filterMode === 'ai' && !aiMatchedIds
                        ? '在上方输入描述并点击「开始挑选」，即可由 AI 帮你找出对应对话。'
                        : '没有符合条件的对话。可以清除搜索或切换筛选方式。'}
                    </li>
                  )}
                </ul>
              </div>
            </>
          ) : (
            <div className="ds-session-empty" data-testid="ds-session-empty">
              <strong>没有找到可导入的历史对话</strong>
              <p>请确认这是 DeepSeek「设置 → 数据管理」导出的 .zip 包，或改用直接粘贴设定导入。</p>
              <button type="button" className="text-action" onClick={handleBack}>重新选择导出包</button>
            </div>
          )}
        </div>
      )}

      <SheetDialog
        open={Boolean(preview && previewSessionId && !receipt)}
        title={preview?.title ?? '对话预览'}
        label="DeepSeek 对话预览"
        testId="deepseek-preview-sheet"
        onClose={() => setPreviewSessionId(null)}
        onExitComplete={() => {
          const trigger = previewTriggerRef.current;
          const target = trigger?.isConnected && trigger.getClientRects().length > 0
            ? trigger
            : document.querySelector<HTMLElement>('[data-testid="ds-session-preview-trigger"]');
          target?.focus();
        }}
      >
        {preview && previewTreeStory && (
          <div className="ds-preview-content" data-testid="deepseek-preview-card">
            <div className="story-review-meta">
              <span>{preview.turnCount} 轮</span>
              <span>{preview.forkCount} 条分支</span>
              {preview.diagnosticCount > 0 && (
                <span>含 {preview.diagnosticCount} 处原平台未完整生成</span>
              )}
            </div>
            {preview.latestSnippet && (
              <div className="story-review-summary">
                <strong>最近进度</strong>
                <span>{preview.latestSnippet}</span>
              </div>
            )}
            {preview.recoveredAttachments.length > 0 && (
              <div className="import-attachment-note">
                <strong>已整理进故事设定</strong>
                <span>{preview.recoveredAttachments.map((attachment) => attachment.fileName).join('、')}（原文件也会保留在设定底部按需下载）</span>
              </div>
            )}
            {(() => {
              const skippedSummary = summarizeSkippedAttachments(preview.skippedAttachments);
              if (!skippedSummary.hasMedia && skippedSummary.otherItems.length === 0) return null;
              return (
                <div className="import-attachment-note" role="note">
                  <strong>原文件备查</strong>
                  {skippedSummary.hasMedia && <span>图片与 PDF 仅保留原文件备查。</span>}
                  {skippedSummary.otherItems.length > 0 && (
                    <ul>
                      {skippedSummary.otherItems.map((attachment) => (
                        <li key={attachment.fileName}>
                          {attachment.fileName}{attachment.hint ? `：${attachment.hint}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}
            {preview.diagnosticCount > 0 && (
              <div className="import-attachment-note" role="note">
                <strong>原平台生成提示</strong>
                <span>部分历史回复在原平台未完整生成，导入后会保留记录，不影响继续故事。</span>
              </div>
            )}
            <StoryTree story={previewTreeStory} defaultExpanded={preview.forkCount > 0} />
          </div>
        )}
      </SheetDialog>
    </OverlayPageShell>
  );
}
