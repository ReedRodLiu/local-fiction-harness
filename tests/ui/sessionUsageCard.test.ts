import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  buildTurnUsageTelemetry,
  createDefaultBlueprint,
  emptyWorkspace,
  newCharacter,
  newConversation,
  newWork,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { CompanionSheet } from '../../src/ui/CompanionSheet.tsx';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';
import { SessionUsageCard } from '../../src/ui/SessionUsageCard.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

function assistantNode(id: string, telemetry?: TurnNode['telemetry']): TurnNode {
  return {
    id,
    parentId: null,
    role: 'assistant',
    content: '雨落在站台铁皮棚顶上。',
    createdAt: 100,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    ...(telemetry ? { telemetry } : {}),
  };
}

describe('SessionUsageCard', () => {
  it('renders empty guidance and unavailable reason without any $0 amounts when telemetry is empty', () => {
    const emptyMarkup = renderToStaticMarkup(
      createElement(SessionUsageCard, { nodes: [] }),
    );
    expect(emptyMarkup).toContain('data-testid="session-usage-card"');
    expect(emptyMarkup).toContain('实测用量与预计省费');
    expect(emptyMarkup).toContain(
      '暂无实测用量数据（发送下一轮后自动记录模型返回的 token 统计）。',
    );
    expect(emptyMarkup).toContain('本会话暂无可比省费：尚无模型返回的实测用量记录');
    expect(emptyMarkup).not.toContain('$0');
    expect(emptyMarkup).not.toContain('US$');

    const zeroTelemetryMarkup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a0',
            buildTurnUsageTelemetry({
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-flash',
              uncompressedPromptChars: 1200,
              compressedPromptChars: 1200,
            }),
          ),
        ],
      }),
    );
    expect(zeroTelemetryMarkup).toContain('本会话暂无可比省费：尚无模型返回的实测用量记录');
    expect(zeroTelemetryMarkup).not.toContain('$0');
    expect(zeroTelemetryMarkup).not.toContain('US$');
  });

  it('renders tokens-only positive savings for unpriced third-party providers without error banner or faking USD', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a1',
            buildTurnUsageTelemetry({
              baseUrl: 'https://relay.example.com/v1',
              model: 'deepseek-flash',
              generationUsage: {
                promptTokens: 1200,
                completionTokens: 320,
                completionTokensDetails: { reasoningTokens: 80 },
              },
              uncompressedPromptChars: 10000,
              compressedPromptChars: 2400,
              retrievedNodeCount: 3,
            }),
          ),
        ],
      }),
    );

    expect(markup).toContain('1 轮');
    expect(markup).toContain('1,200');
    expect(markup).toContain('0 / 1,200');
    expect(markup).toContain('>—<');
    expect(markup).toContain('320');
    expect(markup).toContain('思考 Token 80');
    expect(markup).toContain('1 轮压缩');
    expect(markup).toContain('历史引用 3 条（1 轮）');
    expect(markup).toContain('data-testid="session-usage-savings"');
    expect(markup).toContain('is-saved');
    expect(markup).toContain('累计节省输入估算');
    expect(markup).toContain('3,800 Token');
    expect(markup).toContain('已省略输入估算');
    expect(markup).toContain('摘要压缩开销');
    expect(markup).toContain('0 Token');
    expect(markup).toContain('对比压缩轮次');
    expect(markup).toContain('未配置模型单价时只统计 Token 省量；可在设置中选填单价以估算花费');
    expect(markup).not.toContain('data-testid="session-usage-unavailable"');
    expect(markup).not.toContain('非 DeepSeek 官方接口');
    expect(markup).not.toContain('非高峰优惠时段');
    expect(markup).not.toContain('标准时段');
    expect(markup).not.toContain('US$');
    expect(markup).not.toContain('$0');
  });

  it('renders custom-priced savings in CNY (¥) or USD without DeepSeek schedule pill', () => {
    const cnyMarkup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a1',
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
              uncompressedPromptChars: 12000,
              compressedPromptChars: 2000,
            }),
          ),
        ],
      }),
    );

    expect(cnyMarkup).toContain('data-testid="session-usage-savings"');
    expect(cnyMarkup).toContain('预计省费');
    expect(cnyMarkup).toContain('¥');
    expect(cnyMarkup).not.toContain('US$');
    expect(cnyMarkup).not.toContain('非高峰优惠时段');
    expect(cnyMarkup).not.toContain('标准时段');
    expect(cnyMarkup).toContain('按自定义模型单价与未压缩前文基线估算');
  });

  it('renders real tokens and no-compression-yet reason for pre-compression official DeepSeek turns', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a1',
            buildTurnUsageTelemetry({
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-flash',
              generationUsage: {
                promptCacheHitTokens: 800,
                promptCacheMissTokens: 200,
                completionTokens: 150,
              },
              uncompressedPromptChars: 1500,
              compressedPromptChars: 1500,
            }),
          ),
        ],
      }),
    );

    expect(markup).toContain('1 轮');
    expect(markup).toContain('1,000');
    expect(markup).toContain('800 / 200');
    expect(markup).toContain('80.0%');
    expect(markup).toContain('150');
    expect(markup).toContain('0 轮压缩');
    expect(markup).toContain('本会话暂无可比省费');
    expect(markup).toContain('尚未触发前文压缩');
    expect(markup).not.toContain('US$');
    expect(markup).not.toContain('$0');
  });

  it('renders baseline, actual cost, and net savings percentage for compressed official DeepSeek turns', () => {
    const nodes: TurnNode[] = [
      assistantNode(
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
    ];

    const offPeakMarkup = renderToStaticMarkup(
      createElement(SessionUsageCard, { nodes, scheduleOverride: 'off-peak' }),
    );
    expect(offPeakMarkup).toContain('data-testid="session-usage-savings"');
    expect(offPeakMarkup).toContain('非高峰优惠时段');
    expect(offPeakMarkup).toContain('预计省费');
    expect(offPeakMarkup).toContain('实测费用');
    expect(offPeakMarkup).toContain('未压缩基线');
    expect(offPeakMarkup).toContain('US$');
    expect(offPeakMarkup).toMatch(/（\d+\.\d+%）/);
    expect(offPeakMarkup).toContain('按 DeepSeek 官方公开费率与未压缩前文基线估算');

    const peakMarkup = renderToStaticMarkup(
      createElement(SessionUsageCard, { nodes, scheduleOverride: 'peak' }),
    );
    expect(peakMarkup).toContain('标准时段');
  });

  it('renders positive abs value under 费用增加 when summary overhead outweighs compression savings', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a1',
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
        ],
        scheduleOverride: 'off-peak',
      }),
    );

    expect(markup).toContain('费用增加');
    expect(markup).not.toContain('US$-');
    expect(markup).toContain('is-increased');
  });

  it('renders incomplete-usage reason when official usage is missing completion tokens', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionUsageCard, {
        nodes: [
          assistantNode(
            'a1',
            buildTurnUsageTelemetry({
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-flash',
              generationUsage: {
                promptCacheHitTokens: 600,
                promptCacheMissTokens: 400,
                completionTokens: 100,
              },
              uncompressedPromptChars: 5000,
              compressedPromptChars: 1000,
            }),
          ),
          assistantNode(
            'a2',
            buildTurnUsageTelemetry({
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-flash',
              generationUsage: { promptTokens: 500 },
              uncompressedPromptChars: 6000,
              compressedPromptChars: 1000,
            }),
          ),
        ],
      }),
    );

    expect(markup).toContain('本会话暂无可比省费');
    expect(markup).toContain('缺少完整 token 用量字段');
    expect(markup).not.toContain('US$');
  });

  it('mounts inside CompanionSheet, CharacterPane, and DraftPane companion panels above branch notes', () => {
    const telemetry = buildTurnUsageTelemetry({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      generationUsage: {
        promptCacheHitTokens: 900,
        promptCacheMissTokens: 100,
        completionTokens: 120,
      },
      uncompressedPromptChars: 12000,
      compressedPromptChars: 2000,
    });

    const story: Story = {
      id: 'story-1',
      title: '测试故事',
      rawScript: '',
      blueprint: createDefaultBlueprint('测试故事'),
      nodes: {
        a1: assistantNode('a1', telemetry),
      },
      rootNodeIds: ['a1'],
      activeLeafNodeId: 'a1',
      createdAt: 1,
      updatedAt: 1,
    };

    const storyMarkup = renderToStaticMarkup(
      createElement(CompanionSheet, {
        open: true,
        story,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        isStreaming: false,
        isSummarizing: false,
        isBranchSwitching: false,
        onSwitchBranch: () => undefined,
        onRenameBranch: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(storyMarkup).toContain('data-testid="session-usage-card"');
    expect(storyMarkup.indexOf('data-testid="session-usage-card"')).toBeLessThan(
      storyMarkup.indexOf('data-testid="branch-note-details"'),
    );

    const character = newCharacter('岑灯', '夜航员人设');
    const conv = newConversation(character, 'personal');
    conv.nodes = { a1: assistantNode('a1', telemetry) };
    conv.activeLeafNodeId = 'a1';
    character.conversations = [conv];
    character.activeConversationId = conv.id;

    const work = newWork('雾港笔记');
    work.discussionNodes = { a1: assistantNode('a1', telemetry) };
    work.activeDiscussionLeafId = 'a1';

    const workspace = {
      ...emptyWorkspace(),
      characters: [character],
      activeCharacterId: character.id,
      works: [work],
      activeWorkId: work.id,
    };

    const characterMarkup = renderToStaticMarkup(
      createElement(CreativeWorkspace, {
        mode: 'character',
        workspace,
        ready: true,
        storageError: '',
        save: async () => workspace,
        read: async () => workspace,
        runtime: {} as never,
        requestModel: () => undefined,
        openPublic: () => undefined,
        openDocument: () => undefined,
        initialTurn: null,
        onConsumeInitialTurn: () => undefined,
        companionOpen: true,
        setCompanionOpen: () => undefined,
      }),
    );
    expect(characterMarkup).toContain('data-testid="session-usage-card"');
    expect(characterMarkup.indexOf('data-testid="session-usage-card"')).toBeLessThan(
      characterMarkup.indexOf('data-testid="branch-note-details"'),
    );

    const writingMarkup = renderToStaticMarkup(
      createElement(CreativeWorkspace, {
        mode: 'writing',
        workspace,
        ready: true,
        storageError: '',
        save: async () => workspace,
        read: async () => workspace,
        runtime: {} as never,
        requestModel: () => undefined,
        openPublic: () => undefined,
        openDocument: () => undefined,
        initialTurn: null,
        onConsumeInitialTurn: () => undefined,
        companionOpen: true,
        setCompanionOpen: () => undefined,
      }),
    );
    expect(writingMarkup).toContain('data-testid="session-usage-card"');
    expect(writingMarkup.indexOf('data-testid="session-usage-card"')).toBeLessThan(
      writingMarkup.indexOf('data-testid="branch-note-details"'),
    );
  });
});
