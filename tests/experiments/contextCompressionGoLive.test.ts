import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GO_EXPERIMENT_SETTINGS,
  GO_CHAT_ENDPOINT,
  GO_MODEL,
  GO_USER_AGENT,
  GO_USAGE_ENDPOINT,
  runGoExperiment,
  type GoFetch,
  type GoFetchResponse,
  type LiveArm,
} from '../../experiments/context-compression/live.ts';

function streamResponse(text: string): GoFetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(text);
      },
    },
    async text() {
      return text;
    },
  };
}

function usageResponse(percent = 10): GoFetchResponse {
  const body = JSON.stringify({
    usage: {
      rolling: { status: 'ok', percent, resetsAt: '2026-11-23T12:00:00.000Z' },
      weekly: { status: 'ok', percent: 13, resetsAt: '2026-11-30T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 6, resetsAt: '2026-12-01T00:00:00.000Z' },
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: null,
    async text() {
      return body;
    },
  };
}

function jsonResponse(status: number, body: unknown): GoFetchResponse {
  const text = JSON.stringify(body);
  return {
    ok: false,
    status,
    statusText: 'Failure',
    body: null,
    async text() {
      return text;
    },
  };
}

function routeAnswer(messages: Array<{ role: string; content: string }>): string {
  const serialized = messages.map((message) => message.content).join('\n');
  const matches = [...serialized.matchAll(/当前路线为(route-\d+)。路线独有银印是([^。]+)。当前路线沈砚状态：(.+?)。只沿这条路线继续。/g)];
  const match = matches.at(-1);
  if (!match) return '无法确认当前路线。';
  return `银印：${match[2]}；${match[3]}`;
}

function sseCompletion(content: string, options: {
  finishReason?: string;
  usage?: boolean;
  refusal?: string;
  allowance?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number | null;
  listCost?: number | null;
  responseModel?: string | null;
  systemFingerprint?: string | null;
} = {}): string {
  const finishReason = options.finishReason ?? 'stop';
  const delta = options.refusal
    ? { refusal: options.refusal }
    : { content };
  const responseModel = options.responseModel === undefined ? GO_MODEL : options.responseModel;
  const systemFingerprint = options.systemFingerprint === undefined ? 'fp_mock_go' : options.systemFingerprint;
  const cost = options.cost === undefined ? 0 : options.cost;
  const listCost = options.listCost === undefined ? 0.00001 : options.listCost;
  const finalEvent = {
    ...(responseModel === null ? {} : { model: responseModel }),
    ...(systemFingerprint === null ? {} : { system_fingerprint: systemFingerprint }),
    choices: [{ delta: {}, finish_reason: finishReason }],
    ...(options.usage === false ? {} : {
      usage: {
        prompt_tokens: options.promptTokens ?? 120,
        completion_tokens: options.completionTokens ?? 20,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 7 },
        ...(cost === null ? {} : { cost }),
        opencode: {
          billing_source: 'go',
          ...(listCost === null ? {} : { list_cost: listCost }),
          allowance: options.allowance ?? 0.0001,
          tokens: {
            input: options.promptTokens ?? 120,
            output: options.completionTokens ?? 20,
            reasoning: 7,
            cache_read: 80,
            cache_write_5m: 0,
            cache_write_1h: 0,
          },
        },
      },
    }),
  };
  return [
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n`,
    `data: ${JSON.stringify(finalEvent)}\n`,
    'data: [DONE]\n',
    '',
  ].join('\n');
}

function createFetch(mockOptions: {
  contentFilterArm?: LiveArm;
  truncateArm?: LiveArm;
  omitUsageArm?: LiveArm;
  refuseFirstSummaryArm?: LiveArm;
  truncateFirstProbeArm?: LiveArm;
  includeForbiddenProbeMarkerArm?: LiveArm;
  responseModel?: string | null;
  systemFingerprint?: string | null;
  actualAllowance?: number;
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
  cost?: number | null;
  listCost?: number | null;
} = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  let completionNumber = 0;
  const summaryCalls: Record<LiveArm, number> = { full: 0, folio: 0, retrievable: 0 };
  const probeCalls: Record<LiveArm, number> = { full: 0, folio: 0, retrievable: 0 };
  const fetchImpl: GoFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, headers: init.headers, body });
    if (url === GO_USAGE_ENDPOINT) return usageResponse();
    if (url !== GO_CHAT_ENDPOINT) throw new Error(`Unexpected URL ${url}`);
    const messages = body?.messages as Array<{ role: string; content: string }>;
    const session = init.headers['x-opencode-session'];
    const arm = session.includes('_full_r') ? 'full' : session.includes('_folio_r') ? 'folio' : 'retrievable';
    const isSummary = messages.some((message) => message.content.includes('剧情摘要压缩'));
    const isProbe = messages.at(-1)?.content.includes('保持当前路线') ?? false;
    const completionOptions = {
      responseModel: mockOptions.responseModel,
      systemFingerprint: mockOptions.systemFingerprint,
      allowance: mockOptions.actualAllowance,
      promptTokens: mockOptions.actualPromptTokens,
      completionTokens: mockOptions.actualCompletionTokens,
      cost: mockOptions.cost,
      listCost: mockOptions.listCost,
    };
    if (isSummary) {
      const routeFact = routeAnswer(messages);
      if (arm === mockOptions.refuseFirstSummaryArm && ++summaryCalls[arm] === 1) {
        return streamResponse(sseCompletion('', { ...completionOptions, finishReason: 'content_filter', refusal: '摘要拒绝。' }));
      }
      return streamResponse(sseCompletion(
        routeFact.startsWith('无法确认') ? `摘要${++completionNumber}` : routeFact,
        completionOptions,
      ));
    }
    if (isProbe) {
      const leakedMarker = arm === mockOptions.includeForbiddenProbeMarkerArm
        ? '；路线标记[route-02/衣物]=灰呢长衫，领口别着一截黑羽'
        : '';
      if (arm === mockOptions.truncateFirstProbeArm && ++probeCalls[arm] === 1) {
        return streamResponse(sseCompletion(`${routeAnswer(messages)}${leakedMarker}`, {
          ...completionOptions,
          finishReason: 'length',
        }));
      }
      return streamResponse(sseCompletion(`${routeAnswer(messages)}${leakedMarker}`, completionOptions));
    }
    const usage = arm !== mockOptions.omitUsageArm;
    if (arm === mockOptions.contentFilterArm) {
      return streamResponse(sseCompletion('', { finishReason: 'content_filter', refusal: '无法继续。', usage }));
    }
    if (arm === mockOptions.truncateArm) {
      return streamResponse(sseCompletion('被截断的部分正文', { finishReason: 'length', usage }));
    }
    return streamResponse(sseCompletion(`生成回复-${++completionNumber}`, { ...completionOptions, usage }));
  };
  return { fetch: fetchImpl, calls };
}

function settings(overrides: Partial<typeof DEFAULT_GO_EXPERIMENT_SETTINGS> = {}) {
  return {
    ...DEFAULT_GO_EXPERIMENT_SETTINGS,
    order: ['full', 'folio', 'retrievable'] as LiveArm[],
    cadenceMs: 0,
    ...overrides,
  };
}

function sessionIds() {
  return {
    full: 'ses_test_full',
    folio: 'ses_test_folio',
    retrievable: 'ses_test_retrievable',
  } as const;
}

describe('OpenCode Go context-compression experiment', () => {
  it('runs a mocked 30-turn/arm staged experiment with natural outputs, summaries, branches, probes, and allowance evidence', async () => {
    const mock = createFetch();
    let checkpointCount = 0;
    let checkpointText = '';
    const state = await runGoExperiment({
      apiKey: 'test-key-never-persisted',
      runId: 'mock-run',
      sessionIds: sessionIds(),
      fetch: mock.fetch,
      settings: settings({ turns: 30, maxRequests: 220 }),
      async onCheckpoint(nextState) {
        checkpointCount += 1;
        checkpointText = JSON.stringify(nextState);
      },
    });

    expect(state.status).toBe('completed');
    expect(state.schemaVersion).toBe(2);
    expect(checkpointCount).toBeGreaterThan(90);
    expect(checkpointText).not.toContain('test-key-never-persisted');
    expect(state.usagePreflight?.monthly?.percent).toBe(6);
    expect(state.summary?.usd).toEqual({
      status: 'reported-separately',
      planAllowance: { unit: 'go-allowance', notBalanceCharge: true },
      listCost: { source: 'opencode.list_cost' },
      charged: { source: 'usage.cost' },
    });
    expect(state.summary?.commonRange.logicalTurnKeys).toHaveLength(30);
    expect(state.summary?.commonRange.logicalTurnKeys[0]).toEqual({ repetition: 0, logicalTurnId: 'turn-01' });
    expect(state.summary?.commonRange.byArm.full.phaseCounts).toEqual({ generation: 30, summary: 0, probe: 4 });
    expect(state.summary?.commonRange.byArm.full.billedPhaseCounts).toEqual({ generation: 30, summary: 0, probe: 4 });
    expect(state.summary?.commonRange.byArm.folio.phaseCounts.summary).toBeGreaterThan(0);
    expect(state.summary?.commonRange.byArm.folio.billedPhaseCounts.summary)
      .toBe(state.summary?.commonRange.byArm.folio.phaseCounts.summary);
    expect(state.summary?.commonRange.byArm.retrievable.phaseCounts.probe).toBe(4);
    expect(state.summary?.commonRange.byArm.full.billedRequests).toBe(34);
    expect(state.summary?.byArm.full.coreStatus).toBe('completed');
    expect(state.summary?.byArm.full.summaryStatus).toBe('not-required');
    expect(state.summary?.byArm.full.probeStatus).toBe('completed');
    expect(state.summary?.byArm.full.completedTurns).toBe(30);
    expect(state.summary?.byArm.folio.completedTurns).toBe(30);
    expect(state.summary?.byArm.retrievable.completedTurns).toBe(30);
    expect(state.summary?.byArm.folio.requestCounts.summary).toBeGreaterThan(0);
    expect(state.summary?.byArm.full.probesTotal).toBe(4);
    expect(state.summary?.byArm.full.probesPassed).toBe(4);
    expect(state.summary?.byArm.folio.probesTotal).toBe(4);
    expect(state.summary?.byArm.retrievable.probesPassed).toBeGreaterThan(0);
    expect(state.summary?.byArm.full.planAllowanceUsed).toBeCloseTo(0.0034, 6);
    expect(state.summary?.byArm.full.listCostUsd).toBeCloseTo(34 * 0.00001, 8);
    expect(state.summary?.byArm.full.chargedUsd).toBe(0);
    expect(state.summary?.byArm.full.tokenTotals.cacheRead).toBe(34 * 80);
    expect(state.summary?.byArm.full.generationTokenTotals.cacheRead).toBe(30 * 80);

    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      const generationRecords = state.records.filter((record) => record.arm === arm && record.phase === 'generation');
      expect(generationRecords).toHaveLength(30);
      expect(generationRecords.filter((record) => record.status === 'completed')).toHaveLength(30);
      expect(generationRecords.filter((record) => record.branchSwitch)).toHaveLength(3);
      expect(new Set(generationRecords.map((record) => record.logicalTurnId)).size).toBe(30);
    }
    expect(state.records.every((record) => record.responseModel === GO_MODEL)).toBe(true);
    expect(state.records.every((record) => record.systemFingerprint === 'fp_mock_go')).toBe(true);
    expect(state.records.every((record) => record.estimatedListCostUsdUpperBound > 0)).toBe(true);
    expect(state.records[0].usage).toMatchObject({ chargedUsd: 0, listCostUsd: 0.00001, allowance: 0.0001 });

    const armState = state.repetitions[0].arms.full;
    expect(armState.generatedOutputs).toHaveLength(30);
    expect(new Set(armState.generatedOutputs.map((output) => output.assistant)).size).toBeGreaterThan(25);

    const chatCalls = mock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT);
    expect(chatCalls.some((call) => {
      const messages = call.body?.messages as Array<{ content: string }>;
      const query = messages.at(-1)?.content ?? '';
      return ['路线独有银印', '衣物', '左手', '随身物'].every((label) => query.includes(label));
    })).toBe(true);
    expect(chatCalls.every((call) => call.headers['User-Agent'] === GO_USER_AGENT)).toBe(true);
    expect(chatCalls.every((call) => call.body?.model === GO_MODEL)).toBe(true);
    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      expect(chatCalls.filter((call) => call.headers['x-opencode-session'].includes(`_${arm}_r0`)).length).toBeGreaterThan(30);
    }

    const lastByRoute = new Map<string, string>();
    for (const output of armState.generatedOutputs) {
      const priorAssistant = lastByRoute.get(output.routeId);
      if (priorAssistant) expect(output.parentId).toBe(priorAssistant);
      lastByRoute.set(output.routeId, output.assistantNodeId);
    }
  });

  it('records provider refusal and truncation without appending incomplete natural output', async () => {
    const mock = createFetch({ contentFilterArm: 'retrievable', truncateArm: 'folio' });
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-stop-reasons',
      sessionIds: sessionIds(),
      fetch: mock.fetch,
      settings: settings({ turns: 1 }),
    });

    expect(state.status).toBe('incomplete');
    expect(state.summary?.byArm.retrievable.refusalCount).toBe(1);
    expect(state.summary?.byArm.folio.truncationCount).toBe(1);
    expect(state.repetitions[0].arms.folio.generatedOutputs).toHaveLength(0);
    expect(state.repetitions[0].arms.retrievable.generatedOutputs).toHaveLength(0);
    expect(state.records.find((record) => record.arm === 'retrievable')?.refusal).toBe('无法继续。');
    expect(state.records.find((record) => record.arm === 'folio')?.truncated).toBe(true);
    expect(state.records.find((record) => record.arm === 'retrievable')?.usage?.allowance).toBe(0.0001);
    expect(state.records.find((record) => record.arm === 'folio')?.usage?.allowance).toBe(0.0001);
    expect(state.summary?.commonRange.logicalTurnKeys).toEqual([]);
    expect(state.summary?.comparisons.fullToRetrievable.promptTokenDelta).toBeNull();
    expect(state.summary?.comparisons.folioToRetrievable.planAllowanceDelta).toBeNull();
    expect(state.summary?.comparisons.folioToRetrievable.listCostUsdDelta).toBeNull();
    expect(state.summary?.comparisons.folioToRetrievable.chargedUsdDelta).toBeNull();
  });

  it('keeps core, summary, probe, quality, and request completion status separate', async () => {
    const mock = createFetch({
      refuseFirstSummaryArm: 'folio',
      truncateFirstProbeArm: 'full',
    });
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-phase-status',
      sessionIds: sessionIds(),
      fetch: mock.fetch,
      settings: settings({ turns: 30, maxRequests: 220 }),
    });

    expect(state.status).toBe('incomplete');
    expect(state.repetitions[0].arms.folio).toMatchObject({
      status: 'incomplete',
      incompletePhases: ['summary'],
    });
    expect(state.repetitions[0].arms.full).toMatchObject({
      status: 'incomplete',
      incompletePhases: ['probe'],
    });
    expect(state.summary?.byArm.full).toMatchObject({
      coreStatus: 'completed',
      summaryStatus: 'not-required',
      probeStatus: 'incomplete',
      qualityStatus: 'incomplete',
      probesExpected: 4,
      probesTotal: 4,
      probesScored: 3,
      probesPassed: 3,
      probesIncorrect: 0,
      probesIncomplete: 1,
    });
    expect(state.summary?.byArm.folio.summaryStatus).toBe('incomplete');
    expect(state.summary?.byArm.folio.phaseRequestStatusCounts.summary.refused).toBe(1);
    expect(state.summary?.byArm.full.phaseRequestStatusCounts.probe.truncated).toBe(1);
    const truncatedProbe = state.probes.find((probe) => probe.arm === 'full' && probe.status === 'truncated');
    expect(truncatedProbe?.answer).toContain(truncatedProbe?.expectedFacts[0] ?? '');
    expect(truncatedProbe).toMatchObject({
      expectedFactsPresent: null,
      forbiddenFactsAbsent: null,
      correct: null,
      status: 'truncated',
    });
  });

  it('records response model and fingerprint, accepts absence as unknown, and rejects an explicit mismatch', async () => {
    const absentMock = createFetch({ responseModel: null, systemFingerprint: null, cost: null, listCost: null });
    const absentState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-absent-model-metadata',
      sessionIds: sessionIds(),
      fetch: absentMock.fetch,
      settings: settings({ turns: 1 }),
    });
    expect(absentState.status).toBe('completed');
    expect(absentState.records.every((record) => record.responseModel === null)).toBe(true);
    expect(absentState.records.every((record) => record.systemFingerprint === null)).toBe(true);
    expect(absentState.records.every((record) => record.usage?.chargedUsd === null)).toBe(true);
    expect(absentState.records.every((record) => record.usage?.listCostUsd === null)).toBe(true);
    expect(absentState.summary?.byArm.full.chargedUsd).toBeNull();
    expect(absentState.summary?.byArm.full.listCostUsd).toBeNull();

    const mismatchMock = createFetch({ responseModel: 'different-go-model', systemFingerprint: 'fp_different' });
    const mismatchState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-model-mismatch',
      sessionIds: sessionIds(),
      fetch: mismatchMock.fetch,
      settings: settings({ turns: 1, maxRetries: 2 }),
    });
    expect(mismatchState.status).toBe('failed');
    expect(mismatchMock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT)).toHaveLength(1);
    expect(mismatchState.records[0]).toMatchObject({
      status: 'failed',
      responseModel: 'different-go-model',
      systemFingerprint: 'fp_different',
      error: { type: 'ModelMismatch', retryable: false },
    });
  });

  it('scores individual route markers so a sibling-only leak cannot pass behind a full-state string', async () => {
    const mock = createFetch({ includeForbiddenProbeMarkerArm: 'full' });
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-route-marker-scoring',
      sessionIds: sessionIds(),
      fetch: mock.fetch,
      settings: settings({ turns: 30, maxRequests: 220 }),
    });

    const firstProbe = state.probes.find((probe) => probe.arm === 'full' && probe.afterTurnId === 'turn-08');
    expect(firstProbe?.expectedFacts).toContain('路线标记[route-01/衣物]=靛蓝布衫，袖口缝着两道白线');
    expect(firstProbe?.forbiddenFacts).toContain('路线标记[route-02/衣物]=灰呢长衫，领口别着一截黑羽');
    expect(firstProbe?.forbiddenFacts.every((fact) => !fact.includes('当前路线沈砚状态'))).toBe(true);
    expect(firstProbe).toMatchObject({
      expectedFactsPresent: true,
      forbiddenFactsAbsent: false,
      correct: false,
      status: 'completed',
    });
    expect(state.summary?.byArm.full.probeStatus).toBe('completed');
    expect(state.summary?.byArm.full.qualityStatus).toBe('incomplete');
    expect(state.summary?.byArm.full.probesIncorrect).toBeGreaterThan(0);
  });

  it('uses a distinct stable session for every repetition even when base session IDs contain arbitrary UUID text', async () => {
    const mock = createFetch();
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-repeat',
      sessionIds: {
        full: 'ses_0f70c1d2-r9-r1-full',
        folio: 'ses_folio-r2',
        retrievable: 'ses_retrievable',
      },
      fetch: mock.fetch,
      settings: settings({ turns: 1, repetitions: 2 }),
    });

    expect(state.status).toBe('completed');
    const generationSessions = state.records
      .filter((record) => record.phase === 'generation')
      .map((record) => state.repetitions[record.repetition].arms[record.arm].sessionId);
    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      expect(generationSessions).toContain(`ses_${arm === 'full' ? '0f70c1d2-r9-r1-full' : arm === 'folio' ? 'folio-r2' : 'retrievable'}_r0`);
      expect(generationSessions).toContain(`ses_${arm === 'full' ? '0f70c1d2-r9-r1-full' : arm === 'folio' ? 'folio-r2' : 'retrievable'}_r1`);
    }
    expect(new Set(generationSessions).size).toBe(6);
    expect(state.summary?.commonRange.logicalTurnKeys).toEqual([
      { repetition: 0, logicalTurnId: 'turn-01' },
      { repetition: 1, logicalTurnId: 'turn-01' },
    ]);
    expect(state.summary?.byArm.full.completedLogicalTurnKeys).toEqual([
      { repetition: 0, logicalTurnId: 'turn-01' },
      { repetition: 1, logicalTurnId: 'turn-01' },
    ]);
  });

  it('reserves conservative uncached peak allowance before a request and stops after a billed cap overrun', async () => {
    let prospectiveChatCalls = 0;
    const prospectiveFetch: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse();
      prospectiveChatCalls += 1;
      return streamResponse(sseCompletion('不应发送'));
    };
    const prospectiveState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-prospective-allowance',
      sessionIds: sessionIds(),
      fetch: prospectiveFetch,
      settings: settings({ turns: 1, maxAllowance: 0.000000001 }),
    });
    expect(prospectiveState.status).toBe('failed');
    expect(prospectiveState.failure?.message).toContain('allowance reservation');
    expect(prospectiveChatCalls).toBe(0);

    const postCapMock = createFetch({ actualAllowance: 1 });
    const postCapState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-post-allowance-cap',
      sessionIds: sessionIds(),
      fetch: postCapMock.fetch,
      settings: settings({ turns: 1, maxAllowance: 0.5 }),
    });
    expect(postCapState.status).toBe('failed');
    expect(postCapState.failure?.message).toContain('allowance cap was exceeded');
    expect(postCapMock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT)).toHaveLength(1);
    expect(postCapState.records).toHaveLength(1);
    expect(postCapState.records[0].usage?.allowance).toBe(1);
  });

  it('reserves worst-case output before traffic and does not retry an attempt with unknown billing', async () => {
    let outputCapChatCalls = 0;
    const outputCapFetch: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse();
      outputCapChatCalls += 1;
      return streamResponse(sseCompletion('不应发送'));
    };
    const outputCapState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-prospective-output',
      sessionIds: sessionIds(),
      fetch: outputCapFetch,
      settings: settings({ turns: 1, maxOutputTokensPerRequest: 10, maxTotalOutputTokens: 5 }),
    });
    expect(outputCapState.status).toBe('failed');
    expect(outputCapState.failure?.message).toContain('output-token cap');
    expect(outputCapChatCalls).toBe(0);

    const postOutputCapMock = createFetch({ actualCompletionTokens: 25 });
    const postOutputCapState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-post-output-cap',
      sessionIds: sessionIds(),
      fetch: postOutputCapMock.fetch,
      settings: settings({ turns: 1, maxOutputTokensPerRequest: 20, maxTotalOutputTokens: 20 }),
    });
    expect(postOutputCapState.status).toBe('failed');
    expect(postOutputCapState.failure?.message).toContain('output-token cap was exceeded');
    expect(postOutputCapMock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT)).toHaveLength(1);
    expect(postOutputCapState.records[0].usage?.completionTokens).toBe(25);

    let failedChatCalls = 0;
    const failedFetch: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse();
      failedChatCalls += 1;
      return jsonResponse(503, { error: { message: 'temporarily unavailable', type: 'server_error' } });
    };
    const failedState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-unknown-failed-billing',
      sessionIds: sessionIds(),
      fetch: failedFetch,
      settings: settings({ turns: 1, maxRetries: 2 }),
    });
    expect(failedState.status).toBe('failed');
    expect(failedState.failure?.message).toContain('billing is unknown');
    expect(failedChatCalls).toBe(1);
    expect(failedState.records).toHaveLength(1);
    expect(failedState.records[0]).toMatchObject({ status: 'failed', usage: null });
    expect(failedState.summary?.byArm.full.unknownBillingRecords).toBe(1);
  });

  it('measures first content latency from before fetch and keeps the timeout active while reading the stream', async () => {
    let latencyChatCalls = 0;
    let timeoutChatCalls = 0;
    const delayedHeadersFetch: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse();
      latencyChatCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return streamResponse(sseCompletion('延迟后的正文'));
    };
    const latencyState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-ttft',
      sessionIds: sessionIds(),
      fetch: delayedHeadersFetch,
      settings: settings({ turns: 1, requestTimeoutMs: 500 }),
    });
    const first = latencyState.records.find((record) => record.arm === 'full');
    expect(first?.status).toBe('completed');
    expect(first?.firstContentLatencyMs).toBeGreaterThanOrEqual(20);

    const stalledBodyFetch: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse();
      timeoutChatCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开头"},"finish_reason":null}]}\n\n');
            await new Promise((resolve) => setTimeout(resolve, 80));
          },
        },
        async text() {
          return '';
        },
      };
    };
    const timeoutState = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-stream-timeout',
      sessionIds: sessionIds(),
      fetch: stalledBodyFetch,
      settings: settings({ turns: 1, requestTimeoutMs: 10, maxRetries: 1 }),
    });
    expect(timeoutState.status).toBe('failed');
    expect(timeoutState.failure?.type).toBe('TimeoutError');
    expect(timeoutState.records.find((record) => record.arm === 'full')?.status).toBe('failed');
    expect(latencyChatCalls).toBe(3);
    expect(timeoutChatCalls).toBe(1);
  });

  it('stops before another arm when a terminal truncated response omits billing evidence', async () => {
    const mock = createFetch({ truncateArm: 'full', omitUsageArm: 'full' });
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-missing-terminal-usage',
      sessionIds: sessionIds(),
      fetch: mock.fetch,
      settings: settings({ turns: 1 }),
    });
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toContain('omitted usage');
    expect(state.failure).not.toEqual({});
    expect(mock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT)).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ arm: 'full', status: 'truncated', usage: null });
    expect(state.summary?.byArm.full.unknownBillingRecords).toBe(1);
  });

  it('stops before any model request when usage headroom is unavailable', async () => {
    let chatCalls = 0;
    const fetchImpl: GoFetch = async (url) => {
      if (url === GO_USAGE_ENDPOINT) return usageResponse(95);
      chatCalls += 1;
      return streamResponse(sseCompletion('不应发送'));
    };
    const state = await runGoExperiment({
      apiKey: 'test-key',
      runId: 'mock-headroom-stop',
      sessionIds: sessionIds(),
      fetch: fetchImpl,
      settings: settings({ turns: 1 }),
    });

    expect(state.status).toBe('failed');
    expect(state.failure?.message).toContain('hard stop');
    expect(chatCalls).toBe(0);
  });
});
