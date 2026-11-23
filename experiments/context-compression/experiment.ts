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
import { createInMemoryStoryStorage } from '../../src/harness/storyStorage.ts';
import {
  compareContextExperimentRangeSubset,
  DEEPSEEK_V41_FLASH_OFF_PEAK_RATES,
  estimateContextSavings,
  preflightContextExperiment,
  summarizeContextExperiment,
  type ContextExperimentArm,
  type ContextExperimentBudget,
  type ContextExperimentGroup,
  type ContextExperimentPreflight,
  type ContextExperimentRangeSubsetComparison,
  type ContextExperimentRequestPlan,
  type ContextExperimentRequestRecord,
  type ContextExperimentSummary,
  type ContextSavingsEstimate,
} from './savings.ts';
import type {
  LlmMessage,
  ModelConfig,
  PlotSummarySnapshot,
  Story,
  TurnNode,
} from '../../src/harness/types.ts';

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
  '沈砚 伤痕',
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
  fixture: 'nested';
  execution: 'offline-pure-harness';
  transport: 'in-process-fake';
  modelCalls: number;
  providerCalls: 0;
  reloadedAfterEdit: boolean;
  originalBranchPreserved: boolean;
  siblingIsolated: boolean;
  passed: boolean;
}

export interface OfflineRetryResult {
  entry: 'FictionHarness.regenerateNode';
  fixture: 'branching';
  execution: 'offline-pure-harness';
  transport: 'in-process-fake';
  modelCalls: number;
  providerCalls: 0;
  reloadedAfterRetry: boolean;
  originalReplyPreserved: boolean;
  siblingIsolated: boolean;
  passed: boolean;
}

export interface OfflineSmokeReport {
  schemaVersion: 5;
  mode: 'offline-simulated';
  generatedAt: string;
  providerRuns: 0;
  credentialStatus: 'not-read';
  groups: Record<ContextExperimentArm, ContextExperimentSummary>;
  comparisons: {
    fullToRetrievable: ContextSavingsEstimate;
    folioToRetrievable: ContextSavingsEstimate;
  };
  rangeSubsets: {
    fullToRetrievable: ContextExperimentRangeSubsetComparison;
    folioToRetrievable: ContextExperimentRangeSubsetComparison;
  };
  branchIsolation: {
    checkedRequests: number;
    checkedGenerationRequests: number;
    checkedSummaryRequests: number;
    checkedRetryRequests: number;
    leakedRequests: number;
    passed: boolean;
  };
  branchLifecycle: {
    fixture: 'nested';
    continuationEntry: 'FictionHarness.runTurn';
    continuationModelCalls: number;
    continuedTurns: number;
    providerCalls: 0;
    reopenedAfterRestart: boolean;
    editedSiblingIsolated: boolean;
    oldTurnEdit: OfflineOldTurnEditResult;
    retry: OfflineRetryResult;
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
    retrievalNodeIds?: string[];
    retrievalScores?: number[];
    recentNodeIds?: string[];
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

const OFFLINE_VISIBLE_OUTPUT = {
  generation: '离线模拟正文。',
  summary: '离线模拟摘要。',
  retry: '离线模拟重试。',
} as const;

export interface OfflineExperimentContext {
  messages: LlmMessage[];
  policy: ContextExperimentContextPolicy;
  retrievalCount: number;
  retrievalNodeIds: string[];
  retrievalScores: number[];
  recentNodeIds: string[];
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
): OfflineExperimentContext {
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
    retrievalNodeIds: [],
    retrievalScores: [],
    recentNodeIds: [],
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

export function buildRetrievableExperimentContext(
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): OfflineExperimentContext {
  const path = getActiveBranchNodes(
    { nodes: scenario.nodes, activeLeafNodeId: parentLeafId },
    parentLeafId,
  );
  const recentNodes = path.slice(-6);
  const recentNodeIds = recentNodes.map((node) => node.id);
  const retrieval = parentLeafId
    ? retrieveFromActiveBranch(
        scenario.nodes,
        parentLeafId,
        action,
        3,
        new Set(recentNodeIds),
      )
    : { pathNodeIds: [], selected: [], scores: [] };
  return {
    messages: [
      { role: 'system', content: `${scenario.setting}\n故事：${scenario.title}` },
      ...retrieval.selected.map((node) => ({
        role: 'system' as const,
        content: `按需回取（当前路线 ${node.id}）：${node.content}`,
      })),
      ...recentNodes.map((node) => ({ role: node.role, content: node.content } as LlmMessage)),
      { role: 'user', content: action },
    ],
    policy: 'branch-retrieval',
    retrievalCount: retrieval.selected.length,
    retrievalNodeIds: retrieval.selected.map((node) => node.id),
    retrievalScores: retrieval.scores,
    recentNodeIds,
    summaryRequests: [],
  };
}

function contextForArm(
  arm: ContextExperimentArm,
  scenario: GeneratedExperimentScenario,
  parentLeafId: string | null,
  action: string,
): OfflineExperimentContext {
  if (arm === 'full') {
    return {
      messages: pathMessages(scenario, parentLeafId, action),
      policy: 'full-history',
      retrievalCount: 0,
      retrievalNodeIds: [],
      retrievalScores: [],
      recentNodeIds: [],
      summaryRequests: [],
    };
  }
  return arm === 'folio'
    ? folioMessages(scenario, parentLeafId, action)
    : buildRetrievableExperimentContext(scenario, parentLeafId, action);
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

function hasForbiddenSiblingFact(
  messages: readonly LlmMessage[],
  allowedNodeIds: ReadonlySet<string>,
  forbiddenFacts: readonly string[],
): boolean {
  const serialized = messages.map((message) => message.content).join('\n');
  return forbiddenFacts.some((fact) => serialized.includes(fact)) ||
    messages.some((message) => {
      const match = message.content.match(/当前路线 (turn-\d+-a)/);
      return Boolean(match && !allowedNodeIds.has(match[1]));
    });
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

const OFFLINE_HARNESS_CONFIG: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'offline-placeholder',
  model: 'deepseek-flash',
  reasoningEffort: 'none',
  memoryOnly: true,
};

function nodeValuesEqual(left: TurnNode, right: TurnNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyBranchLifecycle(seed: number): Promise<OfflineSmokeReport['branchLifecycle']> {
  const nestedScenario = generateExperimentScenario('nested', seed);
  const nestedRouteA = nestedScenario.routes[0];
  const historicalUserNodeId = nestedScenario.nodes[nestedRouteA.leafId].parentId!;
  nestedScenario.nodes[historicalUserNodeId] = {
    ...nestedScenario.nodes[historicalUserNodeId],
    content: '原始嵌套旧轮行动（须隔离）',
  };
  nestedScenario.nodes[nestedRouteA.leafId] = {
    ...nestedScenario.nodes[nestedRouteA.leafId],
    content: '原始嵌套旧轮回复（须隔离）',
  };

  const nestedStorage = createInMemoryStoryStorage();
  let nestedNow = 1_765_000_000_000;
  let nestedSequence = 0;
  let nestedModelCalls = 0;
  const makeNestedHarness = () => createFictionHarness({
    transport: {
      async *streamChat(request) {
        nestedModelCalls += 1;
        const input = request.messages.at(-1)?.content ?? '';
        const content = input.includes('嵌套续写一')
          ? '嵌套续写回复一。'
          : input.includes('嵌套续写二')
            ? '嵌套续写回复二。'
            : input.includes('嵌套历史改写')
              ? '嵌套历史改写回复。'
              : '嵌套夹具离线回复。';
        yield { contentDelta: content, finishReason: 'stop' };
      },
    },
    storage: nestedStorage,
    contextBudget: { recentMaxNodes: 10_000, recentMaxChars: 10_000_000 },
    now: () => {
      nestedNow += 1_000;
      return nestedNow;
    },
    createId: () => `real-nested-${++nestedSequence}`,
  });
  const nestedHarness = makeNestedHarness();
  const nestedSaved = await nestedHarness.saveStory(storyFromScenario(nestedHarness, nestedScenario));
  const nestedActive = await nestedHarness.setActiveStory(nestedSaved.id);
  if (!nestedActive) throw new Error('Nested lifecycle fixture was not activated.');
  const continuationOne = await nestedHarness.runTurn(
    nestedActive,
    '嵌套续写一',
    OFFLINE_HARNESS_CONFIG,
  );
  const continuationTwo = await nestedHarness.runTurn(
    continuationOne.story,
    '嵌套续写二',
    OFFLINE_HARNESS_CONFIG,
  );
  const continuedLeafId = continuationTwo.assistantNode.id;
  const continuedPath = getActiveBranchNodes(continuationTwo.story, continuedLeafId);
  const continuedText = continuedPath.map((node) => node.content).join('\n');
  const nestedForbiddenFacts = nestedScenario.routes
    .filter((route) => route.id !== nestedRouteA.id)
    .flatMap((route) => [route.uniqueFact, route.characterState]);
  const nestedReloadHarness = makeNestedHarness();
  const nestedReloaded = await nestedReloadHarness.loadActiveStory();
  const reopenedText = nestedReloaded?.activeLeafNodeId
    ? getActiveBranchNodes(nestedReloaded, nestedReloaded.activeLeafNodeId)
        .map((node) => node.content)
        .join('\n')
    : '';
  const reopenedAfterRestart = Boolean(
    nestedReloaded &&
    nestedReloaded.activeLeafNodeId === continuedLeafId &&
    reopenedText.includes('嵌套续写一') &&
    reopenedText.includes('嵌套续写回复一。') &&
    reopenedText.includes('嵌套续写二') &&
    reopenedText.includes('嵌套续写回复二。') &&
    reopenedText.includes(nestedRouteA.uniqueFact) &&
    reopenedText.includes(nestedRouteA.characterState) &&
    nestedForbiddenFacts.every((fact) => !reopenedText.includes(fact)),
  );

  const preEditNodes = Object.fromEntries(
    Object.entries(nestedReloaded!.nodes).map(([id, value]) => [id, structuredClone(value)]),
  );
  const modelCallsBeforeEdit = nestedModelCalls;
  const edited = await nestedReloadHarness.editAndBranch(
    nestedReloaded!,
    historicalUserNodeId,
    '嵌套历史改写',
    OFFLINE_HARNESS_CONFIG,
  );
  const editedLeafId = edited.assistantNode.id;
  const editedReloadHarness = makeNestedHarness();
  const editedReloaded = await editedReloadHarness.loadActiveStory();
  const editedText = editedReloaded?.activeLeafNodeId
    ? getActiveBranchNodes(editedReloaded, editedReloaded.activeLeafNodeId)
        .map((node) => node.content)
        .join('\n')
    : '';
  const switchedOriginal = await editedReloadHarness.switchBranch(
    editedReloaded!,
    continuedLeafId,
  );
  const originalReloadHarness = makeNestedHarness();
  const originalReloaded = await originalReloadHarness.loadActiveStory();
  const originalText = originalReloaded?.activeLeafNodeId
    ? getActiveBranchNodes(originalReloaded, originalReloaded.activeLeafNodeId)
        .map((node) => node.content)
        .join('\n')
    : '';
  const switchedEdited = await originalReloadHarness.switchBranch(
    originalReloaded!,
    editedLeafId,
  );
  const finalReloadHarness = makeNestedHarness();
  const finalReloaded = await finalReloadHarness.loadActiveStory();
  const originalBranchPreserved =
    Object.entries(preEditNodes).every(([id, value]) => {
      const current = switchedEdited.nodes[id];
      return Boolean(current) && nodeValuesEqual(current, value);
    }) &&
    originalText.includes('原始嵌套旧轮行动（须隔离）') &&
    originalText.includes('原始嵌套旧轮回复（须隔离）') &&
    originalText.includes('嵌套续写回复二。') &&
    originalText === continuedText;
  const siblingIsolated =
    editedText.includes('嵌套历史改写') &&
    editedText.includes('嵌套历史改写回复。') &&
    !editedText.includes('原始嵌套旧轮行动（须隔离）') &&
    !editedText.includes('原始嵌套旧轮回复（须隔离）') &&
    !editedText.includes('嵌套续写回复二。') &&
    originalText.includes('原始嵌套旧轮行动（须隔离）') &&
    originalText.includes('原始嵌套旧轮回复（须隔离）') &&
    !originalText.includes('嵌套历史改写') &&
    !originalText.includes('嵌套历史改写回复。') &&
    finalReloaded?.activeLeafNodeId === editedLeafId &&
    nestedForbiddenFacts.every((fact) => !editedText.includes(fact) && !originalText.includes(fact));
  const editCalls = nestedModelCalls - modelCallsBeforeEdit;
  const oldTurnEdit: OfflineOldTurnEditResult = {
    entry: 'FictionHarness.editAndBranch',
    fixture: 'nested',
    execution: 'offline-pure-harness',
    transport: 'in-process-fake',
    modelCalls: editCalls,
    providerCalls: 0,
    reloadedAfterEdit: editedReloaded?.activeLeafNodeId === editedLeafId &&
      switchedOriginal.activeLeafNodeId === continuedLeafId,
    originalBranchPreserved,
    siblingIsolated,
    passed: editCalls === 1 && originalBranchPreserved && siblingIsolated,
  };

  const branchingScenario = generateExperimentScenario('branching', seed);
  const branchingRouteA = branchingScenario.routes[0];
  branchingScenario.nodes[branchingRouteA.leafId] = {
    ...branchingScenario.nodes[branchingRouteA.leafId],
    content: '原始分支重试回复（须隔离）。',
  };
  const branchingForbiddenFacts = branchingScenario.routes
    .filter((route) => route.id !== branchingRouteA.id)
    .flatMap((route) => [route.uniqueFact, route.characterState]);
  const retryStorage = createInMemoryStoryStorage();
  let retryNow = 1_766_000_000_000;
  let retrySequence = 0;
  let retryModelCalls = 0;
  const makeRetryHarness = () => createFictionHarness({
    transport: {
      async *streamChat() {
        retryModelCalls += 1;
        yield { contentDelta: '分支夹具重试回复。', finishReason: 'stop' };
      },
    },
    storage: retryStorage,
    contextBudget: { recentMaxNodes: 10_000, recentMaxChars: 10_000_000 },
    now: () => {
      retryNow += 1_000;
      return retryNow;
    },
    createId: () => `real-retry-${++retrySequence}`,
  });
  const retryHarness = makeRetryHarness();
  const branchingSaved = await retryHarness.saveStory(storyFromScenario(retryHarness, branchingScenario));
  const branchingActive = await retryHarness.setActiveStory(branchingSaved.id);
  if (!branchingActive) throw new Error('Branching retry fixture was not activated.');
  const originalReply = structuredClone(branchingActive.nodes[branchingRouteA.leafId]);
  const regenerated = await retryHarness.regenerateNode(
    branchingActive,
    branchingRouteA.leafId,
    OFFLINE_HARNESS_CONFIG,
  );
  const retryLeafId = regenerated.assistantNode.id;
  const retryReloadHarness = makeRetryHarness();
  const retryReloaded = await retryReloadHarness.loadActiveStory();
  const retryText = retryReloaded?.activeLeafNodeId
    ? getActiveBranchNodes(retryReloaded, retryReloaded.activeLeafNodeId)
        .map((node) => node.content)
        .join('\n')
    : '';
  const switchedOriginalReply = await retryReloadHarness.switchBranch(
    retryReloaded!,
    branchingRouteA.leafId,
  );
  const originalReplyReloadHarness = makeRetryHarness();
  const originalReplyReloaded = await originalReplyReloadHarness.loadActiveStory();
  const originalReplyText = originalReplyReloaded?.activeLeafNodeId
    ? getActiveBranchNodes(originalReplyReloaded, originalReplyReloaded.activeLeafNodeId)
        .map((node) => node.content)
        .join('\n')
    : '';
  const switchedRetry = await originalReplyReloadHarness.switchBranch(
    originalReplyReloaded!,
    retryLeafId,
  );
  const retryFinalReloadHarness = makeRetryHarness();
  const retryFinalReloaded = await retryFinalReloadHarness.loadActiveStory();
  const preservedRetryOriginal = switchedRetry.nodes[branchingRouteA.leafId];
  const originalReplyPreserved = Boolean(
    preservedRetryOriginal && nodeValuesEqual(preservedRetryOriginal, originalReply),
  );
  const retrySiblingIsolated =
    retryReloaded?.nodes[retryLeafId]?.parentId === originalReply.parentId &&
    retryText.includes('分支夹具重试回复。') &&
    !retryText.includes(originalReply.content) &&
    originalReplyText.includes(originalReply.content) &&
    !originalReplyText.includes('分支夹具重试回复。') &&
    switchedRetry.activeLeafNodeId === retryLeafId &&
    retryFinalReloaded?.activeLeafNodeId === retryLeafId &&
    branchingForbiddenFacts.every((fact) => !retryText.includes(fact) && !originalReplyText.includes(fact));
  const retry: OfflineRetryResult = {
    entry: 'FictionHarness.regenerateNode',
    fixture: 'branching',
    execution: 'offline-pure-harness',
    transport: 'in-process-fake',
    modelCalls: retryModelCalls,
    providerCalls: 0,
    reloadedAfterRetry: retryReloaded?.activeLeafNodeId === retryLeafId &&
      switchedOriginalReply.activeLeafNodeId === branchingRouteA.leafId,
    originalReplyPreserved,
    siblingIsolated: retrySiblingIsolated,
    passed: retryModelCalls === 1 && originalReplyPreserved && retrySiblingIsolated,
  };

  return {
    fixture: 'nested',
    continuationEntry: 'FictionHarness.runTurn',
    continuationModelCalls: modelCallsBeforeEdit,
    continuedTurns: 2,
    providerCalls: 0,
    reopenedAfterRestart,
    editedSiblingIsolated: oldTurnEdit.passed,
    oldTurnEdit,
    retry,
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
  const generationOperationIds = new Map<string, string>();
  const recordsByArm: Record<ContextExperimentArm, ContextExperimentRequestRecord[]> = {
    full: [],
    folio: [],
    retrievable: [],
  };
  const allRequests: OfflineSmokeReport['requests'] = [];
  let leakedRequests = 0;
  let checkedRequests = 0;
  let checkedGenerationRequests = 0;
  let checkedSummaryRequests = 0;
  let checkedRetryRequests = 0;
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
        checkedGenerationRequests += 1;
        if (hasForbiddenSiblingFact(messages, allowedIds, forbiddenFacts)) leakedRequests += 1;
        const sampleNumber = sceneTurn + 1;
        const usage = simulatedUsage(arm, messages, sampleNumber);
        const record: ContextExperimentRequestRecord = {
          requestId: `anonymous-${arm}-${scenario.spec.name}-${String(sampleNumber).padStart(2, '0')}`,
          phase: 'generation',
          status: 'completed',
          logicalTurnId: routed.logicalTurnId,
          transport: 'outbound-http',
          usage,
          visibleOutputCharCount: OFFLINE_VISIBLE_OUTPUT.generation.length,
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
          ...(context.policy === 'branch-retrieval'
            ? {
                retrievalNodeIds: context.retrievalNodeIds,
                retrievalScores: context.retrievalScores,
                recentNodeIds: context.recentNodeIds,
              }
            : {}),
          ...(context.summaryCoverage ? { summaryCoverage: context.summaryCoverage } : {}),
        });
        const generationOperationId = `${arm}-${scenario.spec.name}-${sceneTurn}`;
        plans.push({
          operationId: generationOperationId,
          attempt: 0,
          maxInputTokens: new TextEncoder().encode(messages.map((message) => message.content).join('\n')).length,
          maxOutputTokens: 512,
        });
        generationOperationIds.set(`${arm}\0${routed.logicalTurnId}`, generationOperationId);

        if (context.retrievalCount > 0) {
          const retrievalRecord: ContextExperimentRequestRecord = {
            requestId: `anonymous-${arm}-retrieval-${scenario.spec.name}-${String(sampleNumber).padStart(2, '0')}`,
            phase: 'retrieval',
            status: 'completed',
            logicalTurnId: routed.logicalTurnId,
            transport: 'local',
            usage: null,
            visibleOutputCharCount: null,
          };
          recordsByArm[arm].push(retrievalRecord);
          allRequests.push({
            ...retrievalRecord,
            arm,
            scenario: scenario.spec.name,
            contextPolicy: 'branch-retrieval',
            retrievalNodeIds: context.retrievalNodeIds,
            retrievalScores: context.retrievalScores,
            recentNodeIds: context.recentNodeIds,
          });
        }

        for (let summaryIndex = 0; summaryIndex < context.summaryRequests.length; summaryIndex += 1) {
          const summaryMessages = context.summaryRequests[summaryIndex];
          checkedRequests += 1;
          checkedSummaryRequests += 1;
          if (hasForbiddenSiblingFact(summaryMessages, allowedIds, forbiddenFacts)) leakedRequests += 1;
          const summaryUsage = simulatedUsage(arm, summaryMessages, sampleNumber, 32);
          const summaryRecord: ContextExperimentRequestRecord = {
            requestId: `anonymous-${arm}-summary-${scenario.spec.name}-${String(summaryIndex + 1).padStart(2, '0')}-${String(sampleNumber).padStart(2, '0')}`,
            phase: 'summary',
            status: 'completed',
            logicalTurnId: routed.logicalTurnId,
            transport: 'outbound-http',
            usage: summaryUsage,
            visibleOutputCharCount: OFFLINE_VISIBLE_OUTPUT.summary.length,
            firstContentLatencyMs: 700 + (sampleNumber * 19) % 600,
          };
          recordsByArm[arm].push(summaryRecord);
          allRequests.push({
            ...summaryRecord,
            arm,
            scenario: scenario.spec.name,
            inputCharCount: summaryMessages.reduce(
              (total, message) => total + message.content.length,
              0,
            ),
            messageCount: summaryMessages.length,
            contextPolicy: 'rolling-summary',
            contextFingerprint: contextFingerprint(summaryMessages),
          });
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
    const retryPath = getActiveBranchNodes(
      { nodes: scenarios[0].nodes, activeLeafNodeId: retryParentId },
      retryParentId,
    );
    const retryAllowedIds = new Set(retryPath.map((node) => node.id));
    const retryForbiddenFacts = scenarios[0].routes
      .filter((route) => route.id !== scenarios[0].routes[0].id)
      .flatMap((route) => [route.uniqueFact, route.characterState]);
    checkedRequests += 1;
    checkedRetryRequests += 1;
    if (hasForbiddenSiblingFact(retryMessages, retryAllowedIds, retryForbiddenFacts)) {
      leakedRequests += 1;
    }
    const retryUsage = simulatedUsage(arm, retryMessages, 30, 24);
    const retryLogicalTurnId = `continuous:turn-${retryTurnIndex + 1}`;
    const retryRecord: ContextExperimentRequestRecord = {
      requestId: `anonymous-${arm}-retry-001`,
      phase: 'retry',
      status: 'completed',
      logicalTurnId: retryLogicalTurnId,
      transport: 'outbound-http',
      usage: retryUsage,
      visibleOutputCharCount: OFFLINE_VISIBLE_OUTPUT.retry.length,
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
      ...(retryContext.policy === 'branch-retrieval'
        ? {
            retrievalNodeIds: retryContext.retrievalNodeIds,
            retrievalScores: retryContext.retrievalScores,
            recentNodeIds: retryContext.recentNodeIds,
          }
        : {}),
      ...(retryContext.summaryCoverage ? { summaryCoverage: retryContext.summaryCoverage } : {}),
    });
    const retryOperationId = generationOperationIds.get(`${arm}\0${retryLogicalTurnId}`);
    if (!retryOperationId) throw new Error(`Missing generation plan for retry turn ${retryLogicalTurnId}.`);
    plans.push({
      operationId: retryOperationId,
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

  const groupInputs = Object.fromEntries(
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
      return [arm, group];
    }),
  ) as Record<ContextExperimentArm, ContextExperimentGroup>;
  const groups = Object.fromEntries(
    (['full', 'folio', 'retrievable'] as const).map((arm) => [
      arm,
      summarizeContextExperiment(groupInputs[arm]),
    ]),
  ) as Record<ContextExperimentArm, ContextExperimentSummary>;

  return {
    schemaVersion: 5,
    mode: 'offline-simulated',
    generatedAt: new Date(now()).toISOString(),
    providerRuns: 0,
    credentialStatus: 'not-read',
    groups,
    comparisons: {
      fullToRetrievable: estimateContextSavings(groups.full, groups.retrievable),
      folioToRetrievable: estimateContextSavings(groups.folio, groups.retrievable),
    },
    rangeSubsets: {
      fullToRetrievable: compareContextExperimentRangeSubset(
        groupInputs.full,
        groupInputs.retrievable,
        groups.full,
        groups.retrievable,
      ),
      folioToRetrievable: compareContextExperimentRangeSubset(
        groupInputs.folio,
        groupInputs.retrievable,
        groups.folio,
        groups.retrievable,
      ),
    },
    branchIsolation: {
      checkedRequests,
      checkedGenerationRequests,
      checkedSummaryRequests,
      checkedRetryRequests,
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
      'Latency percentiles use deterministic offline timestamps for completed logical generation/retry attempts and cannot establish provider latency.',
      'It cannot establish quality, real prefix-cache behavior, or API savings.',
      'No DeepSeek credential was read and no funded request was sent.',
    ],
  };
}

export interface BranchRetrievalResult {
  pathNodeIds: string[];
  selected: TurnNode[];
  scores: number[];
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
  excludeNodeIds: ReadonlySet<string> = new Set(),
): BranchRetrievalResult {
  const branchNodes = getActiveBranchNodes({ nodes, activeLeafNodeId: targetLeafId }, targetLeafId);
  const terms = normalizedTerms(query);
  const pathIndex = new Map(branchNodes.map((node, index) => [node.id, index]));
  const selected = branchNodes
    .map((node) => ({ node, score: scoreNode(node, terms) }))
    .filter((entry) => entry.score > 0 && !excludeNodeIds.has(entry.node.id))
    .sort((left, right) => right.score - left.score || right.node.createdAt - left.node.createdAt)
    .slice(0, Math.max(0, Math.floor(limit)))
    .sort((left, right) => (pathIndex.get(left.node.id) ?? 0) - (pathIndex.get(right.node.id) ?? 0))
    .map((entry) => entry.node);

  return {
    pathNodeIds: branchNodes.map((node) => node.id),
    selected,
    scores: selected.map((node) => scoreNode(node, terms)),
  };
}
