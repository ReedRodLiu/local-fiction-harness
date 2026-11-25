import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  computeMarkdownDiff,
  normalizeProposalTarget,
  resolveProposalMarkdown,
  type AssistantMode,
  type DiffBlock,
  type DiffLine,
  type MarkdownDiffResult,
  type ProposalApplyFailureReason,
  type ProposalTarget,
  type TurnProposalRecord,
} from '../harness/index.ts';
import { MarkdownView } from './MarkdownView.tsx';

export type ProposalDetailTab = 'diff' | 'preview';

export interface ProposalCardComputedState {
  normalizedTarget: ProposalTarget;
  hasVersionDrift: boolean;
  hasConflict: boolean;
  rebasedAutomatically: boolean;
  conflictReason?: ProposalApplyFailureReason | 'full_replace_drift';
  resolvedMarkdown: string;
  diff: MarkdownDiffResult | null;
  stats: { added: number; removed: number };
}

export interface ProposalCardProps {
  proposal: TurnProposalRecord;
  currentMarkdown?: string;
  currentVersionId?: string;
  mode?: AssistantMode;
  targetLabel?: string;
  isBusy?: boolean;
  defaultExpanded?: boolean;
  defaultDetailTab?: ProposalDetailTab;
  testId?: string;
  onApply?: (proposal: TurnProposalRecord, resolvedMarkdown: string) => void | Promise<void>;
  onDismiss?: (proposal: TurnProposalRecord) => void | Promise<void>;
  onRevert?: (proposal: TurnProposalRecord) => void | Promise<void>;
  onOpenEditor?: (proposal: TurnProposalRecord) => void;
  onAskAiReorganize?: (proposal: TurnProposalRecord) => void;
}

export function getProposalTargetBadgeLabel(
  target: TurnProposalRecord['target'],
  mode: AssistantMode = 'story',
): string {
  const normalized = normalizeProposalTarget(target) ?? 'setting';
  switch (normalized) {
    case 'setting':
      if (mode === 'writing') return '作品设定';
      if (mode === 'character') return '角色设定';
      return '故事设定';
    case 'memory':
      return '我的记忆';
    case 'note':
      return '分支笔记';
    case 'draft':
      return '新开写故事';
    case 'story':
      return '新开文游';
    case 'manuscript':
      return '作品正文';
    case 'character':
      return '新建角色';
  }
}

function estimateFallbackStats(proposal: TurnProposalRecord): { added: number; removed: number } {
  const lines = proposal.body.replace(/\r\n?/g, '\n').split('\n');
  if (proposal.op === 'patch') {
    let added = 0;
    let removed = 0;
    let mode: 'outside' | 'search' | 'replace' = 'outside';
    for (const line of lines) {
      if (/^<<<<<<<\s*SEARCH\b/.test(line.trimEnd())) {
        mode = 'search';
      } else if (/^=======\s*$/.test(line.trimEnd())) {
        mode = 'replace';
      } else if (/^>>>>>>>\s*REPLACE\b/.test(line.trimEnd())) {
        mode = 'outside';
      } else if (mode === 'search' && line.trim() !== '') {
        removed += 1;
      } else if (mode === 'replace' && line.trim() !== '') {
        added += 1;
      }
    }
    if (added > 0 || removed > 0) {
      return { added, removed };
    }
  }
  const nonEmptyCount = lines.filter((line) => line.trim() !== '').length;
  return { added: nonEmptyCount, removed: 0 };
}

export function computeProposalCardState(
  proposal: TurnProposalRecord,
  currentMarkdown = '',
  currentVersionId?: string,
): ProposalCardComputedState {
  const normalizedTarget = normalizeProposalTarget(proposal.target) ?? 'setting';
  const hasVersionDrift = Boolean(
    proposal.baseVersionId && currentVersionId && proposal.baseVersionId !== currentVersionId,
  );

  if (proposal.status === 'needs_review') {
    return {
      normalizedTarget,
      hasVersionDrift,
      hasConflict: false,
      rebasedAutomatically: false,
      resolvedMarkdown: proposal.body,
      diff: null,
      stats: estimateFallbackStats(proposal),
    };
  }

  const isCreationTarget =
    normalizedTarget === 'character' || normalizedTarget === 'draft' || normalizedTarget === 'story';
  if (isCreationTarget) {
    const resolvedMarkdown = proposal.body;
    const diff = computeMarkdownDiff('', resolvedMarkdown);
    return {
      normalizedTarget,
      hasVersionDrift: false,
      hasConflict: false,
      rebasedAutomatically: false,
      resolvedMarkdown,
      diff,
      stats: { added: diff.stats.added, removed: diff.stats.removed },
    };
  }

  if (proposal.status !== 'pending') {
    const resolved = resolveProposalMarkdown(currentMarkdown, {
      op: proposal.op,
      body: proposal.body,
      heading: proposal.heading,
    });
    if (resolved.ok) {
      const diff = computeMarkdownDiff(currentMarkdown, resolved.markdown);
      const stats =
        diff.stats.added > 0 || diff.stats.removed > 0
          ? { added: diff.stats.added, removed: diff.stats.removed }
          : estimateFallbackStats(proposal);
      return {
        normalizedTarget,
        hasVersionDrift,
        hasConflict: false,
        rebasedAutomatically: false,
        resolvedMarkdown: resolved.markdown,
        diff,
        stats,
      };
    }
    return {
      normalizedTarget,
      hasVersionDrift,
      hasConflict: false,
      rebasedAutomatically: false,
      resolvedMarkdown: proposal.body,
      diff: null,
      stats: estimateFallbackStats(proposal),
    };
  }

  if (
    hasVersionDrift &&
    proposal.op === 'full' &&
    currentMarkdown.trim() !== '' &&
    currentMarkdown !== proposal.body
  ) {
    return {
      normalizedTarget,
      hasVersionDrift: true,
      hasConflict: true,
      rebasedAutomatically: false,
      conflictReason: 'full_replace_drift',
      resolvedMarkdown: proposal.body,
      diff: null,
      stats: estimateFallbackStats(proposal),
    };
  }

  const resolved = resolveProposalMarkdown(currentMarkdown, {
    op: proposal.op,
    body: proposal.body,
    heading: proposal.heading,
  });
  if (!resolved.ok) {
    return {
      normalizedTarget,
      hasVersionDrift,
      hasConflict: true,
      rebasedAutomatically: false,
      conflictReason: resolved.reason,
      resolvedMarkdown: proposal.body,
      diff: null,
      stats: estimateFallbackStats(proposal),
    };
  }

  const diff = computeMarkdownDiff(currentMarkdown, resolved.markdown);
  return {
    normalizedTarget,
    hasVersionDrift,
    hasConflict: false,
    rebasedAutomatically: hasVersionDrift,
    resolvedMarkdown: resolved.markdown,
    diff,
    stats: { added: diff.stats.added, removed: diff.stats.removed },
  };
}

function proposalStatusMeta(status: TurnProposalRecord['status']): {
  label: string;
  toneClass: string;
} {
  switch (status) {
    case 'pending':
      return { label: '待确认', toneClass: 'proposal-status-pending' };
    case 'applied':
      return { label: '已保存', toneClass: 'proposal-status-applied' };
    case 'reverted':
      return { label: '已撤销', toneClass: 'proposal-status-muted' };
    case 'dismissed':
      return { label: '已忽略', toneClass: 'proposal-status-muted' };
    case 'needs_review':
      return { label: '需手动核对', toneClass: 'proposal-status-warn' };
  }
}

function describeNeedsReviewReason(reason?: string): string {
  switch (reason) {
    case 'truncated_stream':
    case 'unclosed_fence':
      return '回复在生成途中中断，已完整保留已收到的内容，请手动核对后复制或编辑保存。';
    case 'missing_name':
      return '缺少角色或作品名称，你可以先复制内容再打开编辑器填写。';
    case 'empty_body':
      return '建议正文为空，未改动当前设定。';
    default:
      return '此修改建议格式略有偏差，已保留原始内容避免丢失，请核对后手动处理。';
  }
}

function renderDiffLineRow(line: DiffLine, key: string) {
  const rowClass =
    line.type === 'insert'
      ? 'diff-line diff-line-add'
      : line.type === 'delete'
        ? 'diff-line diff-line-del'
        : 'diff-line diff-line-ctx';
  const sign = line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' ';

  return (
    <div key={key} className={rowClass}>
      <span className="diff-line-num" aria-hidden="true">
        {line.oldLineNumber ?? ''}
      </span>
      <span className="diff-line-num" aria-hidden="true">
        {line.newLineNumber ?? ''}
      </span>
      <span className="diff-line-code">
        <span className="diff-line-sign" aria-hidden="true">
          {sign}{' '}
        </span>
        {line.inlineParts && line.inlineParts.length > 0
          ? line.inlineParts.map((part, idx) => {
              if (!part.highlight) return <span key={idx}>{part.text}</span>;
              return line.type === 'delete' ? (
                <del key={idx} className="diff-inline-del">
                  {part.text}
                </del>
              ) : (
                <ins key={idx} className="diff-inline-ins">
                  {part.text}
                </ins>
              );
            })
          : line.text || ' '}
      </span>
    </div>
  );
}

function renderDiffBlock(
  block: DiffBlock,
  index: number,
  expanded: boolean,
  onToggle: (idx: number) => void,
) {
  if (block.type === 'collapsed') {
    if (!expanded) {
      return (
        <div key={`collapsed-${index}`} className="diff-collapsed">
          <button
            type="button"
            className="diff-collapsed-btn"
            onClick={() => onToggle(index)}
          >
            展开未改动的 {block.hiddenCount} 行
          </button>
        </div>
      );
    }
    return (
      <div key={`collapsed-open-${index}`} className="diff-hunk">
        <div className="diff-collapsed">
          <button
            type="button"
            className="diff-collapsed-btn"
            onClick={() => onToggle(index)}
          >
            收起未改动的 {block.hiddenCount} 行
          </button>
        </div>
        {block.lines.map((line, lineIdx) => renderDiffLineRow(line, `c-${index}-${lineIdx}`))}
      </div>
    );
  }

  return (
    <div key={`hunk-${index}`} className="diff-hunk">
      {block.lines.map((line, lineIdx) => renderDiffLineRow(line, `h-${index}-${lineIdx}`))}
    </div>
  );
}

export function ProposalCard({
  proposal,
  currentMarkdown = '',
  currentVersionId,
  mode = 'story',
  targetLabel,
  isBusy = false,
  defaultExpanded = false,
  defaultDetailTab = 'diff',
  testId,
  onApply,
  onDismiss,
  onRevert,
  onOpenEditor,
  onAskAiReorganize,
}: ProposalCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [detailTab, setDetailTab] = useState<ProposalDetailTab>(defaultDetailTab);
  const [expandedCollapsedHunks, setExpandedCollapsedHunks] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState(false);

  const computed = useMemo(
    () => computeProposalCardState(proposal, currentMarkdown, currentVersionId),
    [proposal, currentMarkdown, currentVersionId],
  );

  const badgeLabel = targetLabel ?? getProposalTargetBadgeLabel(proposal.target, mode);
  const statusMeta = proposalStatusMeta(proposal.status);
  const summaryText = proposal.summary.trim() || `更新${badgeLabel}`;
  const targetNameSuffix = proposal.name?.trim() ? ` · ${proposal.name.trim()}` : '';

  const toggleCollapsedHunk = (index: number) => {
    setExpandedCollapsedHunks((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable in restricted contexts; user can still select raw text manually.
    }
  };

  const renderDiffView = () => {
    if (!computed.diff) {
      return (
        <pre className="proposal-raw-pre" data-testid="proposal-raw-fallback">
          {proposal.body}
        </pre>
      );
    }
    if (computed.diff.fuseTriggered && computed.diff.overview) {
      return (
        <div className="diff-view">
          <div className="diff-overview">
            文档改动范围较大（原 {computed.diff.overview.oldLineCount} 行 → 新{' '}
            {computed.diff.overview.newLineCount} 行），请切换「完整预览」核对。
          </div>
        </div>
      );
    }
    if (!computed.diff.hasChanges) {
      return (
        <div className="diff-view">
          <div className="diff-overview">与当前内容一致，暂无行级差异。</div>
        </div>
      );
    }
    return (
      <div className="diff-view" data-testid="proposal-diff-view">
        {computed.diff.hunks.map((block, index) =>
          renderDiffBlock(block, index, Boolean(expandedCollapsedHunks[index]), toggleCollapsedHunk),
        )}
      </div>
    );
  };

  return (
    <section
      className={`proposal-card proposal-card-${proposal.status}`}
      data-testid={testId ?? `proposal-card-${proposal.id}`}
      aria-label={`提案确认卡片：${badgeLabel}`}
    >
      <div className="proposal-card-header">
        <button
          type="button"
          className="proposal-card-toggle"
          aria-expanded={expanded}
          data-testid="proposal-card-toggle"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="proposal-card-chevron" aria-hidden="true">
            {expanded ? (
              <ChevronDown size={16} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={16} strokeWidth={1.75} />
            )}
          </span>
          <span className="proposal-target-badge" data-testid="proposal-target-badge">
            {badgeLabel}
            {targetNameSuffix}
          </span>
          <span className="proposal-summary" title={summaryText}>
            {summaryText}
          </span>
          <span className="proposal-stats" data-testid="proposal-diff-stats">
            +{computed.stats.added} -{computed.stats.removed} 行
          </span>
          <span className={`proposal-status-pill ${statusMeta.toneClass}`}>{statusMeta.label}</span>
        </button>

        {proposal.status === 'applied' && onRevert && (
          <button
            type="button"
            className="btn btn-sm proposal-inline-revert"
            data-testid="proposal-revert-btn"
            disabled={isBusy}
            onClick={() => void onRevert(proposal)}
          >
            <RotateCcw size={16} strokeWidth={1.75} />
            撤销此改动
          </button>
        )}
      </div>

      {expanded && (
        <div className="proposal-drawer" data-testid="proposal-drawer">
          {proposal.status === 'needs_review' ? (
            <div className="proposal-needs-review" data-testid="proposal-needs-review-body">
              <p className="proposal-hint">
                <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{describeNeedsReviewReason(proposal.reason)}</span>
              </p>
              <pre className="proposal-raw-pre">{proposal.raw ?? proposal.body}</pre>
              <div className="proposal-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="proposal-copy-raw-btn"
                  onClick={() => void handleCopyText(proposal.body || proposal.raw || '')}
                >
                  <Copy size={16} strokeWidth={1.75} />
                  {copied ? '已复制' : '复制内容'}
                </button>
                {onOpenEditor && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="proposal-open-editor-btn"
                    onClick={() => onOpenEditor(proposal)}
                  >
                    <Edit3 size={16} strokeWidth={1.75} />
                    打开设定编辑
                  </button>
                )}
                {onDismiss && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="proposal-dismiss-btn"
                    disabled={isBusy}
                    onClick={() => void onDismiss(proposal)}
                  >
                    <X size={16} strokeWidth={1.75} />
                    暂不采用
                  </button>
                )}
              </div>
            </div>
          ) : computed.hasConflict && proposal.status === 'pending' ? (
            <div className="proposal-conflict" data-testid="proposal-conflict-view">
              <p className="proposal-hint proposal-hint-warn">
                <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>内容已更新，你可以对照保留自己的修改或由 AI 重新整理</span>
              </p>
              <div className="proposal-conflict-grid">
                <div className="proposal-conflict-pane">
                  <h4>当前内容（你的最新修改）</h4>
                  <pre className="proposal-raw-pre">{currentMarkdown || '（空）'}</pre>
                </div>
                <div className="proposal-conflict-pane">
                  <h4>AI 建议内容</h4>
                  <pre className="proposal-raw-pre">{proposal.body}</pre>
                </div>
              </div>
              <div className="proposal-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="proposal-copy-raw-btn"
                  onClick={() => void handleCopyText(proposal.body)}
                >
                  <Copy size={16} strokeWidth={1.75} />
                  {copied ? '已复制' : '复制建议'}
                </button>
                {onOpenEditor && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="proposal-open-editor-btn"
                    onClick={() => onOpenEditor(proposal)}
                  >
                    <Edit3 size={16} strokeWidth={1.75} />
                    打开设定编辑
                  </button>
                )}
                {onAskAiReorganize && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="proposal-ai-reorganize-btn"
                    disabled={isBusy}
                    onClick={() => onAskAiReorganize(proposal)}
                  >
                    <Sparkles size={16} strokeWidth={1.75} />
                    由 AI 重新整理
                  </button>
                )}
                {onDismiss && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="proposal-dismiss-btn"
                    disabled={isBusy}
                    onClick={() => void onDismiss(proposal)}
                  >
                    <X size={16} strokeWidth={1.75} />
                    暂不采用
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {computed.rebasedAutomatically && proposal.status === 'pending' && (
                <p className="proposal-hint">已自动对齐你刚才的修改，保存前可确认下方变动。</p>
              )}
              <div className="proposal-detail-tabs" role="tablist" aria-label="提案查看方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'diff'}
                  className="proposal-detail-tab"
                  data-testid="proposal-tab-diff"
                  onClick={() => setDetailTab('diff')}
                >
                  改动对比
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'preview'}
                  className="proposal-detail-tab"
                  data-testid="proposal-tab-preview"
                  onClick={() => setDetailTab('preview')}
                >
                  完整预览
                </button>
              </div>

              <div className="proposal-detail-body">
                {detailTab === 'diff' ? (
                  renderDiffView()
                ) : (
                  <div className="proposal-preview-box" data-testid="proposal-markdown-preview">
                    <MarkdownView content={computed.resolvedMarkdown} mode={mode} />
                  </div>
                )}
              </div>

              {proposal.status === 'pending' && (
                <div className="proposal-actions">
                  {onApply && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="proposal-apply-btn"
                      disabled={isBusy}
                      onClick={() => void onApply(proposal, computed.resolvedMarkdown)}
                    >
                      <Check size={16} strokeWidth={1.75} />
                      保存改动
                    </button>
                  )}
                  {onDismiss && (
                    <button
                      type="button"
                      className="btn"
                      data-testid="proposal-dismiss-btn"
                      disabled={isBusy}
                      onClick={() => void onDismiss(proposal)}
                    >
                      <X size={16} strokeWidth={1.75} />
                      暂不采用
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
