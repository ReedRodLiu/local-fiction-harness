import { describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekPublicResearchProvider,
  createFictionHarness,
  createInMemoryStoryStorage,
  derivePublicResearchIdentity,
  characterContext,
  emptyWorkspace,
  editStoryDocument,
  documentVersion,
  exportFolioBackupV3,
  parseAndValidateFolioBackup,
  newCharacter,
  newConversation,
  newDocument,
  publicResearchIdentityKey,
  routeEntryMessage,
  type FetchLike,
  type LlmTransport,
  type ModelConfig,
} from '../../src/harness/index.ts';

const testConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'sk-test-123456',
  memoryOnly: false,
};

describe('public character research', () => {
  it('extracts only explicit public matching metadata from current setting', () => {
    const identity = derivePublicResearchIdentity({
      title: '雨夜车站',
      settingMarkdown: [
        '## 原作资料',
        '原作：《钢之炼金术师》',
        '版本：2003 动画版',
        '剧情时点：第 51 集结局后',
        '角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克',
        '私密补充：不要发送这段内容',
      ].join('\n'),
    });

    expect(identity).toEqual({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克', '阿尔冯斯·艾尔利克'],
    });
    expect(JSON.stringify(identity)).not.toContain('不要发送');
  });

  it('searches with minimal public fields, mandates fetch, and synthesizes from public evidence', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetcher: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ url, headers: init.headers, body });
      if (url.endsWith('/v1/tools/search')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: null,
          async text() {
            return JSON.stringify({
              results: [{
                rerank_score: 2.6,
                title: '官方角色介绍',
                url: 'https://official.example/edward',
                snippet: '角色简介',
                summary: '搜索摘要不能直接当作已抓取正文。',
                content: '',
                site_name: 'Official',
                site_icon: null,
                date: null,
                authority: 4,
              }, {
                rerank_score: 2.9,
                title: '内部地址',
                url: 'http://127.0.0.1/private',
                snippet: '不应抓取',
                summary: '不应抓取',
                content: '',
                site_name: null,
                site_icon: null,
                date: null,
                authority: 4,
              }],
            });
          },
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        async text() {
          return JSON.stringify({
            title: '官方角色介绍',
            content: ['# 爱德华·艾尔利克', '', '说话短促，称呼弟弟为阿尔。'].join('\n'),
          });
        },
      };
    };
    let synthesisMessages: unknown;
    const transport: LlmTransport = {
      async *streamChat(request) {
        synthesisMessages = request.messages;
        yield { contentDelta: ['### 爱德华·艾尔利克', '- 称呼弟弟为阿尔，语气短促。'].join('\n') };
        yield { finishReason: 'stop' };
      },
    };
    const provider = createDeepSeekPublicResearchProvider({
      fetcher,
      transport,
      now: () => 1234,
    });

    const reference = await provider.resolve({
      identity: {
        work: '钢之炼金术师',
        version: '2003 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华·艾尔利克'],
      },
      config: testConfig,
    });

    expect(reference).toMatchObject({
      identityKey: expect.any(String),
      summary: ['### 爱德华·艾尔利克', '- 称呼弟弟为阿尔，语气短促。'].join('\n'),
      sources: [{ title: '官方角色介绍', url: 'https://official.example/edward' }],
      fetchedAt: 1234,
    });
    expect(requests.map((entry) => entry.url)).toEqual([
      'https://api.deepseek.com/v1/tools/search',
      'https://api.deepseek.com/v1/tools/fetch',
    ]);
    expect(requests.every((entry) => entry.headers.Authorization === 'Bearer sk-test-123456')).toBe(true);
    expect(requests.some((entry) => JSON.stringify(entry.body).includes('127.0.0.1'))).toBe(false);
    expect(Object.keys(requests[0].body).sort()).toEqual(['count', 'need_content', 'query']);
    expect(requests[0].body.need_content).toBe(false);
    expect(String(requests[0].body.query)).toContain('钢之炼金术师');
    expect(String(requests[0].body.query)).toContain('2003 动画版');
    expect(requests[0].body).not.toHaveProperty('ori_question');
    expect(requests[0].body).not.toHaveProperty('localization');
    expect(requests[1].body).toEqual({ url: 'https://official.example/edward' });
    expect(JSON.stringify(synthesisMessages)).toContain('说话短促');
    expect(JSON.stringify(synthesisMessages)).not.toContain('sk-test');
  });

  it('enriches the first story turn and reuses the branch reference without another lookup', async () => {
    const identities: unknown[] = [];
    const provider = {
      async resolve(request: Parameters<NonNullable<Parameters<typeof createFictionHarness>[0]['publicResearch']>['resolve']>[0] extends never ? never : any) {
        identities.push(request.identity);
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: [
            '### 爱德华·艾尔利克',
            '- 称呼弟弟为阿尔。',
            '### 阿尔冯斯·艾尔利克',
            '- 语气温和，习惯称哥哥为哥哥。',
          ].join('\n'),
          sources: [{ title: '官方角色页', url: 'https://official.example/characters' }],
          fetchedAt: 100,
        };
      },
    };
    const seenMessages: unknown[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: provider as any,
      transport: {
        async *streamChat(request) {
          seenMessages.push(request.messages);
          yield { contentDelta: '开场。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师续篇',
      rawScript: [
        '## 公开匹配',
        '原作：《钢之炼金术师》',
        '版本：2003 动画版',
        '剧情时点：第 51 集结局后',
        '角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克',
        '私密补充：这一段不能发往检索接口',
      ].join('\n'),
    });

    const first = await harness.runTurn(story, '请开始第一幕。', testConfig);
    const second = await harness.runTurn(first.story, '别急，先看看四周。', testConfig);

    expect(identities).toHaveLength(1);
    expect(identities[0]).toEqual({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克', '阿尔冯斯·艾尔利克'],
    });
    const firstPayload = JSON.stringify(seenMessages[0]);
    const secondPayload = JSON.stringify(seenMessages[1]);
    expect(firstPayload).toContain('公开资料参考');
    expect(firstPayload).toContain('### 爱德华·艾尔利克');
    expect(firstPayload).toContain('### 阿尔冯斯·艾尔利克');
    expect(secondPayload).toContain('公开资料参考');
    expect(first.assistantNode.publicResearch?.identityKey).toBe(second.assistantNode.publicResearch?.identityKey);
  });

  it('returns no research when the bounded public lookup times out', async () => {
    const fetcher: FetchLike = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        async text() {
          return JSON.stringify({ results: [] });
        },
      };
    };
    const provider = createDeepSeekPublicResearchProvider({
      fetcher,
      transport: {
        async *streamChat() {
          yield { contentDelta: 'unused', finishReason: 'stop' };
        },
      },
      timeoutMs: 5,
    });

    const startedAt = Date.now();
    await expect(provider.resolve({
      identity: {
        work: '钢之炼金术师',
        version: '2003 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华·艾尔利克'],
      },
      config: testConfig,
    })).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('enriches the welcome-page formal first reply before routing it', async () => {
    let providerCall: any = null;
    const provider = {
      async resolve(request: any) {
        providerCall = request;
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: '### 爱德华·艾尔利克\n- 称呼弟弟为阿尔。',
          sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
          fetchedAt: 200,
        };
      },
    };
    let welcomeMessages: unknown;
    const transport: LlmTransport = {
      async *streamChat(request) {
        welcomeMessages = request.messages;
        yield { contentDelta: '```lfh-route\nmode: story\ntitle: 炼金术师续篇\n---\n## 原作\n作品：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克\n```\n\n门口响起脚步声。' };
        yield { finishReason: 'stop' };
      },
    };

    const result = await routeEntryMessage(
      '开一个《钢之炼金术师》2003 动画版第 51 集结局后的文游，让我遇见角色：爱德华·艾尔利克',
      [],
      transport,
      testConfig,
      {},
      '',
      { publicResearch: provider as any },
    );

    expect(providerCall?.identity).toEqual({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克'],
    });
    expect(JSON.stringify(welcomeMessages)).toContain('公开资料参考');
    expect(JSON.stringify(welcomeMessages)).toContain('称呼弟弟为阿尔');
    expect(result.publicResearch?.summary).toContain('称呼弟弟为阿尔');
  });

  it('adds character-specific voice references as low-priority context', () => {
    const character = newCharacter('爱德华·艾尔利克', '原作：《钢之炼金术师》\n改编：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克');
    const conversation = newConversation(character, 'roleplay');
    const identity = {
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克'],
    };
    const context = characterContext(
      newDocument('偏好短句'),
      character,
      conversation,
      '阿尔在哪？',
      undefined,
      {
        identity,
        identityKey: publicResearchIdentityKey(identity),
        summary: '称呼阿尔为“阿尔”，急躁时句子很短。',
        sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
        fetchedAt: 300,
      },
    );

    const payload = JSON.stringify(context.messages);
    expect(payload).toContain('公开资料参考（低优先级）');
    expect(payload).toContain('称呼阿尔为');
    expect(payload).toContain('以用户已确认内容为准');
  });

  it('keeps the concise public reference in local backup export and restore', async () => {
    const identity = {
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克'],
    };
    const reference = {
      identity,
      identityKey: publicResearchIdentityKey(identity),
      summary: '称呼阿尔为“阿尔”。',
      sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
      fetchedAt: 400,
    };
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: { resolve: async () => reference },
      transport: {
        async *streamChat() {
          yield { contentDelta: '开场。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克',
    });
    const turn = await harness.runTurn(story, '开始', testConfig);

    const backup = exportFolioBackupV3({
      stories: [turn.story],
      workspace: emptyWorkspace(),
      now: () => 500,
    });
    const restored = parseAndValidateFolioBackup(backup).stories[0];

    expect(restored.nodes[turn.assistantNode.id].publicResearch).toEqual(reference);
  });

  it('keeps two adaptations and their timeline material isolated', async () => {
    const summaries = new Map([
      ['2003 动画版', '### 爱德华\n- 2003 版专用语气。'],
      ['2009 动画版', '### 爱德华\n- 2009 版专用语气。'],
    ]);
    const provider = {
      async resolve(request: any) {
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: summaries.get(request.identity.version)!,
          sources: [{ title: '官方角色页', url: 'https://official.example/character' }],
          fetchedAt: 500,
        };
      },
    };
    const payloads: string[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: provider as any,
      transport: {
        async *streamChat(request) {
          payloads.push(JSON.stringify(request.messages));
          yield { contentDelta: '开场。', finishReason: 'stop' };
        },
      },
    });
    const makeStory = async (version: string, episode: string) => {
      const story = await harness.createAndSaveStory({
        title: '炼金术师续篇',
        rawScript: `原作：《钢之炼金术师》\n版本：${version}\n剧情时点：${episode}\n角色：爱德华`,
      });
      return harness.runTurn(story, '开始', testConfig);
    };

    await makeStory('2003 动画版', '第 51 集结局后');
    await makeStory('2009 动画版', '第 51 集后');

    expect(payloads[0]).toContain('2003 版专用语气');
    expect(payloads[0]).not.toContain('2009 版专用语气');
    expect(payloads[1]).toContain('2009 版专用语气');
    expect(payloads[1]).not.toContain('2003 版专用语气');
  });

  it('continues the first act when research is unavailable or fails', async () => {
    let lookupCalls = 0;
    const failingProvider = {
      async resolve() {
        lookupCalls += 1;
        const error = new Error('search unavailable');
        error.name = 'AbortError';
        throw error;
      },
    };
    let narrationCalls = 0;
    const harness = createFictionHarness({
      publicResearch: failingProvider,
      transport: {
        async *streamChat() {
          narrationCalls += 1;
          yield { contentDelta: '雨声继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    });

    const result = await harness.runTurn(story, '开始', testConfig);
    const original = await harness.runTurn(
      harness.createStory({ title: '原创故事', rawScript: '原创角色站在雨里。' }),
      '开始',
      testConfig,
    );

    expect(result.assistantNode.content).toBe('雨声继续。');
    expect(result.assistantNode.publicResearch).toBeUndefined();
    expect(original.assistantNode.publicResearch).toBeUndefined();
    expect(lookupCalls).toBe(1);
    expect(narrationCalls).toBe(2);
  });

  it('refreshes research only when an explicit version or timeline changes', async () => {
    const identities: any[] = [];
    const provider = {
      async resolve(request: any) {
        identities.push(request.identity);
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: `### 爱德华\n- ${request.identity.version} / ${request.identity.timeline}。`,
          sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
          fetchedAt: 600,
        };
      },
    };
    const payloads: string[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: provider as any,
      transport: {
        async *streamChat(request) {
          payloads.push(JSON.stringify(request.messages));
          yield { contentDelta: '继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '开始', testConfig);
    const second = await harness.runTurn(
      first.story,
      '版本：2009 动画版\n剧情时点：第 64 集结局后\n角色：爱德华\n请从这里继续。',
      testConfig,
    );
    const third = await harness.runTurn(
      second.story,
      '他仍记得刚才的誓言，请继续。',
      testConfig,
    );
    await harness.runTurn(
      third.story,
      '版本：2010 动画版\n请从这里继续。',
      testConfig,
    );

    expect(identities.map((identity) => [identity.version, identity.timeline])).toEqual([
      ['2003 动画版', '第 51 集结局后'],
      ['2009 动画版', '第 64 集结局后'],
    ]);
    expect(payloads[1]).toContain('2009 动画版 / 第 64 集结局后');
    expect(payloads[1]).not.toContain('2003 动画版 / 第 51 集结局后');
    expect(payloads[2]).toContain('2009 动画版 / 第 64 集结局后');
    expect(payloads[2]).not.toContain('2003 动画版 / 第 51 集结局后');
  });

  it('never starts research for private drafts or explicitly original settings', async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      throw new Error('outbound lookup should not happen');
    });
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '按本地设定开场。', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      publicResearch: createDeepSeekPublicResearchProvider({ fetcher, transport }),
      transport,
    });
    const settings = [
      '作品：我没发表的草稿\n版本：2024 动画版\n剧情时点：第 3 集后\n角色：小林',
      '原作：我的原创角色设定\n版本：2024 动画版\n剧情时点：第 3 集后\n角色：小林',
      '原作：《我没发表的草稿》\n版本：2024 动画版\n剧情时点：第 3 集后\n角色：小林',
      '原作：《钢之炼金术师》\n版本：通用版\n剧情时点：第 51 集后\n角色：爱德华',
      '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n版本：2009 动画版\n剧情时点：第 64 集后\n角色：爱德华',
    ];

    for (const rawScript of settings) {
      const story = harness.createStory({ title: '本地草稿', rawScript });
      const result = await harness.runTurn(story, '开始', testConfig);
      expect(result.assistantNode.publicResearch).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it('does not mistake the letters in a public title for the OC marker', () => {
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《Doctor Who》\n版本：2005 电视剧版\n剧情时点：第 1 集后\n角色：博士',
    })).toEqual({
      work: 'Doctor Who',
      version: '2005 电视剧版',
      timeline: '第 1 集后',
      characters: ['博士'],
    });
  });

  it('keeps research for a generic writing phrase mixed with explicit story intent', async () => {
    const providerCalls: any[] = [];
    const provider = {
      async resolve(request: any) {
        providerCalls.push(request);
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: '### 爱德华·艾尔利克\n- 称呼弟弟为阿尔。',
          sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
          fetchedAt: 700,
        };
      },
    };
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '```lfh-route\nmode: story\ntitle: 钢之炼金术师\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克\n```\n\n雨落在中央市。' };
        yield { finishReason: 'stop' };
      },
    };
    const result = await routeEntryMessage(
      '帮我写一篇《钢之炼金术师》2003 动画版第 51 集结局后的文游，从第一幕开始，角色：爱德华·艾尔利克',
      [],
      transport,
      testConfig,
      {},
      '',
      { publicResearch: provider as any },
    );

    expect(providerCalls).toHaveLength(1);
    expect(result.mode).toBe('story');
    expect(result.publicResearch?.identity.characters).toEqual(['爱德华·艾尔利克']);
  });

  it('keeps the routed mode authoritative over preliminary research', async () => {
    const provider = {
      resolve: vi.fn(async (request: any) => {
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: '称呼弟弟为阿尔。',
          sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
          fetchedAt: 701,
        };
      }),
    };
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '```lfh-route\nmode: writing\ntitle: 钢之炼金术师同人\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克\n```\n\n从这段关系写起。' };
        yield { finishReason: 'stop' };
      },
    };
    const result = await routeEntryMessage(
      '写一篇《钢之炼金术师》2003 动画版第 51 集结局后的同人，角色：爱德华·艾尔利克',
      [],
      transport,
      testConfig,
      {},
      '',
      { publicResearch: provider as any },
    );

    expect(result.mode).toBe('writing');
    expect(result.publicResearch).toBeUndefined();
    expect(result.publicResearchFailure).toBeUndefined();
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('never searches for original or private character markers before parenthetical cleanup', async () => {
    const provider = {
      resolve: vi.fn(async () => {
        throw new Error('provider must not be called');
      }),
    };
    const harness = createFictionHarness({
      publicResearch: provider as any,
      transport: {
        async *streamChat() {
          yield { contentDelta: '按本地设定开场。', finishReason: 'stop' };
        },
      },
    });
    const settings = [
      '原作：《某公开作品》\n版本：2024 动画版\n剧情时点：第 3 集后\n角色：小林（原创OC）',
      '原作：《某公开作品》\n版本：2024 动画版\n剧情时点：第 3 集后\n角色：小林（自设，名字暂定）',
      '原作：《某公开作品》\n版本：不确定的 2024 动画版\n剧情时点：第 3 集后\n角色：小林',
    ];

    for (const rawScript of settings) {
      const story = await harness.createAndSaveStory({ title: '私有角色草稿', rawScript });
      const result = await harness.runTurn(story, '开始', testConfig);
      expect(result.assistantNode.publicResearch).toBeUndefined();
    }

    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('rejects multiple inline candidates or uncertainty but accepts one season-and-episode timeline', () => {
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版 或 2009 动画版\n剧情时点：第 51 集后\n角色：爱德华',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《钢之炼金术师》和《进击的巨人》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 1 集后 或 第 3 集后\n角色：爱德华',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《钢之炼金术师》\n版本：可能是 2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
      userInput: '版本：可能是 2009 动画版\n剧情时点：第 64 集后\n角色：爱德华',
    })).toBeNull();

    expect(derivePublicResearchIdentity({
      settingMarkdown: '原作：《某公开动画》\n版本：2024 动画第一季\n剧情时点：第 1 季第 3 集后\n角色：小林',
    })).toMatchObject({ timeline: '第 1 季第 3 集后' });
  });

  it('persists one failed lookup per identity and reuses it across ordinary turns and regeneration', async () => {
    const provider = {
      resolve: vi.fn(async () => {
        throw new Error('search unavailable');
      }),
    };
    const storage = createInMemoryStoryStorage();
    const harness = createFictionHarness({
      storage,
      publicResearch: provider as any,
      transport: {
        async *streamChat() {
          yield { contentDelta: '继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '私密输入CANARY', testConfig);
    const expectedKey = publicResearchIdentityKey({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华'],
    });

    expect(first.assistantNode.publicResearchFailure).toEqual({ identityKey: expectedKey });
    expect(JSON.stringify(first.assistantNode.publicResearchFailure)).not.toContain('CANARY');
    expect((await storage.getStory(story.id))?.nodes[first.assistantNode.id].publicResearchFailure)
      .toEqual({ identityKey: expectedKey });
    const restored = parseAndValidateFolioBackup(exportFolioBackupV3({
      stories: [first.story],
      workspace: emptyWorkspace(),
      now: () => 900,
    })).stories[0];
    expect(restored.nodes[first.assistantNode.id].publicResearchFailure).toEqual({ identityKey: expectedKey });

    const second = await harness.runTurn(first.story, '普通推进。', testConfig);
    await harness.regenerateNode(second.story, first.assistantNode.id, testConfig);

    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it('uses a supported public-style title fallback and retains it through incidental version mentions', async () => {
    expect(derivePublicResearchIdentity({
      title: '钢之炼金术师',
      settingMarkdown: '版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    })).toMatchObject({ work: '钢之炼金术师' });
    expect(derivePublicResearchIdentity({
      title: '炼金术师续篇',
      settingMarkdown: '版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    })).toBeNull();

    let lookups = 0;
    const payloads: string[] = [];
    const harness = createFictionHarness({
      publicResearch: {
        async resolve(request) {
          lookups += 1;
          return {
            identity: request.identity,
            identityKey: publicResearchIdentityKey(request.identity),
            summary: '### 爱德华\n- 说话短促，称呼弟弟为阿尔。',
            sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
            fetchedAt: 800,
          };
        },
      },
      transport: {
        async *streamChat(request) {
          payloads.push(JSON.stringify(request.messages));
          yield { contentDelta: '继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '钢之炼金术师',
      rawScript: '版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '开始。', testConfig);
    await harness.runTurn(first.story, '他提起 2009 动画版，但请继续当前情节。', testConfig);

    expect(lookups).toBe(1);
    expect(payloads[1]).toContain('说话短促');
  });
});
