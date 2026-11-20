import { describe, expect, it, vi } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  importStoryBackup,
  type LlmTransport,
} from '../../src/harness/index.ts';

const mockTransport: LlmTransport = {
  async *streamChat() {
    yield { reasoningDelta: '内部推理链', contentDelta: '测试叙事输出。', finishReason: 'stop' };
  },
};

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

describe('Slice 3: Multi-story storage & auto-persistence', () => {
  it('auto-persists created stories, blueprint tweaks, turns, renames, and active selection across reloads', async () => {
    const storage = createInMemoryStoryStorage();
    const saveSpy = vi.spyOn(storage, 'saveStory');
    const activeSpy = vi.spyOn(storage, 'setActiveStoryId');

    let seq = 0;
    const harnessA = createFictionHarness({
      transport: mockTransport,
      storage,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `id-${++seq}`,
    });

    const story1 = await harnessA.createAndSaveStory({ title: '宫闱风云', rawScript: '规则A' });
    const story2 = await harnessA.createAndSaveStory({ title: '修仙奇缘', rawScript: '规则B' });
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(activeSpy).toHaveBeenLastCalledWith(story2.id);

    const tweaked = await harnessA.updateStoryBlueprint(story2, {
      ...story2.blueprint,
      protagonist: '外门弟子',
      taboos: ['不可私下斗法'],
    });
    expect(saveSpy).toHaveBeenCalledTimes(3);

    const turnResult = await harnessA.runTurn(tweaked, '拜入宗门', testConfig);
    expect(turnResult.story.activeLeafNodeId).toBe(turnResult.assistantNode.id);
    expect(saveSpy).toHaveBeenCalledTimes(4);

    const renamed = await harnessA.renameStory(story1.id, '宫闱风云·改');
    expect(renamed?.title).toBe('宫闱风云·改');

    await harnessA.setActiveStory(story2.id);

    // Simulate reload with a fresh harness sharing the same storage backend
    const harnessB = createFictionHarness({ transport: mockTransport, storage });
    const stories = await harnessB.listStories();
    expect(stories).toHaveLength(2);
    expect(stories.find((s) => s.id === story1.id)?.title).toBe('宫闱风云·改');

    const active = await harnessB.loadActiveStory();
    expect(active?.id).toBe(story2.id);
    expect(active?.rawScript).toBe('规则B');
    expect(active?.blueprint.protagonist).toBe('外门弟子');
    expect(active?.blueprint.taboos).toEqual(['不可私下斗法']);
    expect(active?.activeLeafNodeId).toBe(turnResult.assistantNode.id);

    await harnessB.deleteStory(story2.id);
    const remaining = await harnessB.listStories();
    expect(remaining.map((s) => s.id)).toEqual([story1.id]);
  });
});

describe('Slice 3: Versioned Story JSON export & import backup', () => {
  it('round-trips full Story including blueprint, nodes, reasoning, summary snapshots, and updatedAt', async () => {
    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harness = createFictionHarness({
      transport: mockTransport,
      storage,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `node-${++seq}`,
    });

    const created = await harness.createAndSaveStory({
      title: '星光练习生',
      rawScript: '【核心铁律】每周淘汰一人。',
      blueprint: {
        title: '星光练习生',
        worldRules: ['每周公演考核'],
        protagonist: '林知夏',
        npcs: [{ name: '顾川', role: '导师', traits: '严格' }],
        taboos: ['不可迟到'],
        openingHook: '走进练习室',
        extractionStatus: 'complete',
      },
    });
    const afterTurn = await harness.runTurn(created, '报到练习室', testConfig);

    const jsonBackup = exportStoryBackup(afterTurn.story);
    const parsed = JSON.parse(jsonBackup);
    expect(parsed.schemaVersion).toBe(2);

    const importedFresh = importStoryBackup(jsonBackup, []);
    expect(importedFresh.id).toBe(afterTurn.story.id);
    expect(importedFresh.rawScript).toBe('【核心铁律】每周淘汰一人。');
    expect(importedFresh.blueprint).toEqual(afterTurn.story.blueprint);
    expect(importedFresh.rootNodeIds).toEqual(afterTurn.story.rootNodeIds);
    expect(importedFresh.activeLeafNodeId).toBe(afterTurn.assistantNode.id);
    expect(importedFresh.updatedAt).toBe(afterTurn.story.updatedAt);
    expect(importedFresh.nodes[afterTurn.assistantNode.id]?.reasoningContent).toBe('内部推理链');
    expect(importedFresh.nodes[afterTurn.assistantNode.id]?.summarySnapshot).toEqual(
      afterTurn.assistantNode.summarySnapshot,
    );

    const importedCollision = importStoryBackup(
      jsonBackup,
      [afterTurn.story.id],
      () => 'remapped-story-id',
    );
    expect(importedCollision.id).toBe('remapped-story-id');
    expect(importedCollision.title).toBe('星光练习生（导入副本）');
    expect(importedCollision.id).not.toBe(afterTurn.story.id);
  });

  it('strictly rejects malformed payloads, invalid blueprint types, and dangling node references', () => {
    expect(() => importStoryBackup('not valid json', [])).toThrow();
    expect(() => importStoryBackup(JSON.stringify({ schemaVersion: 99, story: {} }), [])).toThrow();
    expect(() =>
      importStoryBackup(
        JSON.stringify({
          schemaVersion: 1,
          story: {
            id: 's1',
            title: 'T',
            rawScript: 'R',
            blueprint: {
              title: 'T',
              worldRules: 'not-array',
              protagonist: '',
              npcs: [],
              taboos: [],
              openingHook: '',
              extractionStatus: 'complete',
            },
            nodes: {},
            rootNodeIds: [],
            activeLeafNodeId: null,
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        [],
      ),
    ).toThrow();

    expect(() =>
      importStoryBackup(
        JSON.stringify({
          schemaVersion: 1,
          story: {
            id: 's1',
            title: 'T',
            rawScript: 'R',
            blueprint: {
              title: 'T',
              worldRules: [],
              protagonist: '',
              npcs: [],
              taboos: [],
              openingHook: '',
              extractionStatus: 'complete',
            },
            nodes: {},
            rootNodeIds: ['missing-node'],
            activeLeafNodeId: null,
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        [],
      ),
    ).toThrow();
  });
});
