import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Story, ThreeZoneMetrics } from '../../src/harness/index.ts';
import { ContextOverview } from '../../src/ui/ContextOverview.tsx';
import { DocumentReadDetails } from '../../src/ui/DocumentReadDetails.tsx';
import { isBlueprintEditCurrent } from '../../src/ui/StoryBlueprintCard.tsx';
import { StoryReview } from '../../src/ui/StoryReview.tsx';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';
import { emptyWorkspace, newCharacter, newConversation, EMPTY_SUMMARY_SNAPSHOT } from '../../src/harness/index.ts';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const story: Story = {
  id: 'story-1',
  title: '雨夜车站',
  rawScript: '原始剧本锚点',
  blueprint: {
    title: '雨夜车站',
    worldRules: [],
    protagonist: '',
    npcs: [],
    taboos: [],
    openingHook: '',
    extractionStatus: 'partial_fallback',
  },
  nodes: {},
  rootNodeIds: [],
  activeLeafNodeId: null,
  createdAt: 1,
  updatedAt: 1,
};

const metrics: ThreeZoneMetrics = {
  anchorChars: 7,
  summaryChars: 0,
  recentChars: 0,
  recentNodeCount: 0,
  totalEstimatedTokens: 42,
};

describe('UI-POLISH-01 companion panel', () => {
  it('shows only the active conversation path in character document reads', () => {
    const character = newCharacter('小雨', '人设');
    const active = newConversation(character, 'personal');
    const other = newConversation(character, 'roleplay');
    const node = (id: string, parentId: string | null, versionId: string) => ({
      id, parentId, role: 'assistant' as const, content: id, createdAt: 10,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      documentReads: [{ scope: 'container' as const, name: '人设', versionId, readAt: 10 }],
    });
    active.nodes = { root: node('root', null, 'root-version'), current: node('current', 'root', 'current-version'), sibling: node('sibling', 'root', 'sibling-version') };
    active.activeLeafNodeId = 'current';
    other.nodes = { other: node('other', null, 'other-version') };
    other.activeLeafNodeId = 'other';
    character.conversations = [active, other];
    character.activeConversationId = active.id;
    const workspace = { ...emptyWorkspace(), characters: [character], activeCharacterId: character.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
      mode: 'character', workspace, ready: true, storageError: '',
      save: async () => workspace, read: async () => workspace,
      runtime: {} as never, requestModel: () => undefined, openPublic: () => undefined,
      openDocument: () => undefined, onBack: () => undefined,
    }));
    expect(markup).toContain('root-version');
    expect(markup).toContain('current-version');
    expect(markup).toContain('小雨 · current');
    expect(markup).not.toContain('sibling-version');
    expect(markup).not.toContain('other-version');
  });
  it('rejects a stale blueprint edit baseline', () => {
    expect(isBlueprintEditCurrent(story, story)).toBe(true);
    expect(isBlueprintEditCurrent({ ...story, updatedAt: 2 }, story)).toBe(false);
    expect(isBlueprintEditCurrent({ ...story, blueprint: { ...story.blueprint, protagonist: 'changed' } }, story)).toBe(false);
    expect(isBlueprintEditCurrent({ ...story, activeLeafNodeId: 'other' }, story)).toBe(false);
  });

  it('shows plot review metrics and summary without a document-audit disclosure', () => {
    const markup = renderToStaticMarkup(createElement(StoryReview, {
      story,
      metrics,
      isBusy: false,
      isSummarizing: false,
    }));

    expect(markup).toContain('当前路线剧情摘要');
    expect(markup).toContain('分支记忆独立隔离');
    expect(markup).toContain('aria-label="剧情摘要指标"');
    expect(markup).toContain('上下文预算 Token');
    expect(markup).not.toContain('资料审计');
    expect(markup).not.toContain('<details');
  });

  it('keeps reply document reads in the collapsed companion context details', () => {
    const storyWithRead: Story = {
      ...story,
      nodes: {
        'other': { id: 'other', parentId: null, role: 'assistant', content: 'other branch', createdAt: 11, summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 }, documentReads: [{ scope: 'container', name: 'other', versionId: 'other-version', readAt: 11 }] },
        'reply-1': {
          id: 'reply-1',
          parentId: null,
          role: 'assistant',
          content: '雨停后，车站亮起一盏灯。',
          createdAt: 10,
          summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
          documentReads: [{
            scope: 'container',
            name: '雨夜车站',
            versionId: 'container-v3',
            readAt: 10,
          }],
        },
      },
      rootNodeIds: ['reply-1', 'other'],
      activeLeafNodeId: 'reply-1',
      importCandidate: '待核对剧本',
    };
    const markup = renderToStaticMarkup(createElement(ContextOverview, {
      story: storyWithRead,
      summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      metrics,
      isStreaming: false,
      onOpenDocuments: {
        container: () => undefined,
        local: () => undefined,
        public: () => undefined,
        adoptScript: () => undefined,
      },
      onSaveBlueprintTweak: async () => true,
      onReextractBlueprint: () => undefined,
    }));

    expect(markup).toContain('aria-label="资料"');
    expect(markup.match(/class="companion-document-row"/g)).toHaveLength(4);
    expect(markup).toContain('核对候选剧本');
    expect(markup).toContain('>微调</button>');
    expect(markup).toContain('三区上下文与资料版本详情');
    expect(markup).toContain('container-v3');
    expect(markup).toContain('reply-1');
    expect(markup).not.toContain('other-version');
    expect(markup).toContain('雨夜车站');
    expect(markup).not.toContain('资料审计');
    expect(markup).not.toMatch(/<details[^>]* open=/);
  });

  it('renders one collapsed audit disclosure for a creative mode read group', () => {
    const markup = renderToStaticMarkup(createElement(DocumentReadDetails, {
      testId: 'creative-document-reads',
      entries: [{
        id: 'writing-reply-1',
        label: '开书讨论回复',
        createdAt: 10,
        reads: [{ scope: 'container', name: '纸月车站', versionId: 'work-v2', readAt: 10 }],
      }],
    }));

    expect(markup).toContain('三区上下文与资料版本详情');
    expect(markup).toContain('纸月车站 · 容器 · work-v2');
    expect(markup).not.toMatch(/<details[^>]* open=/);
  });
});
