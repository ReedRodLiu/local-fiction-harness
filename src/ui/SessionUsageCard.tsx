import { Activity, Info, TrendingDown, TrendingUp } from 'lucide-react';
import {
  computeSessionUsageSummary,
  type DeepSeekPricingSchedule,
  type PricingCurrency,
  type SessionSavingsUnavailableReason,
  type TurnNode,
} from '../harness/index.ts';
import { InsetGroup } from './primitives/InsetGroup.tsx';

export interface SessionUsageCardProps {
  nodes: readonly TurnNode[];
  title?: string;
  scheduleOverride?: DeepSeekPricingSchedule;
}

const UNAVAILABLE_REASON_TEXT: Record<SessionSavingsUnavailableReason, string> = {
  'no-usage-data': '尚无模型返回的实测用量记录',
  'non-official-provider': '当前会话包含非 DeepSeek 官方接口记录，无法按官方费率对比',
  'incomplete-usage': '部分轮次缺少完整 token 用量字段，暂无法计算对比基线',
  'no-compression-yet': '当前会话尚未触发前文压缩，暂无压缩前后对比基线',
};

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatMoney(amount: number, currency: PricingCurrency = 'USD'): string {
  const prefix = currency === 'CNY' ? '¥' : 'US$';
  const abs = Math.abs(amount);
  if (abs >= 1) return `${prefix}${abs.toFixed(2)}`;
  if (abs >= 0.0001) return `${prefix}${abs.toFixed(4)}`;
  if (abs === 0) return `${prefix}0.0000`;
  return `${prefix}${abs.toFixed(6)}`;
}

export function SessionUsageCard({
  nodes,
  title,
  scheduleOverride,
}: SessionUsageCardProps) {
  const summary = computeSessionUsageSummary(
    nodes,
    scheduleOverride ? { scheduleOverride } : undefined,
  );
  const { savings } = summary;
  const cacheHitRateText =
    summary.cacheHitRate !== null ? `${(summary.cacheHitRate * 100).toFixed(1)}%` : '—';

  return (
    <InsetGroup title={title ?? '实测用量与预计省费'} testId="session-usage-card">
      <div className="session-usage-card">
        {summary.recordedTurnCount === 0 ? (
          <>
            <div className="session-usage-header-meta">
              <Activity size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>等待首轮模型统计回传</span>
            </div>
            <p className="session-usage-empty" data-testid="session-usage-empty">
              暂无实测用量数据（发送下一轮后自动记录模型返回的 token 统计）。
            </p>
            <div className="session-usage-unavailable" data-testid="session-usage-unavailable">
              <Info
                size={16}
                strokeWidth={1.75}
                className="session-usage-unavailable-icon"
                aria-hidden="true"
              />
              <span>本会话暂无可比省费：{UNAVAILABLE_REASON_TEXT[savings.status === 'unavailable' ? savings.reason : 'no-usage-data']}</span>
            </div>
          </>
        ) : (
          <>
            <div className="session-usage-grid" data-testid="session-usage-metrics">
              <div className="session-usage-stat">
                <span className="session-usage-stat-label">实测记录轮次</span>
                <strong className="session-usage-stat-value">
                  {formatCount(summary.recordedTurnCount)} 轮
                </strong>
              </div>

              <div className="session-usage-stat">
                <span className="session-usage-stat-label">输入 Token（总计）</span>
                <strong className="session-usage-stat-value">
                  {formatCount(summary.promptTokens)}
                </strong>
              </div>

              <div className="session-usage-stat">
                <span className="session-usage-stat-label">缓存命中 / 未命中</span>
                <strong className="session-usage-stat-value">
                  {formatCount(summary.promptCacheHitTokens)} /{' '}
                  {formatCount(summary.promptCacheMissTokens)}
                </strong>
              </div>

              <div className="session-usage-stat">
                <span className="session-usage-stat-label">缓存命中率</span>
                <strong className="session-usage-stat-value">{cacheHitRateText}</strong>
              </div>

              <div className="session-usage-stat">
                <span className="session-usage-stat-label">输出 Token</span>
                <strong className="session-usage-stat-value">
                  {formatCount(summary.completionTokens)}
                </strong>
                <span className="session-usage-stat-sub">
                  思考 Token {formatCount(summary.reasoningTokens)}
                </span>
              </div>

              <div className="session-usage-stat">
                <span className="session-usage-stat-label">压缩与历史回溯</span>
                <strong className="session-usage-stat-value">
                  {formatCount(summary.compressedTurnCount)} 轮压缩
                </strong>
                <span className="session-usage-stat-sub">
                  历史引用 {formatCount(summary.totalRetrievedNodes)} 条（
                  {formatCount(summary.retrievedTurnCount)} 轮）
                </span>
              </div>
            </div>

            {savings.status === 'available' ? (
              <div
                className={`session-usage-savings ${
                  savings.estimatedSavingsUsd >= 0 ? 'is-saved' : 'is-increased'
                }`}
                data-testid="session-usage-savings"
              >
                <div className="session-usage-savings-header">
                  <span className="session-usage-savings-title">
                    {savings.estimatedSavingsUsd >= 0 ? (
                      <TrendingDown size={16} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <TrendingUp size={16} strokeWidth={1.75} aria-hidden="true" />
                    )}
                    {savings.estimatedSavingsUsd >= 0 ? '预计省费' : '费用增加'}
                  </span>
                  {savings.pricingSource !== 'custom' && (
                    <span className="session-usage-tier-badge">
                      {savings.schedule === 'off-peak' ? '非高峰优惠时段' : '标准时段'}
                    </span>
                  )}
                </div>

                <div className="session-usage-savings-rows">
                  <div className="session-usage-savings-cell">
                    <span>实测费用</span>
                    <strong>{formatMoney(savings.actualCostUsd, savings.currency ?? 'USD')}</strong>
                  </div>
                  <div className="session-usage-savings-cell">
                    <span>未压缩基线</span>
                    <strong>{formatMoney(savings.baselineCostUsd, savings.currency ?? 'USD')}</strong>
                  </div>
                  <div className="session-usage-savings-cell">
                    <span>{savings.estimatedSavingsUsd >= 0 ? '预计省费' : '费用增加'}</span>
                    <strong>
                      {formatMoney(Math.abs(savings.estimatedSavingsUsd), savings.currency ?? 'USD')}
                      {savings.savingsPercent !== null
                        ? `（${Math.abs(savings.savingsPercent).toFixed(1)}%）`
                        : ''}
                    </strong>
                  </div>
                </div>

                <p className="session-usage-savings-note">
                  {savings.pricingSource === 'custom'
                    ? '按自定义模型单价与未压缩前文基线估算'
                    : '按 DeepSeek 官方公开费率与未压缩前文基线估算'}
                </p>
              </div>
            ) : savings.status === 'tokens-only' ? (
              <div
                className="session-usage-savings is-saved"
                data-testid="session-usage-savings"
              >
                <div className="session-usage-savings-header">
                  <span className="session-usage-savings-title">
                    <TrendingDown size={16} strokeWidth={1.75} aria-hidden="true" />
                    累计节省输入估算
                  </span>
                  <strong className="session-usage-savings-title" data-testid="session-usage-savings-amount">
                    {formatCount(savings.netSavedTokensEstimated)} Token
                  </strong>
                </div>

                <div className="session-usage-savings-rows">
                  <div className="session-usage-savings-cell">
                    <span>已省略输入估算</span>
                    <strong>{formatCount(savings.evictedInputTokensEstimated)} Token</strong>
                  </div>
                  <div className="session-usage-savings-cell">
                    <span>摘要压缩开销</span>
                    <strong>{formatCount(savings.summaryOverheadTokens)} Token</strong>
                  </div>
                  <div className="session-usage-savings-cell">
                    <span>对比压缩轮次</span>
                    <strong>{formatCount(savings.compressedTurnCount)} 轮</strong>
                  </div>
                </div>

                <p className="session-usage-savings-note">
                  未配置模型单价时只统计 Token 省量；可在设置中选填单价以估算花费
                </p>
              </div>
            ) : (
              <div className="session-usage-unavailable" data-testid="session-usage-unavailable">
                <Info
                  size={16}
                  strokeWidth={1.75}
                  className="session-usage-unavailable-icon"
                  aria-hidden="true"
                />
                <span>
                  本会话暂无可比省费：{UNAVAILABLE_REASON_TEXT[savings.reason]}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </InsetGroup>
  );
}
