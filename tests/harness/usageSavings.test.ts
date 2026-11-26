import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  buildTurnUsageTelemetry,
  computeSessionUsageSummary,
  computeWorkspaceUsageSummary,
  createDefaultBlueprint,
  createFictionHarness,
  createInMemoryStoryStorage,
  mergeLlmUsage,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  resolveDeepSeekPricingSchedule,
  resolveUsageProviderKind,
  type LlmTransport,
  type ModelConfig,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function assistantTurn(
  id: string,
  telemetry?: TurnNode['telemetry'],
): TurnNode {
  return {
    id,
    parentId: null,
    role: 'assistant',
    content: '正文回复。',
    createdAt: 100,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    ...(telemetry ? { telemetry } : {}),
  };
}

describe('usageSavings telemetry & cost estimator', () => {
  it('merges partial SSE usages and classifies official vs non-official hosts strictly', () => {
    const merged = mergeLlmUsage(
      {
        promptTokens: 100,
        completionTokens: 20,
        promptCacheHitTokens: 60,
        promptCacheMissTokens: 40,
        completionTokensDetails: { reasoningTokens: 5 },
      },
      {
        promptTokens: 80,
        completionTokens: 30,
        promptCacheHitTokens: 50,
        promptCacheMissTokens: 30,
        completionTokensDetails: { reasoningTokens: 10 },
      },
    );
    expect(merged).toEqual({
      promptTokens: 180,
      completionTokens: 50,
      promptCacheHitTokens: 110,
      promptCacheMissTokens: 70,
      completionTokensDetails: { reasoningTokens: 15 },
    });

    expect(resolveUsageProviderKind('https://api.deepseek.com')).toBe('deepseek-official');
    expect(resolveUsageProviderKind('https://api.deepseek.com/v1')).toBe('deepseek-official');
    expect(resolveUsageProviderKind('https://api.openai.com/v1')).toBe('other');
    expect(resolveUsageProviderKind('https://relay.example.com/v1')).toBe('other');
    expect(resolveUsageProviderKind('http://127.0.0.1:4173/api')).toBe('other');
    expect(
      resolveUsageProviderKind('https://api.siliconflow.cn/v1', {
        pricing: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 },
      }),
    ).toBe('custom-priced');
    expect(
      resolveUsageProviderKind('https://custom.example.com/v1', {
        supportsBuiltinPricing: true,
      }),
    ).toBe('deepseek-official');
    expect(
      resolveUsageProviderKind('https://custom.example.com/v1', {
        capabilities: {
          thinkingProtocol: 'deepseek',
          prefixProtocol: 'deepseek_beta',
          supportsBalanceQuery: true,
          supportsBuiltinSearch: true,
          supportsBuiltinPricing: true,
        },
      }),
    ).toBe('deepseek-official');

    const customTelemetry = buildTurnUsageTelemetry({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3',
      pricing: {
        currency: 'CNY',
        inputPerMillion: 2,
        cacheHitInputPerMillion: 0.5,
        outputPerMillion: 8,
      },
      generationUsage: { promptTokens: 100, completionTokens: 20 },
    });
    expect(customTelemetry.providerKind).toBe('custom-priced');
    expect(customTelemetry.pricingSnapshot).toEqual({
      currency: 'CNY',
      inputPerMillion: 2,
      cacheHitInputPerMillion: 0.5,
      outputPerMillion: 8,
    });

    const invalidPricingTelemetry = buildTurnUsageTelemetry({
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-4o-mini',
      pricing: { currency: 'USD', inputPerMillion: -1, outputPerMillion: 2 },
    });
    expect(invalidPricingTelemetry.providerKind).toBe('other');
    expect(invalidPricingTelemetry.pricingSnapshot).toBeUndefined();

    expect(resolveDeepSeekPricingSchedule(Date.parse('2026-11-24T17:00:00Z'))).toBe('off-peak');
    expect(resolveDeepSeekPricingSchedule(Date.parse('2026-11-24T12:00:00Z'))).toBe('peak');
  });

  it('keeps savings unavailable for missing usage, non-official endpoints, incomplete usage, and pre-compression chats', () => {
    expect(computeSessionUsageSummary([assistantTurn('a1')]).savings).toMatchObject({
      status: 'unavailable',
      reason: 'no-usage-data',
    });

    const nonOfficial = computeSessionUsageSummary([
      assistantTurn(
        'a1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://proxy.example.com/v1',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 500,
            promptCacheMissTokens: 200,
            completionTokens: 150,
          },
          summaryUsage: {
            promptTokens: 300,
            completionTokens: 50,
          },
          uncompressedPromptChars: 8000,
          compressedPromptChars: 2000,
        }),
      ),
    ]);
    expect(nonOfficial.promptTokens).toBe(1000);
    expect(nonOfficial.actualCostUsd).toBeNull();
    // omittedChars = 6000; ratio = clamp(700/2000 = 0.4..1.2) = 0.4 -> evicted = 2400; summaryOverhead = 350 -> net = 2050
    expect(nonOfficial.savings).toEqual({
      status: 'tokens-only',
      evictedInputTokensEstimated: 2400,
      summaryOverheadTokens: 350,
      netSavedTokensEstimated: 2050,
      compressedTurnCount: 1,
      comparedTurnCount: 1,
    });

    const preCompression = computeSessionUsageSummary([
      assistantTurn(
        'a1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 800,
            promptCacheMissTokens: 200,
            completionTokens: 100,
          },
          uncompressedPromptChars: 1500,
          compressedPromptChars: 1500,
        }),
      ),
    ]);
    expect(preCompression.actualCostUsd).not.toBeNull();
    expect(preCompression.savings).toMatchObject({
      status: 'unavailable',
      reason: 'no-compression-yet',
    });

    const incomplete = computeSessionUsageSummary([
      assistantTurn(
        'a1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: { promptTokens: 500 },
          uncompressedPromptChars: 5000,
          compressedPromptChars: 1000,
        }),
      ),
    ]);
    expect(incomplete.savings).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete-usage',
    });
  });

  it('computes real official savings once compression evicts older turns and propagates telemetry from runTurn', async () => {
    const summary = computeSessionUsageSummary(
      [
        assistantTurn(
          'a1',
          buildTurnUsageTelemetry({
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            generationUsage: {
              promptCacheHitTokens: 1500,
              promptCacheMissTokens: 500,
              completionTokens: 400,
              completionTokensDetails: { reasoningTokens: 100 },
            },
            summaryUsage: {
              promptCacheHitTokens: 0,
              promptCacheMissTokens: 1000,
              completionTokens: 100,
            },
            uncompressedPromptChars: 42000,
            compressedPromptChars: 3000,
            retrievedNodeCount: 2,
          }),
        ),
      ],
      { scheduleOverride: 'off-peak' },
    );

    expect(summary.retrievedTurnCount).toBe(1);
    expect(summary.totalRetrievedNodes).toBe(2);
    expect(summary.savings.status).toBe('available');
    if (summary.savings.status === 'available') {
      expect(summary.savings.estimatedSavingsUsd).toBeGreaterThan(0);
      expect(summary.savings.baselineCostUsd).toBeGreaterThan(summary.savings.actualCostUsd);
      expect(summary.savings.savingsPercent).toBeGreaterThan(0);
    }

    const storage = createInMemoryStoryStorage();
    let seenIncludeUsage = false;
    const transport: LlmTransport = {
      async *streamChat(request) {
        if (request.includeUsage) seenIncludeUsage = true;
        yield { contentDelta: '```lfh-proposal\nmode: keep\n```\n夜风吹过长廊。' };
        yield { finishReason: 'stop' };
        yield {
          usage: {
            promptTokens: 600,
            completionTokens: 90,
            promptCacheHitTokens: 400,
            promptCacheMissTokens: 200,
          },
        };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage,
      loadPublicDocument: async () => newDocument('偏好短句'),
    });
    const config: ModelConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test-1234',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
      memoryOnly: false,
    };
    const story = await harness.createAndSaveStory({
      title: '雨夜',
      rawScript: '# 雨夜\n\n从长廊出发。',
      blueprint: createDefaultBlueprint('雨夜'),
    });
    const executed = await harness.runTurn(story, '推门看一眼', config);
    expect(seenIncludeUsage).toBe(true);
    expect(executed.assistantNode.telemetry?.providerKind).toBe('deepseek-official');
    expect(executed.assistantNode.telemetry?.generationUsage).toEqual({
      promptTokens: 600,
      completionTokens: 90,
      promptCacheHitTokens: 400,
      promptCacheMissTokens: 200,
    });
    expect(executed.assistantNode.telemetry?.compressedPromptChars).toBeGreaterThan(0);
  });

  it('aggregates all historical turns across stories (including branches/retries), writing works, and character conversations without double-counting', () => {
    const empty = computeWorkspaceUsageSummary({}, { scheduleOverride: 'off-peak' });
    expect(empty.itemCount).toBe(0);
    expect(empty.total.recordedTurnCount).toBe(0);
    expect(empty.total.savings).toMatchObject({
      status: 'unavailable',
      reason: 'no-usage-data',
    });
    expect(empty.modes.story.itemCount).toBe(0);
    expect(empty.modes.writing.itemCount).toBe(0);
    expect(empty.modes.character.itemCount).toBe(0);

    const officialTelemetry = (
      hit: number,
      miss: number,
      completion: number,
      reasoning = 0,
      uncompressed = 20000,
      compressed = 4000,
      retrieved = 0,
      summaryMiss = 0,
      summaryCompletion = 0,
    ) =>
      buildTurnUsageTelemetry({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        generationUsage: {
          promptCacheHitTokens: hit,
          promptCacheMissTokens: miss,
          completionTokens: completion,
          ...(reasoning > 0 ? { completionTokensDetails: { reasoningTokens: reasoning } } : {}),
        },
        ...(summaryMiss > 0 || summaryCompletion > 0
          ? {
              summaryUsage: {
                promptCacheHitTokens: 0,
                promptCacheMissTokens: summaryMiss,
                completionTokens: summaryCompletion,
              },
            }
          : {}),
        uncompressedPromptChars: uncompressed,
        compressedPromptChars: compressed,
        ...(retrieved > 0 ? { retrievedNodeCount: retrieved } : {}),
      });

    // Story 1: active branch (a1) + off-branch retry/fork (a2)
    const story1: Story = {
      id: 'story-1',
      title: '雨夜归人',
      rawScript: '',
      blueprint: createDefaultBlueprint('雨夜归人'),
      nodes: {
        u1: {
          id: 'u1',
          parentId: null,
          role: 'user',
          content: '进门',
          createdAt: 10,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
        a1: assistantTurn('a1', officialTelemetry(800, 200, 120, 20, 18000, 3000, 2)),
        a2: assistantTurn('a2', officialTelemetry(600, 400, 100, 10, 18000, 3000, 1)),
      },
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a1',
      createdAt: 1,
      updatedAt: 2,
    };

    // Writing 1: V0.2 discussionNodes (w1 active + w2 off-branch retry) AND mirrored w1 in discussion[] (must NOT double count)
    const work1 = newWork('长街灯影');
    const w1 = assistantTurn('w1', officialTelemetry(900, 100, 150, 30, 16000, 3200, 0, 500, 50));
    const w2 = assistantTurn('w2', officialTelemetry(500, 500, 80, 0, 16000, 3200, 0));
    work1.discussionNodes = { w1, w2 };
    work1.activeDiscussionLeafId = 'w1';
    work1.discussion = [w1];

    // Writing 2: Legacy discussion[] only (discussionNodes empty)
    const work2 = newWork('旧稿');
    const wLegacy = assistantTurn('wl1', officialTelemetry(400, 100, 60, 0, 2000, 2000));
    work2.discussionNodes = {};
    work2.discussion = [wLegacy];

    // Character 1 with 2 conversations (one with branch/retry)
    const char1 = newCharacter('沈砚', '设定');
    const conv1 = newConversation(char1, 'personal', '', '雨夜');
    conv1.nodes = {
      c1: assistantTurn('c1', officialTelemetry(700, 300, 90, 15, 12000, 3000, 1)),
      c2: assistantTurn('c2', officialTelemetry(300, 200, 70, 5, 12000, 3000, 0)),
    };
    conv1.activeLeafNodeId = 'c1';
    const conv2 = newConversation(char1, 'roleplay', '', '酒馆');
    conv2.nodes = {
      c3: assistantTurn('c3', officialTelemetry(200, 300, 50, 0, 10000, 2500, 2)),
    };
    conv2.activeLeafNodeId = 'c3';
    char1.conversations = [conv1, conv2];
    char1.activeConversationId = conv1.id;

    // Pass duplicate story1 reference to verify id-based deduplication
    const workspaceSummary = computeWorkspaceUsageSummary(
      {
        stories: [story1, story1],
        creativeWorkspace: {
          works: [work1, work2],
          characters: [char1],
        },
      },
      { scheduleOverride: 'off-peak' },
    );

    expect(workspaceSummary.itemCount).toBe(4);
    expect(workspaceSummary.modes.story.itemCount).toBe(1);
    expect(workspaceSummary.modes.story.recordedTurnCount).toBe(2);
    expect(workspaceSummary.modes.story.promptTokens).toBe(2000);
    expect(workspaceSummary.modes.story.compressedTurnCount).toBe(2);
    expect(workspaceSummary.modes.story.totalRetrievedNodes).toBe(3);

    expect(workspaceSummary.modes.writing.itemCount).toBe(2);
    // w1 (1000 + 500 summary), w2 (1000), wLegacy (500) => 3 recorded turns, 3000 promptTokens
    expect(workspaceSummary.modes.writing.recordedTurnCount).toBe(3);
    expect(workspaceSummary.modes.writing.promptTokens).toBe(3000);
    expect(workspaceSummary.modes.writing.compressedTurnCount).toBe(2);

    expect(workspaceSummary.modes.character.itemCount).toBe(1);
    expect(workspaceSummary.modes.character.conversationCount).toBe(2);
    expect(workspaceSummary.modes.character.recordedTurnCount).toBe(3);
    expect(workspaceSummary.modes.character.promptTokens).toBe(2000);
    expect(workspaceSummary.modes.character.totalRetrievedNodes).toBe(3);

    // Grand total: 2 + 3 + 3 = 8 turns; promptTokens = 2000 + 3000 + 2000 = 7000
    expect(workspaceSummary.total.recordedTurnCount).toBe(8);
    expect(workspaceSummary.total.promptTokens).toBe(7000);
    expect(workspaceSummary.total.promptCacheHitTokens).toBe(4400);
    expect(workspaceSummary.total.promptCacheMissTokens).toBe(2600);
    expect(workspaceSummary.total.completionTokens).toBe(770); // 120+100 + 150+50+80+60 + 90+70+50
    expect(workspaceSummary.total.reasoningTokens).toBe(80); // 20+10 + 30 + 15+5
    expect(workspaceSummary.total.compressedTurnCount).toBe(7);
    expect(workspaceSummary.total.retrievedTurnCount).toBe(4);
    expect(workspaceSummary.total.totalRetrievedNodes).toBe(6);
    expect(workspaceSummary.total.savings.status).toBe('available');
    if (workspaceSummary.total.savings.status === 'available') {
      expect(workspaceSummary.total.savings.estimatedSavingsUsd).toBeGreaterThan(0);
      expect(workspaceSummary.total.savings.savingsPercent).toBeGreaterThan(0);
    }
  });

  it('preserves honest unavailable and cost-increase semantics across mixed providers, pre-compression, and high summary overhead', () => {
    const story: Story = {
      id: 's-official',
      title: '官方故事',
      rawScript: '',
      blueprint: createDefaultBlueprint('官方故事'),
      nodes: {
        a1: assistantTurn(
          'a1',
          buildTurnUsageTelemetry({
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            generationUsage: {
              promptCacheHitTokens: 900,
              promptCacheMissTokens: 100,
              completionTokens: 100,
            },
            uncompressedPromptChars: 12000,
            compressedPromptChars: 2000,
          }),
        ),
      },
      rootNodeIds: ['a1'],
      activeLeafNodeId: 'a1',
      createdAt: 1,
      updatedAt: 1,
    };

    const relayWork = newWork('中转作品');
    relayWork.discussionNodes = {
      w1: assistantTurn(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://relay.example.com/v1',
          model: 'deepseek-flash',
          generationUsage: {
            promptTokens: 500,
            completionTokens: 80,
          },
          uncompressedPromptChars: 8000,
          compressedPromptChars: 2000,
        }),
      ),
    };

    const mixed = computeWorkspaceUsageSummary(
      {
        stories: [story],
        works: [relayWork],
        characters: [],
      },
      { scheduleOverride: 'off-peak' },
    );
    expect(mixed.modes.story.savings.status).toBe('available');
    expect(mixed.modes.writing.savings.status).toBe('tokens-only');
    expect(mixed.total.actualCostUsd).toBeNull();
    expect(mixed.total.promptTokens).toBe(1500);
    expect(mixed.total.savings).toMatchObject({
      status: 'tokens-only',
      compressedTurnCount: 2,
      comparedTurnCount: 2,
    });

    const preCompressionWork = newWork('未压缩作品');
    preCompressionWork.discussionNodes = {
      w1: assistantTurn(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 800,
            promptCacheMissTokens: 200,
            completionTokens: 100,
          },
          uncompressedPromptChars: 1500,
          compressedPromptChars: 1500,
        }),
      ),
    };
    const preCompression = computeWorkspaceUsageSummary(
      { works: [preCompressionWork] },
      { scheduleOverride: 'peak' },
    );
    expect(preCompression.total.savings).toMatchObject({
      status: 'unavailable',
      reason: 'no-compression-yet',
      schedule: 'peak',
    });

    const costlyWork = newWork('高摘要开销作品');
    costlyWork.discussionNodes = {
      w1: assistantTurn(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 1000,
            promptCacheMissTokens: 0,
            completionTokens: 100,
          },
          summaryUsage: {
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 5000,
            completionTokens: 500,
          },
          uncompressedPromptChars: 1200,
          compressedPromptChars: 1000,
        }),
      ),
    };
    const costly = computeWorkspaceUsageSummary(
      { works: [costlyWork] },
      { scheduleOverride: 'off-peak' },
    );
    expect(costly.total.savings.status).toBe('available');
    if (costly.total.savings.status === 'available') {
      expect(costly.total.savings.estimatedSavingsUsd).toBeLessThan(0);
    }
  });

  it('computes custom-priced savings in CNY or USD and falls back to tokens-only when currencies mix', () => {
    const cnyTurn = assistantTurn(
      'cny-1',
      buildTurnUsageTelemetry({
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'deepseek-ai/DeepSeek-V3',
        pricing: {
          currency: 'CNY',
          inputPerMillion: 2,
          cacheHitInputPerMillion: 0.5,
          outputPerMillion: 8,
        },
        generationUsage: {
          promptCacheHitTokens: 1000,
          promptCacheMissTokens: 1000,
          completionTokens: 500,
        },
        summaryUsage: {
          promptTokens: 500,
          completionTokens: 100,
        },
        uncompressedPromptChars: 12000,
        compressedPromptChars: 2000,
      }),
    );

    const cnySummary = computeSessionUsageSummary([cnyTurn]);
    expect(cnySummary.actualCostUsd).toBeNull();
    expect(cnySummary.actualCostCurrency).toBe('CNY');
    // gen cost: (1000*0.5 + 1000*2 + 500*8)/1e6 = 6500/1e6 = 0.0065
    // sum cost: (500*2 + 100*8)/1e6 = 1800/1e6 = 0.0018 -> total actual = 0.0083
    expect(cnySummary.actualCostAmount).toBeCloseTo(0.0083, 8);
    expect(cnySummary.savings.status).toBe('available');
    if (cnySummary.savings.status === 'available') {
      expect(cnySummary.savings.currency).toBe('CNY');
      expect(cnySummary.savings.pricingSource).toBe('custom');
      expect(cnySummary.savings.actualCostUsd).toBeCloseTo(0.0083, 8);
      // evicted = 10000 * clamp(2000/2000=1.0) = 10000; hitRatio = 0.5 -> eff rate = 0.5*0.5 + 0.5*2 = 1.25/M
      // extraBaseline = 10000*1.25/1e6 = 0.0125; baseline = 0.0065 + 0.0125 = 0.019
      expect(cnySummary.savings.baselineCostUsd).toBeCloseTo(0.019, 8);
      expect(cnySummary.savings.estimatedSavingsUsd).toBeCloseTo(0.019 - 0.0083, 8);
    }

    const usdCustomTurn = assistantTurn(
      'usd-1',
      buildTurnUsageTelemetry({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        pricing: {
          currency: 'USD',
          inputPerMillion: 0.15,
          outputPerMillion: 0.6,
        },
        generationUsage: {
          promptTokens: 1000,
          completionTokens: 200,
        },
        uncompressedPromptChars: 10000,
        compressedPromptChars: 2000,
      }),
    );

    const usdSummary = computeSessionUsageSummary([usdCustomTurn]);
    expect(usdSummary.actualCostUsd).toBeCloseTo(0.00027, 8);
    expect(usdSummary.actualCostCurrency).toBe('USD');
    expect(usdSummary.savings.status).toBe('available');
    if (usdSummary.savings.status === 'available') {
      expect(usdSummary.savings.currency).toBe('USD');
      expect(usdSummary.savings.pricingSource).toBe('custom');
    }

    const mixedCurrencies = computeSessionUsageSummary([cnyTurn, usdCustomTurn]);
    expect(mixedCurrencies.actualCostUsd).toBeNull();
    expect(mixedCurrencies.savings).toMatchObject({
      status: 'tokens-only',
      compressedTurnCount: 2,
      comparedTurnCount: 2,
    });
  });
});
