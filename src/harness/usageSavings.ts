import type {
  CreativeWorkspaceState,
  DraftWork,
  LocalCharacter,
} from './creative.ts';
import { classifyAndRedactHost } from './diagnostics.ts';
import type {
  LlmUsage,
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

export type SessionSavingsResult =
  | {
      status: 'available';
      schedule: DeepSeekPricingSchedule;
      rates: Readonly<DeepSeekPricingRates>;
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

function parseHostname(rawBaseUrl?: string): string {
  const trimmed = (rawBaseUrl ?? '').trim();
  if (!trimmed) return '';
  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const slashIndex = withoutScheme.indexOf('/');
  const authority = slashIndex === -1 ? withoutScheme : withoutScheme.slice(0, slashIndex);
  const atIndex = authority.lastIndexOf('@');
  const hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);
  const colonIndex = hostPort.indexOf(':');
  return (colonIndex === -1 ? hostPort : hostPort.slice(0, colonIndex)).toLowerCase();
}

export function resolveUsageProviderKind(baseUrl?: string): UsageProviderKind {
  const host = parseHostname(baseUrl);
  if (!host) return 'other';
  return classifyAndRedactHost(host).hostKind === 'official' ? 'deepseek-official' : 'other';
}

export function buildTurnUsageTelemetry(options: {
  baseUrl?: string;
  model: string;
  generationUsage?: LlmUsage;
  summaryUsage?: LlmUsage;
  uncompressedPromptChars?: number;
  compressedPromptChars?: number;
  retrievedNodeCount?: number;
}): TurnUsageTelemetry {
  return {
    providerKind: resolveUsageProviderKind(options.baseUrl),
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

function usageCostUsd(
  usage: LlmUsage,
  rates: Readonly<DeepSeekPricingRates>,
): number | null {
  const resolved = resolveUsageTokens(usage);
  if (resolved.promptTokens === null || resolved.completionTokens === null) {
    return null;
  }
  const hitTokens = resolved.hasSplitCache ? resolved.cacheHitTokens : 0;
  const missTokens = resolved.hasSplitCache ? resolved.cacheMissTokens : resolved.promptTokens;
  return (
    (hitTokens * rates.cacheHitInputPerMillionUsd +
      missTokens * rates.cacheMissInputPerMillionUsd +
      resolved.completionTokens * rates.outputPerMillionUsd) /
    1_000_000
  );
}

/**
 * Computes branch/session real LLM token totals and a conservative estimated
 * savings comparison against uncompressed full-history replay under DeepSeek official pricing.
 * Strictly marks savings `unavailable` (never fakes zero or placeholder amounts)
 * when official usage or compression deltas are absent.
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
  let allOfficial = telemetryNodes.length > 0;
  let allUsageComplete = true;
  let totalActualCostUsd = 0;
  let totalSummaryCostUsd = 0;
  let totalEvictedInputTokens = 0;
  let summaryOverheadTokens = 0;
  let splitCachePromptTotal = 0;
  const models = new Set<string>();

  for (const node of telemetryNodes) {
    const telemetry = node.telemetry;
    if (telemetry.model) models.add(telemetry.model);
    if (telemetry.providerKind !== 'deepseek-official') {
      allOfficial = false;
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
      const genCost = usageCostUsd(genUsage, rates);
      if (genCost === null) allUsageComplete = false;
      else totalActualCostUsd += genCost;
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
        const sumCost = usageCostUsd(sumUsage, rates);
        if (sumCost === null) allUsageComplete = false;
        else {
          totalActualCostUsd += sumCost;
          totalSummaryCostUsd += sumCost;
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
      totalEvictedInputTokens += Math.round(omittedChars * empiricalTokensPerChar);
    }
  }

  const cacheHitRate =
    splitCachePromptTotal > 0 ? promptCacheHitTokens / splitCachePromptTotal : null;

  const actualCostUsd =
    recordedTurnCount > 0 && allOfficial && allUsageComplete ? totalActualCostUsd : null;

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
  } else if (!allOfficial) {
    savings = {
      status: 'unavailable',
      reason: 'non-official-provider',
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
  } else {
    const observedHitRatio = cacheHitRate ?? 0;
    const effectiveExtraInputRatePerMillionUsd =
      observedHitRatio * rates.cacheHitInputPerMillionUsd +
      (1 - observedHitRatio) * rates.cacheMissInputPerMillionUsd;
    const extraBaselineInputCostUsd =
      (totalEvictedInputTokens * effectiveExtraInputRatePerMillionUsd) / 1_000_000;
    const baselineCostUsd = Math.max(
      0,
      totalActualCostUsd - totalSummaryCostUsd + extraBaselineInputCostUsd,
    );
    const estimatedSavingsUsd = baselineCostUsd - totalActualCostUsd;
    savings = {
      status: 'available',
      schedule,
      rates,
      actualCostUsd: totalActualCostUsd,
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
