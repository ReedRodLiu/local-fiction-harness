import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  EMPTY_SUMMARY_SNAPSHOT,
  buildTurnUsageTelemetry,
  computeWorkspaceUsageSummary,
  createDefaultBlueprint,
  newCharacter,
  newConversation,
  newWork,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';

function assistantNode(id: string, telemetry?: TurnNode['telemetry']): TurnNode {
  return {
    id,
    parentId: null,
    role: 'assistant',
    content: '风穿过走廊。',
    createdAt: 100,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    ...(telemetry ? { telemetry } : {}),
  };
}

function renderSettings(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      appVersion: '0.4.2',
      hasCredentials: true,
      config: { ...DEFAULT_MODEL_CONFIG, apiKey: 'sk-1234567890abcd' },
      useDevEnvKey: false,
      showDevTestProxy: false,
      themePreference: 'system',
      fontSize: 16,
      canExportCurrentStory: false,
      currentStoryTitle: '',
      onBack: vi.fn(),
      onOpenSetupWizard: vi.fn(),
      onClearSavedKey: vi.fn(),
      onApplyDevTestConfig: vi.fn(),
      onOpenDiagnostics: vi.fn(),
      onOpenPublicMemory: vi.fn(),
      onExportCurrentStory: vi.fn(),
      onImportBackupFile: vi.fn(),
      onThemePreferenceChange: vi.fn(),
      onFontSizeChange: vi.fn(),
      ...overrides,
    }),
  );
}

describe('SettingsPage WorkspaceUsageSummaryCard (Issue #141)', () => {
  it('renders 省 Token 与用量总览 prominently after 连接 DeepSeek and before 阅读与外观, with honest empty unavailable state', () => {
    const markup = renderSettings();

    expect(markup).toContain('data-testid="settings-usage-overview"');
    expect(markup).toContain('省 Token 与用量总览');
    const connIdx = markup.indexOf('data-testid="settings-connection-group"');
    const usageIdx = markup.indexOf('data-testid="settings-usage-overview"');
    const appearanceIdx = markup.indexOf('data-testid="settings-appearance-group"');
    expect(connIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeGreaterThan(connIdx);
    expect(appearanceIdx).toBeGreaterThan(usageIdx);

    expect(markup).toContain('暂无可比省费');
    expect(markup).toContain('尚无模型返回的实测用量记录');
    expect(markup).toContain('data-testid="workspace-usage-mode-story"');
    expect(markup).toContain('data-testid="workspace-usage-mode-writing"');
    expect(markup).toContain('data-testid="workspace-usage-mode-character"');
    expect(markup).toContain('文游');
    expect(markup).toContain('写故事');
    expect(markup).toContain('角色互动');
    expect(markup).not.toContain('$0');
    expect(markup).not.toContain('US$');
  });

  it('renders global hero savings, cache hit rate, compressed/retrieved counts, and per-mode breakdown for official compressed turns', () => {
    const story: Story = {
      id: 'story-1',
      title: '雪夜驿站',
      rawScript: '',
      blueprint: createDefaultBlueprint('雪夜驿站'),
      nodes: {
        a1: assistantNode(
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
      },
      rootNodeIds: ['a1'],
      activeLeafNodeId: 'a1',
      createdAt: 1,
      updatedAt: 1,
    };

    const work = newWork('长街灯影');
    work.discussionNodes = {
      w1: assistantNode(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 800,
            promptCacheMissTokens: 200,
            completionTokens: 200,
          },
          uncompressedPromptChars: 16000,
          compressedPromptChars: 2000,
        }),
      ),
    };

    const char = newCharacter('沈砚', '设定');
    const conv = newConversation(char, 'personal');
    conv.nodes = {
      c1: assistantNode(
        'c1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 700,
            promptCacheMissTokens: 300,
            completionTokens: 150,
          },
          uncompressedPromptChars: 12000,
          compressedPromptChars: 2000,
          retrievedNodeCount: 1,
        }),
      ),
    };
    char.conversations = [conv];

    const offPeakSummary = computeWorkspaceUsageSummary(
      {
        stories: [story],
        works: [work],
        characters: [char],
      },
      { scheduleOverride: 'off-peak' },
    );

    const offPeakMarkup = renderSettings({ workspaceUsageSummary: offPeakSummary });
    expect(offPeakMarkup).toContain('data-testid="workspace-usage-hero"');
    expect(offPeakMarkup).toContain('累计预计省费');
    expect(offPeakMarkup).toContain('非高峰优惠时段');
    expect(offPeakMarkup).toContain('实测总花费');
    expect(offPeakMarkup).toContain('未压缩全历史基线');
    expect(offPeakMarkup).toContain('US$');
    expect(offPeakMarkup).toContain('data-testid="workspace-usage-savings-percent"');
    expect(offPeakMarkup).toContain('3 轮');
    expect(offPeakMarkup).toContain('5,000');
    expect(offPeakMarkup).toContain('3,000 / 2,000');
    expect(offPeakMarkup).toContain('60.0%');
    expect(offPeakMarkup).toContain('850');
    expect(offPeakMarkup).toContain('3 轮压缩');
    expect(offPeakMarkup).toContain('历史引用 3 条（2 轮）');
    expect(offPeakMarkup).toContain('1 个故事');
    expect(offPeakMarkup).toContain('1 部作品');
    expect(offPeakMarkup).toContain('1 位角色');

    const peakSummary = computeWorkspaceUsageSummary(
      { stories: [story], works: [work], characters: [char] },
      { scheduleOverride: 'peak' },
    );
    const peakMarkup = renderSettings({ workspaceUsageSummary: peakSummary });
    expect(peakMarkup).toContain('标准时段');
  });

  it('displays tokens-only savings for mixed/unpriced providers and honest pre-compression state without faking US$0', () => {
    const officialStory: Story = {
      id: 's1',
      title: '官方',
      rawScript: '',
      blueprint: createDefaultBlueprint('官方'),
      nodes: {
        a1: assistantNode(
          'a1',
          buildTurnUsageTelemetry({
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            generationUsage: {
              promptCacheHitTokens: 500,
              promptCacheMissTokens: 500,
              completionTokens: 100,
            },
            uncompressedPromptChars: 42000,
            compressedPromptChars: 3000,
          }),
        ),
      },
      rootNodeIds: ['a1'],
      activeLeafNodeId: 'a1',
      createdAt: 1,
      updatedAt: 1,
    };
    const relayWork = newWork('中转');
    relayWork.discussionNodes = {
      w1: assistantNode(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://relay.example.com/v1',
          model: 'deepseek-flash',
          generationUsage: { promptTokens: 400, completionTokens: 80 },
          uncompressedPromptChars: 8000,
          compressedPromptChars: 2000,
        }),
      ),
    };

    const mixedSummary = computeWorkspaceUsageSummary(
      {
        stories: [officialStory],
        works: [relayWork],
        characters: [],
      },
      { scheduleOverride: 'off-peak' },
    );
    const mixedMarkup = renderSettings({ workspaceUsageSummary: mixedSummary });
    expect(mixedMarkup).toContain('累计节省输入估算');
    expect(mixedMarkup).toContain('未配置模型单价时只统计 Token 省量；可在设置中选填单价以估算花费');
    expect(mixedMarkup).toContain('2 轮');
    expect(mixedMarkup).toContain('省 2,400 Token');
    expect(mixedMarkup).not.toContain('data-testid="workspace-usage-unavailable"');
    expect(mixedMarkup).not.toContain('data-testid="workspace-usage-schedule"');
    expect(mixedMarkup).not.toContain('US$0.0000');
    const heroTagStart = mixedMarkup.lastIndexOf(
      '<div',
      mixedMarkup.indexOf('data-testid="workspace-usage-hero"'),
    );
    const heroSection = mixedMarkup.slice(
      heroTagStart,
      mixedMarkup.indexOf('data-testid="workspace-usage-metrics"'),
    );
    expect(heroSection).toContain('is-saved');
    expect(heroSection).toContain('已省略输入估算');
    expect(heroSection).toContain('摘要压缩开销');
    expect(heroSection).toContain('对比压缩轮次');
    expect(heroSection).not.toContain('US$');
    expect(heroSection).not.toContain('$0');

    const preCompWork = newWork('短对话');
    preCompWork.discussionNodes = {
      w1: assistantNode(
        'w1',
        buildTurnUsageTelemetry({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          generationUsage: {
            promptCacheHitTokens: 600,
            promptCacheMissTokens: 200,
            completionTokens: 90,
          },
          uncompressedPromptChars: 1200,
          compressedPromptChars: 1200,
        }),
      ),
    };
    const preCompSummary = computeWorkspaceUsageSummary({ works: [preCompWork] });
    const preCompMarkup = renderSettings({
      workspaceUsageSummary: preCompSummary,
    });
    expect(preCompSummary.total.savings.status).toBe('unavailable');
    expect(preCompSummary.total.actualCostUsd).not.toBeNull();
    expect(preCompMarkup).toContain('暂无可比省费');
    expect(preCompMarkup).toContain('尚未触发前文压缩');
    expect(preCompMarkup).toContain('未触发压缩');
    expect(preCompMarkup).toContain('data-testid="workspace-usage-actual-cost"');
    expect(preCompMarkup).toContain('实测费用');
    expect(preCompMarkup).not.toContain('累计预计省费');
    expect(preCompMarkup).not.toContain('预计省');
    expect(preCompMarkup).not.toContain('width="15"');
    const preCompHero = preCompMarkup.slice(
      preCompMarkup.indexOf('data-testid="workspace-usage-hero"'),
      preCompMarkup.indexOf('data-testid="workspace-usage-metrics"'),
    );
    expect(preCompHero).toContain('实测费用');
    expect(preCompHero).toContain('US$0.');
    const preCompWritingRow = preCompMarkup.slice(
      preCompMarkup.indexOf('data-testid="workspace-usage-mode-writing"'),
      preCompMarkup.indexOf('data-testid="workspace-usage-mode-character"'),
    );
    expect(preCompWritingRow).toContain('实测费用');
    expect(preCompWritingRow).toContain('US$0.');
    expect(preCompWritingRow).toContain('未触发压缩');
  });

  it('displays 费用增加 honestly without negative US$- when compression overhead exceeds baseline', () => {
    const costlyWork = newWork('高摘要开销');
    costlyWork.discussionNodes = {
      w1: assistantNode(
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

    const markup = renderSettings({
      workspaceUsageSummary: computeWorkspaceUsageSummary(
        { works: [costlyWork] },
        { scheduleOverride: 'off-peak' },
      ),
    });
    expect(markup).toContain('费用增加');
    expect(markup).toContain('is-increased');
    expect(markup).not.toContain('US$-');
  });

  it('formats custom CNY pricing with ¥, uses custom baseline note, and hides DeepSeek schedule pill', () => {
    const cnyWork = newWork('硅基作品');
    cnyWork.discussionNodes = {
      w1: assistantNode(
        'w1',
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
    };

    const summary = computeWorkspaceUsageSummary({ works: [cnyWork] });
    const markup = renderSettings({ workspaceUsageSummary: summary });
    expect(markup).toContain('累计预计省费');
    expect(markup).toContain('¥');
    expect(markup).toContain('按自定义模型单价与未压缩前文基线估算');
    expect(markup).not.toContain('data-testid="workspace-usage-schedule"');
    expect(markup).not.toContain('US$');
  });
});
