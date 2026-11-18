import { useMemo, useState } from 'react';
import {
  assistFilterDeepSeekSessions,
  computeActiveReviewState,
  previewDeepSeekSessions,
  scanDeepSeekExportZip,
  type DeepSeekImportBatchResult,
  type DeepSeekSessionIndexItem,
  type DeepSeekZipScanResult,
  type LlmTransport,
  type ModelConfig,
} from '../harness/index.ts';
import { StoryTree } from './StoryTree.tsx';
import { toErrorMessage } from './textHelpers.ts';

interface DeepSeekImportPanelProps {
  config: ModelConfig;
  transport: LlmTransport;
  hasCredentials: boolean;
  onRequireByok: (actionLabel: string, resume: (resolvedConfig: ModelConfig) => void) => void;
  onImportBatch: (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptTurnOverrides: Record<string, number>,
  ) => Promise<DeepSeekImportBatchResult>;
  onContinueStory: (storyId: string) => void;
}

export function DeepSeekImportPanel({
  config,
  transport,
  hasCredentials,
  onRequireByok,
  onImportBatch,
  onContinueStory,
}: DeepSeekImportPanelProps) {
  const [zipBytes, setZipBytes] = useState<Uint8Array | null>(null);
  const [scanResult, setScanResult] = useState<DeepSeekZipScanResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyLikelyFiction, setOnlyLikelyFiction] = useState(false);
  const [aiMatchedIds, setAiMatchedIds] = useState<Set<string> | null>(null);
  const [isAiFiltering, setIsAiFiltering] = useState(false);
  const [scriptTurnOverrides, setScriptTurnOverrides] = useState<Record<string, number>>({});
  const [isImporting, setIsImporting] = useState(false);
  const [receipt, setReceipt] = useState<DeepSeekImportBatchResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleZipFile = async (file: File) => {
    setErrorMsg(null);
    setReceipt(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const scanned = scanDeepSeekExportZip(buf);
      setZipBytes(buf);
      setScanResult(scanned);
      setAiMatchedIds(null);
      setScriptTurnOverrides({});
      const firstLikely = scanned.sessions.find((s) => s.isLikelyFiction) ?? scanned.sessions[0];
      setSelectedIds(firstLikely ? [firstLikely.sessionId] : []);
      setPreviewSessionId(firstLikely?.sessionId ?? null);
    } catch (err) {
      setZipBytes(null);
      setScanResult(null);
      setSelectedIds([]);
      setPreviewSessionId(null);
      setErrorMsg(toErrorMessage(err, '解析 DeepSeek 导出 .zip 文件失败。'));
    }
  };

  const filteredSessions = useMemo<DeepSeekSessionIndexItem[]>(() => {
    if (!scanResult) return [];
    const q = searchQuery.trim().toLowerCase();
    return scanResult.sessions.filter((s) => {
      const isFiction = s.isLikelyFiction || Boolean(aiMatchedIds?.has(s.sessionId));
      if (onlyLikelyFiction && !isFiction) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.firstSnippet.toLowerCase().includes(q) ||
        s.latestSnippet.toLowerCase().includes(q)
      );
    });
  }, [scanResult, searchQuery, onlyLikelyFiction, aiMatchedIds]);

  const activePreviewId = useMemo(() => {
    if (previewSessionId && selectedIds.includes(previewSessionId)) {
      return previewSessionId;
    }
    return selectedIds[0] ?? previewSessionId;
  }, [previewSessionId, selectedIds]);

  const preview = useMemo(() => {
    if (!zipBytes || !activePreviewId) return null;
    try {
      return previewDeepSeekSessions(zipBytes, [activePreviewId], { scriptTurnOverrides })[0] ?? null;
    } catch {
      return null;
    }
  }, [zipBytes, activePreviewId, scriptTurnOverrides]);

  const toggleSelect = (sessionId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(sessionId)) {
        return prev.filter((id) => id !== sessionId);
      }
      setPreviewSessionId(sessionId);
      return [...prev, sessionId];
    });
  };

  const runAiAssistFilter = async (cfg: ModelConfig) => {
    if (!scanResult || isAiFiltering) return;
    setErrorMsg(null);
    setIsAiFiltering(true);
    try {
      const ids = await assistFilterDeepSeekSessions(scanResult.sessions, transport, cfg);
      setAiMatchedIds(new Set(ids));
    } catch (err) {
      setErrorMsg(toErrorMessage(err, 'AI 辅助筛选失败，请检查模型配置。'));
    } finally {
      setIsAiFiltering(false);
    }
  };

  const handleAiAssistClick = () => {
    if (!scanResult) return;
    if (!hasCredentials) {
      onRequireByok('AI 辅助筛选 DeepSeek 会话', (cfg) => {
        void runAiAssistFilter(cfg);
      });
      return;
    }
    void runAiAssistFilter(config);
  };

  const handleConfirmImport = async () => {
    if (!zipBytes || selectedIds.length === 0 || isImporting) return;
    setErrorMsg(null);
    setIsImporting(true);
    try {
      const result = await onImportBatch(zipBytes, selectedIds, scriptTurnOverrides);
      setReceipt(result);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '导入所选故事失败。'));
    } finally {
      setIsImporting(false);
    }
  };

  if (receipt) {
    const primaryStory = receipt.stories[0];
    return (
      <div className="ds-import-box" data-testid="deepseek-import-receipt">
        <div className="panel-header">
          <h4>导入完成回执</h4>
          <span className="badge">新增 {receipt.stories.length} 部独立故事</span>
        </div>
        <ul className="ds-receipt-list">
          {receipt.previews.map((item, idx) => {
            const savedStory = receipt.stories[idx] ?? item.story;
            const review = computeActiveReviewState(savedStory);
            const summaryLabel = review.needsSummaryCompression
              ? '超窗摘要待配置密钥后按需补算'
              : '近期窗口内无需压缩';
            return (
              <li key={savedStory.id} className="ds-receipt-item">
                <div className="story-tree-row-top">
                  <strong>{savedStory.title}</strong>
                  <span className="status-text">
                    {item.turnCount} 轮 · {item.forkCount} 处分叉 · {summaryLabel}
                  </span>
                </div>
                {item.recoveredAttachments.length > 0 && (
                  <div className="status-text">
                    已恢复附件：{item.recoveredAttachments.map((a) => a.fileName).join('、')}
                  </div>
                )}
                {item.skippedAttachments.length > 0 && (
                  <div className="status-text">
                    已跳过附件：{item.skippedAttachments.map((a) => a.fileName).join('、')}
                  </div>
                )}
                {receipt.stories.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onContinueStory(savedStory.id)}
                  >
                    继续《{savedStory.title}》
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {primaryStory && (
          <div className="composer-actions">
            <span className="status-text">已自动定位至原对话最新激活节点（current_message_id）</span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onContinueStory(primaryStory.id)}
            >
              继续这条故事
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ds-import-box" data-testid="deepseek-import-panel">
      {errorMsg && (
        <div className="error-banner" role="alert">
          {errorMsg}
        </div>
      )}

      <div className="notice-box" role="note">
        <strong>免密钥本地预览：</strong>
        选择 DeepSeek「设置 → 数据管理」导出的 <code>.zip</code> 包，本地按需筛选、预览剧情树与附件并保存故事，<strong>无需提前填写 API Key</strong>。
      </div>

      <div className="field">
        <label htmlFor="deepseek-zip-input">选择本地 DeepSeek 导出压缩包（.zip）</label>
        <input
          id="deepseek-zip-input"
          name="deepseekZip"
          type="file"
          accept=".zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void handleZipFile(file);
            }
          }}
        />
      </div>

      {scanResult && (
        <>
          <div className="ds-toolbar">
            <input
              type="search"
              aria-label="搜索 DeepSeek 会话"
              placeholder="搜索标题或首句片段…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={onlyLikelyFiction}
                onChange={(e) => setOnlyLikelyFiction(e.target.checked)}
              />
              <span>仅看疑似文游</span>
            </label>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isAiFiltering}
              onClick={handleAiAssistClick}
            >
              {isAiFiltering ? 'AI 筛选中…' : 'AI 辅助筛选'}
            </button>
          </div>

          <div className="composer-actions">
            <span className="status-text">
              共 {scanResult.sessions.length} 条会话 · 当前显示 {filteredSessions.length} 条 · 已勾选{' '}
              {selectedIds.length} 条
            </span>
            <div className="btn-group">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  setSelectedIds(filteredSessions.map((s) => s.sessionId))
                }
              >
                全选当前筛选
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSelectedIds([])}
              >
                取消全选
              </button>
            </div>
          </div>

          <ul className="ds-session-list" aria-label="DeepSeek 导出会话列表">
            {filteredSessions.map((s) => {
              const checked = selectedIds.includes(s.sessionId);
              const aiHit = aiMatchedIds?.has(s.sessionId);
              return (
                <li
                  key={s.sessionId}
                  className={`ds-session-item ${activePreviewId === s.sessionId ? 'active' : ''}`}
                >
                  <label className="ds-session-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(s.sessionId)}
                    />
                    <span className="ds-session-title">
                      {s.title}
                      {s.hasNullTitle ? '（自动命名）' : ''}
                    </span>
                  </label>
                  <div className="ds-session-meta">
                    {(s.isLikelyFiction || aiHit) && (
                      <span className="badge">{aiHit ? 'AI 识别文游' : '疑似文游'}</span>
                    )}
                    <span className="status-text">{s.turnCount} 轮</span>
                    {s.forkCount > 0 && <span className="badge">⑂ {s.forkCount}</span>}
                    {s.attachments.length > 0 && (
                      <span className="status-text">{s.attachments.length} 附件</span>
                    )}
                    {s.diagnosticCount > 0 && (
                      <span className="badge badge-warn">⚠ {s.diagnosticCount}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPreviewSessionId(s.sessionId)}
                    >
                      预览
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {preview && (
            <div className="blueprint-editor" data-testid="deepseek-preview-card">
              <div className="panel-header">
                <h4>导入前预览：{preview.title}</h4>
                <span className="badge">
                  {preview.scriptConfidence === 'strong' ? '已自动锁定剧本' : '开局待确认'}
                </span>
              </div>

              <div className="story-review-meta">
                <span>轮次：{preview.turnCount} 轮</span>
                <span>分叉点：{preview.forkCount} 处</span>
                <span>原始剧本：{preview.rawScript.length} 字符</span>
                {preview.diagnosticCount > 0 && (
                  <span>含 {preview.diagnosticCount} 条只读平台诊断标记</span>
                )}
              </div>

              {preview.latestSnippet && (
                <div className="story-review-summary">
                  <strong>最后进度片段：</strong>
                  <span>{preview.latestSnippet}</span>
                </div>
              )}

              {preview.recoveredAttachments.length > 0 && (
                <div className="status-text">
                  <strong>可恢复文本附件：</strong>
                  {preview.recoveredAttachments.map((a) => a.fileName).join('、')}
                </div>
              )}

              {preview.skippedAttachments.length > 0 && (
                <div className="turn-diagnostics" role="note">
                  <strong>跳过的附件提示：</strong>
                  {preview.skippedAttachments
                    .map((a) => `${a.fileName}${a.hint ? `（${a.hint}）` : ''}`)
                    .join('；')}
                </div>
              )}

              <StoryTree story={preview.story} defaultExpanded={preview.forkCount > 0} />

              <details className="reasoning-details">
                <summary>手动调整原始剧本起点（可选，默认自动识别）</summary>
                <div className="field" style={{ marginTop: '0.4rem' }}>
                  <label htmlFor="ds-script-cutoff">将激活路径前 N 次玩家发言合并为原始剧本</label>
                  <input
                    id="ds-script-cutoff"
                    type="number"
                    min={1}
                    max={Math.max(1, preview.turnCount)}
                    value={scriptTurnOverrides[preview.sessionId] ?? ''}
                    placeholder="留空则使用自动识别结果"
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setScriptTurnOverrides((prev) => {
                        const next = { ...prev };
                        if (Number.isFinite(val) && val >= 1) {
                          next[preview.sessionId] = Math.floor(val);
                        } else {
                          delete next[preview.sessionId];
                        }
                        return next;
                      });
                    }}
                  />
                </div>
              </details>

              <div className="composer-actions">
                <span className="status-text">每条勾选会话将 1 对 1 独立创建为一部故事</span>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="ds-confirm-import-btn"
                  disabled={selectedIds.length === 0 || isImporting}
                  onClick={() => void handleConfirmImport()}
                >
                  {isImporting
                    ? '正在导入…'
                    : `确认本地导入（已选 ${selectedIds.length} 部故事）`}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
