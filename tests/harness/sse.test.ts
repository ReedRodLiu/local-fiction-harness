import { describe, expect, it } from 'vitest';
import {
  applyPrefixEchoCursor,
  buildOpenAiChatRequest,
  createOpenAiTransport,
  resolveBetaChatCompletionsUrl,
  type LlmStreamDelta,
} from '../../src/harness/index.ts';

async function collect(iterable: AsyncIterable<LlmStreamDelta>): Promise<LlmStreamDelta[]> {
  const deltas: LlmStreamDelta[] = [];
  for await (const delta of iterable) {
    deltas.push(delta);
  }
  return deltas;
}

async function* fromDeltas(deltas: LlmStreamDelta[]): AsyncIterable<LlmStreamDelta> {
  yield* deltas;
}

describe('DeepSeek beta prefix completion request assembly', () => {
  it('derives an idempotent beta chat completions URL', () => {
    expect(resolveBetaChatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/beta/chat/completions',
    );
    expect(resolveBetaChatCompletionsUrl('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/beta/chat/completions',
    );
    expect(resolveBetaChatCompletionsUrl('https://api.deepseek.com/beta')).toBe(
      'https://api.deepseek.com/beta/chat/completions',
    );
    expect(resolveBetaChatCompletionsUrl('https://api.deepseek.com/beta/chat/completions/')).toBe(
      'https://api.deepseek.com/beta/chat/completions',
    );
  });

  it.each([
    {
      name: 'A: content only while thinking is enabled',
      prefixCompletion: { content: '正文预填' },
      thinking: { type: 'enabled' as const },
      reasoning_effort: 'high' as const,
      reasoningContent: undefined,
    },
    {
      name: 'B: reasoning only while thinking is enabled',
      prefixCompletion: { content: '', reasoningContent: '思考预填' },
      thinking: { type: 'enabled' as const },
      reasoning_effort: 'high' as const,
      reasoningContent: '思考预填',
    },
    {
      name: 'C: content and reasoning while thinking is enabled',
      prefixCompletion: { content: '正文预填', reasoningContent: '思考预填' },
      thinking: { type: 'enabled' as const },
      reasoning_effort: 'high' as const,
      reasoningContent: '思考预填',
    },
    {
      name: 'D: neither content nor reasoning while thinking is enabled',
      prefixCompletion: { content: '' },
      thinking: { type: 'enabled' as const },
      reasoning_effort: 'high' as const,
      reasoningContent: undefined,
    },
    {
      name: 'E: disabled thinking strips reasoning prefill',
      prefixCompletion: { content: '正文预填', reasoningContent: '不得发送' },
      thinking: { type: 'disabled' as const },
      reasoning_effort: 'none' as const,
      reasoningContent: undefined,
    },
  ])('$name', ({ prefixCompletion, thinking, reasoning_effort, reasoningContent }) => {
    const originalMessages = [
      { role: 'system' as const, content: '系统' },
      { role: 'user' as const, content: '用户' },
      { role: 'assistant' as const, content: '历史助手' },
    ];
    const request = buildOpenAiChatRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-v4-pro',
      messages: originalMessages,
      prefixCompletion,
      thinking,
      reasoning_effort,
    });
    const body = JSON.parse(request.body) as {
      messages: Array<Record<string, unknown>>;
      stop?: unknown;
    };

    expect(request.url).toBe('https://api.deepseek.com/beta/chat/completions');
    expect(body.stop).toBeUndefined();
    expect(body.messages).toHaveLength(originalMessages.length + 1);
    expect(body.messages.slice(0, -1)).toEqual(originalMessages);
    expect(body.messages.slice(0, -1).some((message) => message.prefix === true)).toBe(false);

    const prefixMessage = body.messages.at(-1);
    expect(prefixMessage).toMatchObject({
      role: 'assistant',
      content: prefixCompletion.content,
      prefix: true,
    });
    expect(prefixMessage?.reasoning_content).toBe(reasoningContent);
  });

  it('keeps ordinary requests on the stable URL and does not add a prefix message', () => {
    const request = buildOpenAiChatRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '普通请求' }],
    });
    const body = JSON.parse(request.body) as { messages: unknown[]; stop?: unknown };

    expect(request.url).toBe('https://api.deepseek.com/chat/completions');
    expect(body.messages).toEqual([{ role: 'user', content: '普通请求' }]);
    expect(body.stop).toBeUndefined();
  });

  it('applies the echo cursor outside the OpenAI SSE syntax parser', async () => {
    const transport = createOpenAiTransport(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/beta/chat/completions');
      expect(JSON.parse(init.body).messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: '预填',
        prefix: true,
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"预"}}]}\n\n',
          );
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"填续写"},"finish_reason":"stop"}]}\n\n',
          );
        })(),
      };
    });

    const deltas = await collect(
      transport.streamChat({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'secret',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '继续' }],
        prefixCompletion: { content: '预填' },
      }),
    );

    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta).join('')).toBe(
      '预填续写',
    );
  });
});

describe('Prefix echo cursor', () => {
  it('strips a split server echo and emits the prefill exactly once before continuation', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        fromDeltas([
          { contentDelta: '雨声在' },
          { contentDelta: '屋檐' },
          { contentDelta: '上回荡' },
          { finishReason: 'stop' },
        ]),
        '雨声在屋檐',
      ),
    );

    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在屋檐',
      '上回荡',
    ]);
    expect(deltas.at(-1)).toMatchObject({ finishReason: 'stop' });
  });

  it('synthesizes the prefill before a server stream that does not echo it', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        fromDeltas([{ contentDelta: '模型直接开写' }, { finishReason: 'stop' }]),
        '雨声在屋檐',
      ),
    );

    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta).join('')).toBe(
      '雨声在屋檐模型直接开写',
    );
    expect(deltas[0]).toEqual({ contentDelta: '雨声在屋檐' });
  });

  it('flushes all held characters when the server diverges halfway through an apparent echo', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        fromDeltas([{ contentDelta: '雨声在' }, { contentDelta: '窗边X' }, { finishReason: 'stop' }]),
        '雨声在屋檐',
      ),
    );

    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta).join('')).toBe(
      '雨声在屋檐雨声在窗边X',
    );
  });

  it('does not drop a partial prefix when the upstream ends before confirming an echo', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(fromDeltas([{ contentDelta: '雨声在' }]), '雨声在屋檐'),
    );

    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta).join('')).toBe(
      '雨声在屋檐雨声在',
    );
  });
});
