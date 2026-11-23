import {
  assembleCreativeThreeZoneContext,
  buildSummaryCompressionMessages,
  DEFAULT_CONTEXT_BUDGET,
  EMPTY_SUMMARY_SNAPSHOT,
  getActiveBranchNodes,
  getTurnTreeSummarySnapshot,
  getUncoveredNodes,
  selectNodesToSummarize,
  takeCreativeSummaryBatch,
} from '../../src/harness/context.ts';
import {
  generateExperimentScenario,
  retrieveFromActiveBranch,
  type GeneratedExperimentScenario,
} from './experiment.ts';
import type {
  LlmMessage,
  PlotSummarySnapshot,
  ReasoningEffort,
  TurnNode,
} from '../../src/harness/types.ts';

export const GO_CHAT_ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
export const GO_USAGE_ENDPOINT = 'https://opencode.ai/inference/go/v1/usage';
export const GO_MODEL = 'deepseek-v4.1-flash';
export const GO_CANONICAL_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
export const GO_USER_AGENT = 'FolioContextBenchmark/0.3';
export const GO_UPPER_BOUND_PRICING = {
  basis: 'published Go model full price, uncached peak',
  inputUsdPerMillion: 0.30,
  outputUsdPerMillion: 1.20,
} as const;

export type LiveArm = 'full' | 'folio' | 'retrievable';
export type LivePhase = 'generation' | 'summary' | 'probe';
export type LiveRequestStatus =
  | 'in-flight'
  | 'completed'
  | 'refused'
  | 'truncated'
  | 'failed'
  | 'aborted';

export interface GoExperimentSettings {
  turns: number;
  repetitions: number;
  order: LiveArm[];
  reasoningEffort: ReasoningEffort;
  summaryReasoningEffort: ReasoningEffort;
  maxRequests: number;
  maxRetries: number;
  maxInputTokensPerRequest: number;
  maxTotalInputTokens: number;
  maxOutputTokensPerRequest: number;
  maxTotalOutputTokens: number;
  maxAllowance: number;
  hardStopUsagePercent: number;
  requestTimeoutMs: number;
  cadenceMs: number;
}

export interface GoUsageSnapshotLimit {
  status: string | null;
  percent: number | null;
  resetsAt: string | null;
}

export interface GoUsageSnapshot {
  capturedAt: string;
  status: 'completed' | 'failed';
  rolling: GoUsageSnapshotLimit | null;
  weekly: GoUsageSnapshotLimit | null;
  monthly: GoUsageSnapshotLimit | null;
  error?: GoRequestError;
}

export interface GoUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  allowance: number | null;
  listCostUsd: number | null;
  chargedUsd: number | null;
  billingSource: string | null;
  hasCostField: boolean;
}

export interface GoRequestError {
  httpStatus?: number;
  type?: string;
  code?: string;
  message: string;
  retryable: boolean;
}

export interface LiveRequestRecord {
  requestId: string;
  operationId: string;
  arm: LiveArm;
  repetition: number;
  attempt: number;
  phase: LivePhase;
  logicalTurnId: string | null;
  routeId: string | null;
  branchSwitch: boolean;
  status: LiveRequestStatus;
  startedAt: string;
  completedAt: string | null;
  messageCount: number;
  inputCharCount: number;
  estimatedInputTokenUpperBound: number;
  contextPolicy: 'full-history' | 'rolling-summary' | 'branch-retrieval';
  summaryCoveredThrough: string | null;
  firstContentLatencyMs: number | null;
  durationMs: number | null;
  responseModel: string | null;
  systemFingerprint: string | null;
  finishReason: string | null;
  refusal: string | null;
  truncated: boolean;
  visibleOutputCharCount: number | null;
  reasoningCharCount: number;
  output: string | null;
  usage: GoUsage | null;
  estimatedListCostUsdUpperBound: number;
  error?: GoRequestError;
}

export interface LiveProbeRecord {
  probeId: string;
  repetition: number;
  arm: LiveArm;
  afterTurnId: string;
  requestId: string | null;
  answer: string | null;
  expectedFacts: string[];
  forbiddenFacts: string[];
  expectedFactsPresent: boolean | null;
  forbiddenFactsAbsent: boolean | null;
  correct: boolean | null;
  status: 'completed' | 'failed' | 'refused' | 'truncated';
}

export interface LiveGeneratedOutput {
  turnId: string;
  routeId: string;
  parentId: string | null;
  user: string;
  assistant: string;
  userNodeId: string;
  assistantNodeId: string;
}

interface LiveArmState {
  sessionId: string;
  status: 'not-started' | 'running' | 'completed' | 'incomplete';
  incompletePhases: LivePhase[];
  nodes: Record<string, TurnNode>;
  activeLeafId: string | null;
  previousAssistantByRoute: Record<string, string>;
  completedTurnIds: string[];
  generatedOutputs: LiveGeneratedOutput[];
}

export interface LiveRepetitionState {
  index: number;
  order: LiveArm[];
  arms: Record<LiveArm, LiveArmState>;
}

export interface LiveTokenTotals {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

export interface LiveRequestStatusCounts {
  total: number;
  inFlight: number;
  completed: number;
  refused: number;
  truncated: number;
  failed: number;
  aborted: number;
}

export type LivePhaseCompletionStatus = 'completed' | 'incomplete' | 'not-required';

export interface LiveLogicalTurnKey {
  repetition: number;
  logicalTurnId: string;
}

export interface LiveArmSummary {
  arm: LiveArm;
  coreStatus: 'completed' | 'incomplete';
  summaryStatus: LivePhaseCompletionStatus;
  probeStatus: LivePhaseCompletionStatus;
  qualityStatus: 'complete' | 'incomplete' | 'not-assessed';
  completedTurns: number;
  completedLogicalTurnKeys: LiveLogicalTurnKey[];
  requestCounts: Record<LivePhase, number>;
  phaseRequestStatusCounts: Record<LivePhase, LiveRequestStatusCounts>;
  refusalCount: number;
  truncationCount: number;
  missingUsageRecords: number;
  unknownBillingRecords: number;
  tokenTotals: LiveTokenTotals;
  generationTokenTotals: LiveTokenTotals;
  planAllowanceUsed: number | null;
  listCostUsd: number | null;
  chargedUsd: number | null;
  firstContentLatencyMsP50: number | null;
  firstContentLatencyMsP95: number | null;
  probesExpected: number;
  probesPassed: number;
  probesScored: number;
  probesIncorrect: number;
  probesIncomplete: number;
  probesTotal: number;
}

export interface LiveCommonRange {
  logicalTurnKeys: LiveLogicalTurnKey[];
  byArm: Record<LiveArm, {
    completedTurns: number;
    billedRequests: number;
    phaseCounts: Record<LivePhase, number>;
    billedPhaseCounts: Record<LivePhase, number>;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    cacheReadTokens: number | null;
    cacheWrite5mTokens: number | null;
    cacheWrite1hTokens: number | null;
    planAllowance: number | null;
    listCostUsd: number | null;
    chargedUsd: number | null;
    latencyMsP50: number | null;
    latencyMsP95: number | null;
  }>;
}

export interface LiveExperimentSummary {
  commonRange: LiveCommonRange;
  byArm: Record<LiveArm, LiveArmSummary>;
  comparisons: Record<'fullToRetrievable' | 'folioToRetrievable', {
    commonTurnCount: number;
    promptTokenDelta: number | null;
    completionTokenDelta: number | null;
    reasoningTokenDelta: number | null;
    cacheReadTokenDelta: number | null;
    cacheWrite5mTokenDelta: number | null;
    cacheWrite1hTokenDelta: number | null;
    planAllowanceDelta: number | null;
    listCostUsdDelta: number | null;
    chargedUsdDelta: number | null;
  }>;
  usd: {
    status: 'reported-separately';
    planAllowance: { unit: 'go-allowance'; notBalanceCharge: true };
    listCost: { source: 'opencode.list_cost' };
    charged: { source: 'usage.cost' };
  };
}

export interface LiveExperimentState {
  schemaVersion: 2;
  mode: 'live-opencode-go';
  runId: string;
  status: 'running' | 'completed' | 'incomplete' | 'failed';
  startedAt: string;
  updatedAt: string;
  provider: {
    name: 'OpenCode Go';
    endpoint: string;
    usageEndpoint: string;
    model: string;
    canonicalModel: string;
    userAgent: string;
    sessionHeader: 'x-opencode-session';
    upperBoundPricing: typeof GO_UPPER_BOUND_PRICING;
  };
  settings: GoExperimentSettings;
  schedule: Array<{
    turnId: string;
    action: string;
    routeId: string;
    branchSwitch: boolean;
    probeAfter: boolean;
  }>;
  usagePreflight: GoUsageSnapshot | null;
  usagePostflight: GoUsageSnapshot | null;
  repetitions: LiveRepetitionState[];
  records: LiveRequestRecord[];
  probes: LiveProbeRecord[];
  summary: LiveExperimentSummary | null;
  failure: GoRequestError | null;
  limitations: string[];
}

export interface GoFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array | string> | null;
  text(): Promise<string>;
}

export type GoFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<GoFetchResponse>;

export interface RunGoExperimentOptions {
  apiKey: string;
  runId: string;
  sessionIds: Record<LiveArm, string>;
  fetch: GoFetch;
  settings: GoExperimentSettings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onCheckpoint?: (state: LiveExperimentState) => Promise<void> | void;
}

const ARMS: readonly LiveArm[] = ['full', 'folio', 'retrievable'] as const;
const FOLIO_BUDGET = {
  recentMaxNodes: 8,
  recentMaxChars: 6_000,
  summaryBatchMaxNodes: DEFAULT_CONTEXT_BUDGET.summaryBatchMaxNodes,
  summaryBatchMaxChars: DEFAULT_CONTEXT_BUDGET.summaryBatchMaxChars,
} as const;
const SUMMARY_STOP_REASONS = new Set(['stop']);

export const DEFAULT_GO_EXPERIMENT_SETTINGS: Readonly<GoExperimentSettings> = {
  turns: 30,
  repetitions: 1,
  order: [...ARMS],
  reasoningEffort: 'high',
  summaryReasoningEffort: 'none',
  maxRequests: 180,
  maxRetries: 1,
  maxInputTokensPerRequest: 256_000,
  maxTotalInputTokens: 4_000_000,
  maxOutputTokensPerRequest: 512,
  maxTotalOutputTokens: 50_000,
  maxAllowance: 0.5,
  hardStopUsagePercent: 90,
  requestTimeoutMs: 120_000,
  cadenceMs: 1_000,
};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalNestedNumber(value: unknown, path: readonly string[]): number | null {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return finiteNonnegative(cursor);
}

function optionalNestedString(value: unknown, path: readonly string[]): string | null {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
}

function parseUsage(raw: unknown): GoUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const promptTokens = optionalNestedNumber(raw, ['prompt_tokens']) ??
    optionalNestedNumber(raw, ['opencode', 'tokens', 'input']);
  const completionTokens = optionalNestedNumber(raw, ['completion_tokens']) ??
    optionalNestedNumber(raw, ['opencode', 'tokens', 'output']);
  const reasoningTokens = optionalNestedNumber(raw, ['completion_tokens_details', 'reasoning_tokens']) ??
    optionalNestedNumber(raw, ['opencode', 'tokens', 'reasoning']);
  const cacheReadTokens = optionalNestedNumber(raw, ['prompt_tokens_details', 'cached_tokens']) ??
    optionalNestedNumber(raw, ['opencode', 'tokens', 'cache_read']);
  const cacheWrite5mTokens = optionalNestedNumber(raw, ['opencode', 'tokens', 'cache_write_5m']);
  const cacheWrite1hTokens = optionalNestedNumber(raw, ['opencode', 'tokens', 'cache_write_1h']);
  const allowance = optionalNestedNumber(raw, ['opencode', 'allowance']);
  const listCostUsd = optionalNestedNumber(raw, ['opencode', 'list_cost']);
  const chargedUsd = optionalNestedNumber(raw, ['cost']);
  const billingSource = optionalNestedString(raw, ['opencode', 'billing_source']);
  const hasCostField = Object.hasOwn(record, 'cost');
  if (
    promptTokens === null &&
    completionTokens === null &&
    reasoningTokens === null &&
    cacheReadTokens === null &&
    cacheWrite5mTokens === null &&
    cacheWrite1hTokens === null &&
    allowance === null &&
    listCostUsd === null &&
    chargedUsd === null &&
    billingSource === null &&
    !hasCostField
  ) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    allowance,
    listCostUsd,
    chargedUsd,
    billingSource,
    hasCostField,
  };
}

function parseUsageLimit(raw: unknown, key: string): GoUsageSnapshotLimit | null {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, key)) return null;
  const limit = (raw as Record<string, unknown>)[key];
  if (!limit || typeof limit !== 'object') return null;
  const record = limit as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : null,
    percent: finiteNonnegative(record.percent),
    resetsAt: typeof record.resetsAt === 'string' ? record.resetsAt : null,
  };
}

function parseErrorPayload(value: unknown, httpStatus?: number, retryable = false): GoRequestError {
  const errorRecord = value && typeof value === 'object' &&
    Object.hasOwn(value, 'error') && (value as Record<string, unknown>).error;
  const source = errorRecord && typeof errorRecord === 'object'
    ? errorRecord as Record<string, unknown>
    : value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
  const rawMessage = source.message;
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage.trim().slice(0, 500)
    : `HTTP ${httpStatus ?? 'unknown'} response`;
  return {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(typeof source.type === 'string' ? { type: source.type } : {}),
    ...(typeof source.code === 'string' ? { code: source.code } : {}),
    message,
    retryable,
  };
}

function requestErrorFromUnknown(error: unknown, timeoutMs: number): GoRequestError {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return {
      type: 'TimeoutError',
      message: `Request exceeded ${timeoutMs} ms.`,
      retryable: false,
    };
  }
  return {
    type: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown request failure.',
    retryable: false,
  };
}

async function responseFailure(
  response: GoFetchResponse,
  retryable: boolean,
): Promise<{ error: GoRequestError; usage: GoUsage | null }> {
  let parsed: unknown = null;
  try {
    const text = await response.text();
    if (text.trim()) parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    error: parseErrorPayload(parsed, response.status, retryable),
    usage: parseUsage(parsed),
  };
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Request exceeded ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function* bodyChunks(body: GoFetchResponse['body']): AsyncIterable<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

interface ParsedCompletion {
  content: string;
  reasoningCharacters: number;
  refusal: string | null;
  finishReason: string | null;
  usage: GoUsage | null;
  responseModel: string | null;
  systemFingerprint: string | null;
  firstContentLatencyMs: number | null;
}

async function parseCompletionStream(
  body: GoFetchResponse['body'],
  startedAt: number,
): Promise<ParsedCompletion> {
  let buffer = '';
  let dataLines: string[] = [];
  let content = '';
  let reasoningCharacters = 0;
  let refusal = '';
  let finishReason: string | null = null;
  let usage: GoUsage | null = null;
  let responseModel: string | null = null;
  let systemFingerprint: string | null = null;
  let firstContentLatencyMs: number | null = null;

  const parseEvent = (payload: string): boolean => {
    const trimmed = payload.trim();
    if (!trimmed) return false;
    if (trimmed === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const event = parsed as Record<string, unknown>;
    if (Object.hasOwn(event, 'error')) throw parseErrorPayload(parsed);
    if (typeof event.model === 'string' && event.model.trim()) responseModel = event.model.trim();
    if (typeof event.system_fingerprint === 'string' && event.system_fingerprint.trim()) {
      systemFingerprint = event.system_fingerprint.trim();
    }
    const parsedUsage = parseUsage(event.usage);
    if (parsedUsage) usage = parsedUsage;
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const choice = choices[0];
    if (!choice || typeof choice !== 'object') return false;
    const choiceRecord = choice as Record<string, unknown>;
    if (typeof choiceRecord.finish_reason === 'string') {
      finishReason = choiceRecord.finish_reason;
    }
    const delta = choiceRecord.delta;
    if (!delta || typeof delta !== 'object') return false;
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.content === 'string' && deltaRecord.content) {
      content += deltaRecord.content;
      firstContentLatencyMs ??= Date.now() - startedAt;
    }
    if (typeof deltaRecord.reasoning_content === 'string') {
      reasoningCharacters += deltaRecord.reasoning_content.length;
    } else if (typeof deltaRecord.reasoning === 'string') {
      reasoningCharacters += deltaRecord.reasoning.length;
    }
    if (typeof deltaRecord.refusal === 'string' && deltaRecord.refusal) {
      refusal += deltaRecord.refusal;
      firstContentLatencyMs ??= Date.now() - startedAt;
    }
    return false;
  };

  const flush = (): boolean => {
    if (dataLines.length === 0) return false;
    const payload = dataLines.join('\n');
    dataLines = [];
    return parseEvent(payload);
  };

  for await (const chunk of bodyChunks(body)) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        if (line === '' && flush()) return { content, reasoningCharacters, refusal: refusal || null, finishReason, usage, responseModel, systemFingerprint, firstContentLatencyMs };
        continue;
      }
      if (dataLines.length > 0) {
        const next = line[5] === ' ' ? line.slice(6) : line.slice(5);
        try {
          JSON.parse(next);
          if (flush()) return { content, reasoningCharacters, refusal: refusal || null, finishReason, usage, responseModel, systemFingerprint, firstContentLatencyMs };
        } catch {
          // Multi-line SSE data is joined below.
        }
      }
      dataLines.push(line[5] === ' ' ? line.slice(6) : line.slice(5));
    }
  }
  if (buffer.startsWith('data:')) {
    dataLines.push(buffer[5] === ' ' ? buffer.slice(6) : buffer.slice(5));
  }
  flush();
  return { content, reasoningCharacters, refusal: refusal || null, finishReason, usage, responseModel, systemFingerprint, firstContentLatencyMs };
}

function conservativeInputTokenUpperBound(messages: readonly LlmMessage[]): number {
  const text = JSON.stringify(messages);
  return Math.max(text.length, new TextEncoder().encode(text).length);
}

function conservativeListCostUsdUpperBound(
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    inputTokens * GO_UPPER_BOUND_PRICING.inputUsdPerMillion +
    outputTokens * GO_UPPER_BOUND_PRICING.outputUsdPerMillion
  ) / 1_000_000;
}

function completedRecord(record: LiveRequestRecord): boolean {
  return record.status === 'completed';
}

function knownTokenSum(
  records: readonly LiveRequestRecord[],
  key: keyof Pick<GoUsage, 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens'>,
): number | null {
  let total = 0;
  for (const record of records) {
    const value = record.usage?.[key];
    if (value === null || value === undefined) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function knownAllowanceSum(records: readonly LiveRequestRecord[]): number | null {
  return knownUsageNumberSum(records, 'allowance');
}

function knownUsageNumberSum(
  records: readonly LiveRequestRecord[],
  key: keyof Pick<GoUsage, 'allowance' | 'listCostUsd' | 'chargedUsd'>,
): number | null {
  let total = 0;
  for (const record of records) {
    const value = record.usage?.[key];
    if (value === null || value === undefined) return null;
    total += value;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

function requestStatusCounts(records: readonly LiveRequestRecord[]): LiveRequestStatusCounts {
  return {
    total: records.length,
    inFlight: records.filter((record) => record.status === 'in-flight').length,
    completed: records.filter((record) => record.status === 'completed').length,
    refused: records.filter((record) => record.status === 'refused').length,
    truncated: records.filter((record) => record.status === 'truncated').length,
    failed: records.filter((record) => record.status === 'failed').length,
    aborted: records.filter((record) => record.status === 'aborted').length,
  };
}

function tokenTotalsFor(records: readonly LiveRequestRecord[]): LiveTokenTotals {
  if (records.length === 0) {
    return {
      prompt: null,
      completion: null,
      reasoning: null,
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
    };
  }
  return {
    prompt: knownTokenSum(records, 'promptTokens'),
    completion: knownTokenSum(records, 'completionTokens'),
    reasoning: knownTokenSum(records, 'reasoningTokens'),
    cacheRead: knownTokenSum(records, 'cacheReadTokens'),
    cacheWrite5m: knownTokenSum(records, 'cacheWrite5mTokens'),
    cacheWrite1h: knownTokenSum(records, 'cacheWrite1hTokens'),
  };
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)];
}

type LiveScenarioRoute = GeneratedExperimentScenario['routes'][number];

function routeStatePieces(route: LiveScenarioRoute): string[] {
  const clothing = /衣物特征：([^；]+)/.exec(route.characterState)?.[1] ?? route.characterState;
  const hand = /左手伤痕：([^；]+)/.exec(route.characterState)?.[1] ?? 'unknown-left-hand';
  const item = /随身物：([^。]+)/.exec(route.characterState)?.[1] ?? 'unknown-item';
  return [
    `路线标记[${route.id}/衣物]=${clothing}`,
    `路线标记[${route.id}/左手]=${hand}`,
    `路线标记[${route.id}/随身物]=${item}`,
  ];
}

function routeStateSeed(route: LiveScenarioRoute): string {
  return `当前路线为${route.id}。路线独有银印是${route.uniqueFact}。当前路线沈砚状态：${routeStatePieces(route).join('；')}。只沿这条路线继续。`;
}

function seedTree(scenario: GeneratedExperimentScenario, arm: LiveArm, repetition: number) {
  const prefix = `seed-${arm}-r${repetition}`;
  const nodes: Record<string, TurnNode> = {};
  const empty = (): PlotSummarySnapshot => ({ ...EMPTY_SUMMARY_SNAPSHOT });
  const add = (id: string, parentId: string | null, role: TurnNode['role'], content: string, createdAt: number) => {
    nodes[id] = { id, parentId, role, content, createdAt, summarySnapshot: empty() };
  };
  add(`${prefix}-root`, null, 'assistant', `${scenario.setting}\n故事：${scenario.title}\n这是受控短跑的前置设定。`, 1);
  add(`${prefix}-trunk-u`, `${prefix}-root`, 'user', '先确认旧线索', 2);
  add(`${prefix}-trunk-a`, `${prefix}-trunk-u`, 'assistant', `众人确认共同伏笔仍是${scenario.sharedFact}，三条路线都没有改变它。`, 3);
  const routeSeedLeafId: Record<string, string> = {};
  [0, 1, 2].forEach((routeIndex) => {
    const route = scenario.routes[routeIndex];
    const userId = `${prefix}-${route.id}-u`;
    const assistantId = `${prefix}-${route.id}-a`;
    add(userId, `${prefix}-trunk-a`, 'user', `进入${route.id}`, 4 + routeIndex * 2);
    add(
      assistantId,
      userId,
      'assistant',
      routeStateSeed(route),
      5 + routeIndex * 2,
    );
    routeSeedLeafId[route.id] = assistantId;
  });
  return { nodes, routeSeedLeafId };
}

function scheduleForScenario(scenario: GeneratedExperimentScenario, turns: number): LiveExperimentState['schedule'] {
  const routeIndexForTurn = (turn: number): number => {
    if (turn <= 8) return 0;
    if (turn <= 16) return 1;
    if (turn <= 23) return 0;
    return 2;
  };
  const probeTurns = new Set([8, 16, 23, 30]);
  return Array.from({ length: turns }, (_, index) => {
    const turn = index + 1;
    const routeIndex = routeIndexForTurn(turn);
    const route = scenario.routes[routeIndex];
    const previousRouteIndex = turn > 1 ? routeIndexForTurn(turn - 1) : routeIndex;
    return {
      turnId: `turn-${String(turn).padStart(2, '0')}`,
      action: scenario.actions[(turn - 1) % scenario.actions.length],
      routeId: route.id,
      branchSwitch: turn > 1 && routeIndex !== previousRouteIndex,
      probeAfter: turns === 30 && probeTurns.has(turn),
    };
  });
}

function routeSeedLeaf(nodes: Record<string, TurnNode>, arm: LiveArm, repetition: number, routeId: string): string {
  return `seed-${arm}-r${repetition}-${routeId}-a`;
}

function pathMessages(nodes: Record<string, TurnNode>, parentId: string | null, action: string, scenario: GeneratedExperimentScenario): LlmMessage[] {
  const path = parentId
    ? getActiveBranchNodes({ nodes, activeLeafNodeId: parentId }, parentId)
    : [];
  return [
    { role: 'system', content: `${scenario.setting}\n故事：${scenario.title}` },
    ...path.map((node) => ({ role: node.role, content: node.content } as LlmMessage)),
    { role: 'user', content: action },
  ];
}

function folioMessages(
  nodes: Record<string, TurnNode>,
  parentId: string | null,
  action: string,
  scenario: GeneratedExperimentScenario,
  snapshot: PlotSummarySnapshot,
): LlmMessage[] {
  const target = parentId ? nodes[parentId] : null;
  const nodesWithSnapshot = target
    ? { ...nodes, [target.id]: { ...target, summarySnapshot: snapshot } }
    : nodes;
  return assembleCreativeThreeZoneContext({
    systemPrompt: `${scenario.setting}\n故事：${scenario.title}`,
    nodes: nodesWithSnapshot,
    targetParentId: parentId,
    userInput: action,
    budgetOverrides: FOLIO_BUDGET,
  }).messages;
}

function retrievalMessages(
  nodes: Record<string, TurnNode>,
  parentId: string | null,
  action: string,
  scenario: GeneratedExperimentScenario,
): LlmMessage[] {
  const path = parentId
    ? getActiveBranchNodes({ nodes, activeLeafNodeId: parentId }, parentId)
    : [];
  const recentNodes = path.slice(-6);
  const recentIds = new Set(recentNodes.map((node) => node.id));
  const retrieval = parentId
    ? retrieveFromActiveBranch(nodes, parentId, action, 3, recentIds)
    : { selected: [] };
  return [
    { role: 'system', content: `${scenario.setting}\n故事：${scenario.title}` },
    ...retrieval.selected.map((node) => ({
      role: 'system' as const,
      content: `按需回取（当前路线 ${node.id}）：${node.content}`,
    })),
    ...recentNodes.map((node) => ({ role: node.role, content: node.content } as LlmMessage)),
    { role: 'user', content: action },
  ];
}

function requestBody(messages: readonly LlmMessage[], effort: ReasoningEffort, maxOutputTokens: number): string {
  return JSON.stringify({
    model: GO_MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
    reasoning_effort: effort,
    max_tokens: maxOutputTokens,
  });
}

function createArmState(arm: LiveArm, repetition: number, sessionId: string): LiveArmState {
  return {
    sessionId,
    status: 'not-started',
    incompletePhases: [],
    nodes: {},
    activeLeafId: null,
    previousAssistantByRoute: {},
    completedTurnIds: [],
    generatedOutputs: [],
  };
}

function markArmIncomplete(armState: LiveArmState, phase: LivePhase): void {
  if (!armState.incompletePhases.includes(phase)) armState.incompletePhases.push(phase);
  armState.status = 'incomplete';
}

class GoExperimentFatalError extends Error {
  readonly requestError?: GoRequestError;

  constructor(message: string, requestError?: GoRequestError) {
    super(message);
    this.name = 'GoExperimentFatalError';
    this.requestError = requestError;
  }
}

function assertKnownBillingEvidence(record: LiveRequestRecord): void {
  if (record.status === 'in-flight') return;
  if (record.usage === null) {
    throw new GoExperimentFatalError('OpenCode Go attempt omitted usage; stopping because billing is unknown.');
  }
  if (record.usage.billingSource !== 'go') {
    throw new GoExperimentFatalError('OpenCode Go response did not report opencode.billing_source=go; stopping to avoid overage.');
  }
  if (record.usage.allowance === null) {
    throw new GoExperimentFatalError('OpenCode Go attempt omitted opencode.allowance; stopping because billing is unknown.');
  }
  if (record.usage.promptTokens === null || record.usage.completionTokens === null) {
    throw new GoExperimentFatalError('OpenCode Go attempt omitted prompt or completion tokens; stopping because billing is unknown.');
  }
}

function hasKnownBillingEvidence(record: LiveRequestRecord): boolean {
  return record.status !== 'in-flight' &&
    record.usage !== null &&
    record.usage.billingSource === 'go' &&
    record.usage.allowance !== null &&
    record.usage.promptTokens !== null &&
    record.usage.completionTokens !== null;
}

function assertNoUnknownBillingAttempts(state: LiveExperimentState): void {
  for (const record of state.records) assertKnownBillingEvidence(record);
}

function conservativeInputTokensUsed(records: readonly LiveRequestRecord[]): number {
  return records.reduce(
    (total, record) => total + Math.max(record.estimatedInputTokenUpperBound, record.usage?.promptTokens ?? 0),
    0,
  );
}

function billedOutputTokensUsed(records: readonly LiveRequestRecord[]): number {
  return records.reduce((total, record) => total + (record.usage?.completionTokens ?? 0), 0);
}

function newestRecord(records: readonly LiveRequestRecord[]): LiveRequestRecord | null {
  return records.length > 0 ? records[records.length - 1] : null;
}

function sanitizeFailureMessage(error: unknown): GoRequestError {
  if (error instanceof GoExperimentFatalError && error.requestError) return error.requestError;
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message.slice(0, 500),
      retryable: false,
    };
  }
  return requestErrorFromUnknown(error, DEFAULT_GO_EXPERIMENT_SETTINGS.requestTimeoutMs);
}

export function validateGoExperimentSettings(input: GoExperimentSettings): GoExperimentSettings {
  const settings = cloneValue(input);
  if (!Number.isSafeInteger(settings.turns) || settings.turns < 1 || settings.turns > 30) {
    throw new Error('turns must be an integer from 1 to 30.');
  }
  if (!Number.isSafeInteger(settings.repetitions) || settings.repetitions < 1 || settings.repetitions > 10) {
    throw new Error('repetitions must be an integer from 1 to 10.');
  }
  if (settings.order.length !== ARMS.length || new Set(settings.order).size !== ARMS.length ||
      settings.order.some((arm) => !ARMS.includes(arm))) {
    throw new Error('order must contain full, folio, and retrievable exactly once.');
  }
  for (const [name, value] of [
    ['maxRequests', settings.maxRequests],
    ['maxInputTokensPerRequest', settings.maxInputTokensPerRequest],
    ['maxTotalInputTokens', settings.maxTotalInputTokens],
    ['maxOutputTokensPerRequest', settings.maxOutputTokensPerRequest],
    ['maxTotalOutputTokens', settings.maxTotalOutputTokens],
    ['requestTimeoutMs', settings.requestTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }
  if (!Number.isSafeInteger(settings.maxRetries) || settings.maxRetries < 0 || settings.maxRetries > 2) {
    throw new Error('maxRetries must be an integer from 0 to 2.');
  }
  if (!Number.isSafeInteger(settings.cadenceMs) || settings.cadenceMs < 0) {
    throw new Error('cadenceMs must be a non-negative integer.');
  }
  if (!Number.isFinite(settings.maxAllowance) || settings.maxAllowance <= 0) {
    throw new Error('maxAllowance must be a positive finite number.');
  }
  if (!Number.isFinite(settings.hardStopUsagePercent) || settings.hardStopUsagePercent <= 0 || settings.hardStopUsagePercent > 100) {
    throw new Error('hardStopUsagePercent must be in (0, 100].');
  }
  if (!['none', 'low', 'high', 'max'].includes(settings.reasoningEffort)) {
    throw new Error('reasoningEffort must be none, low, high, or max.');
  }
  if (!['none', 'low', 'high', 'max'].includes(settings.summaryReasoningEffort)) {
    throw new Error('summaryReasoningEffort must be none, low, high, or max.');
  }
  return settings;
}

async function getUsageSnapshot(options: RunGoExperimentOptions, sessionId: string): Promise<GoUsageSnapshot> {
  const capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  try {
    const result = await withTimeout(options.settings.requestTimeoutMs, async (signal) => {
      const response = await options.fetch(
        GO_USAGE_ENDPOINT,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'User-Agent': GO_USER_AGENT,
            'x-opencode-session': sessionId,
            Accept: 'application/json',
          },
          signal,
        },
      );
      return {
        response,
        text: await response.text(),
      };
    });
    if (!result.response.ok) {
      return {
        capturedAt,
        status: 'failed',
        rolling: null,
        weekly: null,
        monthly: null,
        error: parseErrorPayload(result.text ? JSON.parse(result.text) : null, result.response.status, false),
      };
    }
    const parsed = JSON.parse(result.text) as unknown;
    const usageEnvelope = parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'usage') &&
      (parsed as Record<string, unknown>).usage && typeof (parsed as Record<string, unknown>).usage === 'object'
      ? (parsed as Record<string, unknown>).usage
      : parsed;
    return {
      capturedAt,
      status: 'completed',
      rolling: parseUsageLimit(usageEnvelope, 'rolling'),
      weekly: parseUsageLimit(usageEnvelope, 'weekly'),
      monthly: parseUsageLimit(usageEnvelope, 'monthly'),
    };
  } catch (error) {
    return {
      capturedAt,
      status: 'failed',
      rolling: null,
      weekly: null,
      monthly: null,
      error: requestErrorFromUnknown(error, options.settings.requestTimeoutMs),
    };
  }
}

function assertUsageHeadroom(snapshot: GoUsageSnapshot, settings: GoExperimentSettings): void {
  if (snapshot.status !== 'completed') {
    throw new Error('OpenCode Go usage preflight failed; no model request was sent.');
  }
  for (const [name, limit] of [['rolling', snapshot.rolling], ['weekly', snapshot.weekly], ['monthly', snapshot.monthly]] as const) {
    if (!limit || limit.status !== 'ok' || limit.percent === null) {
      throw new Error(`OpenCode Go ${name} usage is not available as an ok percentage; no model request was sent.`);
    }
    if (limit.percent >= settings.hardStopUsagePercent) {
      throw new Error(`OpenCode Go ${name} usage is at ${limit.percent}%, meeting the ${settings.hardStopUsagePercent}% hard stop.`);
    }
  }
}

function budgetHardStop(
  state: LiveExperimentState,
  settings: GoExperimentSettings,
  estimatedInputTokenUpperBound: number,
  estimatedAllowanceUpperBound: number,
): void {
  assertNoUnknownBillingAttempts(state);
  if (state.records.length + 1 > settings.maxRequests) {
    throw new Error('Experiment request cap reached before the next model request.');
  }
  const projectedInput = conservativeInputTokensUsed(state.records) + estimatedInputTokenUpperBound;
  if (projectedInput > settings.maxTotalInputTokens) {
    throw new Error('Experiment conservative input-token cap reached before the next model request.');
  }
  const projectedOutput = billedOutputTokensUsed(state.records) + settings.maxOutputTokensPerRequest;
  if (projectedOutput > settings.maxTotalOutputTokens) {
    throw new Error('Experiment output-token cap reached before the next model request.');
  }
  const allowance = knownAllowanceSum(state.records.filter((record) => record.usage !== null));
  if (allowance === null || allowance + estimatedAllowanceUpperBound > settings.maxAllowance) {
    throw new Error('Experiment conservative allowance reservation would exceed the OpenCode Go allowance cap.');
  }
}

function postRequestBudgetHardStop(
  state: LiveExperimentState,
  settings: GoExperimentSettings,
  record: LiveRequestRecord,
): void {
  try {
    assertKnownBillingEvidence(record);
  } catch (error) {
    if (error instanceof GoExperimentFatalError) {
      throw new GoExperimentFatalError(
        `${error.message} The attempted request was retained and no retry was sent.`,
        record.error,
      );
    }
    throw error;
  }
  const inputTokens = conservativeInputTokensUsed(state.records);
  if (inputTokens > settings.maxTotalInputTokens) {
    throw new GoExperimentFatalError('Experiment conservative input-token cap was exceeded; stopping before new traffic.');
  }
  if ((record.usage?.promptTokens ?? 0) > settings.maxInputTokensPerRequest) {
    throw new GoExperimentFatalError('A billed request exceeded the per-request input-token cap; stopping before new traffic.');
  }
  const outputTokens = billedOutputTokensUsed(state.records);
  if (outputTokens > settings.maxTotalOutputTokens) {
    throw new GoExperimentFatalError('Experiment output-token cap was exceeded; stopping before new traffic.');
  }
  if ((record.usage?.completionTokens ?? 0) > settings.maxOutputTokensPerRequest) {
    throw new GoExperimentFatalError('A billed request exceeded the per-request output-token cap; stopping before new traffic.');
  }
  const allowance = knownAllowanceSum(state.records.filter((candidate) => candidate.usage !== null));
  if (allowance === null || allowance > settings.maxAllowance) {
    throw new GoExperimentFatalError('Experiment OpenCode Go allowance cap was exceeded; stopping before new traffic.');
  }
}

function isValidResponseModel(responseModel: string): boolean {
  return responseModel === GO_MODEL || responseModel === GO_CANONICAL_MODEL;
}

interface CompletionOptions {
  arm: LiveArm;
  repetition: number;
  phase: LivePhase;
  operationId: string;
  logicalTurnId: string | null;
  routeId: string | null;
  branchSwitch: boolean;
  messages: LlmMessage[];
  reasoningEffort: ReasoningEffort;
  policy: LiveRequestRecord['contextPolicy'];
  summaryCoveredThrough: string | null;
}

let lastModelRequestEndedAt = 0;

async function completeModelRequest(
  state: LiveExperimentState,
  options: RunGoExperimentOptions,
  completion: CompletionOptions,
): Promise<LiveRequestRecord> {
  const settings = options.settings;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    const estimatedInputTokenUpperBound = conservativeInputTokenUpperBound(completion.messages);
    if (estimatedInputTokenUpperBound > settings.maxInputTokensPerRequest) {
      throw new Error('A request exceeded the conservative per-request input-token cap before it was sent.');
    }
    const estimatedListCostUsdUpperBound = conservativeListCostUsdUpperBound(
      estimatedInputTokenUpperBound,
      settings.maxOutputTokensPerRequest,
    );
    budgetHardStop(state, settings, estimatedInputTokenUpperBound, estimatedListCostUsdUpperBound);
    const delay = settings.cadenceMs - ((options.now?.() ?? Date.now()) - lastModelRequestEndedAt);
    if (delay > 0) await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
    const requestId = `${completion.operationId}-a${attempt}`;
    const preparedAt = options.now?.() ?? Date.now();
    const record: LiveRequestRecord = {
      requestId,
      operationId: completion.operationId,
      arm: completion.arm,
      repetition: completion.repetition,
      attempt,
      phase: completion.phase,
      logicalTurnId: completion.logicalTurnId,
      routeId: completion.routeId,
      branchSwitch: completion.branchSwitch,
      status: 'in-flight',
      startedAt: new Date(preparedAt).toISOString(),
      completedAt: null,
      messageCount: completion.messages.length,
      inputCharCount: completion.messages.reduce((total, message) => total + message.content.length, 0),
      estimatedInputTokenUpperBound,
      contextPolicy: completion.policy,
      summaryCoveredThrough: completion.summaryCoveredThrough,
      firstContentLatencyMs: null,
      durationMs: null,
      responseModel: null,
      systemFingerprint: null,
      finishReason: null,
      refusal: null,
      truncated: false,
      visibleOutputCharCount: null,
      reasoningCharCount: 0,
      output: null,
      usage: null,
      estimatedListCostUsdUpperBound,
    };
    state.records.push(record);
    state.updatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    await options.onCheckpoint?.(state);
    const started = options.now?.() ?? Date.now();
    record.startedAt = new Date(started).toISOString();

    let fatalError: GoExperimentFatalError | null = null;
    try {
      const requestResult = await withTimeout(settings.requestTimeoutMs, async (signal) => {
        const response = await options.fetch(
          GO_CHAT_ENDPOINT,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'User-Agent': GO_USER_AGENT,
              'x-opencode-session': state.repetitions[completion.repetition].arms[completion.arm].sessionId,
            },
            body: requestBody(completion.messages, completion.reasoningEffort, settings.maxOutputTokensPerRequest),
            signal,
          },
        );
        if (!response.ok) {
          const failure = await responseFailure(
            response,
            response.status === 429 || response.status >= 500,
          );
          return {
            response,
            parsed: null,
            error: failure.error,
            usage: failure.usage,
          };
        }
        return {
          response,
          parsed: await parseCompletionStream(response.body, started),
          error: null,
          usage: null,
        };
      });
      if (!requestResult.response.ok) {
        record.error = requestResult.error ?? {
          message: `HTTP ${requestResult.response.status}`,
          retryable: false,
        };
        record.status = 'failed';
        record.usage = requestResult.usage;
      } else {
        const parsed = requestResult.parsed!;
        record.firstContentLatencyMs = parsed.firstContentLatencyMs;
        record.reasoningCharCount = parsed.reasoningCharacters;
        record.responseModel = parsed.responseModel;
        record.systemFingerprint = parsed.systemFingerprint;
        record.finishReason = parsed.finishReason;
        record.refusal = parsed.refusal;
        record.truncated = parsed.finishReason === 'length';
        record.output = parsed.content || parsed.refusal;
        record.visibleOutputCharCount = parsed.content ? parsed.content.length : null;
        record.usage = parsed.usage;
        if (parsed.responseModel !== null && !isValidResponseModel(parsed.responseModel)) {
          record.status = 'failed';
          record.error = {
            type: 'ModelMismatch',
            message: `Response model ${parsed.responseModel} did not match ${GO_MODEL} or ${GO_CANONICAL_MODEL}.`,
            retryable: false,
          };
        } else if (parsed.refusal || parsed.finishReason === 'content_filter' || parsed.finishReason === 'refusal') {
          record.status = 'refused';
        } else if (parsed.finishReason === 'length') {
          record.status = 'truncated';
        } else if (parsed.finishReason === 'stop' && parsed.content.trim()) {
          record.status = 'completed';
        } else {
          record.status = 'failed';
          record.error = {
            type: 'IncompleteResponse',
            message: 'The stream did not end with finish_reason=stop and visible content.',
            retryable: false,
          };
        }
      }
      assertKnownBillingEvidence(record);
    } catch (error) {
      if (error instanceof GoExperimentFatalError) {
        record.error = {
          type: error.name,
          message: error.message,
          retryable: false,
        };
        fatalError = error;
      } else {
        record.status = 'failed';
        record.error = requestErrorFromUnknown(error, settings.requestTimeoutMs);
      }
    }

    lastModelRequestEndedAt = options.now?.() ?? Date.now();
    record.completedAt = new Date(lastModelRequestEndedAt).toISOString();
    record.durationMs = lastModelRequestEndedAt - started;
    state.updatedAt = record.completedAt;
    await options.onCheckpoint?.(state);
    if (fatalError) throw fatalError;
    postRequestBudgetHardStop(state, settings, record);

    if (record.status === 'completed' || record.status === 'refused' || record.status === 'truncated') {
      return record;
    }
    if (!record.error?.retryable) {
      throw new GoExperimentFatalError(
        record.error?.message ?? 'Model request failed without a retryable error.',
        record.error,
      );
    }
  }
  const failed = newestRecord(state.records)!;
  throw new GoExperimentFatalError(
    `Model request exhausted retries without terminal quota evidence: ${failed.error?.message ?? 'unknown failure'}`,
    failed.error,
  );
}

async function summarizeFolioIfNeeded(
  state: LiveExperimentState,
  repetition: number,
  armState: LiveArmState,
  parentId: string | null,
  turnId: string,
  scenario: GeneratedExperimentScenario,
  options: RunGoExperimentOptions,
): Promise<PlotSummarySnapshot> {
  if (!parentId) return EMPTY_SUMMARY_SNAPSHOT;
  let snapshot = getTurnTreeSummarySnapshot(armState.nodes, parentId);
  const branch = getActiveBranchNodes({ nodes: armState.nodes, activeLeafNodeId: parentId }, parentId);
  let summaryIndex = 0;
  while (true) {
    const uncovered = getUncoveredNodes(branch, snapshot.coveredUpToNodeId);
    const selected = selectNodesToSummarize(uncovered, FOLIO_BUDGET);
    if (selected.length === 0) return snapshot;
    const batch = takeCreativeSummaryBatch(
      selected,
      FOLIO_BUDGET.summaryBatchMaxNodes,
      FOLIO_BUDGET.summaryBatchMaxChars,
    );
    if (batch.length === 0) return snapshot;
    const record = await completeModelRequest(state, options, {
      arm: 'folio',
      repetition,
      phase: 'summary',
      operationId: `r${repetition}-${turnId}-summary-${summaryIndex}`,
      logicalTurnId: turnId,
      routeId: armState.activeLeafId,
      branchSwitch: false,
      messages: buildSummaryCompressionMessages(
        snapshot.content,
        batch,
        undefined,
        FOLIO_BUDGET.summaryBatchMaxChars,
      ),
      reasoningEffort: options.settings.summaryReasoningEffort,
      policy: 'rolling-summary',
      summaryCoveredThrough: snapshot.coveredUpToNodeId,
    });
    summaryIndex += 1;
    if (record.status !== 'completed' || !record.output?.trim()) {
      markArmIncomplete(armState, 'summary');
      return snapshot;
    }
    snapshot = {
      content: record.output.trim(),
      coveredUpToNodeId: batch[batch.length - 1].id,
      summarizedTurnCount: snapshot.summarizedTurnCount + batch.length,
    };
    armState.nodes = {
      ...armState.nodes,
      [parentId]: { ...armState.nodes[parentId], summarySnapshot: snapshot },
    };
  }
}

function appendGeneratedTurn(
  armState: LiveArmState,
  arm: LiveArm,
  repetition: number,
  turnId: string,
  routeId: string,
  parentId: string | null,
  action: string,
  output: string,
  snapshot: PlotSummarySnapshot,
  now: number,
): void {
  const userId = `live-${arm}-r${repetition}-${turnId}-u`;
  const assistantId = `live-${arm}-r${repetition}-${turnId}-a`;
  const userNode: TurnNode = {
    id: userId,
    parentId,
    role: 'user',
    content: action,
    createdAt: now,
    summarySnapshot: snapshot,
  };
  const assistantNode: TurnNode = {
    id: assistantId,
    parentId: userId,
    role: 'assistant',
    content: output,
    createdAt: now + 1,
    summarySnapshot: snapshot,
  };
  armState.nodes = {
    ...armState.nodes,
    [userId]: userNode,
    [assistantId]: assistantNode,
  };
  armState.activeLeafId = assistantId;
  armState.previousAssistantByRoute[routeId] = assistantId;
  armState.completedTurnIds.push(turnId);
  armState.generatedOutputs.push({
    turnId,
    routeId,
    parentId,
    user: action,
    assistant: output,
    userNodeId: userId,
    assistantNodeId: assistantId,
  });
}

function probeFacts(scenario: GeneratedExperimentScenario, routeId: string) {
  const route = scenario.routes.find((candidate) => candidate.id === routeId)!;
  return {
    expectedFacts: [route.uniqueFact, ...routeStatePieces(route)],
    forbiddenFacts: scenario.routes
      .filter((candidate) => candidate.id !== routeId)
      .slice(0, 3)
      .flatMap((candidate) => [candidate.uniqueFact, ...routeStatePieces(candidate)]),
  };
}

async function runProbe(
  state: LiveExperimentState,
  repetition: number,
  arm: LiveArm,
  afterTurnId: string,
  parentId: string | null,
  scenario: GeneratedExperimentScenario,
  options: RunGoExperimentOptions,
): Promise<void> {
  const repetitionState = state.repetitions[repetition];
  const armState = repetitionState.arms[arm];
  const routeId = state.schedule.find((entry) => entry.turnId === afterTurnId)!.routeId;
  const facts = probeFacts(scenario, routeId);
  const query = '保持当前路线。仅根据已有历史，逐字写出路线独有银印，以及沈砚衣物、左手伤痕、随身物各自的完整路线标记。格式：银印：...；衣物：...；左手：...；随身物：...。不要引用其他路线。';
  const snapshot = arm === 'folio'
    ? await summarizeFolioIfNeeded(state, repetition, armState, parentId, afterTurnId, scenario, options)
    : getTurnTreeSummarySnapshot(armState.nodes, parentId);
  const messages = arm === 'full'
    ? pathMessages(armState.nodes, parentId, query, scenario)
    : arm === 'folio'
      ? folioMessages(armState.nodes, parentId, query, scenario, snapshot)
      : retrievalMessages(armState.nodes, parentId, query, scenario);
  const record = await completeModelRequest(state, options, {
    arm,
    repetition,
    phase: 'probe',
    operationId: `r${repetition}-${afterTurnId}-${arm}-probe`,
    logicalTurnId: afterTurnId,
    routeId,
    branchSwitch: false,
    messages,
    reasoningEffort: options.settings.reasoningEffort,
    policy: arm === 'full' ? 'full-history' : arm === 'folio' ? 'rolling-summary' : 'branch-retrieval',
    summaryCoveredThrough: snapshot.coveredUpToNodeId,
  });
  if (record.status === 'in-flight' || record.status === 'aborted') {
    throw new Error(`Probe ${record.requestId} ended without a scoreable terminal response.`);
  }
  const answer = record.output ?? '';
  const scored = record.status === 'completed';
  const expectedFactsPresent = scored ? facts.expectedFacts.every((fact) => answer.includes(fact)) : null;
  const forbiddenFactsAbsent = scored ? facts.forbiddenFacts.every((fact) => !answer.includes(fact)) : null;
  const correct = expectedFactsPresent === null || forbiddenFactsAbsent === null
    ? null
    : expectedFactsPresent && forbiddenFactsAbsent;
  if (!scored) markArmIncomplete(armState, 'probe');
  state.probes.push({
    probeId: `r${repetition}-${afterTurnId}-${arm}`,
    repetition,
    arm,
    afterTurnId,
    requestId: record.requestId,
    answer,
    expectedFacts: facts.expectedFacts,
    forbiddenFacts: facts.forbiddenFacts,
    expectedFactsPresent,
    forbiddenFactsAbsent,
    correct,
    status: record.status,
  });
}

function armSummary(state: LiveExperimentState, arm: LiveArm): LiveArmSummary {
  const armRecords = state.records.filter((record) => record.arm === arm);
  const completedGenerations = armRecords.filter((record) => record.phase === 'generation' && completedRecord(record));
  const billedRecords = armRecords.filter((record) => record.usage !== null);
  const latencies = completedGenerations
    .map((record) => record.firstContentLatencyMs)
    .filter((value): value is number => value !== null);
  const armProbes = state.probes.filter((probe) => probe.arm === arm);
  const completedLogicalTurnKeyMap = new Map<string, LiveLogicalTurnKey>();
  for (const record of completedGenerations) {
    if (record.logicalTurnId === null) continue;
    completedLogicalTurnKeyMap.set(`${record.repetition}\0${record.logicalTurnId}`, {
      repetition: record.repetition,
      logicalTurnId: record.logicalTurnId,
    });
  }
  const completedLogicalTurnKeys = [...completedLogicalTurnKeyMap.values()];
  const completedTurnCount = completedLogicalTurnKeys.length;
  const expectedTurns = state.settings.turns * state.settings.repetitions;
  const summaryRecords = armRecords.filter((record) => record.phase === 'summary');
  const latestSummaryRecords = [...new Map(summaryRecords.map((record) => [record.operationId, record])).values()];
  const summaryStatus: LivePhaseCompletionStatus = latestSummaryRecords.length === 0
    ? 'not-required'
    : latestSummaryRecords.every((record) => record.status === 'completed')
      ? 'completed'
      : 'incomplete';
  const probesExpected = state.schedule.filter((entry) => entry.probeAfter).length * state.settings.repetitions;
  const probeStatus: LivePhaseCompletionStatus = probesExpected === 0
    ? 'not-required'
    : armProbes.length === probesExpected && armProbes.every((probe) => probe.status === 'completed')
      ? 'completed'
      : 'incomplete';
  const qualityStatus: LiveArmSummary['qualityStatus'] = probesExpected === 0
    ? 'not-assessed'
    : armProbes.length === probesExpected &&
        armProbes.every((probe) => probe.correct === true) &&
        summaryStatus !== 'incomplete'
      ? 'complete'
      : 'incomplete';
  const phaseRecords = (phase: LivePhase) => armRecords.filter((record) => record.phase === phase);
  return {
    arm,
    coreStatus: completedTurnCount === expectedTurns ? 'completed' : 'incomplete',
    summaryStatus,
    probeStatus,
    qualityStatus,
    completedTurns: completedTurnCount,
    completedLogicalTurnKeys,
    requestCounts: {
      generation: phaseRecords('generation').length,
      summary: phaseRecords('summary').length,
      probe: phaseRecords('probe').length,
    },
    phaseRequestStatusCounts: {
      generation: requestStatusCounts(phaseRecords('generation')),
      summary: requestStatusCounts(phaseRecords('summary')),
      probe: requestStatusCounts(phaseRecords('probe')),
    },
    refusalCount: armRecords.filter((record) => record.status === 'refused').length,
    truncationCount: armRecords.filter((record) => record.status === 'truncated').length,
    missingUsageRecords: armRecords.filter((record) => record.status !== 'in-flight' && record.usage === null).length,
    unknownBillingRecords: armRecords.filter((record) => !hasKnownBillingEvidence(record)).length,
    tokenTotals: tokenTotalsFor(billedRecords),
    generationTokenTotals: tokenTotalsFor(completedGenerations),
    planAllowanceUsed: billedRecords.length === 0 ? null : knownAllowanceSum(billedRecords),
    listCostUsd: billedRecords.length === 0 ? null : knownUsageNumberSum(billedRecords, 'listCostUsd'),
    chargedUsd: billedRecords.length === 0 ? null : knownUsageNumberSum(billedRecords, 'chargedUsd'),
    firstContentLatencyMsP50: percentile(latencies, 0.5),
    firstContentLatencyMsP95: percentile(latencies, 0.95),
    probesExpected,
    probesPassed: armProbes.filter((probe) => probe.correct === true).length,
    probesScored: armProbes.filter((probe) => probe.correct !== null).length,
    probesIncorrect: armProbes.filter((probe) => probe.correct === false).length,
    probesIncomplete: probesExpected - armProbes.filter((probe) => probe.correct !== null).length,
    probesTotal: armProbes.length,
  };
}

function summarizeLiveExperiment(state: LiveExperimentState): LiveExperimentSummary {
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, armSummary(state, arm)])) as Record<LiveArm, LiveArmSummary>;
  const logicalTurnKeys = state.repetitions.flatMap((repetitionState) => {
    const prefix: LiveLogicalTurnKey[] = [];
    for (const entry of state.schedule) {
      const completeForEveryArm = ARMS.every((arm) => state.records.some(
        (record) => record.repetition === repetitionState.index &&
          record.arm === arm &&
          record.phase === 'generation' &&
          record.logicalTurnId === entry.turnId &&
          completedRecord(record),
      ));
      if (!completeForEveryArm) break;
      prefix.push({ repetition: repetitionState.index, logicalTurnId: entry.turnId });
    }
    return prefix;
  });
  const logicalTurnKeySet = new Set(logicalTurnKeys.map((key) => `${key.repetition}\0${key.logicalTurnId}`));
  const commonRecords = (arm: LiveArm) => state.records.filter(
    (record) => record.arm === arm && record.logicalTurnId !== null &&
      logicalTurnKeySet.has(`${record.repetition}\0${record.logicalTurnId}`),
  );
  const commonArm = (arm: LiveArm) => {
    const records = commonRecords(arm);
    const billedRecords = records.filter((record) => record.usage !== null);
    const completedGenerations = records.filter((record) => record.phase === 'generation' && completedRecord(record));
    const hasUnknownUsage = records.some((record) => record.status !== 'in-flight' && record.usage === null);
    const latencies = completedGenerations.map((record) => record.firstContentLatencyMs)
      .filter((value): value is number => value !== null);
    const empty = logicalTurnKeys.length === 0;
    return {
      completedTurns: new Set(completedGenerations.flatMap((record) =>
        record.logicalTurnId ? [`${record.repetition}\0${record.logicalTurnId}`] : [],
      )).size,
      billedRequests: billedRecords.length,
      phaseCounts: {
        generation: records.filter((record) => record.phase === 'generation').length,
        summary: records.filter((record) => record.phase === 'summary').length,
        probe: records.filter((record) => record.phase === 'probe').length,
      },
      billedPhaseCounts: {
        generation: billedRecords.filter((record) => record.phase === 'generation').length,
        summary: billedRecords.filter((record) => record.phase === 'summary').length,
        probe: billedRecords.filter((record) => record.phase === 'probe').length,
      },
      promptTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'promptTokens'),
      completionTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'completionTokens'),
      reasoningTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'reasoningTokens'),
      cacheReadTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'cacheReadTokens'),
      cacheWrite5mTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'cacheWrite5mTokens'),
      cacheWrite1hTokens: empty || hasUnknownUsage ? null : knownTokenSum(billedRecords, 'cacheWrite1hTokens'),
      planAllowance: empty || hasUnknownUsage ? null : knownAllowanceSum(billedRecords),
      listCostUsd: empty || hasUnknownUsage ? null : knownUsageNumberSum(billedRecords, 'listCostUsd'),
      chargedUsd: empty || hasUnknownUsage ? null : knownUsageNumberSum(billedRecords, 'chargedUsd'),
      latencyMsP50: empty ? null : percentile(latencies, 0.5),
      latencyMsP95: empty ? null : percentile(latencies, 0.95),
    };
  };
  const commonByArm = {
    full: commonArm('full'),
    folio: commonArm('folio'),
    retrievable: commonArm('retrievable'),
  };
  const delta = (left: number | null, right: number | null) => left === null || right === null ? null : right - left;
  return {
    commonRange: { logicalTurnKeys, byArm: commonByArm },
    byArm,
    comparisons: {
      fullToRetrievable: {
        commonTurnCount: logicalTurnKeys.length,
        promptTokenDelta: delta(commonByArm.full.promptTokens, commonByArm.retrievable.promptTokens),
        completionTokenDelta: delta(commonByArm.full.completionTokens, commonByArm.retrievable.completionTokens),
        reasoningTokenDelta: delta(commonByArm.full.reasoningTokens, commonByArm.retrievable.reasoningTokens),
        cacheReadTokenDelta: delta(commonByArm.full.cacheReadTokens, commonByArm.retrievable.cacheReadTokens),
        cacheWrite5mTokenDelta: delta(commonByArm.full.cacheWrite5mTokens, commonByArm.retrievable.cacheWrite5mTokens),
        cacheWrite1hTokenDelta: delta(commonByArm.full.cacheWrite1hTokens, commonByArm.retrievable.cacheWrite1hTokens),
        planAllowanceDelta: delta(commonByArm.full.planAllowance, commonByArm.retrievable.planAllowance),
        listCostUsdDelta: delta(commonByArm.full.listCostUsd, commonByArm.retrievable.listCostUsd),
        chargedUsdDelta: delta(commonByArm.full.chargedUsd, commonByArm.retrievable.chargedUsd),
      },
      folioToRetrievable: {
        commonTurnCount: logicalTurnKeys.length,
        promptTokenDelta: delta(commonByArm.folio.promptTokens, commonByArm.retrievable.promptTokens),
        completionTokenDelta: delta(commonByArm.folio.completionTokens, commonByArm.retrievable.completionTokens),
        reasoningTokenDelta: delta(commonByArm.folio.reasoningTokens, commonByArm.retrievable.reasoningTokens),
        cacheReadTokenDelta: delta(commonByArm.folio.cacheReadTokens, commonByArm.retrievable.cacheReadTokens),
        cacheWrite5mTokenDelta: delta(commonByArm.folio.cacheWrite5mTokens, commonByArm.retrievable.cacheWrite5mTokens),
        cacheWrite1hTokenDelta: delta(commonByArm.folio.cacheWrite1hTokens, commonByArm.retrievable.cacheWrite1hTokens),
        planAllowanceDelta: delta(commonByArm.folio.planAllowance, commonByArm.retrievable.planAllowance),
        listCostUsdDelta: delta(commonByArm.folio.listCostUsd, commonByArm.retrievable.listCostUsd),
        chargedUsdDelta: delta(commonByArm.folio.chargedUsd, commonByArm.retrievable.chargedUsd),
      },
    },
    usd: {
      status: 'reported-separately',
      planAllowance: { unit: 'go-allowance', notBalanceCharge: true },
      listCost: { source: 'opencode.list_cost' },
      charged: { source: 'usage.cost' },
    },
  };
}

export async function runGoExperiment(options: RunGoExperimentOptions): Promise<LiveExperimentState> {
  if (!options.apiKey.trim()) throw new Error('OpenCode Go API key is empty.');
  if (!options.runId.trim()) throw new Error('runId is required.');
  const settings = validateGoExperimentSettings(options.settings);
  const scenario = generateExperimentScenario('branching', 20261123);
  const started = options.now?.() ?? Date.now();
  const schedule = scheduleForScenario(scenario, settings.turns);
  const repetitions = Array.from({ length: settings.repetitions }, (_, index) => {
    const order = index === 0
      ? [...settings.order]
      : [...settings.order.slice(index % settings.order.length), ...settings.order.slice(0, index % settings.order.length)];
    return {
      index,
      order,
      arms: Object.fromEntries(ARMS.map((arm) => [
        arm,
        createArmState(arm, index, `${options.sessionIds[arm]}_r${index}`),
      ])) as Record<LiveArm, LiveArmState>,
    };
  });
  const state: LiveExperimentState = {
    schemaVersion: 2,
    mode: 'live-opencode-go',
    runId: options.runId,
    status: 'running',
    startedAt: new Date(started).toISOString(),
    updatedAt: new Date(started).toISOString(),
    provider: {
      name: 'OpenCode Go',
      endpoint: GO_CHAT_ENDPOINT,
      usageEndpoint: GO_USAGE_ENDPOINT,
      model: GO_MODEL,
      canonicalModel: GO_CANONICAL_MODEL,
      userAgent: GO_USER_AGENT,
      sessionHeader: 'x-opencode-session',
      upperBoundPricing: GO_UPPER_BOUND_PRICING,
    },
    settings,
    schedule,
    usagePreflight: null,
    usagePostflight: null,
    repetitions,
    records: [],
    probes: [],
    summary: null,
    failure: null,
    limitations: [
      'Go allowance, usage.cost balance charge, and opencode.list_cost are reported separately.',
      'Allowance reservation uses the published full uncached peak rates of $0.30/M input and $1.20/M output.',
      'The 30-turn run is a staged short sample and does not establish the full 300 / 500 / 1,000-turn matrix.',
      'Requests and summaries run serially. Natural generated outputs are retained outside the repository for this run.',
      'A usage endpoint percentage is checked before the run and opencode.allowance is enforced during the run; use a small allowance cap and avoid Extra Usage.',
    ],
  };
  await options.onCheckpoint?.(state);

  try {
    state.usagePreflight = await getUsageSnapshot(options, repetitions[0].arms[settings.order[0]].sessionId);
    assertUsageHeadroom(state.usagePreflight, settings);
    await options.onCheckpoint?.(state);

    for (const repetitionState of state.repetitions) {
      for (const arm of repetitionState.order) {
        const armState = repetitionState.arms[arm];
        const seeds = seedTree(scenario, arm, repetitionState.index);
        armState.nodes = seeds.nodes;
        armState.status = 'running';
        armState.incompletePhases = [];
        armState.activeLeafId = null;
        await options.onCheckpoint?.(state);

        for (const step of state.schedule) {
          const priorAssistant = armState.previousAssistantByRoute[step.routeId];
          const parentId = priorAssistant ?? seeds.routeSeedLeafId[step.routeId];
          const snapshot = arm === 'folio'
            ? await summarizeFolioIfNeeded(state, repetitionState.index, armState, parentId, step.turnId, scenario, options)
            : getTurnTreeSummarySnapshot(armState.nodes, parentId);
          const messages = arm === 'full'
            ? pathMessages(armState.nodes, parentId, step.action, scenario)
            : arm === 'folio'
              ? folioMessages(armState.nodes, parentId, step.action, scenario, snapshot)
              : retrievalMessages(armState.nodes, parentId, step.action, scenario);
          const record = await completeModelRequest(state, options, {
            arm,
            repetition: repetitionState.index,
            phase: 'generation',
            operationId: `r${repetitionState.index}-${step.turnId}-${arm}`,
            logicalTurnId: step.turnId,
            routeId: step.routeId,
            branchSwitch: step.branchSwitch,
            messages,
            reasoningEffort: settings.reasoningEffort,
            policy: arm === 'full' ? 'full-history' : arm === 'folio' ? 'rolling-summary' : 'branch-retrieval',
            summaryCoveredThrough: snapshot.coveredUpToNodeId,
          });
          if (record.status !== 'completed' || !record.output?.trim()) {
            markArmIncomplete(armState, 'generation');
            break;
          }
          appendGeneratedTurn(
            armState,
            arm,
            repetitionState.index,
            step.turnId,
            step.routeId,
            parentId,
            step.action,
            record.output,
            snapshot,
            options.now?.() ?? Date.now(),
          );
          await options.onCheckpoint?.(state);
          if (step.probeAfter) {
            await runProbe(
              state,
              repetitionState.index,
              arm,
              step.turnId,
              armState.activeLeafId,
              scenario,
              options,
            );
          }
        }
        armState.status = armState.incompletePhases.length === 0 ? 'completed' : 'incomplete';
        await options.onCheckpoint?.(state);
      }
    }

    state.usagePostflight = await getUsageSnapshot(options, repetitions[0].arms[settings.order[0]].sessionId);
    state.summary = summarizeLiveExperiment(state);
    state.status = ARMS.every((arm) => {
      const summary = state.summary!.byArm[arm];
      return summary.coreStatus === 'completed' &&
        summary.summaryStatus !== 'incomplete' &&
        summary.probeStatus !== 'incomplete';
    })
      ? 'completed'
      : 'incomplete';
  } catch (error) {
    state.status = 'failed';
    state.failure = sanitizeFailureMessage(error);
    if (state.summary === null) state.summary = summarizeLiveExperiment(state);
  }
  state.updatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  await options.onCheckpoint?.(state);
  return state;
}
