import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createModelConfigStore,
  createOpenAiTransport,
  parseOpenAiSseStream,
  type KeyValueStorage,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('Slice 1: OpenAI SSE streaming & reasoning separation', () => {
  it('decodes split multi-byte UTF-8 chunks and separates reasoning_content from content', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"reasoning_content":"思考过程："}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"分析局势"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"夜色降临，"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"灯火摇曳。"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const bytes = new TextEncoder().encode(ssePayload);
    // Split mid-UTF-8 character intentionally across tiny chunks (5 bytes each)
    async function* chunkGenerator(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 5) {
        yield bytes.slice(i, i + 5);
      }
    }

    const reasoningParts: string[] = [];
    const contentParts: string[] = [];
    let finishReason: string | null | undefined;

    for await (const delta of parseOpenAiSseStream(chunkGenerator())) {
      if (delta.reasoningDelta) reasoningParts.push(delta.reasoningDelta);
      if (delta.contentDelta) contentParts.push(delta.contentDelta);
      if (delta.finishReason) finishReason = delta.finishReason;
    }

    expect(reasoningParts.join('')).toBe('思考过程：分析局势');
    expect(contentParts.join('')).toBe('夜色降临，灯火摇曳。');
    expect(finishReason).toBe('stop');
  });

  it('surfaces DeepSeek cache usage from the final stream chunk and requests usage with a bounded output length', async () => {
    const transport = createOpenAiTransport(async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_tokens).toBe(512);
      const payload = new TextEncoder().encode([
        'data: {"choices":[{"delta":{"content":"铜钥匙还在。"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":18,"total_tokens":138,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":20,"completion_tokens_details":{"reasoning_tokens":7}}}\n\n',
        'data: [DONE]\n\n',
      ].join(''));
      let read = false;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        body: {
          getReader: () => ({
            async read() {
              if (read) return { done: true };
              read = true;
              return { done: false, value: payload };
            },
            releaseLock() {},
          }),
        },
      };
    });

    const deltas = [];
    for await (const delta of transport.streamChat({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test-key',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '钥匙呢' }],
      includeUsage: true,
      maxOutputTokens: 512,
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([
      { contentDelta: '铜钥匙还在。', reasoningDelta: undefined, finishReason: 'stop' },
      {
        contentDelta: undefined,
        reasoningDelta: undefined,
        finishReason: undefined,
        usage: {
          promptTokens: 120,
          completionTokens: 18,
          totalTokens: 138,
          promptCacheHitTokens: 100,
          promptCacheMissTokens: 20,
          completionTokensDetails: { reasoningTokens: 7 },
        },
      },
    ]);
  });

  it('throws descriptive error when OpenAI transport receives non-2xx HTTP response', async () => {
    const transport = createOpenAiTransport(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":{"message":"Invalid key"}}',
      body: null,
    }));

    const req: LlmStreamRequest = {
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret-token',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const collect = async () => {
      for await (const _ of transport.streamChat(req)) {
        // no-op
      }
    };

    await expect(collect()).rejects.toThrow(/401/);
  });

  it('throws on in-stream SSE error payload', async () => {
    const ssePayload = 'data: {"error":{"message":"Rate limit reached"}}\n\n';
    async function* chunks(): AsyncIterable<string> {
      yield ssePayload;
    }

    const collect = async () => {
      for await (const _ of parseOpenAiSseStream(chunks())) {
        // no-op
      }
    };

    await expect(collect()).rejects.toThrow(/Rate limit reached/);
  });

  it('accumulates multi-line data: blocks within a single SSE event frame and preserves real-time per-event streaming', async () => {
    const firstChunk = [
      'event: message\r\n',
      ': keepalive\r\n',
      'data: {\r\n',
      'data:   "choices": [{\r\n',
      'data:     "delta": {"content": "跨行"}\r\n',
      'data:   }]\r\n',
      'data: }\r\n',
      '\r\n',
    ].join('');
    const secondChunk = 'data: {"choices":[{"delta":{"content":"实时"},"finish_reason":"stop"}]}\n\n';
    const doneChunk = 'data: [DONE]\n\n';

    async function* chunks(): AsyncIterable<string> {
      yield firstChunk;
      yield secondChunk;
      yield doneChunk;
    }

    const iter = parseOpenAiSseStream(chunks())[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value?.contentDelta).toBe('跨行');

    const second = await iter.next();
    expect(second.done).toBe(false);
    expect(second.value?.contentDelta).toBe('实时');
    expect(second.value?.finishReason).toBe('stop');

    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  it('streams chunks via getReader() ReadableStream body and releases lock when finished', async () => {
    const encoder = new TextEncoder();
    const payloads = [
      encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先查"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"再答"},"finish_reason":"stop"}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ];
    let index = 0;
    let lockReleased = false;

    const transport = createOpenAiTransport(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      body: {
        getReader() {
          return {
            async read() {
              if (index >= payloads.length) {
                return { done: true };
              }
              return { done: false, value: payloads[index++] };
            },
            releaseLock() {
              lockReleased = true;
            },
          };
        },
      },
    }));

    const deltas = [];
    for await (const d of transport.streamChat({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      deltas.push(d);
    }

    expect(deltas).toEqual([
      { contentDelta: undefined, reasoningDelta: '先查', finishReason: undefined },
      { contentDelta: '再答', reasoningDelta: undefined, finishReason: 'stop' },
    ]);
    expect(lockReleased).toBe(true);
  });
});

describe('Slice 1: BYOK ModelConfigStore persistence & session-memory toggle', () => {
  it('persists apiKey when memoryOnly is false, and purges it on switch to memoryOnly', () => {
    const persistent = createMemoryStorage();
    const store = createModelConfigStore(persistent);

    store.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test-123',
      memoryOnly: false,
    });

    // Simulate reload with a fresh store instance
    const reloaded = createModelConfigStore(persistent);
    expect(reloaded.load()).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test-123',
      memoryOnly: false,
    });

    // Enable memory-only mode: key stays in current instance memory, removed from persistent storage
    reloaded.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test-123',
      memoryOnly: true,
    });
    expect(reloaded.load().apiKey).toBe('sk-test-123');

    // Simulate page refresh: new store instance only sees persistent storage
    const afterRefresh = createModelConfigStore(persistent);
    expect(afterRefresh.load()).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: '',
      memoryOnly: true,
    });
  });
});

describe('Slice 1: FictionHarness streaming turn execution', () => {
  it('streams reasoning and content separately and omits reasoningContent from subsequent request history', async () => {
    const capturedRequests: LlmStreamRequest[] = [];
    let turnCall = 0;

    const transport: LlmTransport = {
      async *streamChat(req) {
        capturedRequests.push(req);
        turnCall += 1;
        if (turnCall === 1) {
          yield { reasoningDelta: '推理1：先确认主角处境' };
          yield { contentDelta: '第一幕：你在雨夜推开茶馆木门。', finishReason: 'stop' };
        } else {
          yield { contentDelta: '第二幕：掌柜抬头看向你。', finishReason: 'stop' };
        }
      },
    };

    let seq = 0;
    const harness = createFictionHarness({
      transport,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `node-${++seq}`,
    });

    const story = harness.createStory({ title: '雨夜茶馆' });
    const streamedReasoning: string[] = [];
    const streamedContent: string[] = [];

    const first = await harness.runTurn(
      story,
      '我走进茶馆',
      {
        baseUrl: '/__dev_llm_proxy',
        model: 'deepseek-v4.1-flash',
        apiKey: 'test',
        memoryOnly: true,
      },
      {
        onReasoningDelta: (d) => streamedReasoning.push(d),
        onContentDelta: (d) => streamedContent.push(d),
      },
    );

    expect(streamedReasoning.join('')).toBe('推理1：先确认主角处境');
    expect(streamedContent.join('')).toBe('第一幕：你在雨夜推开茶馆木门。');
    expect(first.assistantNode.reasoningContent).toBe('推理1：先确认主角处境');
    expect(first.assistantNode.content).toBe('第一幕：你在雨夜推开茶馆木门。');

    const second = await harness.runTurn(first.story, '我坐下点茶', {
      baseUrl: '/__dev_llm_proxy',
      model: 'deepseek-v4.1-flash',
      apiKey: 'test',
      memoryOnly: true,
    });

    expect(capturedRequests).toHaveLength(2);
    const secondMessages = capturedRequests[1].messages;
    expect(secondMessages.some((m) => m.content.includes('推理1'))).toBe(false);
    expect(secondMessages.some((m) => m.content.includes('第一幕：你在雨夜推开茶馆木门。'))).toBe(true);
    expect(second.story.activeLeafNodeId).toBe(second.assistantNode.id);
  });

  it('aborts runTurn cleanly when AbortSignal is triggered mid-stream', async () => {
    const controller = new AbortController();
    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '第一句' };
        controller.abort();
        yield { contentDelta: '不应提交的内容' };
      },
    };

    const harness = createFictionHarness({ transport });
    const story = harness.createStory({ title: '测试中断' });

    await expect(
      harness.runTurn(
        story,
        '继续',
        { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'k', memoryOnly: true },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
