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
    emitError(requestId: string, message: string, options?: { status?: number; aborted?: boolean }) {
      for (const fn of listeners.sseError) {
        fn({ requestId, message, status: options?.status, aborted: options?.aborted });
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
        model: 'deepseek-chat',
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
        getActiveStoryId: async () => null,
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
    fake.emitError('req-mid-1', 'Socket reset mid-stream');
    await expect(midErrRun).rejects.toThrow(/Socket reset mid-stream/);

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
});
