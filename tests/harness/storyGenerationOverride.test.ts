import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  convertActiveAssetMode,
  createFictionHarness,
  createInMemoryStoryStorage,
  emptyWorkspace,
  exportFolioBackupV3,
  exportStoryBackup,
  importStoryBackup,
  materializeAssetFromNodes,
  mergeRestoredBackup,
  parseAndValidateFolioBackup,
  resolveEffectiveModelConfig,
  routeEntryMessage,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
  type TurnNode,
} from '../../src/harness/index.ts';

describe('Issue #109 Slice 1: Welcome materialization & Story independent generationPreference override', () => {
  const sampleTurns: TurnNode[] = [
    {
      id: 'u1',
      parentId: null,
      role: 'user',
      content: '开启海上列车奇幻冒险',
      createdAt: 100,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      content: '汽笛拉响，雾气漫过月台。',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      createdAt: 101,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    },
  ];

  it('carries welcome pending generationPreference into materialized Story / DraftWork / LocalCharacter and omits empty overrides', () => {
    const proMax = { model: 'deepseek-v4-pro' as const, reasoningEffort: 'max' as const };

    const storyRes = materializeAssetFromNodes({
      targetMode: 'story',
      title: '海上列车',
      settingMarkdown: '# 设定\n\n海上蒸汽列车',
      turns: sampleTurns,
      generationPreference: proMax,
    });
    expect(storyRes.story?.generationPreference).toEqual(proMax);

    const workRes = materializeAssetFromNodes({
      targetMode: 'writing',
      title: '列车手稿',
      settingMarkdown: '# 设定',
      turns: sampleTurns,
      generationPreference: { model: 'deepseek-v4-pro' },
    });
    expect(workRes.work?.generationPreference).toEqual({ model: 'deepseek-v4-pro' });

    const charRes = materializeAssetFromNodes({
      targetMode: 'character',
      title: '列车长',
      settingMarkdown: '# 人设',
      turns: sampleTurns,
      characterName: '列车长',
      generationPreference: { reasoningEffort: 'none' },
    });
    expect(charRes.character?.generationPreference).toEqual({ reasoningEffort: 'none' });

    const emptyPrefStory = materializeAssetFromNodes({
      targetMode: 'story',
      title: '默认跟随',
      settingMarkdown: '# 设定',
      turns: sampleTurns,
      generationPreference: {},
    });
    expect(emptyPrefStory.story?.generationPreference).toBeUndefined();
    expect(Object.hasOwn(emptyPrefStory.story!, 'generationPreference')).toBe(false);
  });

  it('preserves generationPreference across convertActiveAssetMode', () => {
    const proMax = { model: 'deepseek-v4-pro' as const, reasoningEffort: 'max' as const };
    const { story } = materializeAssetFromNodes({
      targetMode: 'story',
      title: '海上列车',
      settingMarkdown: '# 设定',
      turns: sampleTurns,
      generationPreference: proMax,
    });

    const asWriting = convertActiveAssetMode({
      fromMode: 'story',
      toMode: 'writing',
      story,
    });
    expect(asWriting.work?.generationPreference).toEqual(proMax);

    const asCharacter = convertActiveAssetMode({
      fromMode: 'writing',
      toMode: 'character',
      work: asWriting.work,
    });
    expect(asCharacter.character?.generationPreference).toEqual(proMax);

    const backToStory = convertActiveAssetMode({
      fromMode: 'character',
      toMode: 'story',
      character: asCharacter.character,
    });
    expect(backToStory.story?.generationPreference).toEqual(proMax);
  });

  it('routes welcome turn with pending preference without mutating global default, isolates Story A override from Story B dynamic global follow, and round-trips via .folio.json', async () => {
    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        if (req.messages[0]?.content.includes('第一入口')) {
          yield {
            contentDelta: '```lfh-route\nmode: story\ntitle: 雾港列车\n---\n# 世界观\n\n海上列车\n```\n第一幕开启。',
            finishReason: 'stop',
          };
          return;
        }
        yield { contentDelta: '下一幕展开。', finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    const harness = createFictionHarness({ transport, storage });

    const globalDefault: ModelConfig = {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      apiKey: 'sk-test-global',
      memoryOnly: false,
    };

    // Welcome ephemeral preference: Pro / 极限
    const welcomeOverride = { model: 'deepseek-v4-pro' as const, reasoningEffort: 'max' as const };
    const effectiveWelcome = resolveEffectiveModelConfig(globalDefault, welcomeOverride);
    const routed = await routeEntryMessage('开个海上列车文游', [], transport, effectiveWelcome);
    expect(requests[0]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });
    // Global default stays untouched
    expect(globalDefault.model).toBe('deepseek-flash');
    expect(globalDefault.reasoningEffort).toBe('high');

    const { story: storyA } = materializeAssetFromNodes({
      targetMode: 'story',
      title: routed.title,
      settingMarkdown: routed.settingMarkdown,
      turns: [
        {
          id: 'u-init',
          parentId: null,
          role: 'user',
          content: '开个海上列车文游',
          createdAt: 1,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
        {
          id: 'a-init',
          parentId: 'u-init',
          role: 'assistant',
          content: routed.assistantReply,
          model: routed.model,
          reasoningEffort: routed.reasoningEffort,
          createdAt: 2,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
      ],
      generationPreference: welcomeOverride,
    });
    await harness.saveStory(storyA!);

    // Story B created without override
    const storyB = await harness.saveStory(harness.createStory({ title: '日常小镇' }));

    // Global default changes to Flash / low
    const updatedGlobal: ModelConfig = {
      ...globalDefault,
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    };

    await harness.runTurn(
      storyA!,
      '检查车票',
      resolveEffectiveModelConfig(updatedGlobal, storyA!.generationPreference),
    );
    expect(requests[1]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });

    await harness.runTurn(
      storyB,
      '走进面包房',
      resolveEffectiveModelConfig(updatedGlobal, storyB.generationPreference),
    );
    expect(requests[2]).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'low' });

    // Global default changes to Pro / none -> Story B dynamically follows
    const updatedGlobal2: ModelConfig = {
      ...globalDefault,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'none',
    };
    await harness.runTurn(
      (await storage.getStory(storyB.id))!,
      '继续聊天',
      resolveEffectiveModelConfig(updatedGlobal2, storyB.generationPreference),
    );
    expect(requests[3]).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'none' });

    // Export .folio.json v3 and restore into clean state
    const latestA = (await storage.getStory(storyA!.id))!;
    const latestB = (await storage.getStory(storyB.id))!;
    const v3Json = exportFolioBackupV3({
      stories: [latestA, latestB],
      workspace: emptyWorkspace(),
    });
    const parsedV3 = parseAndValidateFolioBackup(v3Json);
    const merged = mergeRestoredBackup(
      { stories: [], workspace: emptyWorkspace() },
      parsedV3,
    );
    const restoredA = merged.stories.find((s) => s.title === '雾港列车');
    const restoredB = merged.stories.find((s) => s.title === '日常小镇');
    expect(restoredA?.generationPreference).toEqual(welcomeOverride);
    expect(restoredB?.generationPreference).toBeUndefined();

    // Single-story export/import also preserves override
    const singleJson = exportStoryBackup(latestA);
    const restoredSingle = importStoryBackup(singleJson, []);
    expect(restoredSingle.generationPreference).toEqual(welcomeOverride);
  });
});
