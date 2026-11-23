import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
  estimateContextSavings,
  preflightContextExperiment,
  summarizeContextExperiment,
  type ContextExperimentGroup,
} from '../../experiments/context-compression/savings.ts';

describe('context compression cost evidence', () => {
  it('charges every provider request from authoritative cache and output usage', () => {
    const group: ContextExperimentGroup = {
      arm: 'full',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 10,
      records: [
        {
          requestId: 'generation-1',
          phase: 'generation',
          status: 'completed',
          turnIndex: 1,
          usage: { promptCacheHitTokens: 500_000, promptCacheMissTokens: 500_000, completionTokens: 50_000 },
          firstContentLatencyMs: 900,
        },
        {
          requestId: 'summary-1',
          phase: 'summary',
          status: 'completed',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 100_000, completionTokens: 10_000 },
          firstContentLatencyMs: 2_000,
        },
        {
          requestId: 'retry-1',
          phase: 'retry',
          status: 'failed',
          usage: { promptCacheHitTokens: 25_000, promptCacheMissTokens: 25_000, completionTokens: 5_000 },
          firstContentLatencyMs: 1_500,
        },
      ],
    };

    const summary = summarizeContextExperiment(group);

    expect(summary.records).toBe(3);
    expect(summary.missingUsageRecords).toBe(0);
    expect(summary.usage).toEqual({
      promptCacheHitTokens: 525_000,
      promptCacheMissTokens: 625_000,
      completionTokens: 65_000,
    });
    expect(summary.costUsd).toBeCloseTo(0.134325, 10);
    expect(summary.costPer100TurnsUsd).toBeCloseTo(1.34325, 10);
    expect(summary.cacheHitRate).toBeCloseTo(525_000 / 1_150_000, 10);
    expect(summary.firstContentLatencyMsP50).toBe(900);
    expect(summary.firstContentLatencyMsP95).toBe(900);
    expect(summary.peakInputTokens).toBe(1_000_000);
    expect(summary.completionRate).toBe(0.1);
  });

  it('shows measured savings or a cost increase only for complete matching official runs', () => {
    const makeGroup = (
      arm: 'full' | 'folio' | 'retrievable',
      provider: 'deepseek-official' | 'offline-simulated',
      completionTokens: number,
      missingUsage = false,
    ): ContextExperimentGroup => ({
      arm,
      provider,
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 100,
      records: [
        {
          requestId: `${arm}-generation`,
          phase: 'generation',
          status: 'completed',
          turnIndex: 1,
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000_000, completionTokens },
        },
        ...(missingUsage
          ? [{
              requestId: `${arm}-summary-missing`,
              phase: 'summary' as const,
              status: 'completed' as const,
              usage: null,
            }]
          : []),
      ],
    });

    const baseline = summarizeContextExperiment(makeGroup('full', 'deepseek-official', 100_000));
    const candidate = summarizeContextExperiment(makeGroup('retrievable', 'deepseek-official', 50_000));
    expect(estimateContextSavings(baseline, candidate)).toMatchObject({
      status: 'available',
      baselineCostUsd: 0.21,
      candidateCostUsd: 0.18,
      savingsUsd: 0.03,
      savingsPercent: 30 / 210 * 100,
    });

    const increasedCost = estimateContextSavings(baseline, summarizeContextExperiment(
      makeGroup('retrievable', 'deepseek-official', 200_000),
    ));
    expect(increasedCost.status).toBe('available');
    if (increasedCost.status === 'available') {
      expect(increasedCost.savingsUsd).toBeCloseTo(-0.06, 10);
    }

    expect(estimateContextSavings(baseline, summarizeContextExperiment(
      makeGroup('retrievable', 'offline-simulated', 50_000),
    ))).toMatchObject({ status: 'unavailable', reason: 'non-official-provider' });

    expect(estimateContextSavings(baseline, summarizeContextExperiment(
      makeGroup('retrievable', 'deepseek-official', 50_000, true),
    ))).toMatchObject({ status: 'unavailable', reason: 'incomplete-usage' });

    const shorterCandidate = summarizeContextExperiment({
      ...makeGroup('retrievable', 'deepseek-official', 50_000),
      effectiveTurns: 99,
    });
    expect(estimateContextSavings(baseline, shorterCandidate)).toMatchObject({
      status: 'unavailable',
      reason: 'turn-count-mismatch',
    });
  });

  it('blocks a funded run before transport when request, retry, token, concurrency, or dollar limits are exceeded', () => {
    const budget = {
      maxRequests: 2,
      maxRetriesPerOperation: 1,
      maxInputTokensPerRequest: 100_000,
      maxOutputTokensPerRequest: 512,
      maxTotalCostUsd: 0.03,
      concurrency: 1 as const,
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
    };

    const safe = preflightContextExperiment(budget, [
      { operationId: 'generation-1', attempt: 0, maxInputTokens: 100_000, maxOutputTokens: 512 },
      { operationId: 'summary-1', attempt: 0, maxInputTokens: 50_000, maxOutputTokens: 512 },
    ]);
    expect(safe).toMatchObject({ ok: true, requestCount: 2, violations: [] });
    expect(safe.maxEstimatedCostUsd).toBeCloseTo(0.0231144, 10);

    const unsafe = preflightContextExperiment(budget, [
      { operationId: 'generation-1', attempt: 0, maxInputTokens: 100_000, maxOutputTokens: 512 },
      { operationId: 'generation-1', attempt: 1, maxInputTokens: 100_000, maxOutputTokens: 512 },
      { operationId: 'generation-1', attempt: 2, maxInputTokens: 100_001, maxOutputTokens: 513 },
    ]);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.violations).toEqual(expect.arrayContaining([
      'request-limit',
      'retry-limit',
      'input-token-limit',
      'output-token-limit',
      'cost-limit',
    ]));
  });

});
