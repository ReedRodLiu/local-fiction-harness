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
});
