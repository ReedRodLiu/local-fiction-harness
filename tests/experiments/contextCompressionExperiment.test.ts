import { describe, expect, it } from 'vitest';
import { EMPTY_SUMMARY_SNAPSHOT, getActiveBranchNodes, type TurnNode } from '../../src/harness/index.ts';
import {
  generateExperimentScenario,
  retrieveFromActiveBranch,
  runOfflineSmoke,
} from '../../experiments/context-compression/experiment.ts';

function node(
  id: string,
  parentId: string | null,
  role: TurnNode['role'],
  content: string,
  createdAt: number,
): TurnNode {
  return { id, parentId, role, content, createdAt, summarySnapshot: EMPTY_SUMMARY_SNAPSHOT };
}

describe('branch-safe context retrieval', () => {
  it('retrieves shared ancestors and current-branch facts without leaking sibling branches', () => {
    const nodes: Record<string, TurnNode> = {
      root: node('root', null, 'assistant', '共同伏笔：青铜钥匙藏在钟楼。', 1),
      a: node('a', 'root', 'user', '林舟在甲线守门，钥匙交给妹妹。', 2),
      aReply: node('aReply', 'a', 'assistant', '甲线林舟把钥匙挂在窗前。', 3),
      b: node('b', 'root', 'user', '林舟在乙线背叛众人，钥匙锁进枯井。', 4),
      bReply: node('bReply', 'b', 'assistant', '乙线林舟烧毁了钟楼地图。', 5),
    };

    const branchA = retrieveFromActiveBranch(nodes, 'aReply', '钥匙 林舟', 3);
    const branchB = retrieveFromActiveBranch(nodes, 'bReply', '钥匙 林舟', 3);
    const branchAText = branchA.selected.map((entry) => entry.content).join('\n');
    const branchBText = branchB.selected.map((entry) => entry.content).join('\n');

    expect(branchA.pathNodeIds).toEqual(['root', 'a', 'aReply']);
    expect(branchAText).toContain('青铜钥匙');
    expect(branchAText).toContain('甲线林舟');
    expect(branchAText).not.toContain('乙线');
    expect(branchBText).toContain('青铜钥匙');
    expect(branchBText).toContain('乙线林舟');
    expect(branchBText).not.toContain('甲线');
  });

  it('generates the required deterministic short-action branch matrix with isolated probe facts', () => {
    const cases = [
      { name: 'continuous' as const, turns: 300, routes: 1, minDepth: 1 },
      { name: 'branching' as const, turns: 500, routes: 20, minDepth: 2 },
      { name: 'nested' as const, turns: 1000, routes: 50, minDepth: 3 },
    ];

    for (const expected of cases) {
      const scenario = generateExperimentScenario(expected.name, 20261123);
      expect(generateExperimentScenario(expected.name, 20261123).actions).toEqual(scenario.actions);
      expect(scenario.spec.turns).toBe(expected.turns);
      expect(scenario.spec.routes).toBe(expected.routes);
      expect(scenario.spec.minDepth).toBe(expected.minDepth);
      expect(scenario.turns).toBe(expected.turns);
      expect(scenario.routes).toHaveLength(expected.routes);
      expect(scenario.maxRouteDepth).toBeGreaterThanOrEqual(expected.minDepth);
      for (const route of scenario.routes) {
        const pathActionIndexes = getActiveBranchNodes(
          { nodes: scenario.nodes, activeLeafNodeId: route.leafId },
          route.leafId,
        )
          .filter((node) => node.role === 'user')
          .map((node) => Number(node.id.match(/^turn-(\d+)-u$/)?.[1]) - 1);
        expect(route.actionIndexes).toEqual(pathActionIndexes);
      }

      const shortActions = scenario.routes
        .flatMap((route) => route.actionIndexes)
        .map((index) => scenario.actions[index])
        .filter((action) => {
          const han = action.match(/\p{Script=Han}/gu)?.length ?? 0;
          return han >= 1 && han <= 15;
        });
      expect(shortActions.length / scenario.actions.length).toBeGreaterThanOrEqual(0.8);

      for (const probe of scenario.probes) {
        const retrieval = retrieveFromActiveBranch(scenario.nodes, probe.leafId, probe.query, 4);
        const retrieved = retrieval.selected.map((entry) => entry.content).join('\n');
        for (const fact of probe.expectedFacts) expect(retrieved).toContain(fact);
        for (const fact of probe.forbiddenFacts) expect(retrieved).not.toContain(fact);
      }
    }

    expect(generateExperimentScenario('continuous', 1).actions).not.toEqual(
      generateExperimentScenario('continuous', 2).actions,
    );
  });

  it('runs the 30-turn three-arm smoke offline with anonymous usage, counted background calls, and no cost claim', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });

    expect(report.mode).toBe('offline-simulated');
    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      expect(report.groups[arm].effectiveTurns).toBe(30);
      expect(report.groups[arm].provider).toBe('offline-simulated');
      expect(report.groups[arm].records).toBeGreaterThanOrEqual(30);
    }
    expect(report.groups.folio.records).toBeGreaterThan(report.groups.folio.effectiveTurns);
    expect(report.comparisons.fullToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
    });
    expect(report.comparisons.folioToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
    });
    expect(report.branchIsolation).toMatchObject({ checkedRequests: 90, leakedRequests: 0, passed: true });
    expect(report.branchLifecycle).toMatchObject({
      continuedTurns: 2,
      reopenedAfterRestart: true,
      editedSiblingIsolated: true,
    });
    expect(report.officialPreflight).toMatchObject({
      ok: true,
      violations: [],
      budget: {
        maxRequests: 120,
        maxRetriesPerOperation: 1,
        maxInputTokensPerRequest: 256_000,
        maxOutputTokensPerRequest: 512,
        maxTotalCostUsd: 0.25,
        concurrency: 1,
      },
    });
    expect(report.officialPreflight.maxEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.requests.every((record) => !Object.hasOwn(record, 'content'))).toBe(true);
  });
});
