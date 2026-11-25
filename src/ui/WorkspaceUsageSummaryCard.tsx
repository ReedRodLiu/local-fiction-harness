import {
  Activity,
  BookOpen,
  Info,
  MessageSquare,
  PenLine,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type {
  SessionSavingsUnavailableReason,
  WorkspaceModeUsageSummary,
  WorkspaceUsageMode,
  WorkspaceUsageSummary,
} from '../harness/index.ts';

export interface WorkspaceUsageSummaryCardProps {
  summary: WorkspaceUsageSummary;
}

const WORKSPACE_UNAVAILABLE_REASON_TEXT: Record<SessionSavingsUnavailableReason, string> = {
  'no-usage-data': '尚无模型返回的实测用量记录',
  'non-official-provider': '历史记录包含非 DeepSeek 官方接口，无法按官方费率对比',
  'incomplete-usage': '部分历史轮次缺少完整 token 用量字段，暂无法计算对比基线',
  'no-compression-yet': '全部记录尚未触发前文压缩，暂无压缩前后对比基线',
};

const MODE_UNAVAILABLE_BADGE_TEXT: Record<SessionSavingsUnavailableReason, string> = {
  'no-usage-data': '暂无用量',
  'non-official-provider': '非官方费率',
  'incomplete-usage': '用量不完整',
  'no-compression-yet': '未触发压缩',
};

const MODE_META: Array<{
  mode: WorkspaceUsageMode;
  label: string;
  itemUnit: string;
  icon: typeof BookOpen;
}> = [
  { mode: 'story', label: '文游', itemUnit: '个故事', icon: BookOpen },
  { mode: 'writing', label: '写故事', itemUnit: '部作品', icon: PenLine },
  { mode: 'character', label: '角色互动', itemUnit: '位角色', icon: MessageSquare },
];

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1) return `US$${abs.toFixed(2)}`;
  if (abs >= 0.0001) return `US$${abs.toFixed(4)}`;
  if (abs === 0) return 'US$0.0000';
  return `US$${abs.toFixed(6)}`;
}

function formatModeItemCount(mode: WorkspaceUsageMode, modeSummary: WorkspaceModeUsageSummary, itemUnit: string): string {
  const base = `${formatCount(modeSummary.itemCount)} ${itemUnit}`;
  if (mode === 'character' && modeSummary.conversationCount > 0) {
    return `${base} · ${formatCount(modeSummary.conversationCount)} 段对话`;
  }
  return base;
}

export function WorkspaceUsageSummaryCard({ summary }: WorkspaceUsageSummaryCardProps) {
  const { total, modes, itemCount } = summary;
  const { savings } = total;
  const cacheHitRatePercent =
    total.cacheHitRate !== null ? Math.min(100, Math.max(0, total.cacheHitRate * 100)) : null;
  const cacheHitRateText =
    cacheHitRatePercent !== null ? `${cacheHitRatePercent.toFixed(1)}%` : '—';
  const scheduleLabel = savings.schedule === 'off-peak' ? '非高峰优惠时段' : '标准时段';

  const heroToneClass =
    savings.status === 'available'
      ? savings.estimatedSavingsUsd >= 0
        ? 'is-saved'
        : 'is-increased'
      : 'is-unavailable';

  return (
    <div className="workspace-usage-card" data-testid="workspace-usage-card">
      <div className={`workspace-usage-hero ${heroToneClass}`} data-testid="workspace-usage-hero">
        <div className="workspace-usage-hero-header">
          <span className="workspace-usage-hero-title">
            {savings.status === 'available' ? (
              savings.estimatedSavingsUsd >= 0 ? (
                <TrendingDown size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <TrendingUp size={16} strokeWidth={1.75} aria-hidden="true" />
              )
            ) : (
              <Activity size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {savings.status === 'available'
                ? savings.estimatedSavingsUsd >= 0
                  ? '累计预计省费'
                  : '费用增加'
                : '暂无可比省费'}
            </span>
          </span>
          <span className="workspace-usage-schedule-pill" data-testid="workspace-usage-schedule">
            {scheduleLabel}
          </span>
        </div>

        {savings.status === 'available' ? (
          <>
            <div className="workspace-usage-hero-main">
              <strong className="workspace-usage-hero-amount" data-testid="workspace-usage-savings-amount">
                {formatUsd(Math.abs(savings.estimatedSavingsUsd))}
              </strong>
              {savings.savingsPercent !== null && (
                <span className="workspace-usage-percent-pill" data-testid="workspace-usage-savings-percent">
                  {savings.estimatedSavingsUsd >= 0 ? '节省 ' : '增加 '}
                  {Math.abs(savings.savingsPercent).toFixed(1)}%
                </span>
              )}
            </div>

            <div className="workspace-usage-hero-compare">
              <div className="workspace-usage-compare-cell">
                <span>实测总花费</span>
                <strong>{formatUsd(savings.actualCostUsd)}</strong>
              </div>
              <div className="workspace-usage-compare-cell">
                <span>未压缩全历史基线</span>
                <strong>{formatUsd(savings.baselineCostUsd)}</strong>
              </div>
              <div className="workspace-usage-compare-cell">
                <span>已省略输入估算</span>
                <strong>{formatCount(savings.evictedInputTokensEstimated)} Token</strong>
              </div>
            </div>

            <p className="workspace-usage-hero-note">
              按 DeepSeek 官方公开费率与未压缩前文基线估算（对比 {formatCount(savings.comparedTurnCount)} 轮）
            </p>
          </>
        ) : (
          <div className="workspace-usage-unavailable-body">
            <div className="workspace-usage-unavailable-row" data-testid="workspace-usage-unavailable">
              <Info
                size={16}
                strokeWidth={1.75}
                className="workspace-usage-unavailable-icon"
                aria-hidden="true"
              />
              <span>暂无可比省费：{WORKSPACE_UNAVAILABLE_REASON_TEXT[savings.reason]}</span>
            </div>
            {total.actualCostUsd !== null && (
              <div className="workspace-usage-hero-compare">
                <div className="workspace-usage-compare-cell" data-testid="workspace-usage-actual-cost">
                  <span>实测费用</span>
                  <strong>{formatUsd(total.actualCostUsd)}</strong>
                </div>
              </div>
            )}
            {total.recordedTurnCount === 0 && (
              <p className="workspace-usage-empty" data-testid="workspace-usage-empty">
                暂无实测用量数据（在文游、写故事或角色互动中生成回复后自动记录）。
              </p>
            )}
          </div>
        )}
      </div>

      <div className="workspace-usage-grid" data-testid="workspace-usage-metrics">
        <div className="workspace-usage-stat">
          <span className="workspace-usage-stat-label">实测记录轮次</span>
          <strong className="workspace-usage-stat-value">
            {formatCount(total.recordedTurnCount)} 轮
          </strong>
          <span className="workspace-usage-stat-sub">
            覆盖 {formatCount(itemCount)} 项创作内容
          </span>
        </div>

        <div className="workspace-usage-stat">
          <span className="workspace-usage-stat-label">总输入 Token</span>
          <strong className="workspace-usage-stat-value">
            {formatCount(total.promptTokens)}
          </strong>
          <span className="workspace-usage-stat-sub">
            {formatCount(total.promptCacheHitTokens)} / {formatCount(total.promptCacheMissTokens)}（命中 / 未命中）
          </span>
          <div className="workspace-usage-cache-meter" data-testid="workspace-usage-cache-rate">
            <div className="workspace-usage-cache-header">
              <span>缓存命中率</span>
              <strong>{cacheHitRateText}</strong>
            </div>
            <div className="workspace-usage-cache-track" aria-hidden="true">
              <div
                className="workspace-usage-cache-fill"
                style={{ width: `${cacheHitRatePercent ?? 0}%` }}
              />
            </div>
          </div>
        </div>

        <div className="workspace-usage-stat">
          <span className="workspace-usage-stat-label">输出与思考 Token</span>
          <strong className="workspace-usage-stat-value">
            {formatCount(total.completionTokens)}
          </strong>
          <span className="workspace-usage-stat-sub">
            含思考 Token {formatCount(total.reasoningTokens)}
          </span>
        </div>

        <div className="workspace-usage-stat">
          <span className="workspace-usage-stat-label">压缩与历史回溯</span>
          <strong className="workspace-usage-stat-value">
            {formatCount(total.compressedTurnCount)} 轮压缩
          </strong>
          <span className="workspace-usage-stat-sub">
            历史引用 {formatCount(total.totalRetrievedNodes)} 条（{formatCount(total.retrievedTurnCount)} 轮）
          </span>
        </div>
      </div>

      <div className="workspace-usage-modes" data-testid="workspace-usage-modes">
        <span className="workspace-usage-modes-heading">分模式用量明细</span>
        <div className="workspace-usage-modes-list">
          {MODE_META.map(({ mode, label, itemUnit, icon: Icon }) => {
            const modeSummary = modes[mode];
            const modeSavings = modeSummary.savings;
            const modeBadgeTone =
              modeSavings.status === 'available'
                ? modeSavings.estimatedSavingsUsd >= 0
                  ? 'is-saved'
                  : 'is-increased'
                : 'is-unavailable';

            return (
              <div
                key={mode}
                className="workspace-usage-mode-row"
                data-testid={`workspace-usage-mode-${mode}`}
              >
                <div className="workspace-usage-mode-main">
                  <div className="workspace-usage-mode-title">
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                    <strong>{label}</strong>
                    <span className="workspace-usage-mode-items">
                      {formatModeItemCount(mode, modeSummary, itemUnit)}
                    </span>
                  </div>
                  <div className="workspace-usage-mode-meta">
                    <span>{formatCount(modeSummary.recordedTurnCount)} 轮</span>
                    <span>
                      输入 {formatCount(modeSummary.promptTokens)} / 输出{' '}
                      {formatCount(modeSummary.completionTokens)}
                    </span>
                    {modeSavings.status === 'unavailable' && modeSummary.actualCostUsd !== null && (
                      <span>实测费用 {formatUsd(modeSummary.actualCostUsd)}</span>
                    )}
                  </div>
                </div>

                <span className={`workspace-usage-mode-badge ${modeBadgeTone}`}>
                  {modeSavings.status === 'available'
                    ? modeSavings.estimatedSavingsUsd >= 0
                      ? `预计省 ${formatUsd(modeSavings.estimatedSavingsUsd)}`
                      : `费用增 ${formatUsd(Math.abs(modeSavings.estimatedSavingsUsd))}`
                    : MODE_UNAVAILABLE_BADGE_TEXT[modeSavings.reason]}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
