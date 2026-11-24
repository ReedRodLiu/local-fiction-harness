import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  buildTurnUsageTelemetry,
  computeSessionUsageSummary,
  createDefaultBlueprint,
  createFictionHarness,
  createInMemoryStoryStorage,
  mergeLlmUsage,
  newDocument,
  resolveDeepSeekPricingSchedule,
  resolveUsageProviderKind,
  type LlmTransport,
  type ModelConfig,
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
    expect(resolveUsageProviderKind('https://relay.example.com/v1')).toBe('other');
    expect(resolveUsageProviderKind('http://127.0.0.1:4173/api')).toBe('other');
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
          uncompressedPromptChars: 8000,
          compressedPromptChars: 2000,
        }),
      ),
    ]);
    expect(nonOfficial.promptTokens).toBe(700);
    expect(nonOfficial.actualCostUsd).toBeNull();
    expect(nonOfficial.savings).toMatchObject({
      status: 'unavailable',
      reason: 'non-official-provider',
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
});
