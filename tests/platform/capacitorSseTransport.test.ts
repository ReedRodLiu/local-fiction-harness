import { describe, expect, it, vi } from 'vitest';
import { createAndroidPlatformRuntime } from '../../src/platform/androidRuntime.ts';
import {
  createCapacitorSseTransport,
  type NativeSseEventMap,
  type NativeSsePluginLike,
} from '../../src/platform/capacitorSseTransport.ts';

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function createFakeNativeSsePlugin() {
  const listeners: {
    sseChunk: Set<(ev: NativeSseEventMap['sseChunk']) => void>;
    sseComplete: Set<(ev: NativeSseEventMap['sseComplete']) => void>;
    sseError: Set<(ev: NativeSseEventMap['sseError']) => void>;
  } = {
    sseChunk: new Set(),
    sseComplete: new Set(),
    sseError: new Set(),
  };

  const started: Array<{ requestId: string; url: string; headers: Record<string, string>; body: string }> = [];
  const aborted: string[] = [];

  const plugin: NativeSsePluginLike = {
    async addListener(eventName, listener) {
      const set = listeners[eventName] as Set<(ev: unknown) => void>;
      set.add(listener as (ev: unknown) => void);
      return {
        remove: async () => {
          set.delete(listener as (ev: unknown) => void);
        },
      };
    },
    async startStream(options) {
      started.push({
        requestId: options.requestId,
        url: options.url,
        headers: options.headers,
        body: options.body,
      });
    },
    async abortStream({ requestId }) {
      aborted.push(requestId);
    },
  };

  return {
    plugin,
    started,
    aborted,
    emitChunk(requestId: string, bytes: Uint8Array) {
      for (const fn of listeners.sseChunk) {
        fn({ requestId, chunkBase64: encodeBase64(bytes) });
      }
    },
    emitComplete(requestId: string) {
      for (const fn of listeners.sseComplete) {
        fn({ requestId });
      }
    },
    emitError(
      requestId: string,
      message: string,
      options?: { code?: string; status?: number; aborted?: boolean },
    ) {
      for (const fn of listeners.sseError) {
        fn({
          requestId,
          message,
          code: options?.code,
          status: options?.status,
          aborted: options?.aborted,
        });
      }
    },
    listenerCounts() {
      return {
        chunk: listeners.sseChunk.size,
        complete: listeners.sseComplete.size,
        error: listeners.sseError.size,
      };
    },
  };
}

describe('Capacitor NativeSse LlmTransport contract', () => {
  it('decodes split UTF-8 byte chunks incrementally and separates reasoning_content from content', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-1');

    const sseBytes = new TextEncoder().encode(
      [
        'data: {"choices":[{"delta":{"reasoning_content":"思考：暗巷"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你推开木门。"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );

    const deltas: Array<{ reasoningDelta?: string; contentDelta?: string; finishReason?: string | null }> = [];
    const iterPromise = (async () => {
      for await (const delta of transport.streamChat({
        baseUrl: 'https://no-cors.example/v1',
        apiKey: 'sk-android-1',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        messages: [{ role: 'user', content: '进门' }],
      })) {
        deltas.push(delta);
      }
    })();

    // Wait for startStream to be invoked before emitting chunks
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0]).toMatchObject({
      requestId: 'req-1',
      url: 'https://no-cors.example/v1/chat/completions',
    });
    expect(fake.started[0].headers.Authorization).toBe('Bearer sk-android-1');
    const sentBody = JSON.parse(fake.started[0].body) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoning_effort: 'high',
    });
    expect(sentBody).not.toHaveProperty('thinking');

    // Emit in 5-byte fragments to split multi-byte UTF-8 characters
    for (let i = 0; i < sseBytes.length; i += 5) {
      fake.emitChunk('req-1', sseBytes.slice(i, i + 5));
    }
    fake.emitComplete('req-1');

    await iterPromise;
    expect(deltas).toEqual([
      { contentDelta: undefined, reasoningDelta: '思考：暗巷', finishReason: undefined },
      { contentDelta: '你推开木门。', reasoningDelta: undefined, finishReason: 'stop' },
    ]);
    expect(fake.listenerCounts()).toEqual({ chunk: 0, complete: 0, error: 0 });
  });

  it('derives the beta request and applies the same prefix echo cursor on Android', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-prefix');
    const output: string[] = [];

    const run = (async () => {
      for await (const delta of transport.streamChat({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-android-prefix',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '继续' }],
        prefixCompletion: { content: '预填' },
      })) {
        if (delta.contentDelta) output.push(delta.contentDelta);
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0].url).toBe('https://api.deepseek.com/beta/chat/completions');
    expect(JSON.parse(fake.started[0].body).messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '预填',
      prefix: true,
    });

    fake.emitChunk(
      'req-prefix',
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"预填"}}]}\n\n'),
    );
    fake.emitChunk(
      'req-prefix',
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"续写"},"finish_reason":"stop"}]}\n\n',
      ),
    );
    fake.emitComplete('req-prefix');

    await run;
    expect(output.join('')).toBe('预填续写');
  });

  it('consumes a queued SSE chunk before surfacing an explicit abort', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-abort-queued');
    const controller = new AbortController();
    const output: string[] = [];
    let caught: unknown;

    const run = (async () => {
      try {
        for await (const delta of transport.streamChat({
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'k',
          model: 'm',
          messages: [{ role: 'user', content: '继续' }],
          prefixCompletion: { content: '雨声在屋檐' },
          signal: controller.signal,
        })) {
          if (delta.contentDelta) output.push(delta.contentDelta);
        }
      } catch (error) {
        caught = error;
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    fake.emitChunk(
      'req-abort-queued',
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"雨声在"}}]}\n\n'),
    );
    controller.abort();
    await run;

    expect(output).toEqual(['雨声在']);
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(fake.aborted).toContain('req-abort-queued');
  });

  it('isolates concurrent streams by requestId', async () => {
    const fake = createFakeNativeSsePlugin();
    let seq = 0;
    const transport = createCapacitorSseTransport(fake.plugin, () => `req-${++seq}`);

    const collect = async (model: string) => {
      const out: string[] = [];
      for await (const delta of transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model,
        messages: [{ role: 'user', content: model }],
      })) {
        if (delta.contentDelta) out.push(delta.contentDelta);
      }
      return out.join('');
    };

    const p1 = collect('m1');
    const p2 = collect('m2');
    await vi.waitFor(() => expect(fake.started).toHaveLength(2));

    fake.emitChunk('req-2', new TextEncoder().encode('data: {"choices":[{"delta":{"content":"来自流2"}}]}\n\n'));
    fake.emitChunk('req-1', new TextEncoder().encode('data: {"choices":[{"delta":{"content":"来自流1"}}]}\n\n'));
    fake.emitComplete('req-2');
    fake.emitComplete('req-1');

    expect(await p1).toBe('来自流1');
    expect(await p2).toBe('来自流2');
  });

  it('propagates native HTTP/stream errors and calls abortStream on AbortSignal', async () => {
    const fake = createFakeNativeSsePlugin();
    let seq = 0;
    const transport = createCapacitorSseTransport(fake.plugin, () => `req-${++seq}`);

    const errRun = (async () => {
      for await (const _ of transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'bad',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    fake.emitError('req-1', 'HTTP 401 Unauthorized: Invalid API Key', { status: 401 });
    await expect(errRun).rejects.toThrow(/401/);

    const controller = new AbortController();
    const abortRun = (async () => {
      for await (const _ of transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    controller.abort();
    await expect(abortRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.aborted).toContain('req-2');
  });

  it('aborts cleanly with plain AbortSignalLike (without addEventListener) and wires into Android runtime', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-plain');
    const plainSignal = { aborted: false };

    const runtime = createAndroidPlatformRuntime({
      transport,
      storyStorage: {
        listStories: async () => [],
        getStory: async () => null,
        saveStory: async () => {},
        deleteStory: async () => {},
        getActiveStorySelection: async () => ({ status: 'missing' }),
        setActiveStoryId: async () => {},
        compareAndSetActiveStoryId: async () => false,
      },
    });
    expect(typeof runtime.transport.streamChat).toBe('function');

    const abortRun = (async () => {
      for await (const _ of runtime.transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: plainSignal,
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    plainSignal.aborted = true;
    await expect(abortRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.aborted).toContain('req-plain');
  });

  it('propagates mid-stream sseError and in-stream SSE JSON error payloads after initial chunks', async () => {
    const fake = createFakeNativeSsePlugin();
    let seq = 0;
    const transport = createCapacitorSseTransport(fake.plugin, () => `req-mid-${++seq}`);

    // 1. Mid-stream native sseError after partial content chunk
    const midErrDeltas: string[] = [];
    const midErrRun = (async () => {
      for await (const delta of transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        if (delta.contentDelta) midErrDeltas.push(delta.contentDelta);
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    fake.emitChunk('req-mid-1', new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'));
    await vi.waitFor(() => expect(midErrDeltas).toEqual(['半句']));
    fake.emitError('req-mid-1', '连接中断', { code: 'CONNECTION_ABORTED' });
    await expect(midErrRun).rejects.toMatchObject({
      message: '连接中断',
      code: 'CONNECTION_ABORTED',
    });

    // 2. In-stream SSE error JSON payload
    const sseErrRun = (async () => {
      for await (const _ of transport.streamChat({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    fake.emitChunk('req-mid-2', new TextEncoder().encode('data: {"error":{"message":"Upstream overloaded"}}\n\n'));
    fake.emitComplete('req-mid-2');
    await expect(sseErrRun).rejects.toThrow(/Upstream overloaded/);
  });

  it('drains synchronous resume-burst partial chunks before surfacing CONNECTION_ABORTED and aborts native stream on local decode errors', async () => {
    const fake = createFakeNativeSsePlugin();
    let seq = 0;
    const transport = createCapacitorSseTransport(fake.plugin, () => `req-burst-${++seq}`);

    // 1. Synchronous burst replay (simulating NativeSsePlugin.handleOnResume flushing buffered chunks + CONNECTION_ABORTED)
    const burstDeltas: string[] = [];
    let burstErr: unknown;
    const burstRun = (async () => {
      try {
        for await (const delta of transport.streamChat({
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'k',
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          if (delta.contentDelta) burstDeltas.push(delta.contentDelta);
        }
      } catch (err) {
        burstErr = err;
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    fake.emitChunk('req-burst-1', new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'));
    fake.emitChunk('req-burst-1', new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n'));
    fake.emitError('req-burst-1', '网络连接中断（断线前已接收 128 B）', { code: 'CONNECTION_ABORTED' });

    await burstRun;
    expect(burstDeltas).toEqual(['第一段', '第二段']);
    expect(burstErr).toMatchObject({
      code: 'CONNECTION_ABORTED',
      message: '网络连接中断（断线前已接收 128 B）',
    });

    // 2. Local decode failure must call abortStream so native foreground keepalive releases
    const badChunk = '!!!invalid-base64!!!';
    await expect(
      (async () => {
        const badFake = createFakeNativeSsePlugin();
        let capturedChunkListener: ((ev: NativeSseEventMap['sseChunk']) => void) | undefined;
        const wrappedPlugin: NativeSsePluginLike = {
          async addListener(eventName, listener) {
            if (eventName === 'sseChunk') {
              capturedChunkListener = listener as (ev: NativeSseEventMap['sseChunk']) => void;
            }
            return badFake.plugin.addListener(eventName, listener);
          },
          startStream: badFake.plugin.startStream,
          abortStream: badFake.plugin.abortStream,
        };
        const badTransport = createCapacitorSseTransport(wrappedPlugin, () => 'req-bad-b64');
        const p = (async () => {
          for await (const _ of badTransport.streamChat({
            baseUrl: 'https://example.invalid/v1',
            apiKey: 'k',
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
          })) {
            // no-op
          }
        })();
        await vi.waitFor(() => expect(badFake.started).toHaveLength(1));
        capturedChunkListener?.({ requestId: 'req-bad-b64', chunkBase64: badChunk });
        try {
          await p;
        } finally {
          expect(badFake.aborted).toContain('req-bad-b64');
          expect(badFake.listenerCounts()).toEqual({ chunk: 0, complete: 0, error: 0 });
        }
      })(),
    ).rejects.toThrow(/原生 SSE 分块数据/);
  });

  it('dispatches openai_responses through shared request builder and SSE parser without changing NativeSsePlugin', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-resp-1');

    const sseBytes = new TextEncoder().encode(
      [
        'event: response.reasoning_summary_text.delta\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"推理摘要。"}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"月光落进庭院。"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"input_tokens_details":{"cached_tokens":200},"output_tokens":80,"output_tokens_details":{"reasoning_tokens":30},"total_tokens":580}}}\n\n',
      ].join(''),
    );

    const deltas: Array<{
      reasoningDelta?: string;
      contentDelta?: string;
      finishReason?: string | null;
      usage?: unknown;
    }> = [];
    const run = (async () => {
      for await (const delta of transport.streamChat({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-android-oa',
        model: 'gpt-4.1',
        reasoningEffort: 'medium',
        prefixCompletion: { content: '不应触发前缀回显持有' },
        capabilities: {
          apiProtocol: 'openai_responses',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
        messages: [
          { role: 'system', content: '系统设定' },
          { role: 'user', content: '进院' },
        ],
      })) {
        deltas.push(delta);
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(fake.started[0]!.body)).toEqual({
      model: 'gpt-4.1',
      stream: true,
      store: false,
      instructions: '系统设定',
      input: [{ role: 'user', content: '进院' }],
      reasoning: { effort: 'medium', summary: 'auto' },
    });

    for (let i = 0; i < sseBytes.length; i += 9) {
      fake.emitChunk('req-resp-1', sseBytes.slice(i, i + 9));
    }
    fake.emitComplete('req-resp-1');

    await run;
    expect(deltas).toEqual([
      { reasoningDelta: '推理摘要。' },
      { contentDelta: '月光落进庭院。' },
      {
        finishReason: 'stop',
        usage: {
          promptTokens: 500,
          completionTokens: 80,
          totalTokens: 580,
          promptCacheHitTokens: 200,
          promptCacheMissTokens: 300,
          completionTokensDetails: { reasoningTokens: 30 },
        },
      },
    ]);
  });

  it('dispatches gemini_native through shared request builder and SSE parser without changing NativeSsePlugin', async () => {
    const fake = createFakeNativeSsePlugin();
    const transport = createCapacitorSseTransport(fake.plugin, () => 'req-gem-1');

    const sseBytes = new TextEncoder().encode(
      [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"推理片段。"},{"text":"湖面泛起涟漪。"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":400,"cachedContentTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":20,"totalTokenCount":470}}\n\n',
      ].join(''),
    );

    const deltas: Array<{
      reasoningDelta?: string;
      contentDelta?: string;
      finishReason?: string | null;
      usage?: unknown;
    }> = [];
    const run = (async () => {
      for await (const delta of transport.streamChat({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-android-gem',
        model: 'gemini-2.5-flash',
        reasoningEffort: 'low',
        prefixCompletion: { content: '不应触发前缀回显持有' },
        capabilities: {
          apiProtocol: 'gemini_native',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
        messages: [
          { role: 'system', content: '系统设定' },
          { role: 'user', content: '走近湖边' },
        ],
      })) {
        deltas.push(delta);
      }
    })();

    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    expect(fake.started[0]?.headers['x-goog-api-key']).toBe('AIza-android-gem');
    expect(fake.started[0]?.headers.Authorization).toBeUndefined();

    for (let i = 0; i < sseBytes.length; i += 10) {
      fake.emitChunk('req-gem-1', sseBytes.slice(i, i + 10));
    }
    fake.emitComplete('req-gem-1');

    await run;
    expect(deltas).toEqual([
      {
        reasoningDelta: '推理片段。',
        contentDelta: '湖面泛起涟漪。',
        finishReason: 'stop',
        usage: {
          promptTokens: 400,
          completionTokens: 70,
          totalTokens: 470,
          promptCacheHitTokens: 100,
          promptCacheMissTokens: 300,
          completionTokensDetails: { reasoningTokens: 20 },
        },
      },
    ]);
  });
});
