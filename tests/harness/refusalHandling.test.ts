import { describe, expect, it, vi } from 'vitest';
import {
  judgeRefusal,
  judgeHardRefusal,
  REFUSAL_RULE_COUNT,
} from '../../src/harness/refusalPatterns.ts';
import {
  deliveryIsThin,
  deliverySkeletonLooksLikeRefusal,
  routeRefusal,
} from '../../src/harness/thinDelivery.ts';
import {
  streamWithRefusalHandling,
  type RefusalHandlingOptions,
} from '../../src/harness/refusalWrapper.ts';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  buildModePrefill,
  type LlmStreamDelta,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
  type PromptPackLibrary,
  assembleThreeZoneContext,
  assembleCreativeThreeZoneContext,
  buildEntryRouteMessages,
  buildSummaryCompressionMessages,
  createDefaultBlueprint,
  EMPTY_SUMMARY_SNAPSHOT,
  newDocument,
  restoreRefusalOriginalContent,
  selectNodesToSummarize,
  type Story,
  type TurnNode,
  createFictionHarness,
  streamCreativeReply,
  routeEntryMessage,
  summarizeWorkDiscussion,
  newWork,
  appendWorkDiscussionTurn,
  validateTurnNodeEntry,
} from '../../src/harness/index.ts';

describe('Spec #132 refusal pattern and thin-delivery engine', () => {
  it('ships the calibrated 26-rule detector without flagging real narrative prose', () => {
    expect(REFUSAL_RULE_COUNT).toBe(26);
    expect(judgeRefusal('雨声在屋檐上碎成一片。他抬头，正好看见门外的人影。')).toBeNull();
    expect(judgeRefusal('「我不会写。」他说得很轻。')).toBeNull();
    expect(judgeRefusal('我没办法原谅你。')).toBeNull();
  });

  it('detects hard and object refusals with stable rule ids', () => {
    expect(judgeHardRefusal('抱歉，我不能帮你写这段内容。')).toMatchObject({
      layer: 'L1',
      ruleId: 'L1-02',
    });
    expect(judgeRefusal('我给你一个可用的框架：第一幕建立张力……具体到身体细节的部分我不提供。')).toMatchObject({
      layer: 'L2',
      ruleId: 'L2-02',
    });
  });

  it('protects very short legitimate delivery and protocol artifacts', () => {
    expect(deliveryIsThin('嗯。')).toBe(false);
    expect(deliveryIsThin('「嗯。」她说。')).toBe(false);
    expect(deliveryIsThin('（她没说话，只是把杯子推过来。）')).toBe(false);
    expect(deliveryIsThin('谢云\n40\n邯河县主')).toBe(false);
    expect(deliveryIsThin('……', { hasProtocolArtifacts: true })).toBe(false);
    expect(deliveryIsThin('', { hasProtocolArtifacts: true })).toBe(false);
    expect(deliveryIsThin('')).toBe(true);
    expect(deliveryIsThin('嗯。\n```lfh-summary\n她把茶推过来，等他先开口。\n```')).toBe(false);
  });

  it('routes regex refusals through thin delivery and recovers thin skeletons', () => {
    expect(routeRefusal('抱歉，我不能帮你写这段内容。', true)).toBe('retry');
    expect(routeRefusal('这一段我可以先说结构：开场的雨、两人在廊下擦肩……这类内容的我不写。', true)).toBe('partial_refused');
    expect(routeRefusal('我没办法给你这个。', false)).toBe('retry-skeleton');
    expect(routeRefusal('我不会给你第二次机会。', false)).toBe('pass');
    expect(deliverySkeletonLooksLikeRefusal('我帮不了你。')).toBe(false);
  });
});


const config: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'sk-test-123456',
  memoryOnly: true,
};

const library: PromptPackLibrary = {
  packs: [{
    ...BUILTIN_NARRATIVE_PROMPT_PACK,
    id: 'refusal-pack',
    readOnly: false,
    slots: { head: 'PACK_HEAD', mid: 'PACK_MID', tail: 'PACK_TAIL' },
  }],
  activePackId: 'refusal-pack',
};

function scriptedTransport(
  scripts: Array<(req: LlmStreamRequest, index: number) => AsyncIterable<LlmStreamDelta>>,
): LlmTransport & { requests: LlmStreamRequest[] } {
  const requests: LlmStreamRequest[] = [];
  return {
    requests,
    async *streamChat(req) {
      requests.push(req);
      const script = scripts[requests.length - 1];
      if (!script) throw new Error('unexpected request');
      yield* script(req, requests.length - 1);
    },
  };
}

function stream(deltas: LlmStreamDelta[]): AsyncIterable<LlmStreamDelta> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) yield delta;
    },
  };
}

function baseOptions(
  transport: LlmTransport,
  overrides: Partial<RefusalHandlingOptions> = {},
): RefusalHandlingOptions {
  return {
    transport,
    config,
    messages: [{ role: 'user', content: '继续写下去' }],
    mode: 'story',
    promptPackOptions: { promptPackLibrary: library },
    ...overrides,
  };
}

describe('Spec #132 120-character refusal wrapper', () => {
  it('passes short legitimate replies and streams reasoning immediately while holding content', async () => {
    const events: string[] = [];
    const transport = scriptedTransport([
      () => stream([
        { reasoningDelta: '先想场景。' },
        { contentDelta: '嗯。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: {
        onReasoningDelta: (delta) => events.push(`r:${delta}`),
        onContentDelta: (delta) => events.push(`c:${delta}`),
      },
    }));

    expect(result.content).toBe('嗯。');
    expect(result.finishReason).toBe('stop');
    expect(events).toEqual(['r:先想场景。', 'c:嗯。']);
    expect(transport.requests).toHaveLength(1);
    expect(result.diagnostics).toBeUndefined();
  });

  it('evaluates a stopped delta in full before L1 can trigger an early retry', async () => {
    const raw = '抱歉，我不能帮你写这段内容。\n```lfh-summary\n她把茶推过来，等他先开口。\n```';
    const visible: string[] = [];
    const actions: string[] = [];
    const transport = scriptedTransport([
      () => stream([{ contentDelta: raw, finishReason: 'stop' }]),
    ]);

    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { onContentDelta: (delta) => visible.push(delta) },
      onDiagnostic: (event) => actions.push(event.action),
    }));

    expect(transport.requests).toHaveLength(1);
    expect(visible.join('')).toBe(raw);
    expect(result.content).toBe(raw);
    expect(result.finishReason).toBe('stop');
    expect(result.diagnostics).toMatchObject({
      refusalRoute: 'partial_refused',
      matchedRuleId: 'L1-02',
    });
    expect(actions).toEqual(['refusal_partial_delivered']);
  });

  it('aborts an L1 hard refusal before stop and retries once with Pack.tail and a beta prefill', async () => {
    const retry = vi.fn();
    const visible: string[] = [];
    let firstRequestAborted = false;
    const transport = scriptedTransport([
      (req) => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { contentDelta: '抱歉，我不能帮你写这段内容。' };
          } finally {
            firstRequestAborted = Boolean(req.signal?.aborted);
          }
        },
      }),
      () => stream([
        { contentDelta: '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { onRefusalRetry: retry, onContentDelta: (delta) => visible.push(delta) },
    }));

    expect(firstRequestAborted).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(visible.join('')).toBe(result.content);
    expect(visible.join('')).not.toContain('抱歉');
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].messages.at(-2)).toEqual({ role: 'system', content: 'PACK_TAIL' });
    expect(transport.requests[1].prefixCompletion?.content).toBe(buildModePrefill('story'));
    expect(result.prefillContent).toBe(buildModePrefill('story'));
    expect(result.diagnostics).toMatchObject({
      refusalRoute: 'retry',
      recoveredFromText: '抱歉，我不能帮你写这段内容。',
      retriedWithPrefix: true,
      matchedRuleId: 'L1-02',
    });
  });

  it('silently retries a <=120-character stopped refusal without leaking first-stream text', async () => {
    const visible: string[] = [];
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '这个请求我不会提供，请换一个话题。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '门外传来两声轻响，他停下手里的动作，侧耳去听。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      promptPackOptions: { promptPackLibrary: library, generationPreference: { prefixCompletion: 'off' } },
      callbacks: { onContentDelta: (delta) => visible.push(delta) },
    }));

    expect(transport.requests).toHaveLength(2);
    expect(visible.join('')).toBe(result.content);
    expect(visible.join('')).not.toContain('这个请求');
    expect(transport.requests[1].prefixCompletion).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      refusalRoute: 'retry',
      retriedWithPrefix: false,
      matchedRuleId: 'L1-06',
    });
  });

  it('opens the gate after 120 characters and preserves a partial refusal with protocol artifacts', async () => {
    const visible: string[] = [];
    const longNarrative = '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。'.repeat(4);
    const raw = `${longNarrative}\n这一段我可以先说结构：开场的雨、两人在廊下擦肩……这类内容的我不写。\n\`\`\`lfh-summary\n两人在屋里重新坐下。\n\`\`\``;
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: longNarrative },
        { contentDelta: '\n这一段我可以先说结构：开场的雨、两人在廊下擦肩……这类内容的我不写。\n```lfh-summary\n两人在屋里重新坐下。\n```' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { onContentDelta: (delta) => visible.push(delta) },
    }));

    expect(visible.join('')).toBe(raw);
    expect(result.content).toBe(raw);
    expect(result.diagnostics).toMatchObject({
      refusalRoute: 'partial_refused',
      matchedRuleId: 'L1-06',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('returns a gentle isolated message after the single retry is also refused', async () => {
    const visible: string[] = [];
    const retry = vi.fn();
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '这个请求我不会提供，请换一个话题。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { onRefusalRetry: retry, onContentDelta: (delta) => visible.push(delta) },
    }));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(2);
    expect(visible).toEqual([]);
    expect(result.content).toContain('本轮生成未通过模型的安全策略');
    expect(result.diagnostics).toMatchObject({
      sourceStatus: 'REFUSAL',
      refusalRoute: 'refused_exhausted',
      recoveredFromText: '抱歉，我不能帮你写这段内容。',
      retriedWithPrefix: true,
    });
  });

  it('delivers a retry partial refusal instead of exhausting it', async () => {
    const firstRaw = '抱歉，我不能帮你写这段内容。';
    const longNarrative = '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。'.repeat(4);
    const retryRaw = `${longNarrative}\n这一段我可以先说结构：开场的雨、两人在廊下擦肩……这类内容的我不写。\n\`\`\`lfh-summary\n两人在屋里重新坐下。\n\`\`\``;
    const visible: string[] = [];
    const actions: string[] = [];
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: firstRaw },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { reasoningDelta: '重拟思路。' },
        { contentDelta: retryRaw, finishReason: 'stop' },
      ]),
    ]);

    const result = await streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { onContentDelta: (delta) => visible.push(delta) },
      onDiagnostic: (event) => actions.push(event.action),
    }));

    expect(transport.requests).toHaveLength(2);
    expect(visible.join('')).toBe(retryRaw);
    expect(result.content).toBe(retryRaw);
    expect(result.reasoningContent).toBe('重拟思路。');
    expect(result.finishReason).toBe('stop');
    expect(result.prefillContent).toBe(buildModePrefill('story'));
    expect(result.diagnostics).toMatchObject({
      refusalRoute: 'partial_refused',
      recoveredFromText: firstRaw,
      retriedWithPrefix: true,
      matchedRuleId: 'L1-02',
    });
    expect(actions).toEqual(['refusal_detected', 'refusal_partial_delivered']);
  });

  it.each(['throw', 'yield'] as const)(
    'emits buffered content before AbortError when the transport later tries to %s',
    async (failureMode) => {
      const controller = new AbortController();
      const visible: string[] = [];
      const transport = scriptedTransport([
        () => ({
          async *[Symbol.asyncIterator]() {
            yield { contentDelta: '雨声在' };
            controller.abort();
            if (failureMode === 'throw') throw new Error('upstream failed');
            yield { contentDelta: '屋檐' };
          },
        }),
      ]);

      await expect(streamWithRefusalHandling(baseOptions(transport, {
        callbacks: {
          signal: controller.signal,
          onContentDelta: (delta) => visible.push(delta),
        },
      }))).rejects.toMatchObject({ name: 'AbortError' });
      expect(visible.join('')).toBe('雨声在');
    },
  );

  it('does not retry when the first refusal stream ends after an external abort', async () => {
    const controller = new AbortController();
    const retry = vi.fn();
    const transport = scriptedTransport([
      () => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { contentDelta: '这个我不能写。' };
            yield { finishReason: 'stop' };
          } finally {
            controller.abort();
          }
        },
      }),
    ]);

    await expect(streamWithRefusalHandling(baseOptions(transport, {
      callbacks: { signal: controller.signal, onRefusalRetry: retry },
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(retry).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
  });

  it('does not retry when onRefusalRetry aborts the operation', async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
    ]);

    await expect(streamWithRefusalHandling(baseOptions(transport, {
      callbacks: {
        signal: controller.signal,
        onRefusalRetry: () => controller.abort(),
      },
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests).toHaveLength(1);
  });

  it('does not duplicate a resident Pack.tail on retry', async () => {
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。' },
        { finishReason: 'stop' },
      ]),
    ]);

    await streamWithRefusalHandling(baseOptions(transport, {
      messages: [
        { role: 'system', content: 'PACK_TAIL' },
        { role: 'user', content: '继续写下去' },
      ],
    }));

    expect(
      transport.requests[1].messages.filter(
        (message) => message.role === 'system' && message.content === 'PACK_TAIL',
      ),
    ).toHaveLength(1);
  });

  it('passes through immediately when no prompt pack is enabled', async () => {
    const visible: string[] = [];
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '第一句' },
        { contentDelta: '第二句' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      promptPackOptions: { promptPackLibrary: library, generationPreference: { promptPackMode: 'off' } },
      callbacks: { onContentDelta: (delta) => visible.push(delta) },
    }));

    expect(visible).toEqual(['第一句', '第二句']);
    expect(result.diagnostics).toBeUndefined();
    expect(transport.requests[0].prefixCompletion).toBeUndefined();
  });

  it('honors always-prefill on the first request', async () => {
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: `${buildModePrefill('writing')}风声从窗缝里钻进来。` },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await streamWithRefusalHandling(baseOptions(transport, {
      mode: 'writing',
      promptPackOptions: {
        promptPackLibrary: library,
        generationPreference: { prefixCompletion: 'always' },
      },
    }));

    expect(transport.requests[0].prefixCompletion?.content).toBe(buildModePrefill('writing'));
    expect(result.prefillContent).toBe(buildModePrefill('writing'));
  });
});


function refusalStory(): Story {
  const node = (
    id: string,
    parentId: string | null,
    role: TurnNode['role'],
    content: string,
    diagnostics?: TurnNode['diagnostics'],
    turnSummary?: string,
  ): TurnNode => ({
    id,
    parentId,
    role,
    content,
    ...(diagnostics ? { diagnostics } : {}),
    ...(turnSummary ? { turnSummary } : {}),
    createdAt: id.length,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
  });
  return {
    id: 'story',
    title: '隔离测试',
    rawScript: '当前设定',
    blueprint: createDefaultBlueprint('隔离测试'),
    nodes: {
      u1: node('u1', null, 'user', '第一轮用户'),
      a1: node('a1', 'u1', 'assistant', '第一轮正文'),
      refusedUser: node('refusedUser', 'a1', 'user', 'REFUSED_USER_CANARY'),
      refusedAssistant: node(
        'refusedAssistant',
        'refusedUser',
        'assistant',
        'REFUSAL_CANARY',
        {
          sourceStatus: 'REFUSAL',
          refusalRoute: 'refused_exhausted',
          recoveredFromText: 'REFUSAL_ORIGINAL_CANARY',
        },
        'REFUSAL_SUMMARY_CANARY',
      ),
      u2: node('u2', 'refusedAssistant', 'user', '第二轮有效用户'),
      a2: node('a2', 'u2', 'assistant', '第二轮有效正文'),
    },
    rootNodeIds: ['u1'],
    activeLeafNodeId: 'a2',
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('Spec #132 refusal history isolation and restoration', () => {
  it('keeps refused turns visible in the tree but excludes the whole pair from every context and summary path', () => {
    const story = refusalStory();
    expect(story.nodes.refusedAssistant.content).toBe('REFUSAL_CANARY');

    const storyContext = assembleThreeZoneContext(story, 'a2', '继续', undefined, false, undefined, {
      promptPackLibrary: library,
      generationPreference: { promptPackMode: 'off' },
    });
    const creativeContext = assembleCreativeThreeZoneContext({
      systemPrompt: 'system',
      nodes: story.nodes,
      targetParentId: 'a2',
      userInput: '继续',
    });
    const entryContext = buildEntryRouteMessages('继续', Object.values(story.nodes), '记忆');
    const summary = buildSummaryCompressionMessages('', Object.values(story.nodes));
    const selected = selectNodesToSummarize(Object.values(story.nodes), {
      recentMaxNodes: 2,
      recentMaxChars: 10,
    });

    for (const text of [
      storyContext.messages.map((m) => m.content).join('\n'),
      creativeContext.messages.map((m) => m.content).join('\n'),
      entryContext.map((m) => m.content).join('\n'),
      summary.map((m) => m.content).join('\n'),
      selected.map((n) => n.content).join('\n'),
    ]) {
      expect(text).not.toContain('REFUSAL_CANARY');
      expect(text).not.toContain('REFUSED_USER_CANARY');
      expect(text).not.toContain('REFUSAL_SUMMARY_CANARY');
      expect(text).not.toContain('REFUSAL_ORIGINAL_CANARY');
    }
    expect(storyContext.messages.some((m) => m.content.includes('第二轮有效正文'))).toBe(true);
  });

  it('restores the original refused text losslessly and can swap back', () => {
    const node = refusalStory().nodes.refusedAssistant;
    const restored = restoreRefusalOriginalContent(node);
    expect(restored.content).toBe('REFUSAL_ORIGINAL_CANARY');
    expect(restored.diagnostics?.recoveredFromText).toBe('REFUSAL_CANARY');

    const roundTrip = restoreRefusalOriginalContent(restored);
    expect(roundTrip.content).toBe(node.content);
    expect(roundTrip.diagnostics?.recoveredFromText).toBe('REFUSAL_ORIGINAL_CANARY');
  });
});


describe('Spec #132 foreground integration and background exclusion', () => {
  it('wires refusal recovery into the story harness and persists node diagnostics', async () => {
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const harness = createFictionHarness({ transport, promptPackLibrary: library });
    const result = await harness.runTurn(
      harness.createStory({ title: '重拟测试' }),
      '继续',
      config,
    );

    expect(transport.requests).toHaveLength(2);
    expect(result.assistantNode.content).toContain('雨声落在窗沿上');
    expect(result.assistantNode.diagnostics).toMatchObject({
      refusalRoute: 'retry',
      recoveredFromText: '抱歉，我不能帮你写这段内容。',
      retriedWithPrefix: true,
    });
    expect(result.assistantNode.prefillContent).toBe(buildModePrefill('story'));
  });

  it('wires refusal recovery into creative and entry foreground streams', async () => {
    const creativeTransport = scriptedTransport([
      () => stream([
        { contentDelta: '这个请求我不会提供，请换一个话题。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '她把杯子放下，窗外的风正好吹动纸页。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const creative = await streamCreativeReply(
      creativeTransport,
      config,
      [{ role: 'user', content: '继续写' }],
      {},
      {
        mode: 'writing',
        promptPackOptions: { promptPackLibrary: library },
      },
    );
    expect(creativeTransport.requests).toHaveLength(2);
    expect(creative.diagnostics).toMatchObject({ refusalRoute: 'retry' });

    const entryTransport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '```lfh-route\nmode: story\ntitle: 雾港\n---\n## 设定\n雾港。\n```\n\n雾里传来船笛声。\n```lfh-summary\n雾港故事从船笛声开始。\n```' },
        { finishReason: 'stop' },
      ]),
    ]);
    const routed = await routeEntryMessage(
      '开一个雾港文游',
      [],
      entryTransport,
      config,
      {},
      '',
      { promptPackLibrary: library },
      { mode: 'story' },
    );
    expect(entryTransport.requests).toHaveLength(2);
    expect(entryTransport.requests[1].prefixCompletion?.content).toBe('```lfh-route\nmode: story\n');
    expect(routed.mode).toBe('story');
    expect(routed.diagnostics).toMatchObject({ refusalRoute: 'retry' });
  });

  it('uses refusalOptions prompt pack options for entry messages and retry handling', async () => {
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '```lfh-route\nmode: story\ntitle: 雾港\n---\n## 设定\n雾港。\n```\n\n雾里传来船笛声。' },
        { finishReason: 'stop' },
      ]),
    ]);

    const routed = await routeEntryMessage(
      '开一个雾港文游',
      [],
      transport,
      config,
      {},
      '',
      undefined,
      {
        mode: 'story',
        promptPackOptions: { promptPackLibrary: library },
      },
    );

    const firstRequestText = transport.requests[0].messages.map((message) => message.content).join('\n');
    expect(firstRequestText).toContain('PACK_HEAD');
    expect(firstRequestText).toContain('PACK_MID');
    expect(transport.requests[1].messages).toContainEqual({ role: 'system', content: 'PACK_TAIL' });
    expect(routed.mode).toBe('story');
    expect(routed.diagnostics).toMatchObject({ refusalRoute: 'retry' });
  });

  it('keeps background creative summary outside the refusal wrapper', async () => {
    let work = newWork('摘要测试', '设定');
    work = appendWorkDiscussionTurn(work, { role: 'user', content: '第一轮用户' }).work;
    work = appendWorkDiscussionTurn(work, { role: 'assistant', content: '第一轮正文' }).work;
    work = appendWorkDiscussionTurn(work, { role: 'user', content: '第二轮用户' }).work;
    work = appendWorkDiscussionTurn(work, { role: 'assistant', content: '第二轮正文' }).work;

    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const result = await summarizeWorkDiscussion(work, transport, config, {
      budget: { recentMaxNodes: 2, recentMaxChars: 5, summaryBatchMaxNodes: 2, summaryBatchMaxChars: 5000 },
    });

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].prefixCompletion).toBeUndefined();
    expect(transport.requests[0].messages.at(-1)?.content).not.toContain('PACK_TAIL');
    expect(result.status).toBe('done');
  });
});


describe('Spec #132 refusal diagnostics persistence', () => {
  it('validates and preserves refusal node diagnostics through storage import', () => {
    const node = refusalStory().nodes.refusedAssistant;
    const validated = validateTurnNodeEntry(node);
    expect(validated.diagnostics).toEqual({
      sourceStatus: 'REFUSAL',
      refusalRoute: 'refused_exhausted',
      recoveredFromText: 'REFUSAL_ORIGINAL_CANARY',
    });

    const withRoute = validateTurnNodeEntry({
      ...node,
      diagnostics: {
        ...node.diagnostics,
        retriedWithPrefix: true,
        matchedRuleId: 'L1-02',
      },
    });
    expect(withRoute.diagnostics).toMatchObject({
      sourceStatus: 'REFUSAL',
      retriedWithPrefix: true,
      matchedRuleId: 'L1-02',
    });
  });
});


describe('Spec #132 exhaustion isolation integration', () => {
  it('excludes an actually exhausted refusal round from the next three-zone request', async () => {
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '这个请求我不会提供，请换一个话题。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '灯火重新亮起，他从长街另一头慢慢走来。' },
        { finishReason: 'stop' },
      ]),
    ]);
    const harness = createFictionHarness({ transport, promptPackLibrary: library });
    const first = await harness.runTurn(
      harness.createStory({ title: '耗尽隔离' }),
      'REFUSED_USER_CANARY',
      config,
    );
    expect(first.assistantNode.diagnostics?.sourceStatus).toBe('REFUSAL');
    expect(first.assistantNode.content).toContain('本轮生成未通过模型的安全策略');

    await harness.runTurn(first.story, '换一个切入点', config);
    const nextRequestText = transport.requests[2].messages.map((message) => message.content).join('\n');
    expect(nextRequestText).not.toContain('REFUSED_USER_CANARY');
    expect(nextRequestText).not.toContain('抱歉，我不能帮你写这段内容。');
    expect(nextRequestText).not.toContain('本轮生成未通过模型的安全策略');
    expect(nextRequestText).toContain('换一个切入点');
  });

  it('uses the built-in advancement instruction when Pack.tail is empty', async () => {
    const emptyTailLibrary: PromptPackLibrary = {
      packs: [{
        ...library.packs[0],
        slots: { head: 'PACK_HEAD', mid: 'PACK_MID', tail: '' },
      }],
      activePackId: 'refusal-pack',
    };
    const transport = scriptedTransport([
      () => stream([
        { contentDelta: '抱歉，我不能帮你写这段内容。' },
        { finishReason: 'stop' },
      ]),
      () => stream([
        { contentDelta: '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。' },
        { finishReason: 'stop' },
      ]),
    ]);
    await streamWithRefusalHandling(baseOptions(transport, {
      promptPackOptions: { promptPackLibrary: emptyTailLibrary },
    }));
    expect(transport.requests[1].messages).toContainEqual({
      role: 'system',
      content: '请直接续写当前场景，用具体动作、对白与感官细节自然推进。',
    });
  });
});
