import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAndroidPlatformRuntime,
  createPlatformRuntime,
  createWebPlatformRuntime,
  detectRuntimePlatform,
} from '../../src/platform/runtime.ts';
import type { FetchLike, KeyValueStorage, ModelConfig, StoryStorage } from '../../src/harness/index.ts';

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

function createNoopStoryStorage(): StoryStorage {
  return {
    listStories: async () => [],
    getStory: async () => null,
    saveStory: async () => {},
    deleteStory: async () => {},
    getActiveStorySelection: async () => ({ status: 'missing' }),
    setActiveStoryId: async () => {},
    compareAndSetActiveStoryId: async () => false,
  };
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('PlatformRuntime detection & Web adapter', () => {
  it('detects android only when Capacitor reports native android, otherwise web', () => {
    expect(detectRuntimePlatform({ isNativePlatform: () => false, getPlatform: () => 'web' })).toBe(
      'web',
    );
    expect(detectRuntimePlatform({ isNativePlatform: () => true, getPlatform: () => 'ios' })).toBe(
      'web',
    );
    expect(
      detectRuntimePlatform({ isNativePlatform: () => true, getPlatform: () => 'android' }),
    ).toBe('android');
  });

  it('builds a Web PlatformRuntime with SecretStore, StoryStorage, LlmTransport, and BackupExporter', async () => {
    const kv = createMemoryStorage();
    const exported: Array<{ fileName: string; jsonContent: string }> = [];
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      body: (async function* () {
        yield new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      })(),
    }));

    const runtime = createWebPlatformRuntime({
      keyValueStorage: kv,
      storyStorage: createNoopStoryStorage(),
      fetchImpl: fetchSpy,
      exportJsonFile: async (fileName, jsonContent) => {
        exported.push({ fileName, jsonContent });
      },
      devUseEnvKey: () => true,
      isDev: true,
    });

    expect(runtime.platform).toBe('web');
    expect(runtime.supportsMemoryOnlySession).toBe(true);
    expect(runtime.promptPackStorage).toBe(kv);
    runtime.promptPackStorage.setItem('prompt-packs', 'stored');
    expect(kv.getItem('prompt-packs')).toBe('stored');
    expect(runtime.publicResearch).toBeTruthy();

    await runtime.secretStore.saveApiKey('sk-web-123');
    expect(await runtime.secretStore.loadApiKey()).toBe('sk-web-123');
    await runtime.secretStore.clearApiKey();
    expect(await runtime.secretStore.loadApiKey()).toBe('');

    const deltas: string[] = [];
    for await (const delta of runtime.transport.streamChat({
      baseUrl: '/__dev_llm_proxy',
      apiKey: '',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (delta.contentDelta) deltas.push(delta.contentDelta);
    }
    expect(deltas.join('')).toBe('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers['x-use-dev-env-key']).toBe('1');

    await runtime.backupExporter.exportJsonFile('test.lfh.json', '{"schemaVersion":1}');
    expect(exported).toEqual([{ fileName: 'test.lfh.json', jsonContent: '{"schemaVersion":1}' }]);
  });

  it('exercises createPlatformRuntime() and default DOM Blob BackupExporter', async () => {
    const kv = createMemoryStorage();
    const clickSpy = vi.fn();
    const anchor = { href: '', download: '', click: clickSpy };
    (globalThis as { window: unknown }).window = { localStorage: kv, indexedDB: undefined };
    (globalThis as { document: unknown }).document = {
      createElement: vi.fn(() => anchor),
    };
    URL.createObjectURL = vi.fn(() => 'blob:test-backup');
    URL.revokeObjectURL = vi.fn();

    const runtime = createPlatformRuntime({ fetchImpl: vi.fn() });
    expect(runtime.platform).toBe('web');
    expect(runtime.promptPackStorage).toBe(kv);

    await runtime.backupExporter.exportJsonFile('story.lfh.json', '{"schemaVersion":1}');
    expect(anchor.href).toBe('blob:test-backup');
    expect(anchor.download).toBe('story.lfh.json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-backup');
  });

  it('wires layered routed publicResearch in both Web and Android runtimes without leaking third-party keys', async () => {
    const fetchCalls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      fetchCalls.push(url);
      if (url === 'https://api.tavily.com/search') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () =>
            JSON.stringify({
              results: [
                { title: 'FMA Wiki', url: 'https://fma.example/ed', content: '爱德华·艾尔利克性格直率。' },
              ],
            }),
          body: null,
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"### 爱德华·艾尔利克\\n- 性格直率。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        })(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const kv = createMemoryStorage();
      const webRuntime = createWebPlatformRuntime({
        keyValueStorage: kv,
        storyStorage: createNoopStoryStorage(),
        fetchImpl: fetchSpy as unknown as FetchLike,
      });
      const androidRuntime = createAndroidPlatformRuntime({
        promptPackStorage: kv,
        diagnosticsStorage: kv,
        transport: {
          async *streamChat() {
            yield { contentDelta: '### 爱德华·艾尔利克\n- 性格直率。', finishReason: 'stop' };
          },
        },
      });

      const identity = {
        work: '钢之炼金术师',
        version: '2003 动画版',
        timeline: '第 51 集结局后',
        characters: ['爱德华·艾尔利克'],
      };
      const thirdPartyNoSearch: ModelConfig = {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-openai-secret',
        memoryOnly: false,
        capabilities: {
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
      };

      await expect(
        webRuntime.publicResearch!.resolve({ identity, config: thirdPartyNoSearch }),
      ).resolves.toBeNull();
      await expect(
        androidRuntime.publicResearch!.resolve({ identity, config: thirdPartyNoSearch }),
      ).resolves.toBeNull();
      expect(fetchCalls).toEqual([]);

      const tavilyConfig: ModelConfig = {
        ...thirdPartyNoSearch,
        publicResearch: { provider: 'tavily', apiKey: 'tvly-runtime-1' },
      };
      const webRef = await webRuntime.publicResearch!.resolve({ identity, config: tavilyConfig });
      const androidRef = await androidRuntime.publicResearch!.resolve({ identity, config: tavilyConfig });
      expect(webRef?.sources).toEqual([{ title: 'FMA Wiki', url: 'https://fma.example/ed' }]);
      expect(androidRef?.sources).toEqual([{ title: 'FMA Wiki', url: 'https://fma.example/ed' }]);
      expect(fetchCalls).not.toContain('https://api.deepseek.com/v1/tools/search');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
