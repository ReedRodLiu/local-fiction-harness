export type ContextExperimentArm = 'full' | 'folio' | 'retrievable';
export type ContextExperimentProvider = 'deepseek-official' | 'offline-simulated';
export type ContextExperimentPricingSchedule = 'off-peak' | 'peak';
export type ContextExperimentPhase = 'generation' | 'summary' | 'retrieval' | 'retry' | 'other';
export type ContextExperimentRequestStatus = 'completed' | 'failed' | 'aborted';

export interface ContextExperimentRates {
  cacheHitInputPerMillionUsd: number;
  cacheMissInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface ContextExperimentUsage {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  completionTokensDetails?: {
    reasoningTokens?: number;
  };
}

export interface ContextExperimentRequestRecord {
  requestId: string;
  phase: ContextExperimentPhase;
  status: ContextExperimentRequestStatus;
  logicalTurnId?: string;
  transport: 'outbound-http' | 'local';
  usage: ContextExperimentUsage | null;
  visibleOutputCharCount: number | null;
  firstContentLatencyMs?: number | null;
  branchSwitch?: boolean;
}

export interface ContextExperimentGroup {
  arm: ContextExperimentArm;
  provider: ContextExperimentProvider;
  model: string;
  pricingSchedule: ContextExperimentPricingSchedule;
  rates: ContextExperimentRates;
  effectiveTurns: number;
  records: readonly ContextExperimentRequestRecord[];
}

export interface ContextExperimentSummary {
  arm: ContextExperimentArm;
  provider: ContextExperimentProvider;
  model: string;
  pricingSchedule: ContextExperimentPricingSchedule;
  rates: ContextExperimentRates;
  effectiveTurns: number;
  completedTurnIds: string[];
  records: number;
  outboundRequestCount: number;
  localRetrievalCount: number;
  missingUsageRecords: number;
  usage: ContextExperimentUsage;
  visibleOutputCharCount: number;
  costUsd: number | null;
  costPer100TurnsUsd: number | null;
  cacheHitRate: number | null;
  firstContentLatencyMsP50: number | null;
  firstContentLatencyMsP95: number | null;
  branchSwitchFirstContentLatencyMsP50: number | null;
  latencySampleCount: number;
  peakInputTokens: number;
  completionRate: number;
}

export type ContextSavingsUnavailableReason =
  | 'non-official-provider'
  | 'incomplete-usage'
  | 'model-mismatch'
  | 'pricing-mismatch'
  | 'turn-count-mismatch'
  | 'incomplete-turns'
  | 'turn-id-mismatch'
  | 'insufficient-turns';

export type ContextSavingsEstimate =
  | {
      status: 'available';
      baselineCostUsd: number;
      candidateCostUsd: number;
      savingsUsd: number;
      savingsPercent: number | null;
      baselineCostPer100TurnsUsd: number;
      candidateCostPer100TurnsUsd: number;
    }
  | {
      status: 'unavailable';
      reason: ContextSavingsUnavailableReason;
    };

export interface ContextExperimentBudget {
  maxRequests: number;
  maxRetriesPerOperation: number;
  maxInputTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxTotalCostUsd: number;
  concurrency: number;
  rates: ContextExperimentRates;
}

export interface ContextExperimentRequestPlan {
  operationId: string;
  attempt: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export type ContextExperimentBudgetViolation =
  | 'invalid-budget'
  | 'request-limit'
  | 'retry-limit'
  | 'input-token-limit'
  | 'output-token-limit'
  | 'cost-limit'
  | 'concurrency-limit';

export interface ContextExperimentPreflight {
  ok: boolean;
  requestCount: number;
  maxEstimatedCostUsd: number;
  violations: ContextExperimentBudgetViolation[];
}

export const DEEPSEEK_V41_FLASH_OFF_PEAK_RATES: Readonly<ContextExperimentRates> = {
  cacheHitInputPerMillionUsd: 0.003,
  cacheMissInputPerMillionUsd: 0.15,
  outputPerMillionUsd: 0.6,
};

export const DEEPSEEK_V41_FLASH_PEAK_RATES: Readonly<ContextExperimentRates> = {
  cacheHitInputPerMillionUsd: 0.006,
  cacheMissInputPerMillionUsd: 0.3,
  outputPerMillionUsd: 1.2,
};

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function contextExperimentUsageCostUsd(
  usage: ContextExperimentUsage,
  rates: ContextExperimentRates,
): number {
  return (
    usage.promptCacheHitTokens * rates.cacheHitInputPerMillionUsd +
    usage.promptCacheMissTokens * rates.cacheMissInputPerMillionUsd +
    usage.completionTokens * rates.outputPerMillionUsd
  ) / 1_000_000;
}

export function summarizeContextExperiment(group: ContextExperimentGroup): ContextExperimentSummary {
  const usage: ContextExperimentUsage = {
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    completionTokens: 0,
  };
  let reasoningTokens = 0;
  let hasReasoningTokens = false;
  let visibleOutputCharCount = 0;
  let missingUsageRecords = 0;
  let peakInputTokens = 0;
  const successfulLatencyByTurn = new Map<string, { latencyMs: number; branchSwitch: boolean }>();
  const completedTurnIds = new Set<string>();

  for (const record of group.records) {
    if (record.transport === 'outbound-http') {
      if (!record.usage) {
        missingUsageRecords += 1;
      } else {
        usage.promptCacheHitTokens += record.usage.promptCacheHitTokens;
        usage.promptCacheMissTokens += record.usage.promptCacheMissTokens;
        usage.completionTokens += record.usage.completionTokens;
        const recordReasoningTokens = record.usage.completionTokensDetails?.reasoningTokens;
        if (recordReasoningTokens !== undefined) {
          reasoningTokens += recordReasoningTokens;
          hasReasoningTokens = true;
        }
        peakInputTokens = Math.max(
          peakInputTokens,
          record.usage.promptCacheHitTokens + record.usage.promptCacheMissTokens,
        );
      }
    }
    if (
      typeof record.visibleOutputCharCount === 'number' &&
      Number.isSafeInteger(record.visibleOutputCharCount) &&
      record.visibleOutputCharCount >= 0
    ) {
      visibleOutputCharCount += record.visibleOutputCharCount;
    }
    if (
      (record.phase === 'generation' || record.phase === 'retry') &&
      record.status === 'completed' &&
      typeof record.logicalTurnId === 'string' &&
      record.logicalTurnId.length > 0
    ) {
      completedTurnIds.add(record.logicalTurnId);
      if (
        typeof record.firstContentLatencyMs === 'number' &&
        Number.isFinite(record.firstContentLatencyMs) &&
        record.firstContentLatencyMs >= 0
      ) {
        successfulLatencyByTurn.set(record.logicalTurnId, {
          latencyMs: record.firstContentLatencyMs,
          branchSwitch: record.branchSwitch === true,
        });
      }
    }
  }

  if (hasReasoningTokens) {
    usage.completionTokensDetails = { reasoningTokens };
  }
  const latencyValues = [...successfulLatencyByTurn.values()].map((sample) => sample.latencyMs);
  const branchSwitchLatencies = [...successfulLatencyByTurn.values()]
    .filter((sample) => sample.branchSwitch)
    .map((sample) => sample.latencyMs);

  const totalInputTokens = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
  const complete = missingUsageRecords === 0;
  const costUsd = complete && group.provider === 'deepseek-official'
    ? contextExperimentUsageCostUsd(usage, group.rates)
    : null;
  const costPer100TurnsUsd =
    costUsd !== null && group.effectiveTurns > 0 ? costUsd * 100 / group.effectiveTurns : null;

  return {
    arm: group.arm,
    provider: group.provider,
    model: group.model,
    pricingSchedule: group.pricingSchedule,
    rates: group.rates,
    effectiveTurns: group.effectiveTurns,
    completedTurnIds: [...completedTurnIds],
    records: group.records.length,
    outboundRequestCount: group.records.filter((record) => record.transport === 'outbound-http').length,
    localRetrievalCount: group.records.filter(
      (record) => record.transport === 'local' && record.phase === 'retrieval',
    ).length,
    missingUsageRecords,
    usage,
    visibleOutputCharCount,
    costUsd,
    costPer100TurnsUsd,
    cacheHitRate: totalInputTokens > 0 ? usage.promptCacheHitTokens / totalInputTokens : null,
    firstContentLatencyMsP50: percentile(latencyValues, 0.5),
    firstContentLatencyMsP95: percentile(latencyValues, 0.95),
    branchSwitchFirstContentLatencyMsP50: percentile(branchSwitchLatencies, 0.5),
    latencySampleCount: latencyValues.length,
    peakInputTokens,
    completionRate:
      group.effectiveTurns > 0
        ? Math.min(1, completedTurnIds.size / group.effectiveTurns)
        : 0,
  };
}

export function estimateContextSavings(
  baseline: ContextExperimentSummary,
  candidate: ContextExperimentSummary,
): ContextSavingsEstimate {
  if (baseline.provider !== 'deepseek-official' || candidate.provider !== 'deepseek-official') {
    return { status: 'unavailable', reason: 'non-official-provider' };
  }
  if (
    baseline.missingUsageRecords > 0 ||
    candidate.missingUsageRecords > 0 ||
    baseline.costUsd === null ||
    candidate.costUsd === null
  ) {
    return { status: 'unavailable', reason: 'incomplete-usage' };
  }
  if (baseline.model !== candidate.model) {
    return { status: 'unavailable', reason: 'model-mismatch' };
  }
  if (
    baseline.pricingSchedule !== candidate.pricingSchedule ||
    baseline.rates.cacheHitInputPerMillionUsd !== candidate.rates.cacheHitInputPerMillionUsd ||
    baseline.rates.cacheMissInputPerMillionUsd !== candidate.rates.cacheMissInputPerMillionUsd ||
    baseline.rates.outputPerMillionUsd !== candidate.rates.outputPerMillionUsd
  ) {
    return { status: 'unavailable', reason: 'pricing-mismatch' };
  }
  if (baseline.effectiveTurns !== candidate.effectiveTurns) {
    return { status: 'unavailable', reason: 'turn-count-mismatch' };
  }
  const baselineTurnIds = new Set(baseline.completedTurnIds);
  const candidateTurnIds = new Set(candidate.completedTurnIds);
  if (baselineTurnIds.size === 0 || candidateTurnIds.size === 0) {
    return { status: 'unavailable', reason: 'insufficient-turns' };
  }
  if (
    baselineTurnIds.size !== baseline.effectiveTurns ||
    candidateTurnIds.size !== candidate.effectiveTurns
  ) {
    return { status: 'unavailable', reason: 'incomplete-turns' };
  }
  if (
    baselineTurnIds.size !== candidateTurnIds.size ||
    [...baselineTurnIds].some((turnId) => !candidateTurnIds.has(turnId))
  ) {
    return { status: 'unavailable', reason: 'turn-id-mismatch' };
  }
  if (
    baseline.costPer100TurnsUsd === null ||
    candidate.costPer100TurnsUsd === null
  ) {
    return { status: 'unavailable', reason: 'insufficient-turns' };
  }

  const savingsUsd = baseline.costUsd - candidate.costUsd;
  return {
    status: 'available',
    baselineCostUsd: baseline.costUsd,
    candidateCostUsd: candidate.costUsd,
    savingsUsd,
    savingsPercent: baseline.costUsd > 0 ? savingsUsd / baseline.costUsd * 100 : null,
    baselineCostPer100TurnsUsd: baseline.costPer100TurnsUsd,
    candidateCostPer100TurnsUsd: candidate.costPer100TurnsUsd,
  };
}

export function preflightContextExperiment(
  budget: ContextExperimentBudget,
  requests: readonly ContextExperimentRequestPlan[],
): ContextExperimentPreflight {
  const violations = new Set<ContextExperimentBudgetViolation>();
  const integerLimits = [
    budget.maxRequests,
    budget.maxRetriesPerOperation,
    budget.maxInputTokensPerRequest,
    budget.maxOutputTokensPerRequest,
  ];
  const nonnegativeFiniteLimits = [
    budget.maxTotalCostUsd,
    budget.rates.cacheHitInputPerMillionUsd,
    budget.rates.cacheMissInputPerMillionUsd,
    budget.rates.outputPerMillionUsd,
  ];
  if (
    integerLimits.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    nonnegativeFiniteLimits.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isSafeInteger(budget.concurrency)
  ) {
    violations.add('invalid-budget');
  }
  if (requests.length > budget.maxRequests) violations.add('request-limit');
  if (budget.concurrency !== 1) violations.add('concurrency-limit');

  let maxEstimatedCostUsd = 0;
  for (const request of requests) {
    const validAttempt =
      Number.isSafeInteger(request.attempt) &&
      request.attempt >= 0 &&
      request.attempt <= budget.maxRetriesPerOperation;
    if (!validAttempt) violations.add('retry-limit');

    const validInputTokens =
      Number.isSafeInteger(request.maxInputTokens) &&
      request.maxInputTokens >= 0;
    if (!validInputTokens || request.maxInputTokens > budget.maxInputTokensPerRequest) {
      violations.add('input-token-limit');
    }

    const validOutputTokens =
      Number.isSafeInteger(request.maxOutputTokens) &&
      request.maxOutputTokens >= 0;
    if (!validOutputTokens || request.maxOutputTokens > budget.maxOutputTokensPerRequest) {
      violations.add('output-token-limit');
    }

    if (!validInputTokens || !validOutputTokens) continue;
    const estimatedCost = contextExperimentUsageCostUsd(
      {
        promptCacheHitTokens: 0,
        promptCacheMissTokens: request.maxInputTokens,
        completionTokens: request.maxOutputTokens,
      },
      budget.rates,
    );
    if (Number.isFinite(estimatedCost)) maxEstimatedCostUsd += estimatedCost;
  }
  if (
    Number.isFinite(budget.maxTotalCostUsd) &&
    budget.maxTotalCostUsd >= 0 &&
    maxEstimatedCostUsd > budget.maxTotalCostUsd
  ) {
    violations.add('cost-limit');
  }

  return {
    ok: violations.size === 0,
    requestCount: requests.length,
    maxEstimatedCostUsd,
    violations: [...violations],
  };
}
