import { describe, expect, it } from 'vitest';
import {
  compareContextExperimentRangeSubset,
  contextExperimentUsageFromSse,
  DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
  estimateContextSavings,
  preflightContextExperiment,
  summarizeContextExperiment,
  type ContextExperimentGroup,
} from '../../experiments/context-compression/savings.ts';

describe('context compression cost evidence', () => {
  it('accepts only complete nonnegative safe-integer billed buckets from generic SSE usage', () => {
    expect(contextExperimentUsageFromSse({
      promptTokens: 3,
      promptCacheHitTokens: 2,
      promptCacheMissTokens: 1,
      completionTokens: 4,
      completionTokensDetails: { reasoningTokens: 3 },
    })).toEqual({
      promptCacheHitTokens: 2,
      promptCacheMissTokens: 1,
      completionTokens: 4,
      completionTokensDetails: { reasoningTokens: 3 },
    });

    for (const raw of [
      undefined,
      { promptCacheHitTokens: 2, completionTokens: 4 },
      { promptCacheHitTokens: -1, promptCacheMissTokens: 1, completionTokens: 4 },
      { promptCacheHitTokens: 0.5, promptCacheMissTokens: 1, completionTokens: 4 },
      { promptCacheHitTokens: 0, promptCacheMissTokens: Number.NaN, completionTokens: 4 },
      { promptCacheHitTokens: 0, promptCacheMissTokens: 1, completionTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(contextExperimentUsageFromSse(raw)).toBeNull();
    }
  });

  it('marks incomplete or invalid outbound usage as unknown instead of zero-cost evidence', () => {
    const summary = summarizeContextExperiment({
      arm: 'full',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 1,
      records: [{
        requestId: 'partial-usage',
        phase: 'generation',
        status: 'completed',
        logicalTurnId: 'turn-1',
        transport: 'outbound-http',
        usage: {
          promptCacheHitTokens: 2,
          completionTokens: 4,
        } as unknown as ContextExperimentGroup['records'][number]['usage'],
        visibleOutputCharCount: 12,
      }],
    });

    expect(summary.missingUsageRecords).toBe(1);
    expect(summary.usage).toBeNull();
    expect(summary.costUsd).toBeNull();
    expect(summary.cacheHitRate).toBeNull();

    const overflowed = summarizeContextExperiment({
      arm: 'full',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 2,
      records: ['turn-1', 'turn-2'].map((logicalTurnId, index) => ({
        requestId: `overflow-${index}`,
        phase: 'generation' as const,
        status: 'completed' as const,
        logicalTurnId,
        transport: 'outbound-http' as const,
        usage: {
          promptCacheHitTokens: Number.MAX_SAFE_INTEGER,
          promptCacheMissTokens: 0,
          completionTokens: 0,
        },
        visibleOutputCharCount: 12,
      })),
    });
    expect(overflowed.usage).toBeNull();
    expect(overflowed.costUsd).toBeNull();
  });

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
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: {
            promptCacheHitTokens: 500_000,
            promptCacheMissTokens: 500_000,
            completionTokens: 50_000,
            completionTokensDetails: { reasoningTokens: 30_000 },
          },
          visibleOutputCharCount: 100,
          firstContentLatencyMs: 900,
        },
        {
          requestId: 'summary-1',
          phase: 'summary',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: {
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 100_000,
            completionTokens: 10_000,
            completionTokensDetails: { reasoningTokens: 7_000 },
          },
          visibleOutputCharCount: 40,
          firstContentLatencyMs: 2_000,
        },
        {
          requestId: 'retry-1',
          phase: 'retry',
          status: 'failed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: {
            promptCacheHitTokens: 25_000,
            promptCacheMissTokens: 25_000,
            completionTokens: 5_000,
            completionTokensDetails: { reasoningTokens: 2_000 },
          },
          visibleOutputCharCount: 10,
          firstContentLatencyMs: 1_500,
        },
      ],
    };

    const summary = summarizeContextExperiment(group);

    expect(summary.records).toBe(3);
    expect(summary.completedTurnIds).toEqual(['turn-1']);
    expect(summary.outboundRequestCount).toBe(3);
    expect(summary.localRetrievalCount).toBe(0);
    expect(summary.missingUsageRecords).toBe(0);
    expect(summary.visibleOutputCharCount).toBe(150);
    expect(summary.usage).toEqual({
      promptCacheHitTokens: 525_000,
      promptCacheMissTokens: 625_000,
      completionTokens: 65_000,
      completionTokensDetails: { reasoningTokens: 39_000 },
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
        ...Array.from({ length: 100 }, (_, index) => ({
          requestId: `${arm}-generation-${index + 1}`,
          phase: 'generation' as const,
          status: 'completed' as const,
          logicalTurnId: `turn-${index + 1}`,
          transport: 'outbound-http' as const,
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 10_000, completionTokens: completionTokens / 100 },
          visibleOutputCharCount: 12,
        })),
        ...(missingUsage
          ? [{
              requestId: `${arm}-summary-missing`,
              phase: 'summary' as const,
              status: 'completed' as const,
              logicalTurnId: 'turn-1',
              transport: 'outbound-http' as const,
              usage: null,
              visibleOutputCharCount: null,
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

  it('reports an ordered-prefix cost subset for unequal ranges without relaxing strict savings', () => {
    const makeGroup = (
      arm: 'full' | 'retrievable',
      turnIds: string[],
      missTokens: number,
    ): ContextExperimentGroup => ({
      arm,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: turnIds.length,
      records: turnIds.map((logicalTurnId, index) => ({
        requestId: `${arm}-${index}`,
        phase: 'generation',
        status: 'completed',
        logicalTurnId,
        transport: 'outbound-http',
        usage: {
          promptCacheHitTokens: 0,
          promptCacheMissTokens: missTokens,
          completionTokens: 50,
        },
        visibleOutputCharCount: 20,
      })),
    });
    const baselineGroup = makeGroup(
      'full',
      ['turn-1', 'turn-2', 'turn-3'],
      10_000,
    );
    const candidateGroup = makeGroup(
      'retrievable',
      ['turn-1', 'turn-2'],
      5_000,
    );
    const baseline = summarizeContextExperiment(baselineGroup);
    const candidate = summarizeContextExperiment(candidateGroup);

    expect(estimateContextSavings(baseline, candidate)).toEqual({
      status: 'unavailable',
      reason: 'turn-count-mismatch',
    });
    const subset = compareContextExperimentRangeSubset(
      baselineGroup,
      candidateGroup,
      baseline,
      candidate,
    );
    expect(subset).toMatchObject({
      status: 'available',
      baselineRange: {
        firstTurnId: 'turn-1',
        lastTurnId: 'turn-3',
        completedTurnCount: 3,
      },
      candidateRange: {
        firstTurnId: 'turn-1',
        lastTurnId: 'turn-2',
        completedTurnCount: 2,
      },
      subsetRange: {
        firstTurnId: 'turn-1',
        lastTurnId: 'turn-2',
        completedTurnCount: 2,
        turnIds: ['turn-1', 'turn-2'],
      },
    });
    expect(subset.status).toBe('available');
    if (subset.status === 'available') {
      expect(subset.baselineCostUsd).toBeCloseTo(0.00306, 12);
      expect(subset.candidateCostUsd).toBeCloseTo(0.00156, 12);
      expect(subset.savingsUsd).toBeCloseTo(0.0015, 12);
      expect(subset.savingsPercent).toBeCloseTo(49.01960784313725, 12);
    }
  });

  it('counts a successful generation retry once for completion, while still charging every request', () => {
    const summary = summarizeContextExperiment({
      arm: 'retrievable',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 1,
      records: [
        {
          requestId: 'generation-failed',
          phase: 'generation',
          status: 'failed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 10 },
          visibleOutputCharCount: 0,
        },
        {
          requestId: 'generation-retry',
          phase: 'retry',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 20 },
          visibleOutputCharCount: 15,
          firstContentLatencyMs: 900,
        },
      ],
    });

    expect(summary.completedTurnIds).toEqual(['turn-1']);
    expect(summary.completionRate).toBe(1);
    expect(summary.records).toBe(2);
    expect(summary.usage?.completionTokens).toBe(30);
  });

  it('treats local retrieval as having no provider-usage requirement', () => {
    const summary = summarizeContextExperiment({
      arm: 'retrievable',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 1,
      records: [
        {
          requestId: 'generation-1',
          phase: 'generation',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 20 },
          visibleOutputCharCount: 15,
          firstContentLatencyMs: 800,
        },
        {
          requestId: 'retrieval-1',
          phase: 'retrieval',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'local',
          usage: null,
          visibleOutputCharCount: null,
        },
      ],
    });

    expect(summary.localRetrievalCount).toBe(1);
    expect(summary.missingUsageRecords).toBe(0);
    expect(summary.costUsd).not.toBeNull();
  });

  it('measures nearest-rank latency for successful logical generations including completed retries', () => {
    const summary = summarizeContextExperiment({
      arm: 'retrievable',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 2,
      records: [
        {
          requestId: 'generation-failed',
          phase: 'generation',
          status: 'failed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 5 },
          visibleOutputCharCount: 2,
          firstContentLatencyMs: 100,
        },
        {
          requestId: 'generation-retry',
          phase: 'retry',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 20 },
          visibleOutputCharCount: 15,
          firstContentLatencyMs: 900,
        },
        {
          requestId: 'generation-2',
          phase: 'generation',
          status: 'completed',
          logicalTurnId: 'turn-2',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 20 },
          visibleOutputCharCount: 15,
          firstContentLatencyMs: 300,
        },
        {
          requestId: 'summary-2',
          phase: 'summary',
          status: 'completed',
          logicalTurnId: 'turn-2',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 500, completionTokens: 10 },
          visibleOutputCharCount: 8,
          firstContentLatencyMs: 50,
        },
        {
          requestId: 'retrieval-2',
          phase: 'retrieval',
          status: 'completed',
          logicalTurnId: 'turn-2',
          transport: 'local',
          usage: null,
          visibleOutputCharCount: null,
        },
      ],
    });

    expect(summary.completedTurnIds).toEqual(['turn-1', 'turn-2']);
    expect(summary.firstContentLatencyMsP50).toBe(300);
    expect(summary.firstContentLatencyMsP95).toBe(900);
  });

  it('never estimates savings from empty, truncated, or same-size misaligned turn ranges', () => {
    const summaryFor = (
      arm: 'full' | 'retrievable',
      effectiveTurns: number,
      turnIds: string[],
    ) => summarizeContextExperiment({
      arm,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns,
      records: turnIds.map((logicalTurnId, index) => ({
        requestId: `${arm}-${index}`,
        phase: 'generation' as const,
        status: 'completed' as const,
        logicalTurnId,
        transport: 'outbound-http' as const,
        usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 100 },
        visibleOutputCharCount: 20,
      })),
    });

    const empty = summaryFor('full', 1, []);
    const oneTurn = summaryFor('retrievable', 1, ['turn-1']);
    expect(estimateContextSavings(empty, oneTurn)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete-usage',
    });

    const partialBaseline = summaryFor('full', 2, ['turn-1']);
    const partialCandidate = summaryFor('retrievable', 2, ['turn-1']);
    expect(estimateContextSavings(partialBaseline, partialCandidate)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete-turns',
    });

    const misalignedBaseline = summaryFor('full', 2, ['turn-1', 'turn-2']);
    const misalignedCandidate = summaryFor('retrievable', 2, ['turn-2', 'turn-3']);
    expect(estimateContextSavings(misalignedBaseline, misalignedCandidate)).toMatchObject({
      status: 'unavailable',
      reason: 'turn-id-mismatch',
    });
  });

  it('rejects strict savings when billed outbound usage comes from an unmatched failed turn', () => {
    const summaryFor = (
      arm: 'full' | 'retrievable',
      records: ContextExperimentGroup['records'],
    ) => summarizeContextExperiment({
      arm,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 1,
      records,
    });
    const completedTurn = (arm: 'full' | 'retrievable') => ({
      requestId: `${arm}-generation-1`,
      phase: 'generation' as const,
      status: 'completed' as const,
      logicalTurnId: 'turn-1',
      transport: 'outbound-http' as const,
      usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 100 },
      visibleOutputCharCount: 20,
    });
    const baseline = summaryFor('full', [completedTurn('full')]);
    const candidate = summaryFor('retrievable', [
      completedTurn('retrievable'),
      {
        requestId: 'retrievable-failed-generation-2',
        phase: 'generation',
        status: 'failed',
        logicalTurnId: 'turn-2',
        transport: 'outbound-http',
        usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 100 },
        visibleOutputCharCount: 20,
      },
    ]);

    expect(candidate.completedTurnIds).toEqual(baseline.completedTurnIds);
    expect(estimateContextSavings(baseline, candidate)).toEqual({
      status: 'unavailable',
      reason: 'turn-id-mismatch',
    });
  });

  it('rejects strict savings when completed turn IDs have equal membership but different order', () => {
    const summaryFor = (
      arm: 'full' | 'retrievable',
      turnIds: string[],
    ) => summarizeContextExperiment({
      arm,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: turnIds.length,
      records: turnIds.map((logicalTurnId, index) => ({
        requestId: `${arm}-${index}`,
        phase: 'generation' as const,
        status: 'completed' as const,
        logicalTurnId,
        transport: 'outbound-http' as const,
        usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 100 },
        visibleOutputCharCount: 20,
      })),
    });
    const baseline = summaryFor('full', ['turn-1', 'turn-2']);
    const candidate = summaryFor('retrievable', ['turn-2', 'turn-1']);

    expect(new Set(candidate.completedTurnIds)).toEqual(new Set(baseline.completedTurnIds));
    expect(candidate.completedTurnIds).not.toEqual(baseline.completedTurnIds);
    expect(estimateContextSavings(baseline, candidate)).toEqual({
      status: 'unavailable',
      reason: 'turn-id-mismatch',
    });
  });

  it('keeps billed attempt costs when each attempt belongs to a matched completed turn', () => {
    const summaryFor = (arm: 'full' | 'retrievable') => summarizeContextExperiment({
      arm,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      pricingSchedule: 'off-peak',
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
      effectiveTurns: 2,
      records: [
        {
          requestId: `${arm}-failed-turn-1`,
          phase: 'generation',
          status: 'failed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 1_000, completionTokens: 100 },
          visibleOutputCharCount: 20,
        },
        {
          requestId: `${arm}-retry-turn-1`,
          phase: 'retry',
          status: 'completed',
          logicalTurnId: 'turn-1',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 2_000, completionTokens: 50 },
          visibleOutputCharCount: 20,
        },
        {
          requestId: `${arm}-generation-turn-2`,
          phase: 'generation',
          status: 'completed',
          logicalTurnId: 'turn-2',
          transport: 'outbound-http',
          usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 3_000, completionTokens: 80 },
          visibleOutputCharCount: 20,
        },
      ],
    });
    const baseline = summaryFor('full');
    const candidate = summaryFor('retrievable');
    const estimate = estimateContextSavings(baseline, candidate);

    expect(candidate.outboundLogicalTurnIds).toEqual(['turn-1', 'turn-1', 'turn-2']);
    expect(candidate.costUsd).toBeCloseTo(0.001038, 12);
    expect(estimate).toMatchObject({
      status: 'available',
      baselineCostUsd: candidate.costUsd,
      candidateCostUsd: candidate.costUsd,
      savingsUsd: 0,
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

  it('requires ordered contiguous unique attempts for each operation', () => {
    const budget = {
      maxRequests: 3,
      maxRetriesPerOperation: 1,
      maxInputTokensPerRequest: 100_000,
      maxOutputTokensPerRequest: 512,
      maxTotalCostUsd: 0.03,
      concurrency: 1 as const,
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
    };
    const request = { maxInputTokens: 1_000, maxOutputTokens: 128 };
    const plansFor = (attempts: number[]) => attempts.map((attempt) => ({
      operationId: 'generation-1',
      attempt,
      ...request,
    }));

    expect(preflightContextExperiment(budget, plansFor([0, 1])).ok).toBe(true);
    for (const attempts of [[1], [0, 2], [0, 1, 1]]) {
      expect(preflightContextExperiment(budget, plansFor(attempts))).toMatchObject({
        ok: false,
        violations: ['retry-limit'],
      });
    }
  });

  it('rejects invalid numeric quantities, invalid attempts, and anything other than outbound concurrency one', () => {
    const budget = {
      maxRequests: 2,
      maxRetriesPerOperation: 1,
      maxInputTokensPerRequest: 100_000,
      maxOutputTokensPerRequest: 512,
      maxTotalCostUsd: 0.03,
      concurrency: 1,
      rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
    };
    const safeRequest = {
      operationId: 'generation-1',
      attempt: 0,
      maxInputTokens: 1_000,
      maxOutputTokens: 128,
    };

    for (const invalidBudget of [
      { ...budget, maxRequests: Number.NaN },
      { ...budget, maxRequests: -1 },
      { ...budget, maxRequests: 1.5 },
      { ...budget, maxRetriesPerOperation: Number.NaN },
      { ...budget, maxInputTokensPerRequest: -1 },
      { ...budget, maxOutputTokensPerRequest: 1.5 },
      { ...budget, maxTotalCostUsd: Number.NaN },
      { ...budget, rates: { ...budget.rates, cacheMissInputPerMillionUsd: -0.1 } },
    ]) {
      const result = preflightContextExperiment(invalidBudget, [safeRequest]);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain('invalid-budget');
    }

    for (const concurrency of [0, 2, 1.5, Number.NaN]) {
      const result = preflightContextExperiment({ ...budget, concurrency }, [safeRequest]);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain('concurrency-limit');
    }

    for (const attempt of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = preflightContextExperiment(budget, [{ ...safeRequest, attempt }]);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain('retry-limit');
      expect(Number.isFinite(result.maxEstimatedCostUsd)).toBe(true);
    }

    for (const requestPatch of [
      { maxInputTokens: -1 },
      { maxInputTokens: 1.5 },
      { maxInputTokens: Number.NaN },
      { maxOutputTokens: -1 },
      { maxOutputTokens: 1.5 },
      { maxOutputTokens: Number.NaN },
    ]) {
      const result = preflightContextExperiment(budget, [{ ...safeRequest, ...requestPatch }]);
      expect(result.ok).toBe(false);
      expect(Number.isFinite(result.maxEstimatedCostUsd)).toBe(true);
    }
  });

});
