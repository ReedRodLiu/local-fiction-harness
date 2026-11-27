import type {
  CreativeWorkspaceState,
  DraftWork,
  LocalCharacter,
} from './creative.ts';
import { isOfficialDeepSeekUrl } from './keyConfig.ts';
import type {
  CustomModelPricing,
  LlmUsage,
  ProviderCapabilities,
  Story,
  TurnNode,
  TurnUsageTelemetry,
  UsageProviderKind,
} from './types.ts';

export interface DeepSeekPricingRates {
  cacheHitInputPerMillionUsd: number;
  cacheMissInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export type DeepSeekPricingSchedule = 'off-peak' | 'peak';

export const DEEPSEEK_OFFICIAL_OFF_PEAK_RATES: Readonly<DeepSeekPricingRates> = {
  cacheHitInputPerMillionUsd: 0.003,
  cacheMissInputPerMillionUsd: 0.15,
  outputPerMillionUsd: 0.6,
};

export const DEEPSEEK_OFFICIAL_PEAK_RATES: Readonly<DeepSeekPricingRates> = {
  cacheHitInputPerMillionUsd: 0.006,
  cacheMissInputPerMillionUsd: 0.3,
  outputPerMillionUsd: 1.2,
};

export type SessionSavingsUnavailableReason =
  | 'no-usage-data'
  | 'non-official-provider'
  | 'incomplete-usage'
  | 'no-compression-yet';

export type PricingCurrency = 'USD' | 'CNY';
export type PricingSource = 'deepseek-official' | 'custom';

export type SessionSavingsResult =
  | {
      status: 'available';
      schedule: DeepSeekPricingSchedule;
      rates: Readonly<DeepSeekPricingRates>;
      currency?: PricingCurrency;
      pricingSource?: PricingSource;
      actualCostUsd: number;
      baselineCostUsd: number;
      estimatedSavingsUsd: number;
      savingsPercent: number | null;
      evictedInputTokensEstimated: number;
      summaryOverheadTokens: number;
      compressedTurnCount: number;
      comparedTurnCount: number;
    }
  | {
      status: 'tokens-only';
      evictedInputTokensEstimated: number;
      summaryOverheadTokens: number;
      netSavedTokensEstimated: number;
      compressedTurnCount: number;
      comparedTurnCount: number;
    }
  | {
      status: 'unavailable';
      reason: SessionSavingsUnavailableReason;
      schedule: DeepSeekPricingSchedule;
      rates: Readonly<DeepSeekPricingRates>;
      compressedTurnCount: number;
    };

export interface SessionUsageSummary {
  recordedTurnCount: number;
  compressedTurnCount: number;
  retrievedTurnCount: number;
  totalRetrievedNodes: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  summaryPromptTokens: number;
  summaryCompletionTokens: number;
  cacheHitRate: number | null;
  actualCostUsd: number | null;
  actualCostAmount?: number | null;
  actualCostCurrency?: PricingCurrency;
  models: string[];
  savings: SessionSavingsResult;
}

export type WorkspaceUsageMode = 'story' | 'writing' | 'character';

export interface WorkspaceModeUsageSummary extends SessionUsageSummary {
  mode: WorkspaceUsageMode;
  itemCount: number;
  conversationCount: number;
}

export interface WorkspaceUsageSummary {
  total: SessionUsageSummary;
  modes: Record<WorkspaceUsageMode, WorkspaceModeUsageSummary>;
  itemCount: number;
}

export interface WorkspaceUsageInput {
  stories?: readonly Story[];
  creativeWorkspace?: Pick<CreativeWorkspaceState, 'works' | 'characters'> | null;
  works?: readonly DraftWork[];
  characters?: readonly LocalCharacter[];
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function addOptionalInt(left: number | undefined, right: number | undefined): number | undefined {
  if (!isNonNegativeInt(left) && !isNonNegativeInt(right)) return undefined;
  return (isNonNegativeInt(left) ? left : 0) + (isNonNegativeInt(right) ? right : 0);
}

/**
 * Combines two optional SSE usage payloads across retries or background summary batches.
 */
export function mergeLlmUsage(left?: LlmUsage, right?: LlmUsage): LlmUsage | undefined {
  if (!left) return right;
  if (!right) return left;

  const promptTokens = addOptionalInt(left.promptTokens, right.promptTokens);
  const completionTokens = addOptionalInt(left.completionTokens, right.completionTokens);
  const totalTokens = addOptionalInt(left.totalTokens, right.totalTokens);
  const promptCacheHitTokens = addOptionalInt(
    left.promptCacheHitTokens,
    right.promptCacheHitTokens,
  );
  const promptCacheMissTokens = addOptionalInt(
    left.promptCacheMissTokens,
    right.promptCacheMissTokens,
  );
  const reasoningTokens = addOptionalInt(
    left.completionTokensDetails?.reasoningTokens,
    right.completionTokensDetails?.reasoningTokens,
  );

  const merged: LlmUsage = {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(promptCacheHitTokens !== undefined ? { promptCacheHitTokens } : {}),
    ...(promptCacheMissTokens !== undefined ? { promptCacheMissTokens } : {}),
    ...(reasoningTokens !== undefined
      ? { completionTokensDetails: { reasoningTokens } }
      : {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isValidCustomPricing(pricing: unknown): pricing is CustomModelPricing {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false;
  const candidate = pricing as Partial<CustomModelPricing>;
  if (candidate.currency !== 'CNY' && candidate.currency !== 'USD') return false;
  if (
    typeof candidate.inputPerMillion !== 'number' ||
    !Number.isFinite(candidate.inputPerMillion) ||
    candidate.inputPerMillion < 0
  ) {
    return false;
  }
  if (
    typeof candidate.outputPerMillion !== 'number' ||
    !Number.isFinite(candidate.outputPerMillion) ||
    candidate.outputPerMillion < 0
  ) {
    return false;
  }
  if (
    candidate.cacheHitInputPerMillion !== undefined &&
    (typeof candidate.cacheHitInputPerMillion !== 'number' ||
      !Number.isFinite(candidate.cacheHitInputPerMillion) ||
      candidate.cacheHitInputPerMillion < 0)
  ) {
    return false;
  }
  return true;
}

function cloneCustomPricing(pricing: CustomModelPricing): CustomModelPricing {
  return {
    currency: pricing.currency,
    inputPerMillion: pricing.inputPerMillion,
    ...(pricing.cacheHitInputPerMillion !== undefined
      ? { cacheHitInputPerMillion: pricing.cacheHitInputPerMillion }
      : {}),
    outputPerMillion: pricing.outputPerMillion,
  };
}

export interface ResolveUsageProviderOptions {
  pricing?: CustomModelPricing;
  supportsBuiltinPricing?: boolean;
  capabilities?: ProviderCapabilities;
}

export function resolveUsageProviderKind(
  baseUrl?: string,
  options?: ResolveUsageProviderOptions,
): UsageProviderKind {
  const explicitBuiltin =
    options?.supportsBuiltinPricing ?? options?.capabilities?.supportsBuiltinPricing;
  if (explicitBuiltin === true || (explicitBuiltin !== false && isOfficialDeepSeekUrl(baseUrl ?? ''))) {
    return 'deepseek-official';
  }
  if (isValidCustomPricing(options?.pricing)) {
    return 'custom-priced';
  }
  return 'other';
}

export function buildTurnUsageTelemetry(options: {
  baseUrl?: string;
  model: string;
  generationUsage?: LlmUsage;
  summaryUsage?: LlmUsage;
  uncompressedPromptChars?: number;
  compressedPromptChars?: number;
  retrievedNodeCount?: number;
  pricing?: CustomModelPricing;
  supportsBuiltinPricing?: boolean;
  capabilities?: ProviderCapabilities;
}): TurnUsageTelemetry {
  const providerKind = resolveUsageProviderKind(options.baseUrl, {
    pricing: options.pricing,
    supportsBuiltinPricing: options.supportsBuiltinPricing,
    capabilities: options.capabilities,
  });
  const pricingSnapshot =
    providerKind === 'custom-priced' && isValidCustomPricing(options.pricing)
      ? cloneCustomPricing(options.pricing)
      : undefined;
  return {
    providerKind,
    model: options.model.trim() || 'deepseek-flash',
    ...(options.generationUsage ? { generationUsage: options.generationUsage } : {}),
    ...(options.summaryUsage ? { summaryUsage: options.summaryUsage } : {}),
    ...(options.uncompressedPromptChars !== undefined
      ? { uncompressedPromptChars: options.uncompressedPromptChars }
      : {}),
    ...(options.compressedPromptChars !== undefined
      ? { compressedPromptChars: options.compressedPromptChars }
      : {}),
    ...(options.retrievedNodeCount !== undefined
      ? { retrievedNodeCount: options.retrievedNodeCount }
      : {}),
    ...(pricingSnapshot ? { pricingSnapshot } : {}),
  };
}

/**
 * Resolves DeepSeek's published UTC off-peak discount window (16:30–00:30 UTC).
 */
export function resolveDeepSeekPricingSchedule(nowMs: number = Date.now()): DeepSeekPricingSchedule {
  const date = new Date(nowMs);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return utcMinutes >= 16 * 60 + 30 || utcMinutes < 30 ? 'off-peak' : 'peak';
}

export function getDeepSeekOfficialRates(
  schedule: DeepSeekPricingSchedule,
): Readonly<DeepSeekPricingRates> {
  return schedule === 'off-peak' ? DEEPSEEK_OFFICIAL_OFF_PEAK_RATES : DEEPSEEK_OFFICIAL_PEAK_RATES;
}

function resolveUsageTokens(usage: LlmUsage): {
  promptTokens: number | null;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hasSplitCache: boolean;
  completionTokens: number | null;
  reasoningTokens: number;
} {
  const hasHit = isNonNegativeInt(usage.promptCacheHitTokens);
  const hasMiss = isNonNegativeInt(usage.promptCacheMissTokens);
  const cacheHitTokens = hasHit ? usage.promptCacheHitTokens! : 0;
  const cacheMissTokens = hasMiss ? usage.promptCacheMissTokens! : 0;

  let promptTokens: number | null = null;
  if (hasHit && hasMiss) {
    promptTokens = cacheHitTokens + cacheMissTokens;
  } else if (isNonNegativeInt(usage.promptTokens)) {
    promptTokens = usage.promptTokens!;
  } else if (hasHit || hasMiss) {
    promptTokens = cacheHitTokens + cacheMissTokens;
  }

  const completionTokens = isNonNegativeInt(usage.completionTokens)
    ? usage.completionTokens!
    : null;
  const reasoningTokens = isNonNegativeInt(usage.completionTokensDetails?.reasoningTokens)
    ? usage.completionTokensDetails!.reasoningTokens!
    : 0;

  return {
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    hasSplitCache: hasHit || hasMiss,
    completionTokens,
    reasoningTokens,
  };
}

interface ResolvedTurnRates {
  source: PricingSource;
  currency: PricingCurrency;
  cacheHitInputPerMillion: number;
  cacheMissInputPerMillion: number;
  outputPerMillion: number;
}

function resolveTurnRates(
  telemetry: TurnUsageTelemetry,
  officialRates: Readonly<DeepSeekPricingRates>,
): ResolvedTurnRates | null {
  if (telemetry.providerKind === 'deepseek-official') {
    return {
      source: 'deepseek-official',
      currency: 'USD',
      cacheHitInputPerMillion: officialRates.cacheHitInputPerMillionUsd,
      cacheMissInputPerMillion: officialRates.cacheMissInputPerMillionUsd,
      outputPerMillion: officialRates.outputPerMillionUsd,
    };
  }
  if (telemetry.providerKind === 'custom-priced' && isValidCustomPricing(telemetry.pricingSnapshot)) {
    const snap = telemetry.pricingSnapshot;
    return {
      source: 'custom',
      currency: snap.currency,
      cacheHitInputPerMillion: snap.cacheHitInputPerMillion ?? snap.inputPerMillion,
      cacheMissInputPerMillion: snap.inputPerMillion,
      outputPerMillion: snap.outputPerMillion,
    };
  }
  return null;
}

function usageCostWithRates(
  usage: LlmUsage,
  rates: Pick<ResolvedTurnRates, 'cacheHitInputPerMillion' | 'cacheMissInputPerMillion' | 'outputPerMillion'>,
): number | null {
  const resolved = resolveUsageTokens(usage);
  if (resolved.promptTokens === null || resolved.completionTokens === null) {
    return null;
  }
  const hitTokens = resolved.hasSplitCache ? resolved.cacheHitTokens : 0;
  const missTokens = resolved.hasSplitCache ? resolved.cacheMissTokens : resolved.promptTokens;
  return (
    (hitTokens * rates.cacheHitInputPerMillion +
      missTokens * rates.cacheMissInputPerMillion +
      resolved.completionTokens * rates.outputPerMillion) /
    1_000_000
  );
}

/**
 * Computes branch/session real LLM token totals and a conservative estimated
 * savings comparison against uncompressed full-history replay.
 * Uses DeepSeek official pricing or custom per-model pricing when all turns share one
 * currency; falls back to `tokens-only` savings when pricing is absent or mixed.
 */
export function computeSessionUsageSummary(
  nodes: readonly TurnNode[],
  options: { nowMs?: number; scheduleOverride?: DeepSeekPricingSchedule } = {},
): SessionUsageSummary {
  const schedule =
    options.scheduleOverride ?? resolveDeepSeekPricingSchedule(options.nowMs ?? Date.now());
  const rates = getDeepSeekOfficialRates(schedule);

  const telemetryNodes = nodes.filter(
    (node): node is TurnNode & { telemetry: TurnUsageTelemetry } => Boolean(node.telemetry),
  );

  let recordedTurnCount = 0;
  let compressedTurnCount = 0;
  let retrievedTurnCount = 0;
  let totalRetrievedNodes = 0;
  let promptTokens = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let summaryPromptTokens = 0;
  let summaryCompletionTokens = 0;
  let allPriced = telemetryNodes.length > 0;
  let hasCustomPricing = false;
  const currencies = new Set<PricingCurrency>();
  let allUsageComplete = true;
  let totalActualCost = 0;
  let totalSummaryCost = 0;
  let totalEvictedInputTokens = 0;
  let summaryOverheadTokens = 0;
  let splitCachePromptTotal = 0;
  const models = new Set<string>();
  const pricedCompressedTurns: Array<{
    evictedTokens: number;
    turnHitRatio: number | null;
    turnRates: ResolvedTurnRates;
  }> = [];

  for (const node of telemetryNodes) {
    const telemetry = node.telemetry;
    if (telemetry.model) models.add(telemetry.model);
    const turnRates = resolveTurnRates(telemetry, rates);
    if (!turnRates) {
      allPriced = false;
    } else {
      currencies.add(turnRates.currency);
      if (turnRates.source === 'custom') hasCustomPricing = true;
    }

    if ((telemetry.retrievedNodeCount ?? 0) > 0) {
      retrievedTurnCount += 1;
      totalRetrievedNodes += telemetry.retrievedNodeCount ?? 0;
    }

    const genUsage = telemetry.generationUsage;
    const sumUsage = telemetry.summaryUsage;
    if (!genUsage) {
      allUsageComplete = false;
      continue;
    }

    const genResolved = resolveUsageTokens(genUsage);
    if (genResolved.promptTokens === null || genResolved.completionTokens === null) {
      allUsageComplete = false;
    } else {
      recordedTurnCount += 1;
      promptTokens += genResolved.promptTokens;
      completionTokens += genResolved.completionTokens;
      reasoningTokens += genResolved.reasoningTokens;
      if (genResolved.hasSplitCache) {
        promptCacheHitTokens += genResolved.cacheHitTokens;
        promptCacheMissTokens += genResolved.cacheMissTokens;
        splitCachePromptTotal += genResolved.cacheHitTokens + genResolved.cacheMissTokens;
      } else {
        promptCacheMissTokens += genResolved.promptTokens;
      }
      if (turnRates) {
        const genCost = usageCostWithRates(genUsage, turnRates);
        if (genCost === null) allUsageComplete = false;
        else totalActualCost += genCost;
      }
    }

    if (sumUsage) {
      const sumResolved = resolveUsageTokens(sumUsage);
      if (sumResolved.promptTokens === null || sumResolved.completionTokens === null) {
        allUsageComplete = false;
      } else {
        summaryPromptTokens += sumResolved.promptTokens;
        summaryCompletionTokens += sumResolved.completionTokens;
        summaryOverheadTokens += sumResolved.promptTokens + sumResolved.completionTokens;
        promptTokens += sumResolved.promptTokens;
        completionTokens += sumResolved.completionTokens;
        reasoningTokens += sumResolved.reasoningTokens;
        if (sumResolved.hasSplitCache) {
          promptCacheHitTokens += sumResolved.cacheHitTokens;
          promptCacheMissTokens += sumResolved.cacheMissTokens;
          splitCachePromptTotal += sumResolved.cacheHitTokens + sumResolved.cacheMissTokens;
        } else {
          promptCacheMissTokens += sumResolved.promptTokens;
        }
        if (turnRates) {
          const sumCost = usageCostWithRates(sumUsage, turnRates);
          if (sumCost === null) allUsageComplete = false;
          else {
            totalActualCost += sumCost;
            totalSummaryCost += sumCost;
          }
        }
      }
    }

    const uncompressedChars = telemetry.uncompressedPromptChars ?? 0;
    const compressedChars = telemetry.compressedPromptChars ?? 0;
    if (uncompressedChars > compressedChars && compressedChars > 0) {
      compressedTurnCount += 1;
      const omittedChars = uncompressedChars - compressedChars;
      const empiricalTokensPerChar =
        genResolved.promptTokens !== null && compressedChars > 0
          ? Math.min(1.2, Math.max(0.4, genResolved.promptTokens / compressedChars))
          : 0.65;
      const turnEvicted = Math.round(omittedChars * empiricalTokensPerChar);
      totalEvictedInputTokens += turnEvicted;
      if (turnRates) {
        const turnSplitTotal = genResolved.cacheHitTokens + genResolved.cacheMissTokens;
        const turnHitRatio =
          genResolved.hasSplitCache && turnSplitTotal > 0
            ? genResolved.cacheHitTokens / turnSplitTotal
            : null;
        pricedCompressedTurns.push({
          evictedTokens: turnEvicted,
          turnHitRatio,
          turnRates,
        });
      }
    }
  }

  const cacheHitRate =
    splitCachePromptTotal > 0 ? promptCacheHitTokens / splitCachePromptTotal : null;

  const singleCurrency = currencies.size === 1 ? ([...currencies][0] as PricingCurrency) : undefined;
  const canComputeMoney =
    recordedTurnCount > 0 && allPriced && singleCurrency !== undefined && allUsageComplete;
  const actualCostAmount = canComputeMoney ? totalActualCost : null;
  const actualCostUsd = canComputeMoney && singleCurrency === 'USD' ? totalActualCost : null;

  const hasAnyGenerationUsage = telemetryNodes.some((node) => Boolean(node.telemetry.generationUsage));

  let savings: SessionSavingsResult;
  if (telemetryNodes.length === 0 || !hasAnyGenerationUsage) {
    savings = {
      status: 'unavailable',
      reason: 'no-usage-data',
      schedule,
      rates,
      compressedTurnCount,
    };
  } else if (!allUsageComplete || recordedTurnCount === 0) {
    savings = {
      status: 'unavailable',
      reason: 'incomplete-usage',
      schedule,
      rates,
      compressedTurnCount,
    };
  } else if (compressedTurnCount === 0 || totalEvictedInputTokens <= 0) {
    savings = {
      status: 'unavailable',
      reason: 'no-compression-yet',
      schedule,
      rates,
      compressedTurnCount,
    };
  } else if (!canComputeMoney || !singleCurrency) {
    savings = {
      status: 'tokens-only',
      evictedInputTokensEstimated: totalEvictedInputTokens,
      summaryOverheadTokens,
      netSavedTokensEstimated: Math.max(0, totalEvictedInputTokens - summaryOverheadTokens),
      compressedTurnCount,
      comparedTurnCount: recordedTurnCount,
    };
  } else {
    const observedHitRatio = cacheHitRate ?? 0;
    const pricingSource: PricingSource = hasCustomPricing ? 'custom' : 'deepseek-official';
    const firstRates = pricedCompressedTurns[0]?.turnRates;
    const uniformRates =
      !hasCustomPricing ||
      (firstRates !== undefined &&
        pricedCompressedTurns.every(
          (item) =>
            item.turnRates.cacheHitInputPerMillion === firstRates.cacheHitInputPerMillion &&
            item.turnRates.cacheMissInputPerMillion === firstRates.cacheMissInputPerMillion,
        ));

    let extraBaselineInputCost = 0;
    if (!hasCustomPricing) {
      const effectiveExtraInputRatePerMillion =
        observedHitRatio * rates.cacheHitInputPerMillionUsd +
        (1 - observedHitRatio) * rates.cacheMissInputPerMillionUsd;
      extraBaselineInputCost =
        (totalEvictedInputTokens * effectiveExtraInputRatePerMillion) / 1_000_000;
    } else if (uniformRates && firstRates) {
      const effectiveExtraInputRatePerMillion =
        observedHitRatio * firstRates.cacheHitInputPerMillion +
        (1 - observedHitRatio) * firstRates.cacheMissInputPerMillion;
      extraBaselineInputCost =
        (totalEvictedInputTokens * effectiveExtraInputRatePerMillion) / 1_000_000;
    } else {
      for (const item of pricedCompressedTurns) {
        const ratio = item.turnHitRatio ?? observedHitRatio;
        const effectiveRate =
          ratio * item.turnRates.cacheHitInputPerMillion +
          (1 - ratio) * item.turnRates.cacheMissInputPerMillion;
        extraBaselineInputCost += (item.evictedTokens * effectiveRate) / 1_000_000;
      }
    }

    const baselineCostUsd = Math.max(
      0,
      totalActualCost - totalSummaryCost + extraBaselineInputCost,
    );
    const estimatedSavingsUsd = baselineCostUsd - totalActualCost;
    savings = {
      status: 'available',
      schedule,
      rates,
      currency: singleCurrency,
      pricingSource,
      actualCostUsd: totalActualCost,
      baselineCostUsd,
      estimatedSavingsUsd,
      savingsPercent: baselineCostUsd > 0 ? (estimatedSavingsUsd / baselineCostUsd) * 100 : null,
      evictedInputTokensEstimated: totalEvictedInputTokens,
      summaryOverheadTokens,
      compressedTurnCount,
      comparedTurnCount: recordedTurnCount,
    };
  }

  return {
    recordedTurnCount,
    compressedTurnCount,
    retrievedTurnCount,
    totalRetrievedNodes,
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    reasoningTokens,
    summaryPromptTokens,
    summaryCompletionTokens,
    cacheHitRate,
    actualCostUsd,
    actualCostAmount,
    ...(canComputeMoney && singleCurrency ? { actualCostCurrency: singleCurrency } : {}),
    models: [...models],
    savings,
  };
}

function deduplicateById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function collectDraftWorkNodes(work: DraftWork): TurnNode[] {
  const byId = new Map<string, TurnNode>();
  for (const node of work.discussion) {
    byId.set(node.id, node);
  }
  if (work.discussionNodes) {
    for (const node of Object.values(work.discussionNodes)) {
      byId.set(node.id, node);
    }
  }
  return [...byId.values()];
}

/**
 * Aggregates historical TurnNode telemetry across all stories (including branches/retries),
 * writing works, and character conversations without double-counting.
 */
export function computeWorkspaceUsageSummary(
  input: WorkspaceUsageInput,
  options: { nowMs?: number; scheduleOverride?: DeepSeekPricingSchedule } = {},
): WorkspaceUsageSummary {
  const computeOptions = {
    nowMs: options.nowMs ?? Date.now(),
    ...(options.scheduleOverride ? { scheduleOverride: options.scheduleOverride } : {}),
  };

  const stories = deduplicateById(input.stories ?? []);
  const works = deduplicateById(input.works ?? input.creativeWorkspace?.works ?? []);
  const characters = deduplicateById(input.characters ?? input.creativeWorkspace?.characters ?? []);

  const storyNodes: TurnNode[] = [];
  for (const story of stories) {
    storyNodes.push(...Object.values(story.nodes));
  }

  const writingNodes: TurnNode[] = [];
  for (const work of works) {
    writingNodes.push(...collectDraftWorkNodes(work));
  }

  const characterNodes: TurnNode[] = [];
  let characterConversationCount = 0;
  for (const character of characters) {
    const conversations = deduplicateById(character.conversations);
    characterConversationCount += conversations.length;
    for (const conversation of conversations) {
      characterNodes.push(...Object.values(conversation.nodes));
    }
  }

  const storySummary: WorkspaceModeUsageSummary = {
    mode: 'story',
    itemCount: stories.length,
    conversationCount: stories.length,
    ...computeSessionUsageSummary(storyNodes, computeOptions),
  };

  const writingSummary: WorkspaceModeUsageSummary = {
    mode: 'writing',
    itemCount: works.length,
    conversationCount: works.length,
    ...computeSessionUsageSummary(writingNodes, computeOptions),
  };

  const characterSummary: WorkspaceModeUsageSummary = {
    mode: 'character',
    itemCount: characters.length,
    conversationCount: characterConversationCount,
    ...computeSessionUsageSummary(characterNodes, computeOptions),
  };

  const total = computeSessionUsageSummary(
    [...storyNodes, ...writingNodes, ...characterNodes],
    computeOptions,
  );

  return {
    total,
    modes: {
      story: storySummary,
      writing: writingSummary,
      character: characterSummary,
    },
    itemCount: stories.length + works.length + characters.length,
  };
}
