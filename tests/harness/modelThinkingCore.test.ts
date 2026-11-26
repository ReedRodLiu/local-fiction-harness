import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import {
  DEFAULT_MODEL_CONFIG,
  EMPTY_SUMMARY_SNAPSHOT,
  appendWorkDiscussionTurn,
  assistFilterDeepSeekSessions,
  buildOpenAiChatRequest,
  buildRedactedStorySkeleton,
  createAsyncModelConfigStore,
  createBackgroundModelConfig,
  createDiagnosticCollector,
  createDiagnosticTransport,
  createFictionHarness,
  createKeyValueSecretStore,
  createOpenAiTransport,
  emptyWorkspace,
  exportFolioBackupV3,
  importDeepSeekSessions,
  locateDeepSeekScriptBoundary,
  mapReasoningEffortToDeepSeekParams,
  newCharacter,
  newConversation,
  newWork,
  normalizeOfficialDeepSeekModel,
  normalizeOfficialModelConfig,
  normalizeReasoningEffort,
  parseAndValidateFolioBackup,
  resolveEffectiveModelConfig,
  routeEntryMessage,
  scanDeepSeekExportZip,
  streamCreativeReply,
  summarizeCharacterConversation,
  summarizeStoryBranchSilent,
  summarizeWorkDiscussion,
  type KeyValueStorage,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
  type TurnNode,
} from '../../src/harness/index.ts';

function createMemoryKv(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe('Issue #108 Slice 1 & 2: DeepSeek official model whitelist, reasoning effort, and request mapping', () => {
  it('initializes DEFAULT_MODEL_CONFIG to deepseek-flash + none reasoningEffort and migrates legacy models without clobbering deepseek-v4-pro', () => {
    expect(DEFAULT_MODEL_CONFIG).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      reasoningEffort: 'none',
      apiKey: '',
      memoryOnly: false,
    });

    expect(normalizeOfficialDeepSeekModel('deepseek-chat')).toBe('deepseek-flash');
    expect(normalizeOfficialDeepSeekModel('deepseek-reasoner')).toBe('deepseek-flash');
    expect(normalizeOfficialDeepSeekModel('custom-model')).toBe('deepseek-flash');
    expect(normalizeOfficialDeepSeekModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(normalizeOfficialDeepSeekModel('deepseek-flash')).toBe('deepseek-flash');

    expect(normalizeReasoningEffort(undefined)).toBe('none');
    expect(normalizeReasoningEffort('invalid')).toBe('none');
    expect(normalizeReasoningEffort('none')).toBe('none');
    expect(normalizeReasoningEffort('low')).toBe('low');
    expect(normalizeReasoningEffort('medium')).toBe('medium');
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('max')).toBe('max');

    const proConfig = normalizeOfficialModelConfig({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      apiKey: 'sk-pro-123',
      memoryOnly: true,
    });
    expect(proConfig).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      apiKey: 'sk-pro-123',
      memoryOnly: false,
    });
  });

  it('persists deepseek-v4-pro and reasoningEffort across AsyncModelConfigStore cold restarts', async () => {
    const kv = createMemoryKv();
    const store = createAsyncModelConfigStore(createKeyValueSecretStore(kv));

    await store.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
      apiKey: 'sk-pro-456',
      memoryOnly: false,
    });

    const restarted = createAsyncModelConfigStore(createKeyValueSecretStore(kv));
    expect(await restarted.load()).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
      apiKey: 'sk-pro-456',
      memoryOnly: false,
    });
  });

  it('resolves effective foreground preferences dynamically and uses backgroundModel or current model + none for background tasks', () => {
    const globalPro: ModelConfig = {
      baseUrl: '/__dev_llm_proxy',
      model: 'deepseek-v4-pro',
      backgroundModel: 'deepseek-flash',
      reasoningEffort: 'max',
      apiKey: '',
      memoryOnly: false,
    };

    expect(resolveEffectiveModelConfig(globalPro)).toEqual({
      baseUrl: '/__dev_llm_proxy',
      model: 'deepseek-v4-pro',
      backgroundModel: 'deepseek-flash',
      reasoningEffort: 'max',
      apiKey: '',
      memoryOnly: false,
    });

    expect(resolveEffectiveModelConfig(globalPro, { model: 'deepseek-flash', reasoningEffort: 'low' })).toEqual({
      baseUrl: '/__dev_llm_proxy',
      model: 'deepseek-flash',
      backgroundModel: 'deepseek-flash',
      reasoningEffort: 'low',
      apiKey: '',
      memoryOnly: false,
    });

    expect(createBackgroundModelConfig(globalPro)).toEqual({
      baseUrl: '/__dev_llm_proxy',
      model: 'deepseek-flash',
      backgroundModel: 'deepseek-flash',
      reasoningEffort: 'none',
      apiKey: '',
      memoryOnly: false,
    });

    const thirdPartyConfig: ModelConfig = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
      apiKey: 'sk-openai-123',
      memoryOnly: false,
    };

    expect(createBackgroundModelConfig(thirdPartyConfig)).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'none',
      apiKey: 'sk-openai-123',
      memoryOnly: false,
    });
  });

  it('maps 4-tier reasoning effort to DeepSeek thinking and reasoning_effort payload fields in OpenAI transport', async () => {
    expect(mapReasoningEffortToDeepSeekParams('none')).toEqual({
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    });
    expect(mapReasoningEffortToDeepSeekParams('low')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(mapReasoningEffortToDeepSeekParams('high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(mapReasoningEffortToDeepSeekParams('max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });

    const sentBodies: Array<Record<string, unknown>> = [];
    const transport = createOpenAiTransport(async (_url, init) => {
      sentBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          );
        })(),
      };
    });

    for (const effort of ['none', 'low', 'high', 'max'] as const) {
      for await (const _ of transport.streamChat({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-v4-pro',
        reasoningEffort: effort,
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // consume
      }
    }

    expect(sentBodies.map((b) => ({ model: b.model, thinking: b.thinking, reasoning_effort: b.reasoning_effort }))).toEqual([
      { model: 'deepseek-v4-pro', thinking: { type: 'disabled' }, reasoning_effort: 'none' },
      { model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, reasoning_effort: 'low' },
      { model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      { model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    ]);

    const defaultReq = JSON.parse(
      buildOpenAiChatRequest({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }).body,
    ) as Record<string, unknown>;
    expect(defaultReq.thinking).toEqual({ type: 'enabled' });
    expect(defaultReq.reasoning_effort).toBe('high');
  });
});

describe('Issue #108 Slice 3: Foreground/background isolation and TurnNode metadata', () => {
  const proMaxConfig: ModelConfig = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    backgroundModel: 'deepseek-flash',
    reasoningEffort: 'max',
    apiKey: 'sk-pro',
    memoryOnly: false,
  };

  it('uses foreground preferences on harness turns while pinning background summary, gist, and blueprint to deepseek-flash + none', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧情摘要压缩')) {
          yield { contentDelta: '压缩后的剧情摘要。', finishReason: 'stop' };
          return;
        }
        if (sys.includes('分支梗概') || sys.includes('梗概')) {
          yield { contentDelta: '支线梗概。', finishReason: 'stop' };
          return;
        }
        if (sys.includes('JSON')) {
          yield {
            contentDelta: JSON.stringify({
              title: '夜雾港',
              worldRules: ['子夜禁止登船'],
              protagonist: '调查员',
              npcs: [],
              taboos: [],
              openingHook: '钟声响起。',
            }),
            finishReason: 'stop',
          };
          return;
        }
        yield { reasoningDelta: '深度推演中' };
        yield { contentDelta: '主舞台续写正文。', finishReason: 'stop' };
      },
    };

    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 120 },
    });
    const story0 = harness.createStory({ title: '夜雾港' });

    const t1 = await harness.runTurn(story0, '第一轮探索港口', proMaxConfig);
    expect(t1.assistantNode.model).toBe('deepseek-v4-pro');
    expect(t1.assistantNode.reasoningEffort).toBe('max');
    expect(t1.assistantNode.reasoningContent).toBe('深度推演中');
    expect(requests[0]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });

    // Second turn triggers rolling summary overflow (>2 nodes)
    const t2 = await harness.runTurn(t1.story, '第二轮登上旧栈桥并查看货物清单', proMaxConfig);
    expect(t2.assistantNode.model).toBe('deepseek-v4-pro');
    expect(t2.assistantNode.reasoningEffort).toBe('max');

    const summaryReq = requests.find((r) => r.messages[0]?.content.includes('剧情摘要压缩'));
    expect(summaryReq).toBeDefined();
    expect(summaryReq?.model).toBe('deepseek-flash');
    expect(summaryReq?.reasoningEffort).toBe('none');

    // Reasoning disabled ('none') suppresses reasoningContent even if transport emits stray reasoningDelta
    const flashNoneConfig: ModelConfig = {
      ...proMaxConfig,
      model: 'deepseek-flash',
      reasoningEffort: 'none',
    };
    const seenReasoning: string[] = [];
    const t3 = await harness.runTurn(t2.story, '第三轮关灯等待', flashNoneConfig, {
      onReasoningDelta: (d) => seenReasoning.push(d),
    });
    expect(seenReasoning).toEqual([]);
    expect(t3.assistantNode.reasoningContent).toBeUndefined();
    expect(t3.assistantNode.model).toBe('deepseek-flash');
    expect(t3.assistantNode.reasoningEffort).toBe('none');

    // Gist and blueprint extraction are also pinned to deepseek-flash + none
    const countBeforeHelpers = requests.length;
    await harness.extractBranchGist(t3.story, t1.userNode.id, proMaxConfig);
    await harness.extractStoryBlueprint('【规则】测试', proMaxConfig, '夜雾港');
    const helperReqs = requests.slice(countBeforeHelpers);
    expect(helperReqs).toHaveLength(2);
    for (const req of helperReqs) {
      expect(req.model).toBe('deepseek-flash');
      expect(req.reasoningEffort).toBe('none');
    }
  });

  it('forwards foreground model & reasoningEffort in entryRouter and suppresses reasoning when none', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        yield { reasoningDelta: '路由思考' };
        yield {
          contentDelta: '```lfh-route\nmode: story\ntitle: 雾港\n---\n# 设定\n\n雾夜\n```\n第一幕开始。',
          finishReason: 'stop',
        };
      },
    };

    const resPro = await routeEntryMessage('开个雾港文游', [], transport, proMaxConfig);
    expect(requests[0]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });
    expect(resPro.model).toBe('deepseek-v4-pro');
    expect(resPro.reasoningEffort).toBe('max');
    expect(resPro.reasoningContent).toBe('路由思考');

    const resNone = await routeEntryMessage('开个雾港文游', [], transport, {
      ...proMaxConfig,
      reasoningEffort: 'none',
    });
    expect(requests[1]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'none' });
    expect(resNone.reasoningContent).toBe('');
    expect(resNone.reasoningEffort).toBe('none');
  });

  it('isolates creative foreground streamCreativeReply from background summarizeWorkDiscussion/summarizeCharacterConversation/summarizeStoryBranchSilent', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        yield { reasoningDelta: '创作思考' };
        yield { contentDelta: '创作回复与摘要内容。', finishReason: 'stop' };
      },
    };

    const fgRes = await streamCreativeReply(transport, proMaxConfig, [{ role: 'user', content: '聊聊开头' }]);
    expect(requests[0]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });
    expect(fgRes.model).toBe('deepseek-v4-pro');
    expect(fgRes.reasoningEffort).toBe('max');
    expect(fgRes.reasoningContent).toBe('创作思考');

    const fgNone = await streamCreativeReply(
      transport,
      { ...proMaxConfig, reasoningEffort: 'none' },
      [{ role: 'user', content: '聊聊开头' }],
    );
    expect(fgNone.reasoningContent).toBe('');

    let work = newWork('测试作品', '设定');
    for (let i = 1; i <= 4; i++) {
      work = appendWorkDiscussionTurn(work, { role: 'user', content: `问${i}` }).work;
      work = appendWorkDiscussionTurn(work, { role: 'assistant', content: `答${i}` }).work;
    }
    const reqsBeforeSummary = requests.length;
    await summarizeWorkDiscussion(work, transport, proMaxConfig, { budget: { recentMaxNodes: 2 } });

    const char = newCharacter('顾砚', '人设');
    const conv = newConversation(char, 'personal');
    const nodes: Record<string, TurnNode> = {};
    let parent: string | null = null;
    for (let i = 1; i <= 4; i++) {
      const uid = `u${i}`;
      const aid = `a${i}`;
      nodes[uid] = { id: uid, parentId: parent, role: 'user', content: `u${i}`, createdAt: i * 2, summarySnapshot: EMPTY_SUMMARY_SNAPSHOT };
      nodes[aid] = { id: aid, parentId: uid, role: 'assistant', content: `a${i}`, createdAt: i * 2 + 1, summarySnapshot: EMPTY_SUMMARY_SNAPSHOT };
      parent = aid;
    }
    conv.nodes = nodes;
    conv.activeLeafNodeId = parent;
    await summarizeCharacterConversation(conv, transport, proMaxConfig, { budget: { recentMaxNodes: 2 } });

    const harness = createFictionHarness({ transport });
    const story = harness.createStory({ title: '测试' });
    story.nodes = nodes;
    story.rootNodeIds = ['u1'];
    story.activeLeafNodeId = parent;
    await summarizeStoryBranchSilent(story, parent, transport, proMaxConfig, { budget: { recentMaxNodes: 2 } });

    const summaryReqs = requests.slice(reqsBeforeSummary);
    expect(summaryReqs.length).toBeGreaterThanOrEqual(3);
    for (const req of summaryReqs) {
      expect(req.model).toBe('deepseek-flash');
      expect(req.reasoningEffort).toBe('none');
    }
  });

  it('pins DeepSeek import boundary detection and AI session filter to deepseek-flash + none', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧本边界定位')) {
          yield {
            contentDelta: JSON.stringify({ scriptMessageIds: ['m1'], firstPlayMessageId: 'm2' }),
            finishReason: 'stop',
          };
          return;
        }
        yield {
          contentDelta: JSON.stringify({ fictionSessionIds: ['s1'] }),
          finishReason: 'stop',
        };
      },
    };

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'manifest.json': encoder.encode(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/s1.json': encoder.encode(
        JSON.stringify({
          id: 's1',
          title: '普通闲聊开头',
          current_message_id: 'm2',
          messages: [
            { id: 'm1', parent_id: null, role: 'USER', inserted_at: 1000, fragments: [{ type: 'REQUEST', content: '你好' }] },
            { id: 'm2', parent_id: 'm1', role: 'ASSISTANT', inserted_at: 2000, fragments: [{ type: 'RESPONSE', content: '你好！' }] },
          ],
        }),
      ),
    });

    const scan = scanDeepSeekExportZip(zipBytes);
    await assistFilterDeepSeekSessions(scan.sessions, transport, proMaxConfig, undefined, '找文游');

    const harness = createFictionHarness({ transport });
    const imported = await importDeepSeekSessions(zipBytes, ['s1'], harness, { modelConfig: proMaxConfig });
    await locateDeepSeekScriptBoundary(imported.stories[0]!, transport, proMaxConfig);

    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const req of requests) {
      expect(req.model).toBe('deepseek-flash');
      expect(req.reasoningEffort).toBe('none');
    }
  });

  it('uses third-party model with reasoningEffort none when importing DeepSeek sessions without backgroundModel', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧本边界定位')) {
          yield {
            contentDelta: JSON.stringify({ scriptMessageIds: ['m1'], firstPlayMessageId: 'm2' }),
            finishReason: 'stop',
          };
          return;
        }
        yield {
          contentDelta: JSON.stringify({ fictionSessionIds: ['s1'] }),
          finishReason: 'stop',
        };
      },
    };

    const thirdPartyConfig: ModelConfig = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
      apiKey: 'sk-openai-import',
      memoryOnly: false,
    };

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'manifest.json': encoder.encode(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/s1.json': encoder.encode(
        JSON.stringify({
          id: 's1',
          title: '普通闲聊开头',
          current_message_id: 'm2',
          messages: [
            { id: 'm1', parent_id: null, role: 'USER', inserted_at: 1000, fragments: [{ type: 'REQUEST', content: '你好' }] },
            { id: 'm2', parent_id: 'm1', role: 'ASSISTANT', inserted_at: 2000, fragments: [{ type: 'RESPONSE', content: '你好！' }] },
          ],
        }),
      ),
    });

    const scan = scanDeepSeekExportZip(zipBytes);
    await assistFilterDeepSeekSessions(scan.sessions, transport, thirdPartyConfig, undefined, '找文游');

    const harness = createFictionHarness({ transport });
    const imported = await importDeepSeekSessions(zipBytes, ['s1'], harness, { modelConfig: thirdPartyConfig });
    await locateDeepSeekScriptBoundary(imported.stories[0]!, transport, thirdPartyConfig);

    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const req of requests) {
      expect(req.baseUrl).toBe('https://api.openai.com/v1');
      expect(req.model).toBe('gpt-4o-mini');
      expect(req.reasoningEffort).toBe('none');
    }
  });
});

describe('Issue #108 Slice 4: Backup validation & redacted diagnostics for model and reasoningEffort', () => {
  it('round-trips TurnNode model/reasoningEffort and optional generationPreference in .folio.json v3 and rejects invalid values', async () => {
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '回复正文。', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({ transport });
    const story = harness.createStory({ title: '测试归档' });
    story.generationPreference = { model: 'deepseek-v4-pro', reasoningEffort: 'max' };
    const turn = await harness.runTurn(story, '出发', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      apiKey: 'sk-secret',
      memoryOnly: false,
    });

    const work = {
      ...newWork('作品A', '# 设定'),
      generationPreference: { model: 'deepseek-v4-pro' as const, reasoningEffort: 'low' as const },
    };
    const char = {
      ...newCharacter('角色A', '# 人设'),
      generationPreference: { model: 'deepseek-flash' as const, reasoningEffort: 'none' as const },
    };
    const ws = { ...emptyWorkspace(), works: [work], characters: [char] };

    const exported = exportFolioBackupV3({ stories: [turn.story], workspace: ws });
    const parsed = parseAndValidateFolioBackup(exported);
    expect(parsed.stories[0]?.generationPreference).toEqual({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    expect(parsed.stories[0]?.nodes[turn.assistantNode.id]?.model).toBe('deepseek-v4-pro');
    expect(parsed.stories[0]?.nodes[turn.assistantNode.id]?.reasoningEffort).toBe('max');
    expect(parsed.workspace.works[0]?.generationPreference).toEqual({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    });
    expect(parsed.workspace.characters[0]?.generationPreference).toEqual({
      model: 'deepseek-flash',
      reasoningEffort: 'none',
    });

    const bad = JSON.parse(exported) as { stories: Array<{ nodes: Record<string, Record<string, unknown>> }> };
    bad.stories[0]!.nodes[turn.assistantNode.id]!.reasoningEffort = 'ultra';
    expect(() => parseAndValidateFolioBackup(JSON.stringify(bad))).toThrow();
  });

  it('records sanitized model & reasoningEffort in redacted diagnostics events, endpointProfile, and storySkeleton without leaking secrets', async () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    const transport = createDiagnosticTransport(
      {
        async *streamChat() {
          yield { reasoningDelta: 'SECRET_REASONING_CANARY' };
          yield { contentDelta: 'SECRET_STORY_CANARY', finishReason: 'stop' };
        },
      },
      collector,
      () => 1_700_000_000_100,
    );

    const harness = createFictionHarness({ transport });
    const story = harness.createStory({ title: 'TITLE_CANARY' });
    const res = await harness.runTurn(story, 'USER_CANARY', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      apiKey: 'sk-live-secret-canary-9999',
      memoryOnly: false,
    });

    // Simulate unsafe model string on a node or event meta to verify redaction
    const skeletonWithUnsafe = buildRedactedStorySkeleton({
      ...res.story,
      nodes: {
        ...res.story.nodes,
        [res.userNode.id]: {
          ...res.userNode,
          model: 'sk-leaked-in-model-CANARY',
          reasoningEffort: 'low',
        },
      },
    });
    const assistantSkeleton = skeletonWithUnsafe.nodes.find((n) => n.role === 'assistant');
    const userSkeleton = skeletonWithUnsafe.nodes.find((n) => n.role === 'user');
    expect(assistantSkeleton?.model).toBe('deepseek-v4-pro');
    expect(assistantSkeleton?.reasoningEffort).toBe('max');
    expect(userSkeleton?.model).toBeUndefined();
    expect(userSkeleton?.reasoningEffort).toBe('low');

    collector.recordEvent({
      level: 'info',
      category: 'llm',
      action: 'stream_done',
      meta: { model: 'sk-secret-CANARY', reasoningEffort: 'invalid_CANARY' as never },
    });

    const bundle = collector.buildBundle(
      {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        apiKey: 'sk-live-secret-canary-9999',
        memoryOnly: false,
      },
      { activeStory: res.story },
    );

    expect(bundle.endpointProfile.model).toBe('deepseek-v4-pro');
    expect(bundle.endpointProfile.reasoningEffort).toBe('max');
    expect(bundle.events[0]?.meta).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    expect(bundle.events[1]?.meta).toBeUndefined();
    expect(bundle.activeStorySkeleton?.nodes.find((n) => n.role === 'assistant')).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('CANARY');
    expect(serialized).not.toContain('sk-live-secret-canary-9999');
  });
});
