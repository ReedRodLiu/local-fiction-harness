import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  importStoryBackup,
  type LlmTransport,
} from '../../src/harness/index.ts';

const mockTransport: LlmTransport = {
  async *streamChat() {
    yield { contentDelta: '测试叙事输出。', finishReason: 'stop' };
  },
};

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

describe('Slice 3: Multi-story storage & auto-persistence', () => {
  it('auto-persists created stories, turns, renames, and active selection across harness instances', async () => {
    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harnessA = createFictionHarness({
      transport: mockTransport,
      storage,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `id-${++seq}`,
    });

    const story1 = await harnessA.createAndSaveStory({ title: '宫闱风云', rawScript: '规则A' });
    const story2 = await harnessA.createAndSaveStory({ title: '修仙奇缘', rawScript: '规则B' });

    const turnResult = await harnessA.runTurn(story2, '拜入宗门', testConfig);
    expect(turnResult.story.activeLeafNodeId).toBe(turnResult.assistantNode.id);

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
    expect(active?.activeLeafNodeId).toBe(turnResult.assistantNode.id);

    await harnessB.deleteStory(story2.id);
    const remaining = await harnessB.listStories();
    expect(remaining.map((s) => s.id)).toEqual([story1.id]);
  });
});

describe('Slice 3: Versioned Story JSON export & import backup', () => {
  it('round-trips a full Story with blueprint, nodes, and summary snapshots without loss', async () => {
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
    });
    const afterTurn = await harness.runTurn(created, '报到练习室', testConfig);

    const jsonBackup = exportStoryBackup(afterTurn.story);
    const parsed = JSON.parse(jsonBackup);
    expect(parsed.schemaVersion).toBe(1);

    // Importing into a fresh set with no ID collisions preserves original story ID and all nodes
    const importedFresh = importStoryBackup(jsonBackup, []);
    expect(importedFresh.id).toBe(afterTurn.story.id);
    expect(importedFresh.rawScript).toBe('【核心铁律】每周淘汰一人。');
    expect(importedFresh.activeLeafNodeId).toBe(afterTurn.assistantNode.id);
    expect(Object.keys(importedFresh.nodes)).toHaveLength(2);

    // Importing when ID already exists remaps ID and marks copy to avoid overwriting
    const importedCollision = importStoryBackup(
      jsonBackup,
      [afterTurn.story.id],
      () => 'remapped-story-id',
    );
    expect(importedCollision.id).toBe('remapped-story-id');
    expect(importedCollision.title).toContain('星光练习生');
    expect(importedCollision.id).not.toBe(afterTurn.story.id);
  });

  it('rejects malformed or incompatible JSON backup payloads', () => {
    expect(() => importStoryBackup('not valid json', [])).toThrow();
    expect(() => importStoryBackup(JSON.stringify({ schemaVersion: 99, story: {} }), [])).toThrow();
    expect(() => importStoryBackup(JSON.stringify({ schemaVersion: 1, story: { id: 'x' } }), [])).toThrow();
  });
});
