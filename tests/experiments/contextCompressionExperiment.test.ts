import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EMPTY_SUMMARY_SNAPSHOT, getActiveBranchNodes, type TurnNode } from '../../src/harness/index.ts';
import {
  buildRetrievableExperimentContext,
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
  it('keeps the committed offline evidence identical to a deterministic replay', async () => {
    const generatedAt = Date.parse('2026-11-23T00:00:00+08:00');
    const report = await runOfflineSmoke({ seed: 20261123, now: () => generatedAt });
    const committed = JSON.parse(await readFile(
      new URL('../../experiments/context-compression/evidence/offline-smoke.json', import.meta.url),
      'utf8',
    ));

    expect(committed).toEqual(report);
  });

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
    expect(branchA.scores).toHaveLength(3);
    expect(branchA.scores.every((score) => score > 0)).toBe(true);
    expect(branchAText).toContain('青铜钥匙');
    expect(branchAText).toContain('甲线林舟');
    expect(branchAText).not.toContain('乙线');
    expect(branchBText).toContain('青铜钥匙');
    expect(branchBText).toContain('乙线林舟');
    expect(branchBText).not.toContain('甲线');

    expect(retrieveFromActiveBranch(nodes, 'aReply', '不存在的线索', 3).selected).toEqual([]);
    const excludingRecent = retrieveFromActiveBranch(
      nodes,
      'aReply',
      '钥匙 林舟',
      3,
      new Set(['root', 'a', 'aReply']),
    );
    expect(excludingRecent.selected).toEqual([]);
    expect(excludingRecent.scores.every((score) => score > 0)).toBe(true);
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
      expect(new Set(scenario.routes.map((route) => route.characterState)).size).toBe(expected.routes);
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
        const context = buildRetrievableExperimentContext(
          scenario,
          probe.leafId,
          probe.query,
        );
        const retrieved = context.messages
          .filter((message) => message.content.startsWith('按需回取'))
          .map((message) => message.content)
          .join('\n');
        expect(context.retrievalNodeIds.length).toBeGreaterThan(0);
        expect(context.retrievalScores).toHaveLength(context.retrievalNodeIds.length);
        expect(context.retrievalScores.every((score) => score > 0)).toBe(true);
        expect(context.retrievalNodeIds.every(
          (nodeId) => !context.recentNodeIds.includes(nodeId),
        )).toBe(true);
        for (const fact of probe.expectedFacts) {
          expect(probe.query).not.toContain(fact);
          expect(retrieved).toContain(fact);
        }
        for (const fact of probe.forbiddenFacts) {
          expect(probe.query).not.toContain(fact);
          expect(retrieved).not.toContain(fact);
        }
      }
    }

    expect(generateExperimentScenario('continuous', 1).actions).not.toEqual(
      generateExperimentScenario('continuous', 2).actions,
    );
  });

  it('runs the 30-turn three-arm smoke offline with anonymous usage, counted background calls, and no cost claim', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });

    expect(report.schemaVersion).toBe(5);
    expect(report.mode).toBe('offline-simulated');
    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      expect(report.groups[arm].effectiveTurns).toBe(30);
      expect(report.groups[arm].provider).toBe('offline-simulated');
      expect(report.groups[arm].records).toBeGreaterThanOrEqual(30);
      expect(report.groups[arm].completedTurnIds).toHaveLength(30);
    }
    expect(report.groups.full.completedTurnIds).toEqual(report.groups.retrievable.completedTurnIds);
    expect(report.groups.folio.records).toBeGreaterThan(report.groups.folio.effectiveTurns);
    expect(report.comparisons.fullToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
    });
    expect(report.comparisons.folioToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
    });
    expect(report.rangeSubsets.fullToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
      baselineRange: { completedTurnCount: 30 },
      candidateRange: { completedTurnCount: 30 },
      subsetRange: { completedTurnCount: 30 },
    });
    expect(report.rangeSubsets.folioToRetrievable).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
      baselineRange: { completedTurnCount: 30 },
      candidateRange: { completedTurnCount: 30 },
      subsetRange: { completedTurnCount: 30 },
    });
    expect(report.branchIsolation).toMatchObject({
      checkedRequests: 123,
      checkedGenerationRequests: 90,
      checkedSummaryRequests: 30,
      checkedRetryRequests: 3,
      leakedRequests: 0,
      passed: true,
    });
    expect(report.branchLifecycle).toMatchObject({
      continuedTurns: 2,
      reopenedAfterRestart: true,
      editedSiblingIsolated: true,
    });
    expect(report.officialPreflight).toMatchObject({
      ok: true,
      violations: [],
      budget: {
        maxRequests: 128,
        maxRetriesPerOperation: 1,
        maxInputTokensPerRequest: 256_000,
        maxOutputTokensPerRequest: 512,
        maxTotalCostUsd: 0.25,
        concurrency: 1,
      },
    });
    expect(report.officialPreflight.maxEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.officialPreflight.requestCount).toBe(123);
    const outboundRecords = report.requests.filter((record) => record.transport === 'outbound-http');
    const localRetrievalRecords = report.requests.filter((record) => record.transport === 'local');
    expect(report.officialPreflight.requestCount).toBe(outboundRecords.length);
    expect(localRetrievalRecords).toHaveLength(30);
    expect(localRetrievalRecords.every((record) => record.phase === 'retrieval')).toBe(true);
    expect(localRetrievalRecords.every((record) => record.usage === null)).toBe(true);
    for (const record of localRetrievalRecords) {
      expect(record.retrievalNodeIds?.length).toBeGreaterThan(0);
      expect(record.retrievalScores).toHaveLength(record.retrievalNodeIds!.length);
      expect(record.retrievalScores?.every((score) => score > 0)).toBe(true);
      expect(record.retrievalNodeIds?.every(
        (nodeId) => !record.recentNodeIds?.includes(nodeId),
      )).toBe(true);
    }
    expect(report.groups.retrievable.missingUsageRecords).toBe(0);
    expect(outboundRecords.every((record) => (record.visibleOutputCharCount ?? 0) > 0)).toBe(true);
    expect(report.requests.every((record) => !Object.hasOwn(record, 'content'))).toBe(true);

    const continuousReplay = report.requests.filter(
      (record) =>
        record.arm === 'full' &&
        record.scenario === 'continuous' &&
        record.phase === 'generation',
    );
    expect(continuousReplay.map((record) => record.logicalTurnId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `continuous:turn-${291 + index}`),
    );
    expect(continuousReplay.map((record) => record.inputNodeCount)).toEqual(
      Array.from({ length: 10 }, (_, index) => 580 + index * 2),
    );
    for (const record of continuousReplay) {
      const targetTurn = Number(record.logicalTurnId?.match(/:turn-(\d+)$/)?.[1]);
      expect(record.inputTailNodeId).toBe(`turn-${targetTurn - 1}-a`);
    }
  });

  it('keeps offline Folio summary coverage contiguous and retains the shared retrieval probes', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });
    const probes = (['continuous', 'branching', 'nested'] as const)
      .flatMap((scenario) => generateExperimentScenario(scenario, 20261123).probes);

    expect(report.schemaVersion).toBe(5);
    expect(report.folioSummaryPolicy).toMatchObject({
      simulation: 'deterministic-offline',
      policy: 'production-selectNodesToSummarize-with-rolling-batches',
      contextsChecked: 30,
      coverageViolations: 0,
      sharedProbeCount: probes.length,
      passed: true,
    });
    expect(report.folioSummaryPolicy.simulatedSummaryRequests).toBeGreaterThan(0);

    const backgroundSummaryRecords = report.requests.filter((record) => record.phase === 'summary');
    expect(backgroundSummaryRecords).toHaveLength(30);
    for (const record of backgroundSummaryRecords) {
      expect(record).toMatchObject({
        arm: 'folio',
        transport: 'outbound-http',
        contextPolicy: 'rolling-summary',
        inputCharCount: expect.any(Number),
        messageCount: expect.any(Number),
        visibleOutputCharCount: expect.any(Number),
      });
      expect(record.contextFingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(record.inputCharCount).toBeGreaterThan(0);
      expect(record.messageCount).toBeGreaterThan(0);
      expect(record.visibleOutputCharCount).toBeGreaterThan(0);
    }

    const folioContexts = report.requests.filter(
      (record) =>
        record.arm === 'folio' &&
        (record.phase === 'generation' || record.phase === 'retry'),
    );
    for (const record of folioContexts) {
      expect(record.contextPolicy).toBe('rolling-summary');
      expect(record.summaryCoverage).toBeDefined();
      const coverage = record.summaryCoverage!;
      expect(coverage.contiguous).toBe(true);
      expect(coverage.coveredNodeCount + coverage.uncoveredNodeCount).toBe(record.inputNodeCount);
      expect(coverage.coveredNodeCount).toBeLessThanOrEqual(record.inputNodeCount!);
    }
  });

  it('uses each arm policy for retry instead of replaying the full-history payload', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });
    const expectedPolicies = {
      full: 'full-history',
      folio: 'rolling-summary',
      retrievable: 'branch-retrieval',
    } as const;
    const retryFingerprints: string[] = [];

    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      const retry = report.requests.find(
        (record) => record.arm === arm && record.phase === 'retry',
      );
      const generation = report.requests.find(
        (record) =>
          record.arm === arm &&
          record.scenario === 'continuous' &&
          record.phase === 'generation' &&
          record.logicalTurnId === retry?.logicalTurnId,
      );

      expect(retry?.contextPolicy).toBe(expectedPolicies[arm]);
      expect(retry?.contextFingerprint).toBe(generation?.contextFingerprint);
      expect(retry?.inputCharCount).toBe(generation?.inputCharCount);
      expect(retry?.messageCount).toBe(generation?.messageCount);
      expect(retry?.contextFingerprint).toMatch(/^[0-9a-f]{8}$/);
      retryFingerprints.push(retry!.contextFingerprint!);

      if (arm === 'folio') {
        expect(retry?.summaryCoverage).toMatchObject({
          contiguous: true,
          coveredNodeCount: expect.any(Number),
          uncoveredNodeCount: expect.any(Number),
        });
      }
    }

    expect(new Set(retryFingerprints).size).toBe(3);
  });

  it('exercises and measures A/B/A and A/B/C route returns through the pure Harness branch switcher', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });
    const [routeA, routeB, routeC] = generateExperimentScenario('branching', 20261123).routes;

    expect(report.routeReturns.aToBToA).toMatchObject({
      steps: ['A', 'B', 'A'],
      routeIds: [routeA.id, routeB.id, routeA.id],
      switchCount: 3,
      returnedPathIdentical: true,
      passed: true,
    });
    expect(report.routeReturns.aToBToC).toMatchObject({
      steps: ['A', 'B', 'C'],
      routeIds: [routeA.id, routeB.id, routeC.id],
      switchCount: 3,
      passed: true,
    });

    for (const traversal of [report.routeReturns.aToBToA, report.routeReturns.aToBToC]) {
      expect(traversal.measurements).toHaveLength(3);
      for (const measurement of traversal.measurements) {
        expect(measurement.pathNodeCount).toBeGreaterThan(0);
        expect(measurement.contextEstimatedTokens).toBeGreaterThan(0);
        expect(measurement.uniqueFactPresent).toBe(true);
        expect(measurement.foreignRouteFactCount).toBe(0);
      }
    }
  });

  it('uses real Harness lifecycle methods with reload and sibling-isolation checks', async () => {
    const report = await runOfflineSmoke({ seed: 20261123, now: () => 1_765_000_000_000 });

    expect(report.branchLifecycle).toMatchObject({
      fixture: 'nested',
      continuationEntry: 'FictionHarness.runTurn',
      continuationModelCalls: 2,
      continuedTurns: 2,
      providerCalls: 0,
      reopenedAfterRestart: true,
      editedSiblingIsolated: true,
    });
    expect(report.branchLifecycle.oldTurnEdit).toEqual({
      entry: 'FictionHarness.editAndBranch',
      fixture: 'nested',
      execution: 'offline-pure-harness',
      transport: 'in-process-fake',
      modelCalls: 1,
      providerCalls: 0,
      reloadedAfterEdit: true,
      originalBranchPreserved: true,
      siblingIsolated: true,
      passed: true,
    });
    expect(report.branchLifecycle.retry).toEqual({
      entry: 'FictionHarness.regenerateNode',
      fixture: 'branching',
      execution: 'offline-pure-harness',
      transport: 'in-process-fake',
      modelCalls: 1,
      providerCalls: 0,
      reloadedAfterRetry: true,
      originalReplyPreserved: true,
      siblingIsolated: true,
      passed: true,
    });
    expect(report.branchLifecycle.editedSiblingIsolated).toBe(true);
  });
});
