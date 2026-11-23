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

function routeAnswer(messages: Array<{ role: string; content: string }>): string {
  const serialized = messages.map((message) => message.content).join('\n');
  const matches = [...serialized.matchAll(/当前路线为(route-\d+)。路线独有银印是([^。]+)。(.+?) 只沿这条路线继续。/g)];
  const match = matches.at(-1);
  if (!match) return '无法确认当前路线。';
  return `路线：${match[1]}；银印：${match[2]}；${match[3]}`;
}

function sseCompletion(content: string, options: { finishReason?: string; usage?: boolean; refusal?: string } = {}): string {
  const finishReason = options.finishReason ?? 'stop';
  const delta = options.refusal
    ? { refusal: options.refusal }
    : { content };
  const finalEvent = {
    choices: [{ delta: {}, finish_reason: finishReason }],
    ...(options.usage === false ? {} : {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 7 },
        cost: 0,
        opencode: {
          billing_source: 'go',
          list_cost: 0.00001,
          allowance: 0.0001,
          tokens: {
            input: 120,
            output: 20,
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
} = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  let completionNumber = 0;
  const fetchImpl: GoFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, headers: init.headers, body });
    if (url === GO_USAGE_ENDPOINT) return usageResponse();
    if (url !== GO_CHAT_ENDPOINT) throw new Error(`Unexpected URL ${url}`);
    const messages = body?.messages as Array<{ role: string; content: string }>;
    const isSummary = messages.some((message) => message.content.includes('剧情摘要压缩'));
    const isProbe = messages.at(-1)?.content.includes('保持当前路线') ?? false;
    if (isSummary) {
      const routeFact = routeAnswer(messages);
      return streamResponse(sseCompletion(routeFact.startsWith('无法确认') ? `摘要${++completionNumber}` : routeFact));
    }
    if (isProbe) return streamResponse(sseCompletion(routeAnswer(messages)));
    const session = init.headers['x-opencode-session'];
    const arm = session.includes('_full_r') ? 'full' : session.includes('_folio_r') ? 'folio' : 'retrievable';
    const usage = arm !== mockOptions.omitUsageArm;
    if (arm === mockOptions.contentFilterArm) {
      return streamResponse(sseCompletion('', { finishReason: 'content_filter', refusal: '无法继续。', usage }));
    }
    if (arm === mockOptions.truncateArm) {
      return streamResponse(sseCompletion('被截断的部分正文', { finishReason: 'length', usage }));
    }
    return streamResponse(sseCompletion(`生成回复-${++completionNumber}`, { usage }));
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
    expect(checkpointCount).toBeGreaterThan(90);
    expect(checkpointText).not.toContain('test-key-never-persisted');
    expect(state.usagePreflight?.monthly?.percent).toBe(6);
    expect(state.summary?.usd).toEqual({ status: 'not-rendered', reason: 'go-allowance-only' });
    expect(state.summary?.commonRange.turnIds).toHaveLength(30);
    expect(state.summary?.commonRange.byArm.full.phaseCounts).toEqual({ generation: 30, summary: 0, probe: 4 });
    expect(state.summary?.commonRange.byArm.folio.phaseCounts.summary).toBeGreaterThan(0);
    expect(state.summary?.commonRange.byArm.retrievable.phaseCounts.probe).toBe(4);
    expect(state.summary?.commonRange.byArm.full.billedRequests).toBe(34);
    expect(state.summary?.byArm.full.completedTurns).toBe(30);
    expect(state.summary?.byArm.folio.completedTurns).toBe(30);
    expect(state.summary?.byArm.retrievable.completedTurns).toBe(30);
    expect(state.summary?.byArm.folio.requestCounts.summary).toBeGreaterThan(0);
    expect(state.summary?.byArm.full.probesTotal).toBe(4);
    expect(state.summary?.byArm.full.probesPassed).toBe(4);
    expect(state.summary?.byArm.folio.probesTotal).toBe(4);
    expect(state.summary?.byArm.retrievable.probesPassed).toBeGreaterThan(0);
    expect(state.summary?.byArm.full.allowanceUsed).toBeCloseTo(0.0034, 6);
    expect(state.summary?.byArm.full.tokenTotals.cacheRead).toBe(34 * 80);
    expect(state.summary?.byArm.full.generationTokenTotals.cacheRead).toBe(30 * 80);

    for (const arm of ['full', 'folio', 'retrievable'] as const) {
      const generationRecords = state.records.filter((record) => record.arm === arm && record.phase === 'generation');
      expect(generationRecords).toHaveLength(30);
      expect(generationRecords.filter((record) => record.status === 'completed')).toHaveLength(30);
      expect(generationRecords.filter((record) => record.branchSwitch)).toHaveLength(3);
      expect(new Set(generationRecords.map((record) => record.logicalTurnId)).size).toBe(30);
    }

    const armState = state.repetitions[0].arms.full;
    expect(armState.generatedOutputs).toHaveLength(30);
    expect(new Set(armState.generatedOutputs.map((output) => output.assistant)).size).toBeGreaterThan(25);

    const chatCalls = mock.calls.filter((call) => call.url === GO_CHAT_ENDPOINT);
    expect(chatCalls.some((call) => {
      const messages = call.body?.messages as Array<{ content: string }>;
      return messages.at(-1)?.content.includes('路线独有银印标记') ?? false;
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
    expect(state.summary?.commonRange.turnIds).toEqual([]);
    expect(state.summary?.comparisons.fullToRetrievable.promptTokenDelta).toBeNull();
    expect(state.summary?.comparisons.folioToRetrievable.allowanceDelta).toBeNull();
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
