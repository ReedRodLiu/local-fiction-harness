import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, FileUp, Link2 } from 'lucide-react';
import {
  DEFAULT_ZIP_MAX_BYTES,
  UnsupportedDeepSeekExportVersionError,
  assistFilterDeepSeekSessions,
  isAbortError,
  previewDeepSeekSessions,
  scanDeepSeekExportZip,
  type BinaryDownloader,
  type DeepSeekImportBatchResult,
  type DeepSeekSessionIndexItem,
  type DeepSeekStructureStats,
  type DiagnosticCollector,
  type DeepSeekZipScanResult,
  type ImportSummaryStatus,
  type LlmTransport,
  type ModelConfig,
  type ScriptTurnRange,
} from '../harness/index.ts';
import { StoryTree } from './StoryTree.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import { toErrorMessage } from './textHelpers.ts';

const SUMMARY_STATUS_LABELS: Record<ImportSummaryStatus, string> = {
  compressed: '已压缩',
  within_window: '近期窗口内',
  pending_key: '待配置密钥',
};

type DeepSeekSourceMode = 'file' | 'url';
type DeepSeekFilterMode = 'all' | 'likely' | 'ai';

const SOURCE_TABS: ReadonlyArray<{ id: DeepSeekSourceMode; label: string }> = [
  { id: 'file', label: '本地 .zip' },
  { id: 'url', label: 'HTTPS 下载链接' },
];

const FILTER_TABS: ReadonlyArray<{ id: DeepSeekFilterMode; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'likely', label: '疑似文游' },
  { id: 'ai', label: 'AI 辅助筛选' },
];

function moveTabSelection<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  currentId: T,
  tabs: ReadonlyArray<{ id: T }>,
  onSelect: (id: T) => void,
  idPrefix: string,
) {
  const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (currentIndex < 0 || direction === 0) return;
  event.preventDefault();
  const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
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

interface DeepSeekImportPanelProps {
  config: ModelConfig;
  transport: LlmTransport;
  binaryDownloader: BinaryDownloader;
  hasCredentials: boolean;
  onRequireByok: (actionLabel: string, resume: (resolvedConfig: ModelConfig) => void) => void;
  onImportBatch: (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptRangeOverrides: Record<string, ScriptTurnRange>,
  ) => Promise<DeepSeekImportBatchResult>;
  onContinueStory: (storyId: string) => void;
  diagnostics: DiagnosticCollector;
  onPackageDiagnostics: () => void;
  onCancel?: () => void;
}

export function DeepSeekImportPanel({
  config,
  transport,
  binaryDownloader,
  hasCredentials,
  onRequireByok,
  onImportBatch,
  onContinueStory,
  diagnostics,
  onPackageDiagnostics,
  onCancel,
}: DeepSeekImportPanelProps) {
  const [sourceMode, setSourceMode] = useState<DeepSeekSourceMode>('file');
  const [zipUrl, setZipUrl] = useState('');
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const urlAbortRef = useRef<AbortController | null>(null);
  const [loadedSource, setLoadedSource] = useState<'zip_file' | 'url'>('zip_file');
  const [zipBytes, setZipBytes] = useState<Uint8Array | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [scanResult, setScanResult] = useState<DeepSeekZipScanResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<DeepSeekFilterMode>('all');
  const [aiMatchedIds, setAiMatchedIds] = useState<Set<string> | null>(null);
  const [isAiFiltering, setIsAiFiltering] = useState(false);
  const [scriptRangeOverrides, setScriptRangeOverrides] = useState<Record<string, ScriptTurnRange>>(
    {},
  );
  const [isImporting, setIsImporting] = useState(false);
  const [receipt, setReceipt] = useState<DeepSeekImportBatchResult | null>(null);
  const [importError, setImportError] = useState<DeepSeekImportError | null>(null);
  const zipGenerationRef = useRef(0);
  const zipReadSeqRef = useRef(0);
  const aiAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      zipReadSeqRef.current += 1;
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      zipGenerationRef.current += 1;
      urlAbortRef.current?.abort();
    };
  }, []);

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
    zipGenerationRef.current += 1;
    setAiMatchedIds(null);
    setIsAiFiltering(false);
    setFilterMode('all');
  };

  const loadZipBytes = (bytes: Uint8Array, source: 'zip_file' | 'url', startedAt: number) => {
    invalidateAiFilter();
    const scanned = scanDeepSeekExportZip(bytes);
    if (scanned.sessions.length === 0) {
      recordScanFailure(
        new Error('DeepSeek 导出包中没有可导入的会话。'),
        source,
        Date.now() - startedAt,
        scanned.structure,
      );
      setImportError({
        kind: 'empty_zip',
        message: '这个 .zip 文件中没有可导入的会话。请换一个 DeepSeek 数据导出包，或使用自由剧本导入。',
      });
    } else {
      setImportError(null);
    }
    setLoadedSource(source);
    setZipBytes(bytes);
    setScanResult(scanned);
    setScriptRangeOverrides({});
    const firstLikely = scanned.sessions.find((s) => s.isLikelyFiction) ?? scanned.sessions[0];
    setSelectedIds(firstLikely ? [firstLikely.sessionId] : []);
    setPreviewSessionId(null);
  };

  const resetLoadedZip = () => {
    zipReadSeqRef.current += 1;
    invalidateAiFilter();
    setZipBytes(null);
    setScanResult(null);
    setSelectedIds([]);
    setPreviewSessionId(null);
    if (zipInputRef.current) zipInputRef.current.value = '';
  };

  const handleZipFile = async (file: File) => {
    const readSeq = ++zipReadSeqRef.current;
    invalidateAiFilter();
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

  const filteredSessions = useMemo<DeepSeekSessionIndexItem[]>(() => {
    if (!scanResult) return [];
    const q = searchQuery.trim().toLowerCase();
    return scanResult.sessions.filter((s) => {
      if (filterMode === 'likely' && !s.isLikelyFiction) return false;
      if (filterMode === 'ai' && !aiMatchedIds?.has(s.sessionId)) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.firstSnippet.toLowerCase().includes(q) ||
        s.latestSnippet.toLowerCase().includes(q)
      );
    });
  }, [scanResult, searchQuery, filterMode, aiMatchedIds]);

  const preview = useMemo(() => {
    if (!zipBytes || !previewSessionId) return null;
    try {
      return previewDeepSeekSessions(zipBytes, [previewSessionId], { scriptRangeOverrides })[0] ?? null;
    } catch {
      return null;
    }
  }, [zipBytes, previewSessionId, scriptRangeOverrides]);

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
  ) => {
    if (zipGeneration !== zipGenerationRef.current || isAiFiltering) return;
    setImportError(null);
    setIsAiFiltering(true);
    const controller = new AbortController();
    aiAbortRef.current = controller;
    try {
      const ids = await assistFilterDeepSeekSessions(sessions, transport, cfg, controller.signal);
      if (controller.signal.aborted || zipGeneration !== zipGenerationRef.current) return;
      setAiMatchedIds(new Set(ids));
      setFilterMode('ai');
    } catch (err) {
      if (
        controller.signal.aborted ||
        isAbortError(err) ||
        zipGeneration !== zipGenerationRef.current
      ) {
        return;
      }
      setImportError({
        kind: 'ai_filter',
        message: toErrorMessage(err, 'AI 辅助筛选失败，请检查模型配置。'),
      });
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        if (zipGeneration === zipGenerationRef.current) setIsAiFiltering(false);
      }
    }
  };

  const handleAiAssistClick = () => {
    if (!scanResult) return;
    if (aiMatchedIds) {
      setFilterMode('ai');
      return;
    }
    const zipGeneration = zipGenerationRef.current;
    const sessions = scanResult.sessions;
    if (!hasCredentials) {
      onRequireByok('AI 辅助筛选 DeepSeek 会话', (cfg) => {
        void runAiAssistFilter(cfg, zipGeneration, sessions);
      });
      return;
    }
    void runAiAssistFilter(config, zipGeneration, sessions);
  };

  const selectSourceMode = (nextMode: DeepSeekSourceMode) => {
    if (nextMode === 'file') {
      urlAbortRef.current?.abort();
    } else {
      zipReadSeqRef.current += 1;
    }
    setSourceMode(nextMode);
    setImportError(null);
  };

  const selectFilterMode = (nextMode: DeepSeekFilterMode) => {
    if (nextMode === 'ai') {
      handleAiAssistClick();
      return;
    }
    setFilterMode(nextMode);
  };

  const handleConfirmImport = async () => {
    if (!zipBytes || selectedIds.length === 0 || isImporting) return;
    const startedAt = Date.now();
    setImportError(null);
    setIsImporting(true);
    try {
      const result = await onImportBatch(zipBytes, selectedIds, scriptRangeOverrides);
      const confidenceCounts = { strong: 0, ambiguous: 0 };
      for (const p of result.previews) confidenceCounts[p.scriptConfidence] += 1;
      recordImportRadar(
        scanResult?.structure, loadedSource, 'success', selectedIds.length,
        Date.now() - startedAt, confidenceCounts,
      );
      setReceipt(result);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      recordImportRadar(scanResult?.structure, loadedSource, 'error', selectedIds.length, durationMs);
      diagnostics.recordError({
        category: 'import',
        action: 'deepseek_import_error',
        error: err,
        durationMs,
      });
      setImportError({
        kind: 'import',
        message: toErrorMessage(err, '导入所选故事失败。'),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const updateScriptRange = (sessionId: string, edge: 'start' | 'end', rawValue: string) => {
    const val = Number(rawValue);
    setScriptRangeOverrides((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(val) || val < 1) {
        delete next[sessionId];
        return next;
      }
      const n = Math.floor(val);
      const current = prev[sessionId];
      next[sessionId] =
        edge === 'start'
          ? { startTurn: n, endTurn: Math.max(n, current?.endTurn ?? n) }
          : { startTurn: Math.min(n, current?.startTurn ?? 1), endTurn: n };
      return next;
    });
  };

  const step = receipt ? 3 : scanResult ? 2 : 1;
  const primaryStory = receipt?.stories[0];
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
        继续这条故事
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
      disabled={selectedIds.length === 0 || isImporting}
      onClick={() => void handleConfirmImport()}
    >
      {isImporting ? '正在导入…' : `确认导入（已选 ${selectedIds.length} 部故事）`}
    </button>
  ) : sourceMode === 'url' ? (
    isFetchingUrl ? (
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
        className="btn btn-primary import-primary-action"
        data-testid="deepseek-fetch-zip"
        disabled={!zipUrl.trim()}
        onClick={() => void handleFetchZipUrl()}
      >
        拉取并预览
      </button>
    )
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
      title="从 DeepSeek 继续"
      testId="deepseek-import-panel"
      step={step}
      stepCount={3}
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
                    setSourceMode('file');
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
                  setSourceMode('file');
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
                onClick={handleAiAssistClick}
              >
                重试 AI 筛选
              </button>
            )}
            {importError.kind === 'import' && (
              <button
                type="button"
                className="text-action"
                data-testid="import-error-action-retry-import"
                onClick={() => void handleConfirmImport()}
              >
                重试导入
              </button>
            )}
            <button type="button" className="text-action" onClick={onPackageDiagnostics}>
              打包排障日志
            </button>
          </div>
        </BannerAlert>
      )}

      {receipt ? (
        <div className="import-step-content" data-testid="deepseek-import-receipt">
          <div className="import-intro">
            <h2>故事已导入</h2>
            <p>所选外部会话已分别保存为本地故事，原始剧本定位到最新激活节点。</p>
          </div>
          <div className="import-receipt-summary">
            <strong>新增 {receipt.stories.length} 部独立故事</strong>
            <span className="badge badge-ok">已保存在本机</span>
          </div>
          <ul className="ds-receipt-list">
            {receipt.previews.map((item, index) => {
              const savedStory = receipt.stories[index] ?? item.story;
              const status = receipt.summaryStatuses[savedStory.id] ?? 'within_window';
              return (
                <li key={savedStory.id} className="ds-receipt-item">
                  <div className="ds-receipt-heading">
                    <strong>{savedStory.title}</strong>
                    <span className="badge">{SUMMARY_STATUS_LABELS[status]}</span>
                  </div>
                  <span className="status-text">{item.turnCount} 轮 · {item.forkCount} 处分叉</span>
                  {item.recoveredAttachments.length > 0 && (
                    <span className="status-text">
                      已恢复附件：{item.recoveredAttachments.map((attachment) => attachment.fileName).join('、')}
                    </span>
                  )}
                  {item.skippedAttachments.length > 0 && (
                    <div className="turn-diagnostics" role="note">
                      已跳过附件：{item.skippedAttachments
                        .map((attachment) => `${attachment.fileName}${attachment.hint ? `（${attachment.hint}）` : ''}`)
                        .join('；')}
                    </div>
                  )}
                  {receipt.stories.length > 1 && (
                    <button type="button" className="text-action" onClick={() => onContinueStory(savedStory.id)}>
                      继续《{savedStory.title}》
                    </button>
                  )}
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
            <span className="import-privacy-pill">免密钥本地读取</span>
            <h2>选择 DeepSeek 导出包</h2>
            <p>本地按需筛选会话、预览剧情树和附件。文件只在此设备解析，无需提前填写 API Key。</p>
          </div>
          <div className="ds-source-tabs" role="tablist" aria-label="导入来源">
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`deepseek-source-tab-${tab.id}`}
                type="button"
                role="tab"
                data-testid={`deepseek-source-${tab.id}`}
                aria-selected={sourceMode === tab.id}
                aria-controls="deepseek-source-panel"
                tabIndex={sourceMode === tab.id ? 0 : -1}
                className={`btn ${sourceMode === tab.id ? 'is-selected' : ''}`}
                onClick={() => selectSourceMode(tab.id)}
                onKeyDown={(event) =>
                  moveTabSelection(
                    event,
                    sourceMode,
                    SOURCE_TABS,
                    selectSourceMode,
                    'deepseek-source-tab-',
                  )}
              >
                {tab.id === 'file'
                  ? <FileUp size={17} strokeWidth={1.75} />
                  : <Link2 size={17} strokeWidth={1.75} />}
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id="deepseek-source-panel"
            role="tabpanel"
            aria-labelledby={`deepseek-source-tab-${sourceMode}`}
            tabIndex={0}
          >
            {sourceMode === 'file' ? (
              <div className="import-file-card ds-file-card">
                <button
                  type="button"
                  className="import-file-picker"
                  data-testid="deepseek-zip-picker"
                  onClick={() => zipInputRef.current?.click()}
                >
                  <FileUp size={24} strokeWidth={1.6} aria-hidden="true" />
                  <span className="import-file-title">选择 DeepSeek 数据导出包</span>
                  <span className="import-file-description">从「设置 → 数据管理」导出的 .zip 文件</span>
                  <span className="import-file-action">浏览文件</span>
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
            ) : (
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
                  下载链接会由浏览器直接拉取。若链接要求登录或来源站点限制跨域，可切换为本地 .zip 文件。
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="import-step-content">
          <div className="import-intro">
            <h2>筛选外部会话</h2>
            <p>每条勾选会话会独立创建为一部故事。点击右侧箭头可查看最近进度、附件和剧情树。</p>
          </div>
          {scanResult && scanResult.sessions.length > 0 ? (
            <>
              {isImporting && (
                <p className="status-text" role="status" data-testid="deepseek-import-busy">
                  正在导入并保存所选故事，请稍候。完成后会显示导入回执。
                </p>
              )}
              <div className="ds-toolbar">
                <input
                  type="search"
                  aria-label="搜索外部会话"
                  placeholder="搜索标题或最近片段…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <div className="ds-filter-tabs" role="tablist" aria-label="筛选会话">
                  {FILTER_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      id={`deepseek-filter-tab-${tab.id}`}
                      type="button"
                      role="tab"
                      aria-selected={filterMode === tab.id}
                      aria-controls="deepseek-filter-panel"
                      tabIndex={filterMode === tab.id ? 0 : -1}
                      disabled={tab.id === 'ai' && isAiFiltering}
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
                      {tab.id === 'ai' && isAiFiltering ? 'AI 筛选中…' : tab.label}
                    </button>
                  ))}
                </div>
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
                      onClick={() => setSelectedIds((current) => [...new Set([
                        ...current,
                        ...filteredSessions.map((session) => session.sessionId),
                      ])])}
                    >
                      全选
                    </button>
                    <button type="button" className="text-action" onClick={() => setSelectedIds([])}>
                      清空
                    </button>
                  </div>
                </div>
                {filterMode === 'ai' && !aiMatchedIds && !isAiFiltering && (
                  <p className="status-text">选择「AI 辅助筛选」后会连接你配置的模型，结果只用于本次筛选。</p>
                )}
                <ul className="ds-session-list" data-testid="ds-session-list" aria-label="外部会话列表">
                  {filteredSessions.map((session) => {
                    const checked = selectedIds.includes(session.sessionId);
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
                            onClick={() => setPreviewSessionId(session.sessionId)}
                          >
                            <ChevronRight size={19} strokeWidth={1.75} />
                          </button>
                        </div>
                        <p className="ds-session-latest">{session.latestSnippet || session.firstSnippet || '暂无剧情片段'}</p>
                        <div className="ds-session-chips">
                          <span className="badge">{session.turnCount} 轮</span>
                          {session.forkCount > 0 && <span className="badge">⑂ {session.forkCount}</span>}
                          {(session.attachments.length > 0 || session.diagnosticCount > 0) && (
                            <span className={`badge ${session.diagnosticCount > 0 ? 'badge-warn' : ''}`}>
                              {session.attachments.length > 0 ? `${session.attachments.length} 附件` : ''}
                              {session.attachments.length > 0 && session.diagnosticCount > 0 ? ' · ' : ''}
                              {session.diagnosticCount > 0 ? `⚠ ${session.diagnosticCount}` : ''}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {filteredSessions.length === 0 && (
                    <li className="ds-session-empty">没有符合条件的会话。可以清除搜索或切换筛选方式。</li>
                  )}
                </ul>
              </div>
            </>
          ) : (
            <div className="ds-session-empty" data-testid="ds-session-empty">
              <strong>没有找到可导入的外部会话</strong>
              <p>请确认这是 DeepSeek 设置中的数据管理导出包，或使用自由剧本导入。</p>
              <button type="button" className="text-action" onClick={handleBack}>重新选择来源</button>
            </div>
          )}
        </div>
      )}

      <SheetDialog
        open={Boolean(preview && previewSessionId && !receipt)}
        title={preview?.title ?? '外部会话预览'}
        label="DeepSeek 外部会话预览"
        testId="deepseek-preview-sheet"
        onClose={() => setPreviewSessionId(null)}
      >
        {preview && (
          <div className="ds-preview-content" data-testid="deepseek-preview-card">
            <div className="story-review-meta">
              <span>{preview.turnCount} 轮</span>
              <span>{preview.forkCount} 处分叉</span>
              <span>原始剧本 {preview.rawScript.length} 字</span>
              <span data-testid="ds-script-range-status">
                {scriptRangeOverrides[preview.sessionId]
                  ? '已手动调整原始剧本边界'
                  : preview.scriptConfidence === 'strong'
                    ? '已识别原始剧本边界'
                    : '原始剧本边界待确认'}
              </span>
              {preview.diagnosticCount > 0 && <span>{preview.diagnosticCount} 条只读平台诊断</span>}
            </div>
            {preview.latestSnippet && (
              <div className="story-review-summary">
                <strong>最近进度</strong>
                <span>{preview.latestSnippet}</span>
              </div>
            )}
            {preview.recoveredAttachments.length > 0 && (
              <div className="import-attachment-note">
                <strong>可恢复附件</strong>
                <span>{preview.recoveredAttachments.map((attachment) => attachment.fileName).join('、')}</span>
              </div>
            )}
            {preview.skippedAttachments.length > 0 && (
              <div className="turn-diagnostics" role="note">
                <strong>跳过的附件</strong>
                <ul>
                  {preview.skippedAttachments.map((attachment) => (
                    <li key={attachment.fileName}>
                      {attachment.fileName}{attachment.hint ? `：${attachment.hint}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <StoryTree story={preview.story} defaultExpanded={preview.forkCount > 0} />
            <details className="import-range-details">
              <summary>手动调整原始剧本起点/终点</summary>
              <p className="status-text">留空时会自动识别原始剧本边界。</p>
              <div className="import-range-fields">
                <div className="field">
                  <label htmlFor="ds-script-start">起始玩家轮次</label>
                  <input
                    id="ds-script-start"
                    type="number"
                    min={1}
                    max={Math.max(1, preview.turnCount)}
                    value={scriptRangeOverrides[preview.sessionId]?.startTurn ?? ''}
                    placeholder="自动识别"
                    onChange={(event) => updateScriptRange(preview.sessionId, 'start', event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ds-script-end">结束玩家轮次</label>
                  <input
                    id="ds-script-end"
                    type="number"
                    min={1}
                    max={Math.max(1, preview.turnCount)}
                    value={scriptRangeOverrides[preview.sessionId]?.endTurn ?? ''}
                    placeholder="自动识别"
                    onChange={(event) => updateScriptRange(preview.sessionId, 'end', event.target.value)}
                  />
                </div>
              </div>
            </details>
          </div>
        )}
      </SheetDialog>
    </OverlayPageShell>
  );
}
