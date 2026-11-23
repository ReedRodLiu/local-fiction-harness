import type { LlmUsage } from '../../src/harness/types.ts';

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
  outboundLogicalTurnIds: Array<string | null>;
  records: number;
  outboundRequestCount: number;
  localRetrievalCount: number;
  missingUsageRecords: number;
  usage: ContextExperimentUsage | null;
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

export interface ContextExperimentTurnRange {
  firstTurnId: string | null;
  lastTurnId: string | null;
  completedTurnCount: number;
}

export interface ContextExperimentTurnSubsetRange extends ContextExperimentTurnRange {
  turnIds: string[];
}

export type ContextExperimentRangeSubsetComparison =
  | {
      status: 'available';
      baselineRange: ContextExperimentTurnRange;
      candidateRange: ContextExperimentTurnRange;
      subsetRange: ContextExperimentTurnSubsetRange;
      baselineCostUsd: number;
      candidateCostUsd: number;
      savingsUsd: number;
      savingsPercent: number | null;
    }
  | {
      status: 'unavailable';
      reason: ContextSavingsUnavailableReason;
      baselineRange: ContextExperimentTurnRange;
      candidateRange: ContextExperimentTurnRange;
      subsetRange: ContextExperimentTurnSubsetRange;
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

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function addSafeCount(total: number, value: number): number | null {
  const next = total + value;
  return Number.isSafeInteger(next) ? next : null;
}

export function contextExperimentUsageFromSse(
  raw: LlmUsage | undefined,
): ContextExperimentUsage | null {
  if (
    !raw ||
    !isNonnegativeSafeInteger(raw.promptCacheHitTokens) ||
    !isNonnegativeSafeInteger(raw.promptCacheMissTokens) ||
    !isNonnegativeSafeInteger(raw.completionTokens)
  ) {
    return null;
  }

  const reasoningTokens = raw.completionTokensDetails?.reasoningTokens;
  return {
    promptCacheHitTokens: raw.promptCacheHitTokens,
    promptCacheMissTokens: raw.promptCacheMissTokens,
    completionTokens: raw.completionTokens,
    ...(isNonnegativeSafeInteger(reasoningTokens)
      ? { completionTokensDetails: { reasoningTokens } }
      : {}),
  };
}

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
  let usageComplete = true;
  let visibleOutputCharCount = 0;
  let missingUsageRecords = 0;
  let peakInputTokens = 0;
  const successfulLatencyByTurn = new Map<string, { latencyMs: number; branchSwitch: boolean }>();
  const completedTurnIds = new Set<string>();
  const outboundLogicalTurnIds: Array<string | null> = [];

  for (const record of group.records) {
    if (record.transport === 'outbound-http') {
      outboundLogicalTurnIds.push(
        typeof record.logicalTurnId === 'string' && record.logicalTurnId.length > 0
          ? record.logicalTurnId
          : null,
      );
      const recordUsage = contextExperimentUsageFromSse(record.usage ?? undefined);
      if (!recordUsage) {
        missingUsageRecords += 1;
        usageComplete = false;
      } else {
        const nextCacheHitTokens = addSafeCount(
          usage.promptCacheHitTokens,
          recordUsage.promptCacheHitTokens,
        );
        const nextCacheMissTokens = addSafeCount(
          usage.promptCacheMissTokens,
          recordUsage.promptCacheMissTokens,
        );
        const nextCompletionTokens = addSafeCount(
          usage.completionTokens,
          recordUsage.completionTokens,
        );
        if (
          nextCacheHitTokens === null ||
          nextCacheMissTokens === null ||
          nextCompletionTokens === null
        ) {
          usageComplete = false;
        } else {
          usage.promptCacheHitTokens = nextCacheHitTokens;
          usage.promptCacheMissTokens = nextCacheMissTokens;
          usage.completionTokens = nextCompletionTokens;
          const recordReasoningTokens = recordUsage.completionTokensDetails?.reasoningTokens;
          if (recordReasoningTokens !== undefined) {
            const nextReasoningTokens = addSafeCount(reasoningTokens, recordReasoningTokens);
            if (nextReasoningTokens !== null) {
              reasoningTokens = nextReasoningTokens;
              hasReasoningTokens = true;
            }
          }
          const recordInputTokens = addSafeCount(
            recordUsage.promptCacheHitTokens,
            recordUsage.promptCacheMissTokens,
          );
          if (recordInputTokens === null) usageComplete = false;
          else peakInputTokens = Math.max(peakInputTokens, recordInputTokens);
        }
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

  const outboundRequestCount = group.records.filter(
    (record) => record.transport === 'outbound-http',
  ).length;
  const complete = outboundRequestCount > 0 && missingUsageRecords === 0 && usageComplete;
  const totalInputTokens = complete
    ? usage.promptCacheHitTokens + usage.promptCacheMissTokens
    : 0;
  const calculatedCostUsd = complete && group.provider === 'deepseek-official'
    ? contextExperimentUsageCostUsd(usage, group.rates)
    : null;
  const costUsd = calculatedCostUsd !== null && Number.isFinite(calculatedCostUsd)
    ? calculatedCostUsd
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
    outboundLogicalTurnIds,
    records: group.records.length,
    outboundRequestCount,
    localRetrievalCount: group.records.filter(
      (record) => record.transport === 'local' && record.phase === 'retrieval',
    ).length,
    missingUsageRecords,
    usage: complete ? usage : null,
    visibleOutputCharCount,
    costUsd,
    costPer100TurnsUsd,
    cacheHitRate: complete && totalInputTokens > 0
      ? usage.promptCacheHitTokens / totalInputTokens
      : null,
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
    baseline.usage === null ||
    candidate.usage === null ||
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
  if (baseline.completedTurnIds.length === 0 || candidate.completedTurnIds.length === 0) {
    return { status: 'unavailable', reason: 'insufficient-turns' };
  }
  if (
    baseline.completedTurnIds.length !== baseline.effectiveTurns ||
    candidate.completedTurnIds.length !== candidate.effectiveTurns
  ) {
    return { status: 'unavailable', reason: 'incomplete-turns' };
  }
  if (
    baseline.completedTurnIds.length !== candidate.completedTurnIds.length ||
    baseline.completedTurnIds.some((turnId, index) => turnId !== candidate.completedTurnIds[index])
  ) {
    return { status: 'unavailable', reason: 'turn-id-mismatch' };
  }
  if (
    baseline.outboundLogicalTurnIds.some(
      (turnId) => turnId === null || !baseline.completedTurnIds.includes(turnId),
    ) ||
    candidate.outboundLogicalTurnIds.some(
      (turnId) => turnId === null || !baseline.completedTurnIds.includes(turnId),
    )
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

function turnRange(turnIds: readonly string[]): ContextExperimentTurnRange {
  return {
    firstTurnId: turnIds[0] ?? null,
    lastTurnId: turnIds.at(-1) ?? null,
    completedTurnCount: turnIds.length,
  };
}

function costsByLogicalTurn(group: ContextExperimentGroup): Map<string, number> | null {
  const result = new Map<string, number>();
  for (const record of group.records) {
    if (record.transport === 'local') continue;
    const turnId = record.logicalTurnId;
    const usage = contextExperimentUsageFromSse(record.usage ?? undefined);
    if (!turnId || !usage) return null;
    result.set(
      turnId,
      (result.get(turnId) ?? 0) + contextExperimentUsageCostUsd(usage, group.rates),
    );
  }
  return result;
}

/**
 * Reports an evidence-only cost comparison over the ordered turn prefix shared
 * by unequal runs. It does not relax estimateContextSavings, which remains the
 * strict basis for user-facing savings claims.
 */
export function compareContextExperimentRangeSubset(
  baselineGroup: ContextExperimentGroup,
  candidateGroup: ContextExperimentGroup,
  baseline: ContextExperimentSummary,
  candidate: ContextExperimentSummary,
): ContextExperimentRangeSubsetComparison {
  const baselineTurnIds = [...new Set(baseline.completedTurnIds)];
  const candidateTurnIds = [...new Set(candidate.completedTurnIds)];
  const subsetTurnIds: string[] = [];
  for (let index = 0; index < Math.min(baselineTurnIds.length, candidateTurnIds.length); index += 1) {
    if (baselineTurnIds[index] !== candidateTurnIds[index]) break;
    subsetTurnIds.push(baselineTurnIds[index]);
  }
  const ranges = {
    baselineRange: turnRange(baselineTurnIds),
    candidateRange: turnRange(candidateTurnIds),
    subsetRange: {
      ...turnRange(subsetTurnIds),
      turnIds: subsetTurnIds,
    },
  };

  if (baseline.provider !== 'deepseek-official' || candidate.provider !== 'deepseek-official') {
    return { status: 'unavailable', reason: 'non-official-provider', ...ranges };
  }
  if (
    baseline.usage === null ||
    candidate.usage === null ||
    baseline.missingUsageRecords > 0 ||
    candidate.missingUsageRecords > 0
  ) {
    return { status: 'unavailable', reason: 'incomplete-usage', ...ranges };
  }
  if (baseline.model !== candidate.model) {
    return { status: 'unavailable', reason: 'model-mismatch', ...ranges };
  }
  if (
    baseline.pricingSchedule !== candidate.pricingSchedule ||
    baseline.rates.cacheHitInputPerMillionUsd !== candidate.rates.cacheHitInputPerMillionUsd ||
    baseline.rates.cacheMissInputPerMillionUsd !== candidate.rates.cacheMissInputPerMillionUsd ||
    baseline.rates.outputPerMillionUsd !== candidate.rates.outputPerMillionUsd
  ) {
    return { status: 'unavailable', reason: 'pricing-mismatch', ...ranges };
  }
  if (subsetTurnIds.length === 0) {
    return { status: 'unavailable', reason: 'insufficient-turns', ...ranges };
  }

  const baselineCosts = costsByLogicalTurn(baselineGroup);
  const candidateCosts = costsByLogicalTurn(candidateGroup);
  if (!baselineCosts || !candidateCosts) {
    return { status: 'unavailable', reason: 'incomplete-usage', ...ranges };
  }
  const baselineCostUsd = subsetTurnIds.reduce(
    (total, turnId) => total + (baselineCosts.get(turnId) ?? 0),
    0,
  );
  const candidateCostUsd = subsetTurnIds.reduce(
    (total, turnId) => total + (candidateCosts.get(turnId) ?? 0),
    0,
  );
  const savingsUsd = baselineCostUsd - candidateCostUsd;
  return {
    status: 'available',
    ...ranges,
    baselineCostUsd,
    candidateCostUsd,
    savingsUsd,
    savingsPercent: baselineCostUsd > 0 ? savingsUsd / baselineCostUsd * 100 : null,
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
  const attemptsByOperation = new Map<string, Set<number>>();
  for (const request of requests) {
    const validAttempt =
      Number.isSafeInteger(request.attempt) &&
      request.attempt >= 0 &&
      request.attempt <= budget.maxRetriesPerOperation;
    if (!validAttempt) violations.add('retry-limit');
    if (validAttempt) {
      const attempts = attemptsByOperation.get(request.operationId) ?? new Set<number>();
      if (attempts.has(request.attempt)) violations.add('retry-limit');
      attempts.add(request.attempt);
      attemptsByOperation.set(request.operationId, attempts);
    }

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
  for (const attempts of attemptsByOperation.values()) {
    let expectedAttempt = 0;
    for (const attempt of attempts) {
      if (attempt !== expectedAttempt) {
        violations.add('retry-limit');
        break;
      }
      expectedAttempt += 1;
    }
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
