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
  resolvePublicResearchForTurn,
  routeEntryMessage,
  type FetchLike,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
  type TurnNode,
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

  it('never promotes generic asset titles or private field tails into lookup metadata', async () => {
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
      '版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
      '版本：2003 动画版\n剧情时点：第 51 集后（作者自创秘密）\n角色：爱德华',
    ];

    for (const rawScript of settings) {
      const story = harness.createStory({ title: '雨夜重逢', rawScript });
      const result = await harness.runTurn(story, '开始。', testConfig);
      expect(result.assistantNode.publicResearch).toBeUndefined();
    }

    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('accepts bounded work identifiers but rejects raw label tails', () => {
    const input = (work: string) => ({
      settingMarkdown: `原作：${work}\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华`,
    });

    for (const work of [
      '雨夜重逢 私密补充',
      '某公开作品，内部说明',
      '某公开作品（内部说明）',
      '《某公开作品》私密补充',
      '《某公开作品》（内部说明）',
    ]) {
      expect(derivePublicResearchIdentity(input(work))).toBeNull();
    }

    expect(derivePublicResearchIdentity(input('某公开作品'))).toMatchObject({ work: '某公开作品' });
    expect(derivePublicResearchIdentity(input('Doctor Who'))).toMatchObject({ work: 'Doctor Who' });
    expect(derivePublicResearchIdentity(input('《Re:从零开始的异世界生活》'))).toMatchObject({
      work: 'Re:从零开始的异世界生活',
    });
  });

  it('normalizes Markdown labels and trailing Chinese periods without accepting arbitrary tails', () => {
    const settingMarkdown = [
      '- **原作**：《钢之炼金术师》',
      '- **版本**：**2003 动画版**。',
      '- **剧情时点**：第 51 集结局后。',
      '- **角色**：**爱德华·艾尔利克**。',
      '- **角色**：阿尔冯斯·艾尔利克。',
    ].join('\n');

    expect(derivePublicResearchIdentity({ settingMarkdown })).toEqual({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集结局后',
      characters: ['爱德华·艾尔利克', '阿尔冯斯·艾尔利克'],
    });

    for (const invalidSetting of [
      settingMarkdown.replace('2003 动画版**。', '2003 动画版**。附带说明'),
      settingMarkdown.replace('第 51 集结局后。', '第 51 集结局后。附带说明'),
      settingMarkdown.replace('阿尔冯斯·艾尔利克。', '阿尔冯斯·艾尔利克。附带说明'),
    ]) {
      expect(derivePublicResearchIdentity({ settingMarkdown: invalidSetting })).toBeNull();
    }
  });

  it('keeps known fan-AU lookup while scoping uncertainty and private markers to matching fields', () => {
    const settingMarkdown = [
      '原作：《哈利·波特》',
      '版本：2011 电影版',
      '剧情时点：第 8 部后',
      '角色：哈利·波特、赫敏·格兰杰',
      '同人改设：哈利可能没有走进禁林，后续仍未确定。',
      '人物状态：他大概很疲惫，也可能在犹豫。',
    ].join('\n');

    expect(derivePublicResearchIdentity({
      settingMarkdown,
      userInput: '他可能还在犹豫，但请继续当前情节。',
    })).toEqual({
      work: '哈利·波特',
      version: '2011 电影版',
      timeline: '第 8 部后',
      characters: ['哈利·波特', '赫敏·格兰杰'],
    });
    expect(derivePublicResearchIdentity({
      settingMarkdown,
      userInput: '版本：可能是 2009 电影版，请继续。',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown,
      userInput: '切换到也许 2009 电影版，请继续。',
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      settingMarkdown: settingMarkdown.replace('角色：哈利·波特、赫敏·格兰杰', '角色：哈利·波特（原创OC）'),
    })).toBeNull();
    expect(derivePublicResearchIdentity({
      title: '哈利·波特',
      settingMarkdown: '版本：2011 电影版\n剧情时点：第 8 部后\n角色：哈利·波特',
    })).toBeNull();
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

  it('pins public-research synthesis to background Flash/none while keeping the foreground request on Pro/max', async () => {
    const fetcher: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      async text() {
        return url.endsWith('/v1/tools/search')
          ? JSON.stringify({
              results: [{
                rerank_score: 2.6,
                authority: 4,
                title: '官方角色介绍',
                url: 'https://official.example/edward',
              }],
            })
          : JSON.stringify({ title: '官方角色介绍', content: '爱德华·艾尔利克说话短促。' });
      },
    });
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(request) {
        requests.push(request);
        const synthesis = JSON.stringify(request.messages).includes('公开角色资料提炼器');
        yield {
          contentDelta: synthesis
            ? '### 爱德华·艾尔利克\n- 说话短促。'
            : '```lfh-route\nmode: story\ntitle: 钢之炼金术师\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克\n```\n\n雨落在中央市。',
        };
        yield { finishReason: 'stop' };
      },
    };
    const foregroundConfig: ModelConfig = {
      ...testConfig,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    };
    const provider = createDeepSeekPublicResearchProvider({ fetcher, transport });

    await routeEntryMessage(
      '开一个《钢之炼金术师》2003 动画版第 51 集后的文游，角色：爱德华·艾尔利克',
      [],
      transport,
      foregroundConfig,
      {},
      '',
      { publicResearch: provider },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: 'deepseek-flash',
      reasoningEffort: 'none',
    });
    expect(requests[1]).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    expect(foregroundConfig).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
  });

  it('verifies character candidates against fetched public text before synthesis', async () => {
    for (const privateTail of ['私密关系设定', '阿信']) {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetcher: FetchLike = async (url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        requests.push({ url, body });
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
                  authority: 4,
                  title: '官方角色介绍',
                  url: 'https://official.example/edward',
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
              content: '爱德华·艾尔利克说话短促，通常会先观察四周。',
            });
          },
        };
      };
      let synthesisMessages: unknown;
      const provider = createDeepSeekPublicResearchProvider({
        fetcher,
        transport: {
          async *streamChat(request) {
            synthesisMessages = request.messages;
            yield { contentDelta: '### 爱德华·艾尔利克\n- 说话短促。' };
            yield { finishReason: 'stop' };
          },
        },
      });

      const reference = await provider.resolve({
        identity: {
          work: '钢之炼金术师',
          version: '2003 动画版',
          timeline: '第 51 集结局后',
          characters: ['爱德华·艾尔利克', privateTail],
        },
        config: testConfig,
      });

      expect(reference).not.toBeNull();
      const searchQuery = String(requests[0].body.query);
      expect(searchQuery).toContain('钢之炼金术师');
      expect(searchQuery).toContain('2003 动画版');
      expect(searchQuery).toContain('第 51 集结局后');
      expect(searchQuery).not.toContain('爱德华·艾尔利克');
      expect(searchQuery).not.toContain(privateTail);
      expect(JSON.stringify(synthesisMessages)).toContain('爱德华·艾尔利克');
      expect(JSON.stringify(synthesisMessages)).not.toContain(privateTail);
    }
  });

  it('falls back before synthesis when fetched public text verifies no character candidate', async () => {
    const fetcher: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      async text() {
        return url.endsWith('/v1/tools/search')
          ? JSON.stringify({
              results: [{
                rerank_score: 2.6,
                authority: 4,
                title: '公开作品资料',
                url: 'https://official.example/cast',
              }],
            })
          : JSON.stringify({ title: '公开作品资料', content: '该页面没有列出用户设定中的角色。' });
      },
    });
    const transport = {
      streamChat: vi.fn(async function* () {
        yield { contentDelta: 'unexpected', finishReason: 'stop' };
      }),
    };
    const provider = createDeepSeekPublicResearchProvider({
      fetcher,
      transport: transport as any,
    });

    await expect(provider.resolve({
      identity: {
        work: '钢之炼金术师',
        version: '2003 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华·艾尔利克', '阿信'],
      },
      config: testConfig,
    })).resolves.toBeNull();
    expect(transport.streamChat).not.toHaveBeenCalled();
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

  it.each([
    '角色：阿尔冯斯说：“哥哥，走吧。”',
    '角色：阿尔冯斯',
  ])('keeps the cached two-character scene for ordinary speaker input: %s', async (speakerInput) => {
    const identities: unknown[] = [];
    const payloads: unknown[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: {
        async resolve(request) {
          identities.push(request.identity);
          return {
            identity: request.identity,
            identityKey: publicResearchIdentityKey(request.identity),
            summary: [
              '### 爱德华·艾尔利克',
              '- 称呼弟弟为阿尔。',
              '### 阿尔冯斯·艾尔利克',
              '- 习惯称哥哥为哥哥。',
            ].join('\n'),
            sources: [{ title: '官方角色页', url: 'https://official.example/characters' }],
            fetchedAt: 125,
          };
        },
      },
      transport: {
        async *streamChat(request) {
          payloads.push(request.messages);
          yield { contentDelta: '继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师雨夜',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克',
    });

    const first = await harness.runTurn(story, '开始。', testConfig);
    const second = await harness.runTurn(first.story, speakerInput, testConfig);

    expect(identities).toHaveLength(1);
    expect(JSON.stringify(payloads[1])).toContain('公开资料参考');
    expect(JSON.stringify(payloads[1])).toContain('称呼弟弟为阿尔');
    expect(JSON.stringify(payloads[1])).toContain('习惯称哥哥为哥哥');
    expect(second.assistantNode.publicResearch?.identityKey).toBe(first.assistantNode.publicResearch?.identityKey);
  });

  it('refreshes when the user explicitly switches to a new interaction target', async () => {
    const identities: any[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: {
        async resolve(request) {
          identities.push(request.identity);
          return {
            identity: request.identity,
            identityKey: publicResearchIdentityKey(request.identity),
            summary: request.identity.characters.map((name) => `### ${name}\n- 参考语气。`).join('\n'),
            sources: [{ title: '官方角色页', url: 'https://official.example/characters' }],
            fetchedAt: 150,
          };
        },
      },
      transport: {
        async *streamChat() {
          yield { contentDelta: '继续。', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '炼金术师雨夜',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克',
    });
    const first = await harness.runTurn(story, '开始。', testConfig);

    const second = await harness.runTurn(first.story, '切换到角色：阿尔冯斯', testConfig);

    expect(identities.map((identity) => identity.characters)).toEqual([
      ['爱德华·艾尔利克', '阿尔冯斯·艾尔利克'],
      ['阿尔冯斯'],
    ]);
    expect(second.assistantNode.publicResearch?.identity.characters).toEqual(['阿尔冯斯']);
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

  it('derives research from bounded recent user welcome history when the current input only says start', async () => {
    let providerCall: any = null;
    const provider = {
      async resolve(request: any) {
        providerCall = request;
        return {
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: '### 爱德华·艾尔利克\n- 称呼弟弟为阿尔。',
          sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
          fetchedAt: 225,
        };
      },
    };
    let welcomeMessages: unknown;
    const transport: LlmTransport = {
      async *streamChat(request) {
        welcomeMessages = request.messages;
        yield { contentDelta: '```lfh-route\nmode: story\ntitle: 炼金术师续篇\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克\n```\n\n门口响起脚步声。' };
        yield { finishReason: 'stop' };
      },
    };
    const makeNode = (id: string, role: TurnNode['role'], content: string): TurnNode => ({
      id,
      parentId: null,
      role,
      content,
      createdAt: Number(id.replace(/\D/g, '')) || 1,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    });
    const neutralHistory: TurnNode[] = [
      makeNode('u0', 'user', '原作：《哈利·波特》\n版本：2011 电影版\n剧情时点：第 8 部后\n角色：哈利·波特'),
      ...Array.from({ length: 12 }, (_, index) => makeNode(`u${index + 1}`, 'user', `继续聊聊${index + 1}`)),
      makeNode(
        'u13',
        'user',
        '开一个《钢之炼金术师》文游。\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克、阿尔冯斯·艾尔利克\n私密备注：CANARY-NOT-FOR-LOOKUP',
      ),
      makeNode(
        'a14',
        'assistant',
        '可以用《进击的巨人》作为原作，版本：2013 动画版，剧情时点：第 1 集后，角色：艾伦。',
      ),
    ];

    const result = await routeEntryMessage(
      '开始吧。',
      neutralHistory,
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
      characters: ['爱德华·艾尔利克', '阿尔冯斯·艾尔利克'],
    });
    expect(JSON.stringify(providerCall?.identity)).not.toContain('CANARY-NOT-FOR-LOOKUP');
    expect(JSON.stringify(welcomeMessages)).toContain('公开资料参考');
    expect(JSON.stringify(welcomeMessages)).toContain('称呼弟弟为阿尔');
    expect(result.publicResearch?.summary).toContain('称呼弟弟为阿尔');
  });

  it('does not treat assistant welcome history as public lookup authority', async () => {
    const provider = { resolve: vi.fn() };
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '我们可以从这个方向继续。' };
        yield { finishReason: 'stop' };
      },
    };
    const assistantHistory: TurnNode[] = [{
      id: 'assistant-1',
      parentId: null,
      role: 'assistant',
      content: '开一个《钢之炼金术师》文游。\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克',
      createdAt: 1,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    }];

    const result = await routeEntryMessage(
      '开始吧。',
      assistantHistory,
      transport,
      testConfig,
      {},
      '',
      { publicResearch: provider as any },
    );

    expect(provider.resolve).not.toHaveBeenCalled();
    expect(result.publicResearch).toBeUndefined();
  });

  it('honors the newest explicit writing correction over older story intent in welcome history', async () => {
    const provider = { resolve: vi.fn() };
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '```lfh-route\nmode: writing\ntitle: 钢之炼金术师同人\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克\n```\n\n雨落在中央市。' };
        yield { finishReason: 'stop' };
      },
    };
    const neutralHistory: TurnNode[] = [{
      id: 'user-1',
      parentId: null,
      role: 'user',
      content: '开一个《钢之炼金术师》文游。\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克',
      createdAt: 1,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    }, {
      id: 'user-2',
      parentId: 'user-1',
      role: 'user',
      content: '不要写成文游，按小说来。',
      createdAt: 2,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    }];

    const result = await routeEntryMessage(
      '开始吧。',
      neutralHistory,
      transport,
      testConfig,
      {},
      '',
      { publicResearch: provider as any },
    );

    expect(result.mode).toBe('writing');
    expect(provider.resolve).not.toHaveBeenCalled();
    expect(result.publicResearch).toBeUndefined();
  });

  it.each([
    ['leading rejection', '不用角色互动，帮我写一篇正文。'],
    ['trailing rejection', '角色互动不要了，帮我写一篇正文。'],
  ])('treats a latest %s as authoritative over older character mode', async (_case, latest) => {
    const provider = {
      resolve: vi.fn(async () => ({
        identity: {
          work: '钢之炼金术师',
          version: '2003 动画版',
          timeline: '第 51 集后',
          characters: ['爱德华·艾尔利克'],
        },
        identityKey: '钢之炼金术师|2003 动画版|第 51 集后|爱德华·艾尔利克',
        summary: '### 爱德华·艾尔利克\n- 称呼弟弟为阿尔。',
        sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
        fetchedAt: 250,
      })),
    };
    const neutralHistory: TurnNode[] = [{
      id: 'user-1',
      parentId: null,
      role: 'user',
      content: [
        '想开角色互动。',
        '原作：《钢之炼金术师》',
        '版本：2003 动画版',
        '剧情时点：第 51 集后',
        '角色：爱德华·艾尔利克',
      ].join('\n'),
      createdAt: 1,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    }];
    const routedPayloads: string[] = [];
    const routedTransport: LlmTransport = {
      async *streamChat(request) {
        routedPayloads.push(JSON.stringify(request.messages));
        yield { contentDelta: '```lfh-route\nmode: writing\ntitle: 钢之炼金术师同人\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克\n```\n\n雨落在中央市。' };
        yield { finishReason: 'stop' };
      },
    };
    const fallbackPayloads: string[] = [];
    const fallbackTransport: LlmTransport = {
      async *streamChat(request) {
        fallbackPayloads.push(JSON.stringify(request.messages));
        yield { contentDelta: '雨落在中央市。' };
        yield { finishReason: 'stop' };
      },
    };

    const routed = await routeEntryMessage(latest, neutralHistory, routedTransport, testConfig, {}, '', {
      publicResearch: provider as any,
    });
    expect(routed.mode).toBe('writing');
    expect(routed.publicResearch).toBeUndefined();
    expect(routedPayloads).toHaveLength(1);
    expect(routedPayloads[0]).not.toContain('公开资料参考');
    expect(provider.resolve).not.toHaveBeenCalled();

    const fallback = await routeEntryMessage(latest, neutralHistory, fallbackTransport, testConfig, {}, '', {
      publicResearch: provider as any,
    });
    expect(fallback.mode).toBe('writing');
    expect(fallback.usedFallback).toBe(true);
    expect(fallback.publicResearch).toBeUndefined();
    expect(fallbackPayloads).toHaveLength(1);
    expect(fallbackPayloads[0]).not.toContain('公开资料参考');
    expect(provider.resolve).not.toHaveBeenCalled();
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
    expect(restored.nodes[turn.assistantNode.id].publicResearchSettingKey).toEqual(
      publicResearchIdentityKey(identity),
    );
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

  it('inherits saved scope for concrete version-only pivots and reuses each result', async () => {
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
      '版本：2009 动画版',
      testConfig,
    );
    const third = await harness.runTurn(
      second.story,
      '他仍记得刚才的誓言，请继续。',
      testConfig,
    );
    const fourth = await harness.runTurn(
      third.story,
      '切换到 2010 动画版',
      testConfig,
    );
    const fifth = await harness.runTurn(fourth.story, '继续推进。', testConfig);

    expect(identities).toEqual([
      {
        work: '钢之炼金术师',
        version: '2003 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华'],
      },
      {
        work: '钢之炼金术师',
        version: '2009 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华'],
      },
      {
        work: '钢之炼金术师',
        version: '2010 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华'],
      },
    ]);
    expect(payloads[1]).toContain('2009 动画版 / 第 51 集结局后');
    expect(payloads[2]).toContain('2009 动画版 / 第 51 集结局后');
    expect(payloads[3]).toContain('2010 动画版 / 第 51 集结局后');
    expect(payloads[4]).toContain('2010 动画版 / 第 51 集结局后');
    expect(fifth.assistantNode.publicResearch?.identity.version).toBe('2010 动画版');
  });

  it('refreshes research when the saved setting changes scope without refreshing on incidental mentions', async () => {
    const identities: any[] = [];
    const payloads: string[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: {
        async resolve(request) {
          identities.push(request.identity);
          return {
            identity: request.identity,
            identityKey: publicResearchIdentityKey(request.identity),
            summary: `### 爱德华\n- ${request.identity.version} / ${request.identity.timeline}。`,
            sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
            fetchedAt: 650,
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
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '开始。', testConfig);
    const leafId = first.story.activeLeafNodeId!;
    const containerId = first.story.nodes[leafId]?.documents?.container ?? first.story.documents!.container.head;
    const currentSetting = documentVersion(first.story.documents!.container, containerId).markdown;
    const edited = editStoryDocument(
      first.story,
      'container',
      containerId,
      currentSetting.replace('2003 动画版', '2009 动画版').replace('第 51 集后', '第 64 集后'),
    );
    const saved = await harness.saveStory(edited, first.story.updatedAt);
    const second = await harness.runTurn(saved, '按新版本继续。', testConfig);
    const third = await harness.runTurn(
      second.story,
      '他偶然提起 2003 动画版，但请继续当前情节。',
      testConfig,
    );

    expect(identities.map((identity) => [identity.version, identity.timeline])).toEqual([
      ['2003 动画版', '第 51 集后'],
      ['2009 动画版', '第 64 集后'],
    ]);
    expect(payloads[1]).toContain('2009 动画版 / 第 64 集后');
    expect(payloads[1]).not.toContain('2003 动画版 / 第 51 集后');
    expect(payloads[2]).toContain('2009 动画版 / 第 64 集后');
    expect(payloads[2]).not.toContain('2003 动画版 / 第 51 集后');
  });

  it('ties an in-dialogue override to its source setting and refreshes after the saved setting changes', async () => {
    const identities: any[] = [];
    const payloads: string[] = [];
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      publicResearch: {
        async resolve(request) {
          identities.push(request.identity);
          return {
            identity: request.identity,
            identityKey: publicResearchIdentityKey(request.identity),
            summary: `### 爱德华\n- ${request.identity.version} / ${request.identity.timeline}。`,
            sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
            fetchedAt: 675,
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
      title: '炼金术师续篇',
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '开始。', testConfig);
    const second = await harness.runTurn(
      first.story,
      '版本：2009 动画版\n剧情时点：第 64 集后\n角色：爱德华\n请从这里继续。',
      testConfig,
    );
    const third = await harness.runTurn(second.story, '请继续刚才的剧情。', testConfig);
    const sourceSettingKey = publicResearchIdentityKey({
      work: '钢之炼金术师',
      version: '2003 动画版',
      timeline: '第 51 集后',
      characters: ['爱德华'],
    });
    const editedSettingKey = publicResearchIdentityKey({
      work: '钢之炼金术师',
      version: '2010 动画版',
      timeline: '第 51 集后',
      characters: ['爱德华'],
    });

    expect((second.assistantNode as any).publicResearchSettingKey).toBe(sourceSettingKey);
    expect((third.assistantNode as any).publicResearchSettingKey).toBe(sourceSettingKey);

    const leafId = third.story.activeLeafNodeId!;
    const containerId = third.story.nodes[leafId]?.documents?.container ?? third.story.documents!.container.head;
    const currentSetting = documentVersion(third.story.documents!.container, containerId).markdown;
    const edited = editStoryDocument(
      third.story,
      'container',
      containerId,
      currentSetting.replace('2003 动画版', '2010 动画版'),
    );
    const saved = await harness.saveStory(edited, third.story.updatedAt);
    const fourth = await harness.runTurn(saved, '按更新后的设定继续。', testConfig);

    expect(identities.map((identity) => [identity.version, identity.timeline])).toEqual([
      ['2003 动画版', '第 51 集后'],
      ['2009 动画版', '第 64 集后'],
      ['2010 动画版', '第 51 集后'],
    ]);
    expect(payloads[2]).toContain('2009 动画版 / 第 64 集后');
    expect(payloads[3]).toContain('2010 动画版 / 第 51 集后');
    expect(payloads[3]).not.toContain('2009 动画版 / 第 64 集后');
    expect((fourth.assistantNode as any).publicResearchSettingKey).toBe(editedSettingKey);
  });

  it('keeps ownerless legacy cache entries usable only for an exact identity match', async () => {
    const legacyIdentity = {
      work: '钢之炼金术师',
      version: '2009 动画版',
      timeline: '第 64 集后',
      characters: ['爱德华'],
    };
    const legacyReference = {
      identity: legacyIdentity,
      identityKey: publicResearchIdentityKey(legacyIdentity),
      summary: '### 爱德华\n- 2009 版参考。',
      sources: [{ title: '官方角色页', url: 'https://official.example/edward' }],
      fetchedAt: 676,
    };
    const snapshot = { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };
    const nodes: Record<string, TurnNode> = {
      'user-2009': {
        id: 'user-2009',
        parentId: null,
        role: 'user',
        content: '版本：2009 动画版\n剧情时点：第 64 集后\n角色：爱德华',
        createdAt: 1,
        summarySnapshot: snapshot,
      },
      'assistant-2009': {
        id: 'assistant-2009',
        parentId: 'user-2009',
        role: 'assistant',
        content: '继续。',
        createdAt: 2,
        summarySnapshot: snapshot,
        publicResearch: legacyReference,
      },
    };
    let lookups = 0;
    const provider = {
      async resolve(request: any) {
        lookups += 1;
        return {
          ...legacyReference,
          identity: request.identity,
          identityKey: publicResearchIdentityKey(request.identity),
          summary: `### 爱德华\n- ${request.identity.version} 参考。`,
        };
      },
    };
    const exact = await resolvePublicResearchForTurn({
      provider,
      nodes,
      parentId: 'assistant-2009',
      settingMarkdown: '原作：《钢之炼金术师》\n版本：2009 动画版\n剧情时点：第 64 集后\n角色：爱德华',
      userInput: '继续。',
      config: testConfig,
    });
    const changed = await resolvePublicResearchForTurn({
      provider,
      nodes,
      parentId: 'assistant-2009',
      settingMarkdown: '原作：《钢之炼金术师》\n版本：2010 动画版\n剧情时点：第 64 集后\n角色：爱德华',
      userInput: '继续。',
      config: testConfig,
    });

    expect(exact.reference).toBe(legacyReference);
    expect(lookups).toBe(1);
    expect(changed.reference?.identity.version).toBe('2010 动画版');
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

  it('never researches or decorates writing when stage intent is negated', async () => {
    const provider = { resolve: vi.fn() };
    const payloads: string[] = [];
    const transport: LlmTransport = {
      async *streamChat(request) {
        payloads.push(JSON.stringify(request.messages));
        yield {
          contentDelta: '```lfh-route\nmode: writing\ntitle: 钢之炼金术师同人\n---\n原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克\n```\n\n雨落在中央市。',
        };
        yield { finishReason: 'stop' };
      },
    };
    const prompts = [
      '写一篇《钢之炼金术师》2003 动画版第 51 集后的小说，不要写成文游。角色：爱德华·艾尔利克',
      '写一段《钢之炼金术师》2003 动画版第 51 集后的同人，不是文游，而是小说。角色：爱德华·艾尔利克',
      '请写一篇《钢之炼金术师》2003 动画版第 51 集后的小说，不要把它做成文游，也不要按角色互动处理。角色：爱德华·艾尔利克',
      '写一篇《钢之炼金术师》2003 动画版第 51 集后的小说，从第一幕开始，不要写成文游。角色：爱德华·艾尔利克',
      '写一段《钢之炼金术师》2003 动画版第 51 集后的同人，不是文游而是写一篇小说。角色：爱德华·艾尔利克',
    ];

    for (const prompt of prompts) {
      const result = await routeEntryMessage(prompt, [], transport, testConfig, {}, '', {
        publicResearch: provider as any,
      });
      expect(result.mode).toBe('writing');
      expect(result.publicResearch).toBeUndefined();
      expect(result.publicResearchFailure).toBeUndefined();
      expect(payloads.at(-1)).not.toContain('公开资料参考');
    }

    expect(provider.resolve).not.toHaveBeenCalled();
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

  it('requires complete concrete version and timeline tokens', () => {
    const identityInput = (version: string, timeline: string) => ({
      settingMarkdown: [
        '原作：《钢之炼金术师》',
        `版本：${version}`,
        `剧情时点：${timeline}`,
        '角色：爱德华',
      ].join('\n'),
    });

    for (const [version, timeline] of [
      ['动画版', '第 51 集后'],
      ['2003/2009 动画版', '第 51 集后'],
      ['2003／2009 动画版', '第 51 集后'],
      ['2003、2009 动画版', '第 51 集后'],
      ['2003 或 2009 动画版', '第 51 集后'],
      ['2003 动画版/2009 动画版', '第 51 集后'],
      ['2003 动画版', '之后'],
      ['2003 动画版（制作组备注）', '第 51 集后'],
      ['2003 动画版', '第 51 集后，作者备注'],
    ]) {
      expect(derivePublicResearchIdentity(identityInput(version, timeline))).toBeNull();
    }

    expect(derivePublicResearchIdentity(identityInput('2003动画版', '第 51 集之后'))).toEqual({
      work: '钢之炼金术师',
      version: '2003动画版',
      timeline: '第 51 集之后',
      characters: ['爱德华'],
    });
    expect(derivePublicResearchIdentity(identityInput('动画 第1季', '第1季第3集后'))).toEqual({
      work: '钢之炼金术师',
      version: '动画 第1季',
      timeline: '第1季第3集后',
      characters: ['爱德华'],
    });
  });

  it('never falls back to the saved scope after an explicit ambiguous field update', () => {
    const settingMarkdown = [
      '原作：《钢之炼金术师》',
      '版本：2003 动画版',
      '剧情时点：第 51 集后',
      '角色：爱德华',
    ].join('\n');

    for (const userInput of [
      '版本：动画版\n请继续。',
      '版本：2003/2009 动画版\n请继续。',
      '剧情时点：之后\n请继续。',
      '原作：雨夜重逢 私密补充\n请继续。',
      '切换到动画版\n请继续。',
      '切换到 2003/2009 动画版\n请继续。',
    ]) {
      expect(derivePublicResearchIdentity({ settingMarkdown, userInput })).toBeNull();
    }
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

  it('never uses an asset title as public metadata and ignores incidental version mentions', async () => {
    for (const title of ['钢之炼金术师', '炼金术师续篇']) {
      expect(derivePublicResearchIdentity({
        title,
        settingMarkdown: '版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
      })).toBeNull();
    }

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
      rawScript: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华',
    });
    const first = await harness.runTurn(story, '开始。', testConfig);
    await harness.runTurn(first.story, '他提起 2009 动画版，但请继续当前情节。', testConfig);

    expect(lookups).toBe(1);
    expect(payloads[1]).toContain('说话短促');
  });
});
