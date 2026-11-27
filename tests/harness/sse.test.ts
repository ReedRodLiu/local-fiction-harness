import { describe, expect, it } from 'vitest';
import {
  applyPrefixEchoCursor,
  buildOpenAiChatRequest,
  buildProviderStreamRequest,
  createOpenAiTransport,
  parseOpenAiSseStream,
  resolveBetaChatCompletionsUrl,
  resolveResponsesUrl,
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

async function* fromDeltasThenThrow(
  deltas: LlmStreamDelta[],
  error: Error,
): AsyncIterable<LlmStreamDelta> {
  yield* deltas;
  throw error;
}

async function collectUntilError(iterable: AsyncIterable<LlmStreamDelta>): Promise<{
  deltas: LlmStreamDelta[];
  error: unknown;
}> {
  const deltas: LlmStreamDelta[] = [];
  try {
    for await (const delta of iterable) {
      deltas.push(delta);
    }
  } catch (error) {
    return { deltas, error };
  }
  return { deltas, error: undefined };
}

describe('DeepSeek beta prefix completion request assembly', () => {
  it.each([
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/',
    'https://api.deepseek.com/chat/completions',
    'https://api.deepseek.com/chat/completions/',
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.deepseek.com/v1/chat/completions/',
    'https://api.deepseek.com/beta',
    'https://api.deepseek.com/beta/',
    'https://api.deepseek.com/beta/chat/completions',
    'https://api.deepseek.com/beta/chat/completions/',
  ])('derives an idempotent beta chat completions URL from %s', (baseUrl) => {
    const expected = 'https://api.deepseek.com/beta/chat/completions';
    const resolved = resolveBetaChatCompletionsUrl(baseUrl);
    expect(resolved).toBe(expected);
    expect(resolveBetaChatCompletionsUrl(resolved)).toBe(expected);
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
      { role: 'user' as const, content: '继续' },
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

  it('rejects prefix completion when the original messages already end with assistant', () => {
    expect(() =>
      buildOpenAiChatRequest({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'secret',
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: '开始' },
          { role: 'assistant', content: '尚未结束的回复' },
        ],
        prefixCompletion: { content: '继续' },
      }),
    ).toThrow(/assistant prefix.*assistant message/i);
  });

  it('rejects prefix completion when the original message history is empty', () => {
    expect(() =>
      buildOpenAiChatRequest({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'secret',
        model: 'deepseek-flash',
        messages: [],
        prefixCompletion: { content: '继续' },
      }),
    ).toThrow(/empty message/i);
  });

  it.each([
    {
      name: 'thinking is disabled',
      thinking: { type: 'disabled' as const },
      reasoning_effort: 'high' as const,
    },
    {
      name: 'reasoning effort is none',
      thinking: { type: 'enabled' as const },
      reasoning_effort: 'none' as const,
    },
  ])('strips reasoning prefill when $name', ({ thinking, reasoning_effort }) => {
    const request = buildOpenAiChatRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '继续' }],
      prefixCompletion: { content: '正文预填', reasoningContent: '不得发送' },
      thinking,
      reasoning_effort,
    });
    const body = JSON.parse(request.body) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(body.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '正文预填',
      prefix: true,
    });
    expect(body.messages.at(-1)).not.toHaveProperty('reasoning_content');
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

  it('preserves held bytes then fails when a partial echo ends before confirmation', async () => {
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(fromDeltas([{ contentDelta: '雨声在' }]), '雨声在屋檐'),
    );

    expect(error).toEqual(
      new Error('Prefix echo could not be confirmed before the stream ended.'),
    );
    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在',
    ]);
  });

  it('preserves held bytes then fails when a terminal finish reason arrives before confirmation', async () => {
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltas([{ contentDelta: '雨声在' }, { finishReason: 'stop' }]),
        '雨声在屋檐',
      ),
    );

    expect(error).toEqual(
      new Error('Prefix echo could not be confirmed before the stream ended.'),
    );
    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在',
    ]);
  });

  it('preserves held bytes before propagating an upstream error', async () => {
    const upstreamError = new Error('upstream disconnected');
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltasThenThrow([{ contentDelta: '雨声在' }], upstreamError),
        '雨声在屋檐',
      ),
    );

    expect(error).toBe(upstreamError);
    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在',
    ]);
  });

  it('emits an exactly held prefill once before propagating an upstream abort', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltasThenThrow([{ contentDelta: '雨声在屋檐' }], abortError),
        '雨声在屋檐',
      ),
    );

    expect(error).toBe(abortError);
    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在屋檐',
    ]);
  });

  it('preserves held bytes before propagating an abort after a partial echo', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltasThenThrow([{ contentDelta: '雨声在' }], abortError),
        '雨声在屋檐',
      ),
    );

    expect(error).toBe(abortError);
    expect(deltas.filter((delta) => delta.contentDelta).map((delta) => delta.contentDelta)).toEqual([
      '雨声在',
    ]);
  });

  it('does not synthesize prefill for an empty upstream stream', async () => {
    const deltas = await collect(applyPrefixEchoCursor(fromDeltas([]), '雨声在屋檐'));

    expect(deltas).toEqual([]);
  });

  it('does not synthesize prefill for an empty content delta', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(fromDeltas([{ contentDelta: '' }]), '雨声在屋檐'),
    );

    expect(deltas.filter((delta) => delta.contentDelta)).toEqual([]);
  });

  it('does not synthesize prefill when the upstream only sends [DONE]', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        parseOpenAiSseStream(
          (async function* () {
            yield new TextEncoder().encode('data: [DONE]\n\n');
          })(),
        ),
        '雨声在屋檐',
      ),
    );

    expect(deltas).toEqual([]);
  });

  it('does not synthesize prefill when the upstream only sends a finish reason', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(fromDeltas([{ finishReason: 'stop' }]), '雨声在屋檐'),
    );

    expect(deltas.filter((delta) => delta.contentDelta)).toEqual([]);
    expect(deltas).toEqual([{ finishReason: 'stop' }]);
  });

  it('emits a complete echoed prefill once when the stream ends normally', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(fromDeltas([{ contentDelta: '雨声在屋檐' }]), '雨声在屋檐'),
    );

    expect(deltas).toEqual([{ contentDelta: '雨声在屋檐' }]);
  });

  it('emits a complete echoed prefill once before a terminal finish reason', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        fromDeltas([{ contentDelta: '雨声在屋檐' }, { finishReason: 'stop' }]),
        '雨声在屋檐',
      ),
    );

    expect(deltas).toEqual([
      { contentDelta: '雨声在屋檐' },
      { finishReason: 'stop' },
    ]);
  });

  it('propagates an upstream error without synthesizing prefill when no content arrived', async () => {
    const upstreamError = new Error('upstream disconnected before content');
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(fromDeltasThenThrow([], upstreamError), '雨声在屋檐'),
    );

    expect(error).toBe(upstreamError);
    expect(deltas).toEqual([]);
  });

  it('propagates an upstream abort without synthesizing prefill when no content arrived', async () => {
    const abortError = new Error('aborted before content');
    abortError.name = 'AbortError';
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(fromDeltasThenThrow([], abortError), '雨声在屋檐'),
    );

    expect(error).toBe(abortError);
    expect(deltas).toEqual([]);
  });

  it('preserves a diverged continuation once and propagates an upstream error', async () => {
    const upstreamError = new Error('upstream disconnected after divergence');
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltasThenThrow([{ contentDelta: '模型直接开写' }], upstreamError),
        '雨声在屋檐',
      ),
    );

    expect(error).toBe(upstreamError);
    expect(deltas).toEqual([
      { contentDelta: '雨声在屋檐' },
      { contentDelta: '模型直接开写' },
    ]);
  });

  it('preserves a diverged continuation once and propagates an upstream abort', async () => {
    const abortError = new Error('aborted after divergence');
    abortError.name = 'AbortError';
    const { deltas, error } = await collectUntilError(
      applyPrefixEchoCursor(
        fromDeltasThenThrow([{ contentDelta: '模型直接开写' }], abortError),
        '雨声在屋檐',
      ),
    );

    expect(error).toBe(abortError);
    expect(deltas).toEqual([
      { contentDelta: '雨声在屋檐' },
      { contentDelta: '模型直接开写' },
    ]);
  });

  it('keeps reasoning and terminal metadata on a terminal delta that also contains echoed content', async () => {
    const deltas = await collect(
      applyPrefixEchoCursor(
        fromDeltas([
          {
            contentDelta: '雨声在屋檐',
            reasoningDelta: '思考中',
            finishReason: 'stop',
          },
        ]),
        '雨声在屋檐',
      ),
    );

    expect(deltas).toEqual([
      { contentDelta: '雨声在屋檐' },
      { reasoningDelta: '思考中', finishReason: 'stop' },
    ]);
  });
});

describe('Multi-provider capability-driven OpenAI request & usage parsing', () => {
  it('defaults DeepSeek thinking to disabled/none when reasoningEffort is omitted and maps medium to high', () => {
    const defaultReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-ds',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const defaultBody = JSON.parse(defaultReq.body) as Record<string, unknown>;
    expect(defaultBody.thinking).toEqual({ type: 'disabled' });
    expect(defaultBody.reasoning_effort).toBe('none');

    const mediumReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-ds',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const mediumBody = JSON.parse(mediumReq.body) as Record<string, unknown>;
    expect(mediumBody.thinking).toEqual({ type: 'enabled' });
    expect(mediumBody.reasoning_effort).toBe('high');
  });

  it('omits thinking and reasoning_effort for openai_reasoning_effort when none, and maps max to high', () => {
    const offReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const offBody = JSON.parse(offReq.body) as Record<string, unknown>;
    expect(offReq.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(offBody).not.toHaveProperty('thinking');
    expect(offBody).not.toHaveProperty('reasoning_effort');

    const mediumReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'o3-mini',
      reasoningEffort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const mediumBody = JSON.parse(mediumReq.body) as Record<string, unknown>;
    expect(mediumBody).not.toHaveProperty('thinking');
    expect(mediumBody.reasoning_effort).toBe('medium');

    const maxReq = buildOpenAiChatRequest({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or',
      model: 'openai/o3',
      reasoningEffort: 'max',
      capabilities: {
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'none',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
      messages: [{ role: 'user', content: 'hi' }],
    });
    const maxBody = JSON.parse(maxReq.body) as Record<string, unknown>;
    expect(maxBody).not.toHaveProperty('thinking');
    expect(maxBody.reasoning_effort).toBe('high');
  });

  it('handles prefixProtocol standard_assistant_prefill and none properly', async () => {
    const standardPrefillReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-ex',
      model: 'model-a',
      messages: [{ role: 'user', content: '继续' }],
      prefixCompletion: { content: '窗外的雨', reasoningContent: '不发送' },
      reasoningEffort: 'high',
      capabilities: {
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'standard_assistant_prefill',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
    });
    expect(standardPrefillReq.url).toBe('https://api.example.com/v1/chat/completions');
    const standardBody = JSON.parse(standardPrefillReq.body) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(standardBody.messages.at(-1)).toEqual({ role: 'assistant', content: '窗外的雨' });
    expect(standardBody.messages.at(-1)).not.toHaveProperty('prefix');
    expect(standardBody.messages.at(-1)).not.toHaveProperty('reasoning_content');

    const disabledPrefixReq = buildOpenAiChatRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '继续' }],
      prefixCompletion: { content: '不应注入' },
    });
    expect(disabledPrefixReq.url).toBe('https://api.openai.com/v1/chat/completions');
    const disabledBody = JSON.parse(disabledPrefixReq.body) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(disabledBody.messages).toEqual([{ role: 'user', content: '继续' }]);

    const transport = createOpenAiTransport(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      body: (async function* () {
        yield new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"全新内容"},"finish_reason":"stop"}]}\n\n',
        );
      })(),
    }));
    const deltas = await collect(
      transport.streamChat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '继续' }],
        prefixCompletion: { content: '不应合成' },
      }),
    );
    expect(deltas.map((d) => d.contentDelta ?? '').join('')).toBe('全新内容');
  });

  it('parses OpenAI prompt_tokens_details.cached_tokens while preserving DeepSeek cache fields', async () => {
    const encoder = new TextEncoder();
    const openAiDeltas = await collect(
      parseOpenAiSseStream(
        (async function* () {
          yield encoder.encode(
            'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_tokens_details":{"cached_tokens":700}}}\n\n',
          );
          yield encoder.encode('data: [DONE]\n\n');
        })(),
      ),
    );
    expect(openAiDeltas[0]?.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      promptCacheHitTokens: 700,
      promptCacheMissTokens: 300,
    });

    const deepSeekDeltas = await collect(
      parseOpenAiSseStream(
        (async function* () {
          yield encoder.encode(
            'data: {"choices":[],"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":600,"prompt_cache_miss_tokens":400,"prompt_tokens_details":{"cached_tokens":999}}}\n\n',
          );
        })(),
      ),
    );
    expect(deepSeekDeltas[0]?.usage).toEqual({
      promptTokens: 1000,
      promptCacheHitTokens: 600,
      promptCacheMissTokens: 400,
    });
  });
});

describe('OpenAI Responses API multi-protocol dispatch & streaming', () => {
  it('resolves /responses URLs idempotently and strips /chat/completions', () => {
    expect(resolveResponsesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses');
    expect(resolveResponsesUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/responses');
    expect(resolveResponsesUrl('https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1/responses');
    expect(resolveResponsesUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  it('builds openai_responses payloads with store:false, instructions+input, and reasoning mapping', () => {
    const offReq = buildProviderStreamRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-oa-1',
      model: 'gpt-4.1',
      reasoningEffort: 'none',
      includeUsage: true,
      maxOutputTokens: 2048,
      prefixCompletion: { content: '不应发送预填' },
      capabilities: {
        apiProtocol: 'openai_responses',
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'standard_assistant_prefill',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
      messages: [
        { role: 'system', content: '系统规则一' },
        { role: 'system', content: '系统规则二' },
        { role: 'user', content: '开场' },
        { role: 'assistant', content: '回应' },
        { role: 'user', content: '继续' },
      ],
    });

    expect(offReq.protocol).toBe('openai_responses');
    expect(offReq.url).toBe('https://api.openai.com/v1/responses');
    expect(offReq.headers.Authorization).toBe('Bearer sk-oa-1');
    const offBody = JSON.parse(offReq.body) as Record<string, unknown>;
    expect(offBody).toEqual({
      model: 'gpt-4.1',
      stream: true,
      store: false,
      instructions: '系统规则一\n\n系统规则二',
      input: [
        { role: 'user', content: '开场' },
        { role: 'assistant', content: '回应' },
        { role: 'user', content: '继续' },
      ],
      max_output_tokens: 2048,
    });
    expect(offBody).not.toHaveProperty('reasoning');
    expect(offBody).not.toHaveProperty('stream_options');
    expect(offBody).not.toHaveProperty('messages');

    const onReq = buildProviderStreamRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-oa-1',
      model: 'o4-mini',
      reasoningEffort: 'max',
      capabilities: {
        apiProtocol: 'openai_responses',
        thinkingProtocol: 'openai_reasoning_effort',
        prefixProtocol: 'none',
        supportsBalanceQuery: false,
        supportsBuiltinSearch: false,
        supportsBuiltinPricing: false,
      },
      messages: [{ role: 'user', content: '推理一下' }],
    });
    const onBody = JSON.parse(onReq.body) as Record<string, unknown>;
    expect(onBody).not.toHaveProperty('instructions');
    expect(onBody.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('streams reasoning summary deltas, output text deltas, and normalized usage from OpenAI Responses SSE', async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
      'event: response.reasoning_summary_text.delta\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"先梳理线索。"}\n\n',
      'event: response.reasoning_text.delta\n',
      'data: {"type":"response.reasoning_text.delta","delta":"再核对动机。"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"雨夜中的"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"钟声响起。"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":750},"output_tokens":180,"output_tokens_details":{"reasoning_tokens":60},"total_tokens":1180}}}\n\n',
    ].join('');
    const bytes = encoder.encode(ssePayload);

    const transport = createOpenAiTransport(async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'gpt-4.1',
        store: false,
        stream: true,
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        body: (async function* () {
          // Split across UTF-8 multi-byte boundaries
          for (let i = 0; i < bytes.length; i += 7) {
            yield bytes.slice(i, i + 7);
          }
        })(),
      };
    });

    const deltas = await collect(
      transport.streamChat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oa-1',
        model: 'gpt-4.1',
        reasoningEffort: 'medium',
        prefixCompletion: { content: '雨夜' },
        capabilities: {
          apiProtocol: 'openai_responses',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
        messages: [{ role: 'user', content: '继续' }],
      }),
    );

    expect(deltas.map((d) => d.reasoningDelta ?? '').join('')).toBe('先梳理线索。再核对动机。');
    expect(deltas.map((d) => d.contentDelta ?? '').join('')).toBe('雨夜中的钟声响起。');
    const last = deltas.at(-1);
    expect(last?.finishReason).toBe('stop');
    expect(last?.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 180,
      totalTokens: 1180,
      promptCacheHitTokens: 750,
      promptCacheMissTokens: 250,
      completionTokensDetails: { reasoningTokens: 60 },
    });
  });

  it('maps incomplete responses to length/content_filter and surfaces response.failed / error events', async () => {
    const encoder = new TextEncoder();
    const incompleteTransport = createOpenAiTransport(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      body: (async function* () {
        yield encoder.encode(
          'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
        );
      })(),
    }));
    const incompleteDeltas = await collect(
      incompleteTransport.streamChat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oa-1',
        model: 'gpt-4.1',
        capabilities: {
          apiProtocol: 'openai_responses',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(incompleteDeltas.at(-1)?.finishReason).toBe('length');

    const failedTransport = createOpenAiTransport(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      body: (async function* () {
        yield encoder.encode(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"Quota exceeded"}}}\n\n',
        );
      })(),
    }));
    const { error } = await collectUntilError(
      failedTransport.streamChat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oa-1',
        model: 'gpt-4.1',
        capabilities: {
          apiProtocol: 'openai_responses',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Quota exceeded');
  });
});
