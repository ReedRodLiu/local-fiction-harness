import {
  assembleCreativeThreeZoneContext,
  buildSummaryCompressionMessages,
  DEFAULT_CONTEXT_BUDGET,
  EMPTY_SUMMARY_SNAPSHOT,
  getActiveBranchNodes,
  getUncoveredNodes,
  selectNodesToSummarize,
} from '../../src/harness/context.ts';
import { createFictionHarness } from '../../src/harness/harness.ts';
import {
  DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
  estimateContextSavings,
  preflightContextExperiment,
  summarizeContextExperiment,
  type ContextExperimentArm,
  type ContextExperimentBudget,
  type ContextExperimentGroup,
  type ContextExperimentPreflight,
  type ContextExperimentRequestPlan,
  type ContextExperimentRequestRecord,
  type ContextExperimentSummary,
  type ContextSavingsEstimate,
} from './savings.ts';
import type { LlmMessage, PlotSummarySnapshot, Story, TurnNode } from '../../src/harness/types.ts';

export type ExperimentScenarioName = 'continuous' | 'branching' | 'nested';

export interface ExperimentScenarioSpec {
  name: ExperimentScenarioName;
  title: string;
  turns: number;
  routes: number;
  minDepth: number;
}

export interface ExperimentRoute {
  id: string;
  leafId: string;
  actionIndexes: number[];
  depth: number;
  uniqueFact: string;
  characterState: string;
}

export interface ExperimentProbe {
  routeId: string;
  leafId: string;
  query: string;
  expectedFacts: string[];
  forbiddenFacts: string[];
}

export interface GeneratedExperimentScenario {
  spec: ExperimentScenarioSpec;
  title: string;
  setting: string;
  sharedFact: string;
  turns: number;
  actions: string[];
  nodes: Record<string, TurnNode>;
  routes: ExperimentRoute[];
  probes: ExperimentProbe[];
  maxRouteDepth: number;
}

const SCENARIO_SPECS: Record<ExperimentScenarioName, ExperimentScenarioSpec> = {
  continuous: {
    name: 'continuous',
    title: '雾港灯影',
    turns: 300,
    routes: 1,
    minDepth: 1,
  },
  branching: {
    name: 'branching',
    title: '双城来信',
    turns: 500,
    routes: 20,
    minDepth: 2,
  },
  nested: {
    name: 'nested',
    title: '十三号钟楼',
    turns: 1000,
    routes: 50,
    minDepth: 3,
  },
};

const SHORT_ACTIONS = [
  '继续',
  '推门进去',
  '查看旧钥匙',
  '问沈砚详情',
  '打开那封信',
  '沿石阶向下',
  '先别惊动他',
  '把灯递给他',
  '回到钟楼',
  '记住这句话',
  '让沈砚先选',
  '藏好铜钥匙',
  '追上那个人',
  '只问一个问题',
  '在窗边等',
] as const;

const PROBE_CUES = [
  '沈砚 衣物',
  '沈砚 左手',
  '沈砚 随身物',
  '沈砚 痕迹',
] as const;

const SHEN_YAN_CLOTHING = [
  '靛蓝布衫，袖口缝着两道白线',
  '灰呢长衫，领口别着一截黑羽',
  '旧蓝外套，肩头沾着湿煤灰',
  '墨色短褂，腰间系着红绳',
] as const;

const SHEN_YAN_HANDS = [
  '左手虎口有浅疤',
  '右手食指缠着纱布',
  '左手腕戴着断开的铜扣',
  '右手掌留着一道新划痕',
] as const;

const SHEN_YAN_ITEMS = [
  '随身的铜钥匙缺了一角',
  '随身怀表停在三点一刻',
  '随身火柴盒里只剩一根火柴',
  '随身纸包里藏着半张车票',
] as const;

interface MutableScenario {
  spec: ExperimentScenarioSpec;
  seed: number;
  sharedFact: string;
  actions: string[];
  nodes: Record<string, TurnNode>;
  routeUniqueFacts: Map<string, string>;
  routeCharacterStates: Map<string, string>;
  routeLeaves: Map<string, string>;
  routeDepth: Map<string, number>;
}

function appendTurn(
  scenario: MutableScenario,
  parentId: string | null,
  routeFact?: string,
  characterState?: string,
): string {
  const turnIndex = scenario.actions.length + 1;
  const action = SHORT_ACTIONS[(turnIndex - 1 + scenario.seed) % SHORT_ACTIONS.length];
  const userId = `turn-${turnIndex}-u`;
  const assistantId = `turn-${turnIndex}-a`;
  const assistantNotes = [
    '雨声压低了街巷里的脚步，人物继续面对眼前的选择。',
    ...(turnIndex === 1 || turnIndex % 29 === 0
      ? [`共同伏笔仍有效：旧址暗记是${scenario.sharedFact}，所有路线都记得。`]
      : []),
    ...(routeFact ? [`当前路线独有银印：${routeFact}。`] : []),
    ...(characterState ? [`当前路线沈砚状态：${characterState}。`] : []),
  ];
  scenario.actions.push(action);
  scenario.nodes[userId] = {
    id: userId,
    parentId,
    role: 'user',
    content: action,
    createdAt: turnIndex * 2,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
  };
  scenario.nodes[assistantId] = {
    id: assistantId,
    parentId: userId,
    role: 'assistant',
    content: assistantNotes.join(' '),
    createdAt: turnIndex * 2 + 1,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
  };
  return assistantId;
}

function routeFact(index: number): string {
  return `路线${String(index + 1).padStart(2, '0')}银印`;
}

function routeCharacterState(index: number): string {
  return `沈砚的衣物特征：${SHEN_YAN_CLOTHING[index % SHEN_YAN_CLOTHING.length]}；左手伤痕：${SHEN_YAN_HANDS[Math.floor(index / SHEN_YAN_CLOTHING.length) % SHEN_YAN_HANDS.length]}；随身物：${SHEN_YAN_ITEMS[Math.floor(index / (SHEN_YAN_CLOTHING.length * SHEN_YAN_HANDS.length)) % SHEN_YAN_ITEMS.length]}。`;
}

function initializeScenario(spec: ExperimentScenarioSpec, seed: number): MutableScenario {
  return {
    spec,
    seed,
    sharedFact: '北星七号',
    actions: [],
    nodes: {},
    routeUniqueFacts: new Map(),
    routeCharacterStates: new Map(),
    routeLeaves: new Map(),
    routeDepth: new Map(),
  };
}

function generateContinuous(spec: ExperimentScenarioSpec, seed: number): MutableScenario {
  const scenario = initializeScenario(spec, seed);
  const routeId = 'route-01';
  scenario.routeUniqueFacts.set(routeId, routeFact(0));
  scenario.routeCharacterStates.set(routeId, routeCharacterState(0));
  scenario.routeDepth.set(routeId, 1);
  let leafId: string | null = null;
  for (let turn = 1; turn <= spec.turns; turn += 1) {
    leafId = appendTurn(
      scenario,
      leafId,
      turn === 1 ? routeFact(0) : undefined,
      turn === 1 ? routeCharacterState(0) : undefined,
    );
  }
  scenario.routeLeaves.set(routeId, leafId!);
  return scenario;
}

function generateBranching(spec: ExperimentScenarioSpec, seed: number): MutableScenario {
  const scenario = initializeScenario(spec, seed);
  const routeIds = Array.from({ length: spec.routes }, (_, index) => `route-${String(index + 1).padStart(2, '0')}`);

  const trunkTurns = Math.min(50, spec.turns);
  let trunkLeaf: string | null = null;
  for (let turn = 1; turn <= trunkTurns; turn += 1) {
    trunkLeaf = appendTurn(scenario, trunkLeaf);
  }

  const remaining = spec.turns - trunkTurns;
  const base = Math.floor(remaining / spec.routes);
  const remainder = remaining % spec.routes;
  routeIds.forEach((routeId, index) => {
    const uniqueFact = routeFact(index);
    const characterState = routeCharacterState(index);
    scenario.routeUniqueFacts.set(routeId, uniqueFact);
    scenario.routeCharacterStates.set(routeId, characterState);
    scenario.routeDepth.set(routeId, 2);
    let leafId = trunkLeaf;
    const routeTurns = base + (index < remainder ? 1 : 0);
    for (let turn = 0; turn < routeTurns; turn += 1) {
      leafId = appendTurn(
        scenario,
        leafId,
        turn === 0 ? uniqueFact : undefined,
        turn === 0 ? characterState : undefined,
      );
    }
    scenario.routeLeaves.set(routeId, leafId!);
  });
  return scenario;
}

function generateNested(spec: ExperimentScenarioSpec, seed: number): MutableScenario {
  const scenario = initializeScenario(spec, seed);
  const routeIds = Array.from({ length: spec.routes }, (_, index) => `route-${String(index + 1).padStart(2, '0')}`);

  const trunkTurns = Math.min(100, spec.turns);
  let trunkLeaf: string | null = null;
  for (let turn = 1; turn <= trunkTurns; turn += 1) {
    trunkLeaf = appendTurn(scenario, trunkLeaf);
  }

  const topGroups = Array.from({ length: 5 }, (_, index) => ({
    index,
    leafId: appendTurn(scenario, trunkLeaf),
  }));
  const midGroups = topGroups.flatMap((top) => Array.from({ length: 5 }, (_, index) => ({
    top,
    index,
    leafId: appendTurn(scenario, top.leafId),
  })));
  const leafRoutes = midGroups.flatMap((mid, midIndex) => [0, 1].map((subIndex) => {
    const routeIndex = midIndex * 2 + subIndex;
    const routeId = routeIds[routeIndex];
    const uniqueFact = routeFact(routeIndex);
    const characterState = routeCharacterState(routeIndex);
    scenario.routeUniqueFacts.set(routeId, uniqueFact);
    scenario.routeCharacterStates.set(routeId, characterState);
    scenario.routeDepth.set(routeId, 3);
    return {
      routeId,
      leafId: appendTurn(scenario, mid.leafId, uniqueFact, characterState),
      uniqueFact,
    };
  }));

  const remaining = spec.turns - scenario.actions.length;
  const base = Math.floor(remaining / leafRoutes.length);
  const remainder = remaining % leafRoutes.length;
  leafRoutes.forEach((route, index) => {
    let leafId = route.leafId;
    const routeTurns = base + (index < remainder ? 1 : 0);
    for (let turn = 0; turn < routeTurns; turn += 1) {
      leafId = appendTurn(scenario, leafId);
    }
    scenario.routeLeaves.set(route.routeId, leafId);
  });
  return scenario;
}

function buildProbes(scenario: MutableScenario): ExperimentProbe[] {
  const routeIds = [...scenario.routeLeaves.keys()];
  const probeCount = scenario.spec.name === 'continuous' ? 1 : scenario.spec.name === 'branching' ? 4 : 8;
  return Array.from({ length: probeCount }, (_, index) => {
    const routeIndex = Math.floor(index * routeIds.length / probeCount);
    const routeId = routeIds[routeIndex];
    const characterState = scenario.routeCharacterStates.get(routeId)!;
    const forbiddenFacts = routeIds
      .filter((candidate) => candidate !== routeId)
      .slice(routeIndex + 1)
      .concat(routeIds.filter((candidate) => candidate !== routeId).slice(0, routeIndex + 1))
      .slice(0, 3)
      .map((candidate) => scenario.routeCharacterStates.get(candidate)!);
    return {
      routeId,
      leafId: scenario.routeLeaves.get(routeId)!,
      query: PROBE_CUES[index % PROBE_CUES.length],
      expectedFacts: [characterState],
      forbiddenFacts,
    };
  });
}

export function generateExperimentScenario(
  name: ExperimentScenarioName,
  seed = 20261123,
): GeneratedExperimentScenario {
  const spec = SCENARIO_SPECS[name];
  const mutable =
    name === 'continuous'
      ? generateContinuous(spec, seed)
      : name === 'branching'
        ? generateBranching(spec, seed)
        : generateNested(spec, seed);
  const routes = [...mutable.routeLeaves.entries()].map(([id, leafId]) => ({
    id,
    leafId,
    actionIndexes: getActiveBranchNodes(
      { nodes: mutable.nodes, activeLeafNodeId: leafId },
      leafId,
    )
      .filter((node) => node.role === 'user')
      .map((node) => Number(node.id.match(/^turn-(\d+)-u$/)?.[1]) - 1),
    depth: mutable.routeDepth.get(id)!,
    uniqueFact: mutable.routeUniqueFacts.get(id)!,
    characterState: mutable.routeCharacterStates.get(id)!,
  }));
  return {
    spec,
    title: spec.title,
    setting: '原创民国奇幻悬疑。短指令推进，旧线索必须从当前路线及其共享祖先中找回。',
    sharedFact: mutable.sharedFact,
    turns: mutable.actions.length,
    actions: mutable.actions,
    nodes: mutable.nodes,
    routes,
    probes: buildProbes(mutable),
    maxRouteDepth: Math.max(...routes.map((route) => route.depth)),
  };
}

export const OFFICIAL_SHORT_RUN_BUDGET: ContextExperimentBudget = {
  maxRequests: 128,
  maxRetriesPerOperation: 1,
  maxInputTokensPerRequest: 256_000,
  maxOutputTokensPerRequest: 512,
  maxTotalCostUsd: 0.25,
  concurrency: 1,
  rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
};

export interface OfflineSmokeOptions {
  seed?: number;
  now?: () => number;
}

export type ContextExperimentContextPolicy =
  | 'full-history'
  | 'rolling-summary'
  | 'branch-retrieval';

export interface OfflineSummaryCoverage {
  coveredUpToNodeId: string | null;
  coveredNodeCount: number;
  uncoveredNodeCount: number;
  fixturePrefixNodeCount: number;
  contiguous: boolean;
}

export interface OfflineFolioSummaryPolicy {
  simulation: 'deterministic-offline';
  policy: 'production-selectNodesToSummarize-with-rolling-batches';
  recentMaxNodes: number;
  recentMaxChars: number;
  summaryBatchMaxNodes: number;
  summaryBatchMaxChars: number;
  contextsChecked: number;
  simulatedSummaryRequests: number;
  coverageViolations: number;
  sharedProbeCount: number;
  passed: boolean;
}

export interface OfflineRouteMeasurement {
  step: string;
  routeId: string;
  pathNodeCount: number;
  pathCharCount: number;
  contextEstimatedTokens: number;
  uniqueFactPresent: boolean;
  foreignRouteFactCount: number;
}

export interface OfflineRouteReturn {
  steps: string[];
  routeIds: string[];
  switchCount: number;
  measurements: OfflineRouteMeasurement[];
  returnedPathIdentical?: boolean;
  passed: boolean;
}

export interface OfflineOldTurnEditResult {
  entry: 'FictionHarness.editAndBranch';
  execution: 'offline-pure-harness';
  transport: 'in-process-fake';
  modelCalls: number;
  providerCalls: 0;
  originalBranchPreserved: boolean;
  siblingIsolated: boolean;
  passed: boolean;
}

export interface OfflineSmokeReport {
  schemaVersion: 3;
  mode: 'offline-simulated';
  generatedAt: string;
  providerRuns: 0;
  credentialStatus: 'not-read';
  groups: Record<ContextExperimentArm, ContextExperimentSummary>;
  comparisons: {
    fullToRetrievable: ContextSavingsEstimate;
    folioToRetrievable: ContextSavingsEstimate;
  };
  branchIsolation: {
    checkedRequests: number;
    leakedRequests: number;
    passed: boolean;
  };
  branchLifecycle: {
    continuedTurns: number;
    reopenedAfterRestart: boolean;
    editedSiblingIsolated: boolean;
    oldTurnEdit: OfflineOldTurnEditResult;
  };
  routeReturns: {
    aToBToA: OfflineRouteReturn;
    aToBToC: OfflineRouteReturn;
  };
  folioSummaryPolicy: OfflineFolioSummaryPolicy;
  officialPreflight: ContextExperimentPreflight & { budget: ContextExperimentBudget };
  requests: Array<ContextExperimentRequestRecord & {
    arm: ContextExperimentArm;
    scenario: ExperimentScenarioName;
    inputNodeCount?: number;
    inputTailNodeId?: string | null;
    inputCharCount?: number;
    messageCount?: number;
    contextPolicy?: ContextExperimentContextPolicy;
    contextFingerprint?: string;
    summaryCoverage?: OfflineSummaryCoverage;
  }>;
  limitations: string[];
}

interface RoutedAction {
  action: string;
  parentLeafId: string | null;
  routeId: string;
  logicalTurnId: string;
  branchSwitch: boolean;
}

function shortSmokeActions(
  scenario: GeneratedExperimentScenario,
  count: number,
): RoutedAction[] {
  const routeCount = scenario.spec.name === 'continuous' ? 1 : scenario.spec.name === 'branching' ? 2 : 5;
  const perRoute = Math.ceil(count / routeCount);
  const result: RoutedAction[] = [];
  for (let routeOffset = 0; routeOffset < routeCount && result.length < count; routeOffset += 1) {
    const routeIndex = Math.floor(routeOffset * scenario.routes.length / routeCount);
    const route = scenario.routes[routeIndex];
    const indexes = route.actionIndexes.slice(Math.max(0, route.actionIndexes.length - perRoute));
    for (let index = 0; index < indexes.length && result.length < count; index += 1) {
      result.push({
        action: scenario.actions[indexes[index]],
        parentLeafId: indexes[index] === 0 ? null : `turn-${indexes[index]}-a`,
        routeId: route.id,
        logicalTurnId: `${scenario.spec.name}:turn-${indexes[index] + 1}`,
        branchSwitch: routeOffset > 0 && index === 0,
      });
    }
  }
  return result;
}

function pathMessages(
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): LlmMessage[] {
  const path = parentLeafId
    ? getActiveBranchNodes({ nodes: scenario.nodes, activeLeafNodeId: parentLeafId }, parentLeafId)
    : [];
  return [
    { role: 'system', content: `${scenario.setting}\n故事：${scenario.title}` },
    ...path.map((node) => ({ role: node.role, content: node.content } as LlmMessage)),
    { role: 'user', content: action },
  ];
}

const OFFLINE_FOLIO_BUDGET = {
  recentMaxNodes: 8,
  recentMaxChars: 6_000,
  summaryBatchMaxNodes: DEFAULT_CONTEXT_BUDGET.summaryBatchMaxNodes,
  summaryBatchMaxChars: DEFAULT_CONTEXT_BUDGET.summaryBatchMaxChars,
} as const;

const OFFLINE_FOLIO_FIXTURE_TAIL_NODES = 10;

interface OfflineArmContext {
  messages: LlmMessage[];
  policy: ContextExperimentContextPolicy;
  retrievalCount: number;
  summaryRequests: LlmMessage[][];
  summaryCoverage?: OfflineSummaryCoverage;
}

function offlineSummaryText(previous: string, nodes: readonly TurnNode[]): string {
  const addition = nodes.map((node) => {
    const detail = (node.turnSummary ?? node.content).replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${node.role === 'user' ? '行动' : '叙事'}：${detail}`;
  }).join('；');
  return `${previous}${previous ? '；' : ''}${addition}`.slice(-2_000);
}

function takeOfflineSummaryBatch(nodes: readonly TurnNode[]): TurnNode[] {
  let end = 0;
  let chars = 0;
  for (const node of nodes) {
    if (end >= OFFLINE_FOLIO_BUDGET.summaryBatchMaxNodes) break;
    if (chars + node.content.length > OFFLINE_FOLIO_BUDGET.summaryBatchMaxChars && end > 0) break;
    chars += node.content.length;
    end += 1;
  }
  if (end < nodes.length && end > 1 && nodes[end - 1]?.role === 'user') end -= 1;
  return nodes.slice(0, end);
}

function folioMessages(
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): OfflineArmContext {
  const path = getActiveBranchNodes(
    { nodes: scenario.nodes, activeLeafNodeId: parentLeafId },
    parentLeafId,
  );
  const fixturePrefixNodeCount = Math.max(0, path.length - OFFLINE_FOLIO_FIXTURE_TAIL_NODES);
  const fixturePrefix = path.slice(0, fixturePrefixNodeCount);
  let snapshot: PlotSummarySnapshot = fixturePrefixNodeCount > 0
    ? {
        content: offlineSummaryText('', fixturePrefix),
        coveredUpToNodeId: fixturePrefix[fixturePrefix.length - 1].id,
        summarizedTurnCount: fixturePrefix.length,
      }
    : EMPTY_SUMMARY_SNAPSHOT;
  const summaryRequests: LlmMessage[][] = [];

  while (true) {
    const uncovered = getUncoveredNodes(path, snapshot.coveredUpToNodeId);
    const selected = selectNodesToSummarize(uncovered, OFFLINE_FOLIO_BUDGET);
    if (selected.length === 0) break;
    const batch = takeOfflineSummaryBatch(selected);
    if (batch.length === 0) break;
    summaryRequests.push(buildSummaryCompressionMessages(
      snapshot.content,
      batch,
      undefined,
      OFFLINE_FOLIO_BUDGET.summaryBatchMaxChars,
    ));
    snapshot = {
      content: offlineSummaryText(snapshot.content, batch),
      coveredUpToNodeId: batch[batch.length - 1].id,
      summarizedTurnCount: snapshot.summarizedTurnCount + batch.length,
    };
  }

  const target = path.at(-1);
  const nodes = target
    ? {
        ...scenario.nodes,
        [target.id]: { ...target, summarySnapshot: snapshot },
      }
    : scenario.nodes;
  const messages = assembleCreativeThreeZoneContext({
    systemPrompt: `${scenario.setting}\n故事：${scenario.title}`,
    nodes,
    targetParentId: parentLeafId,
    userInput: action,
    budgetOverrides: OFFLINE_FOLIO_BUDGET,
  }).messages;
  const coveredNodeCount = snapshot.coveredUpToNodeId
    ? path.findIndex((node) => node.id === snapshot.coveredUpToNodeId) + 1
    : 0;

  return {
    messages,
    policy: 'rolling-summary',
    retrievalCount: 0,
    summaryRequests,
    summaryCoverage: {
      coveredUpToNodeId: snapshot.coveredUpToNodeId,
      coveredNodeCount,
      uncoveredNodeCount: path.length - coveredNodeCount,
      fixturePrefixNodeCount,
      contiguous:
        coveredNodeCount >= 0 &&
        coveredNodeCount <= path.length &&
        snapshot.summarizedTurnCount === coveredNodeCount,
    },
  };
}

function retrievableMessages(
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): OfflineArmContext {
  const path = getActiveBranchNodes(
    { nodes: scenario.nodes, activeLeafNodeId: parentLeafId },
    parentLeafId,
  );
  const retrieval = parentLeafId
    ? retrieveFromActiveBranch(scenario.nodes, parentLeafId, action, 3)
    : { pathNodeIds: [], selected: [] };
  return {
    messages: [
      { role: 'system', content: `${scenario.setting}\n故事：${scenario.title}` },
      ...retrieval.selected.map((node) => ({
        role: 'system' as const,
        content: `按需回取（当前路线 ${node.id}）：${node.content}`,
      })),
      ...path.slice(-6).map((node) => ({ role: node.role, content: node.content } as LlmMessage)),
      { role: 'user', content: action },
    ],
    policy: 'branch-retrieval',
    retrievalCount: retrieval.selected.length,
    summaryRequests: [],
  };
}

function contextForArm(
  arm: ContextExperimentArm,
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): OfflineArmContext {
  if (arm === 'full') {
    return {
      messages: pathMessages(scenario, parentLeafId, action),
      policy: 'full-history',
      retrievalCount: 0,
      summaryRequests: [],
    };
  }
  return arm === 'folio'
    ? folioMessages(scenario, parentLeafId, action)
    : retrievableMessages(scenario, parentLeafId, action);
}

function contextFingerprint(messages: readonly LlmMessage[]): string {
  let hash = 0x811c9dc5;
  for (const message of messages) {
    for (const character of `${message.role}\0${message.content}\0`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function simulatedTokens(value: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).length * 0.65));
}

function simulatedUsage(
  arm: ContextExperimentArm,
  messages: readonly LlmMessage[],
  turnIndex: number,
  completionTokens = 64,
) {
  const promptTokens = simulatedTokens(messages.map((message) => message.content).join('\n'));
  const baseRate = arm === 'full' ? 0.7 : arm === 'folio' ? 0.48 : 0.58;
  const hitRate = Math.min(0.98, baseRate + turnIndex * 0.008);
  const promptCacheHitTokens = Math.floor(promptTokens * hitRate);
  return {
    promptCacheHitTokens,
    promptCacheMissTokens: promptTokens - promptCacheHitTokens,
    completionTokens,
  };
}

function createOfflineHarness() {
  return createFictionHarness({
    transport: {
      async *streamChat() {
        yield { contentDelta: '离线纯 Harness 回复。', finishReason: 'stop' };
      },
    },
  });
}

function storyFromScenario(
  harness: ReturnType<typeof createOfflineHarness>,
  scenario: GeneratedExperimentScenario,
): Story {
  const base = harness.createStory({ title: scenario.title, rawScript: scenario.setting });
  const rootNodeIds = Object.values(scenario.nodes)
    .filter((node) => node.parentId === null)
    .map((node) => node.id);
  return {
    ...base,
    nodes: structuredClone(scenario.nodes),
    rootNodeIds,
    activeLeafNodeId: scenario.routes[0]?.leafId ?? null,
  };
}

async function measureRouteSequence(
  scenario: GeneratedExperimentScenario,
  steps: readonly ['A', 'B', 'A'] | readonly ['A', 'B', 'C'],
  routeIndexes: readonly number[],
): Promise<{ result: OfflineRouteReturn; activePathIdsByStep: string[][] }> {
  const harness = createOfflineHarness();
  let story = storyFromScenario(harness, scenario);
  const routeIds = routeIndexes.map((index) => scenario.routes[index].id);
  const measurements: OfflineRouteMeasurement[] = [];
  const activePathIdsByStep: string[][] = [];

  for (let index = 0; index < routeIndexes.length; index += 1) {
    const route = scenario.routes[routeIndexes[index]];
    story = await harness.switchBranch(story, route.leafId);
    const path = getActiveBranchNodes(
      { nodes: story.nodes, activeLeafNodeId: story.activeLeafNodeId },
      story.activeLeafNodeId,
    );
    const pathText = path.map((node) => node.content).join('\n');
    const foreignFacts = scenario.routes
      .filter((candidate) => candidate.id !== route.id)
      .flatMap((candidate) => [candidate.uniqueFact, candidate.characterState]);
    const context = harness.assembleContext(story, story.activeLeafNodeId, '离线路线返回测量');
    activePathIdsByStep.push(path.map((node) => node.id));
    measurements.push({
      step: steps[index],
      routeId: route.id,
      pathNodeCount: path.length,
      pathCharCount: pathText.length,
      contextEstimatedTokens: context.metrics.totalEstimatedTokens,
      uniqueFactPresent:
        pathText.includes(route.uniqueFact) && pathText.includes(route.characterState),
      foreignRouteFactCount: foreignFacts.filter((fact) => pathText.includes(fact)).length,
    });
  }

  return {
    result: {
      steps: [...steps],
      routeIds,
      switchCount: routeIndexes.length,
      measurements,
      passed: measurements.every(
        (measurement) =>
          measurement.uniqueFactPresent && measurement.foreignRouteFactCount === 0,
      ),
    },
    activePathIdsByStep,
  };
}

async function verifyRouteReturns(seed: number): Promise<OfflineSmokeReport['routeReturns']> {
  const scenario = generateExperimentScenario('branching', seed);
  const aToBToA = await measureRouteSequence(scenario, ['A', 'B', 'A'], [0, 1, 0]);
  const returnedPathIdentical = JSON.stringify(aToBToA.activePathIdsByStep[0]) ===
    JSON.stringify(aToBToA.activePathIdsByStep[2]);
  const aToBToC = await measureRouteSequence(scenario, ['A', 'B', 'C'], [0, 1, 2]);

  return {
    aToBToA: {
      ...aToBToA.result,
      returnedPathIdentical,
      passed: aToBToA.result.passed && returnedPathIdentical,
    },
    aToBToC: aToBToC.result,
  };
}

async function verifyBranchLifecycle(seed: number): Promise<OfflineSmokeReport['branchLifecycle']> {
  const scenario = generateExperimentScenario('branching', seed);
  const [routeA, routeB] = scenario.routes;
  const nodes = structuredClone(scenario.nodes);
  const append = (parentId: string, id: string, content: string): string => {
    const userId = `${id}-u`;
    const assistantId = `${id}-a`;
    const parent = nodes[parentId];
    nodes[userId] = {
      id: userId,
      parentId,
      role: 'user',
      content,
      createdAt: parent.createdAt + 2,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    nodes[assistantId] = {
      id: assistantId,
      parentId: userId,
      role: 'assistant',
      content: `确认${content}`,
      createdAt: parent.createdAt + 3,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    return assistantId;
  };

  const continuedA = append(routeA.leafId, 'lifecycle-a', 'A线继续写');
  const continuedB = append(routeB.leafId, 'lifecycle-b', 'B线继续写');
  const reopenedNodes = JSON.parse(JSON.stringify(nodes)) as Record<string, TurnNode>;
  const reopenedA = getActiveBranchNodes(
    { nodes: reopenedNodes, activeLeafNodeId: continuedA },
    continuedA,
  ).map((node) => node.content).join('\n');
  const reopenedB = getActiveBranchNodes(
    { nodes: reopenedNodes, activeLeafNodeId: continuedB },
    continuedB,
  ).map((node) => node.content).join('\n');
  const reopenedAfterRestart =
    reopenedA.includes('A线继续写') &&
    reopenedA.includes(routeA.uniqueFact) &&
    reopenedA.includes(routeA.characterState) &&
    !reopenedA.includes(routeB.characterState) &&
    !reopenedA.includes('B线继续写') &&
    reopenedB.includes('B线继续写') &&
    reopenedB.includes(routeB.uniqueFact) &&
    reopenedB.includes(routeB.characterState) &&
    !reopenedB.includes(routeA.characterState) &&
    !reopenedB.includes('A线继续写');

  let modelCalls = 0;
  const harness = createFictionHarness({
    transport: {
      async *streamChat() {
        modelCalls += 1;
        yield { contentDelta: '纯 Harness 旧轮改写回复。', finishReason: 'stop' };
      },
    },
    contextBudget: { recentMaxNodes: 8, recentMaxChars: 6_000 },
  });
  const storyBase = harness.createStory({ title: '离线旧轮编辑', rawScript: scenario.setting });
  const story: Story = {
    ...storyBase,
    nodes: {
      'edit-u1': {
        id: 'edit-u1', parentId: null, role: 'user', content: '旧轮根行动。', createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      'edit-a1': {
        id: 'edit-a1', parentId: 'edit-u1', role: 'assistant', content: '旧轮根回复。', createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      'edit-u2': {
        id: 'edit-u2', parentId: 'edit-a1', role: 'user', content: '原始旧轮行动。', createdAt: 3,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      'edit-a2': {
        id: 'edit-a2', parentId: 'edit-u2', role: 'assistant', content: '原始旧轮回复。', createdAt: 4,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    },
    rootNodeIds: ['edit-u1'],
    activeLeafNodeId: 'edit-a2',
  };
  const originalUserNode = { ...story.nodes['edit-u2'] };
  const originalAssistantNode = { ...story.nodes['edit-a2'] };
  const edited = await harness.editAndBranch(story, 'edit-u2', '纯 Harness 旧轮改写', {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'offline-fake',
    model: 'deepseek-flash',
    reasoningEffort: 'none',
    memoryOnly: true,
  });
  const editedPath = getActiveBranchNodes(
    { nodes: edited.story.nodes, activeLeafNodeId: edited.story.activeLeafNodeId },
    edited.story.activeLeafNodeId,
  ).map((node) => node.content).join('\n');
  const originalBranchPreserved =
    edited.story.nodes['edit-u2']?.content === originalUserNode.content &&
    edited.story.nodes['edit-u2']?.parentId === originalUserNode.parentId &&
    edited.story.nodes['edit-a2']?.content === originalAssistantNode.content &&
    edited.story.nodes['edit-a2']?.parentId === originalAssistantNode.parentId;
  const siblingIsolated =
    editedPath.includes('纯 Harness 旧轮改写') &&
    editedPath.includes('纯 Harness 旧轮改写回复。') &&
    !editedPath.includes('原始旧轮行动。') &&
    !editedPath.includes('原始旧轮回复。');
  const oldTurnEdit: OfflineOldTurnEditResult = {
    entry: 'FictionHarness.editAndBranch',
    execution: 'offline-pure-harness',
    transport: 'in-process-fake',
    modelCalls,
    providerCalls: 0,
    originalBranchPreserved,
    siblingIsolated,
    passed: modelCalls === 1 && originalBranchPreserved && siblingIsolated,
  };

  return {
    continuedTurns: 2,
    reopenedAfterRestart,
    editedSiblingIsolated: oldTurnEdit.passed,
    oldTurnEdit,
  };
}

export async function runOfflineSmoke(options: OfflineSmokeOptions = {}): Promise<OfflineSmokeReport> {
  const seed = options.seed ?? 20261123;
  const now = options.now ?? (() => Date.now());
  const scenarios = [
    generateExperimentScenario('continuous', seed),
    generateExperimentScenario('branching', seed),
    generateExperimentScenario('nested', seed),
  ];
  const plans: ContextExperimentRequestPlan[] = [];
  const recordsByArm: Record<ContextExperimentArm, ContextExperimentRequestRecord[]> = {
    full: [],
    folio: [],
    retrievable: [],
  };
  const allRequests: OfflineSmokeReport['requests'] = [];
  let leakedRequests = 0;
  let checkedRequests = 0;
  let folioContextsChecked = 0;
  let folioCoverageViolations = 0;

  for (const arm of ['full', 'folio', 'retrievable'] as const) {
    for (const scenario of scenarios) {
      const routedActions = shortSmokeActions(scenario, 10);
      for (let sceneTurn = 0; sceneTurn < routedActions.length; sceneTurn += 1) {
        const routed = routedActions[sceneTurn];
        const path = routed.parentLeafId
          ? getActiveBranchNodes(
              { nodes: scenario.nodes, activeLeafNodeId: routed.parentLeafId },
              routed.parentLeafId,
            )
          : [];
        const allowedIds = new Set(path.map((node) => node.id));
        const forbiddenFacts = scenario.routes
          .filter((route) => route.id !== routed.routeId)
          .flatMap((route) => [route.uniqueFact, route.characterState]);
        const context = contextForArm(arm, scenario, routed.parentLeafId, routed.action);
        const messages = context.messages;
        if (arm === 'folio') {
          folioContextsChecked += 1;
          if (!context.summaryCoverage?.contiguous) folioCoverageViolations += 1;
        }
        checkedRequests += 1;
        const serialized = messages.map((message) => message.content).join('\n');
        const leaked = forbiddenFacts.some((fact) => serialized.includes(fact)) ||
          messages.some((message) => {
            const match = message.content.match(/当前路线 (turn-\d+-a)/);
            return Boolean(match && !allowedIds.has(match[1]));
          });
        if (leaked) leakedRequests += 1;
        const sampleNumber = sceneTurn + 1;
        const usage = simulatedUsage(arm, messages, sampleNumber);
        const record: ContextExperimentRequestRecord = {
          requestId: `anonymous-${arm}-${scenario.spec.name}-${String(sampleNumber).padStart(2, '0')}`,
          phase: 'generation',
          status: 'completed',
          logicalTurnId: routed.logicalTurnId,
          transport: 'outbound-http',
          usage,
          firstContentLatencyMs: 420 + (sampleNumber * 37 + seed) % 900,
          branchSwitch: routed.branchSwitch,
        };
        recordsByArm[arm].push(record);
        allRequests.push({
          ...record,
          arm,
          scenario: scenario.spec.name,
          inputNodeCount: path.length,
          inputTailNodeId: path.at(-1)?.id ?? null,
          inputCharCount: messages.reduce((total, message) => total + message.content.length, 0),
          messageCount: messages.length,
          contextPolicy: context.policy,
          contextFingerprint: contextFingerprint(messages),
          ...(context.summaryCoverage ? { summaryCoverage: context.summaryCoverage } : {}),
        });
        plans.push({
          operationId: `${arm}-${scenario.spec.name}-${sceneTurn}`,
          attempt: 0,
          maxInputTokens: new TextEncoder().encode(messages.map((message) => message.content).join('\n')).length,
          maxOutputTokens: 512,
        });

        if (context.retrievalCount > 0) {
          const retrievalRecord: ContextExperimentRequestRecord = {
            requestId: `anonymous-${arm}-retrieval-${scenario.spec.name}-${String(sampleNumber).padStart(2, '0')}`,
            phase: 'retrieval',
            status: 'completed',
            logicalTurnId: routed.logicalTurnId,
            transport: 'local',
            usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 0, completionTokens: 0 },
          };
          recordsByArm[arm].push(retrievalRecord);
          allRequests.push({ ...retrievalRecord, arm, scenario: scenario.spec.name });
        }

        for (let summaryIndex = 0; summaryIndex < context.summaryRequests.length; summaryIndex += 1) {
          const summaryMessages = context.summaryRequests[summaryIndex];
          const summaryUsage = simulatedUsage(arm, summaryMessages, sampleNumber, 32);
          const summaryRecord: ContextExperimentRequestRecord = {
            requestId: `anonymous-${arm}-summary-${scenario.spec.name}-${String(summaryIndex + 1).padStart(2, '0')}-${String(sampleNumber).padStart(2, '0')}`,
            phase: 'summary',
            status: 'completed',
            logicalTurnId: routed.logicalTurnId,
            transport: 'outbound-http',
            usage: summaryUsage,
            firstContentLatencyMs: 700 + (sampleNumber * 19) % 600,
          };
          recordsByArm[arm].push(summaryRecord);
          allRequests.push({ ...summaryRecord, arm, scenario: scenario.spec.name });
          plans.push({
            operationId: `summary-${scenario.spec.name}-${summaryIndex}-${sceneTurn}`,
            attempt: 0,
            maxInputTokens: new TextEncoder().encode(
              summaryMessages.map((message) => message.content).join('\n'),
            ).length,
            maxOutputTokens: 512,
          });
        }
      }
    }

    const retryTurnIndex = scenarios[0].actions.length - 1;
    const retryParentId = `turn-${retryTurnIndex}-a`;
    const retryAction = scenarios[0].actions[retryTurnIndex];
    const retryContext = contextForArm(arm, scenarios[0], retryParentId, retryAction);
    const retryMessages = retryContext.messages;
    const retryUsage = simulatedUsage(arm, retryMessages, 30, 24);
    const retryRecord: ContextExperimentRequestRecord = {
      requestId: `anonymous-${arm}-retry-001`,
      phase: 'retry',
      status: 'completed',
      logicalTurnId: `continuous:turn-${retryTurnIndex + 1}`,
      transport: 'outbound-http',
      usage: retryUsage,
      firstContentLatencyMs: 980,
    };
    recordsByArm[arm].push(retryRecord);
    allRequests.push({
      ...retryRecord,
      arm,
      scenario: 'continuous',
      inputNodeCount: retryTurnIndex * 2,
      inputTailNodeId: retryParentId,
      inputCharCount: retryMessages.reduce((total, message) => total + message.content.length, 0),
      messageCount: retryMessages.length,
      contextPolicy: retryContext.policy,
      contextFingerprint: contextFingerprint(retryMessages),
      ...(retryContext.summaryCoverage ? { summaryCoverage: retryContext.summaryCoverage } : {}),
    });
    plans.push({
      operationId: `${arm}-retry`,
      attempt: 1,
      maxInputTokens: new TextEncoder().encode(
        retryMessages.map((message) => message.content).join('\n'),
      ).length,
      maxOutputTokens: 512,
    });
  }

  const preflight = preflightContextExperiment(OFFICIAL_SHORT_RUN_BUDGET, plans);
  if (!preflight.ok) {
    throw new Error(`Offline smoke budget preflight failed: ${preflight.violations.join(', ')}`);
  }

  const groups = Object.fromEntries(
    (['full', 'folio', 'retrievable'] as const).map((arm) => {
      const group: ContextExperimentGroup = {
        arm,
        provider: 'offline-simulated',
        model: 'deepseek-flash',
        pricingSchedule: 'off-peak',
        rates: DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
        effectiveTurns: 30,
        records: recordsByArm[arm],
      };
      return [arm, summarizeContextExperiment(group)];
    }),
  ) as Record<ContextExperimentArm, ContextExperimentSummary>;

  return {
    schemaVersion: 3,
    mode: 'offline-simulated',
    generatedAt: new Date(now()).toISOString(),
    providerRuns: 0,
    credentialStatus: 'not-read',
    groups,
    comparisons: {
      fullToRetrievable: estimateContextSavings(groups.full, groups.retrievable),
      folioToRetrievable: estimateContextSavings(groups.folio, groups.retrievable),
    },
    branchIsolation: {
      checkedRequests,
      leakedRequests,
      passed: leakedRequests === 0,
    },
    branchLifecycle: await verifyBranchLifecycle(seed),
    routeReturns: await verifyRouteReturns(seed),
    folioSummaryPolicy: {
      simulation: 'deterministic-offline',
      policy: 'production-selectNodesToSummarize-with-rolling-batches',
      recentMaxNodes: OFFLINE_FOLIO_BUDGET.recentMaxNodes,
      recentMaxChars: OFFLINE_FOLIO_BUDGET.recentMaxChars,
      summaryBatchMaxNodes: OFFLINE_FOLIO_BUDGET.summaryBatchMaxNodes,
      summaryBatchMaxChars: OFFLINE_FOLIO_BUDGET.summaryBatchMaxChars,
      contextsChecked: folioContextsChecked,
      simulatedSummaryRequests: recordsByArm.folio.filter((record) => record.phase === 'summary').length,
      coverageViolations: folioCoverageViolations,
      sharedProbeCount: scenarios.reduce((total, scenario) => total + scenario.probes.length, 0),
      passed: folioContextsChecked === 30 && folioCoverageViolations === 0,
    },
    officialPreflight: { ...preflight, budget: OFFICIAL_SHORT_RUN_BUDGET },
    requests: allRequests,
    limitations: [
      'Offline simulated usage validates branch identity and measurement plumbing only.',
      'Folio summary text and request cadence are deterministic offline simulations driven by the production summary-selection and rolling-batch policy.',
      'Route-return and old-turn edit probes use the pure Harness entry points with an in-process fake model transport; no provider response quality is measured.',
      'It cannot establish quality, real prefix-cache behavior, latency, or API savings.',
      'No DeepSeek credential was read and no funded request was sent.',
    ],
  };
}

export interface BranchRetrievalResult {
  pathNodeIds: string[];
  selected: TurnNode[];
}

function normalizedTerms(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s，。！？、；：“”‘’（）()\[\]{}]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function scoreNode(node: TurnNode, terms: readonly string[]): number {
  const content = node.content.normalize('NFKC').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (content.includes(term)) score += term.length * 20;
    for (let index = 0; index < term.length - 1; index += 1) {
      const bigram = term.slice(index, index + 2);
      if (content.includes(bigram)) score += 3;
    }
  }
  return score;
}

/**
 * Local experiment retrieval. It can only rank nodes already on the target
 * leaf's active path, which includes shared ancestors and excludes siblings.
 */
export function retrieveFromActiveBranch(
  nodes: Record<string, TurnNode>,
  targetLeafId: string,
  query: string,
  limit: number,
): BranchRetrievalResult {
  const branchNodes = getActiveBranchNodes({ nodes, activeLeafNodeId: targetLeafId }, targetLeafId);
  const terms = normalizedTerms(query);
  const pathIndex = new Map(branchNodes.map((node, index) => [node.id, index]));
  const selected = branchNodes
    .map((node) => ({ node, score: scoreNode(node, terms) }))
    .sort((left, right) => right.score - left.score || right.node.createdAt - left.node.createdAt)
    .slice(0, Math.max(0, Math.floor(limit)))
    .sort((left, right) => (pathIndex.get(left.node.id) ?? 0) - (pathIndex.get(right.node.id) ?? 0))
    .map((entry) => entry.node);

  return {
    pathNodeIds: branchNodes.map((node) => node.id),
    selected,
  };
}
