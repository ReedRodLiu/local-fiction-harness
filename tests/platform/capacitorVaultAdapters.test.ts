import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAsyncModelConfigStore,
  createDiagnosticCollector,
  type KeyValueStorage,
  type Story,
} from '../../src/harness/index.ts';
import {
  createAndroidBackupExporter,
  createAndroidSecretStore,
  createAndroidStoryStorage,
  type NativeVaultPluginLike,
} from '../../src/platform/capacitorVaultAdapters.ts';
import { createAndroidPlatformRuntime } from '../../src/platform/androidRuntime.ts';

function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeStory(id: string, title: string, updatedAt: number): Story {
  return {
    id,
    title,
    rawScript: `script-${id}`,
    blueprint: {
      title,
      worldRules: ['rule-1'],
      protagonist: '主角',
      npcs: [],
      taboos: [],
      openingHook: '开场',
      extractionStatus: 'complete',
    },
    nodes: {},
    rootNodeIds: [],
    activeLeafNodeId: null,
    createdAt: 1000,
    updatedAt,
  };
}

function createFakeNativeVault() {
  let meta: { baseUrl: string; model: string; memoryOnly: boolean } | null = null;
  let apiKey = '';
  const stories = new Map<string, Story>();
  let activeId: string | null = null;
  let activePresent = false;
  const exported: Array<{ fileName: string; jsonContent: string }> = [];
  const callLog: string[] = [];

  const plugin: NativeVaultPluginLike = {
    async loadMeta() {
      callLog.push('loadMeta');
      return { meta: meta ? { ...meta } : null };
    },
    async saveMeta(next) {
      callLog.push('saveMeta');
      meta = { ...next };
    },
    async loadApiKey() {
      callLog.push('loadApiKey');
      return { apiKey };
    },
    async saveApiKey({ apiKey: nextKey }) {
      callLog.push('saveApiKey');
      apiKey = nextKey;
    },
    async clearApiKey() {
      callLog.push('clearApiKey');
      apiKey = '';
    },
    async listStories() {
      callLog.push('listStories');
      return {
        stories: Array.from(stories.values())
          .map((s) => JSON.parse(JSON.stringify(s)) as Story)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    },
    async getStory({ id }) {
      callLog.push(`getStory:${id}`);
      const found = stories.get(id);
      return { story: found ? (JSON.parse(JSON.stringify(found)) as Story) : null };
    },
    async saveStory({ story }) {
      callLog.push(`saveStory:${story.id}:${story.updatedAt}`);
      stories.set(story.id, JSON.parse(JSON.stringify(story)) as Story);
    },
    async deleteStory({ id }) {
      callLog.push(`deleteStory:${id}`);
      stories.delete(id);
      if (activeId === id) {
        activeId = null;
        activePresent = true;
      }
    },
    async getActiveStoryId() {
      callLog.push('getActiveStoryId');
      return { id: activeId, present: activePresent };
    },
    async setActiveStoryId({ id }) {
      callLog.push(`setActiveStoryId:${id}`);
      activeId = id;
      activePresent = true;
    },
    async exportJsonFile({ fileName, jsonContent }) {
      callLog.push(`exportJsonFile:${fileName}`);
      exported.push({ fileName, jsonContent });
    },
  };

  return { plugin, exported, callLog, getApiKey: () => apiKey };
}

describe('Android NativeVault TS adapters & PlatformRuntime parity', () => {
  it('implements SecretStore contract and clears persisted apiKey via NativeVault', async () => {
    const fake = createFakeNativeVault();
    const secretStore = createAndroidSecretStore(fake.plugin);

    expect(await secretStore.loadMeta()).toBeNull();
    expect(await secretStore.loadApiKey()).toBe('');

    await secretStore.saveMeta({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      memoryOnly: false,
    });
    await secretStore.saveApiKey('sk-android-vault');

    expect(await secretStore.loadMeta()).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      memoryOnly: false,
    });
    expect(await secretStore.loadApiKey()).toBe('sk-android-vault');

    await secretStore.clearApiKey();
    expect(fake.getApiKey()).toBe('');
    expect(await secretStore.loadApiKey()).toBe('');

    // End-to-end memoryOnly toggle through AsyncModelConfigStore + Android SecretStore
    const configStore = createAsyncModelConfigStore(secretStore);
    await configStore.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-vault-persist',
      memoryOnly: false,
    });
    expect(fake.getApiKey()).toBe('sk-vault-persist');
    await configStore.save({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-vault-persist',
      memoryOnly: true,
    });
    expect(fake.getApiKey()).toBe('');
    const restarted = createAsyncModelConfigStore(secretStore);
    expect((await restarted.load()).apiKey).toBe('');
  });

  it('serializes StoryStorage concurrent writes in strict FIFO order without losing updates', async () => {
    const events: string[] = [];
    let releaseFirstSave!: () => void;
    const firstSaveBlocked = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });

    const fake = createFakeNativeVault();
    let saveCalls = 0;
    const baseSave = fake.plugin.saveStory;
    fake.plugin.saveStory = async ({ story }) => {
      saveCalls += 1;
      const callNum = saveCalls;
      events.push(`start:${callNum}:${story.title}`);
      if (callNum === 1) {
        await firstSaveBlocked;
      }
      await baseSave({ story });
      events.push(`end:${callNum}:${story.title}`);
    };

    const storage = createAndroidStoryStorage(fake.plugin);
    const p1 = storage.saveStory(makeStory('s1', '第一版', 100));
    const p2 = storage.saveStory(makeStory('s1', '第二版', 200));
    const pRead = storage.getStory('s1');

    // Give microtasks a chance: second write must wait for first write to finish!
    await vi.waitFor(() => expect(events).toEqual(['start:1:第一版']));
    releaseFirstSave();

    await Promise.all([p1, p2]);
    const latest = await pRead;
    expect(events).toEqual(['start:1:第一版', 'end:1:第一版', 'start:2:第二版', 'end:2:第二版']);
    expect(latest?.title).toBe('第二版');
    expect(latest?.updatedAt).toBe(200);
  });

  it('delivers a diagnostic bundle unchanged through the native export bridge', async () => {
    const fake = createFakeNativeVault();
    const diagnostics = createDiagnosticCollector({ platform: 'android', now: () => 1000 });
    diagnostics.recordImportRadar({
      exportFormatVersion: 3,
      sourceMode: 'zip_file',
      totalSessions: 0,
      selectedSessions: 0,
      danglingParentCount: 0,
      emptyTitleCount: 0,
      unknownFragmentTypes: [],
      attachmentExtensions: {},
      scriptConfidenceCounts: { strong: 0, ambiguous: 0 },
      status: 'error',
      durationMs: 12,
    });
    const json = JSON.stringify(diagnostics.buildBundle({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: '',
      memoryOnly: true,
    }));

    await createAndroidBackupExporter(fake.plugin).exportJsonFile('lfh-diagnostics-v1.json', json);

    expect(fake.exported).toEqual([{ fileName: 'lfh-diagnostics-v1.json', jsonContent: json }]);
    expect(fake.callLog).toContain('exportJsonFile:lfh-diagnostics-v1.json');
    expect(JSON.parse(fake.exported[0].jsonContent)).toMatchObject({
      platform: 'android',
      importRadars: [{ exportFormatVersion: 3, totalSessions: 0, status: 'error' }],
    });
  });

  it('supports BackupExporter and wires all native adapters into createAndroidPlatformRuntime', async () => {
    const fake = createFakeNativeVault();
    const exporter = createAndroidBackupExporter(fake.plugin);
    await exporter.exportJsonFile('宫廷.lfh.json', '{"schemaVersion":1}');
    expect(fake.exported).toEqual([{ fileName: '宫廷.lfh.json', jsonContent: '{"schemaVersion":1}' }]);

    const runtime = createAndroidPlatformRuntime({
      secretStore: createAndroidSecretStore(fake.plugin),
      storyStorage: createAndroidStoryStorage(fake.plugin),
      backupExporter: exporter,
    });
    expect(runtime.platform).toBe('android');
    expect(runtime.supportsMemoryOnlySession).toBe(true);
    expect(await runtime.storyStorage.getActiveStorySelection()).toEqual({ status: 'missing' });
    await runtime.storyStorage.saveStory(makeStory('s2', '安卓存档', 300));
    await runtime.storyStorage.setActiveStoryId('s2');
    expect(await runtime.storyStorage.getActiveStorySelection()).toEqual({ status: 'present', id: 's2' });
    await expect(runtime.storyStorage.compareAndSetActiveStoryId('other', 's1')).resolves.toBe(false);
    await expect(runtime.storyStorage.compareAndSetActiveStoryId('s2', 's1')).resolves.toBe(true);
    expect(await runtime.storyStorage.getActiveStorySelection()).toEqual({ status: 'present', id: 's1' });
    expect((await runtime.storyStorage.listStories()).map((s) => s.id)).toEqual(['s2']);
  });

  it('uses injected prompt-pack storage before browser localStorage', () => {
    const injectedStorage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: createMemoryStorage() });

    const runtime = createAndroidPlatformRuntime({ promptPackStorage: injectedStorage });

    expect(runtime.promptPackStorage).toBe(injectedStorage);
  });

  it('uses browser localStorage as the default prompt-pack storage', () => {
    const browserStorage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: browserStorage });

    const runtime = createAndroidPlatformRuntime();

    expect(runtime.promptPackStorage).toBe(browserStorage);
  });

  it('uses functional in-memory prompt-pack storage when browser localStorage is unavailable', () => {
    vi.stubGlobal('window', undefined);

    const runtime = createAndroidPlatformRuntime();
    runtime.promptPackStorage.setItem('prompt-packs', 'stored');

    expect(runtime.promptPackStorage.getItem('prompt-packs')).toBe('stored');
    runtime.promptPackStorage.removeItem('prompt-packs');
    expect(runtime.promptPackStorage.getItem('prompt-packs')).toBeNull();
  });
});
