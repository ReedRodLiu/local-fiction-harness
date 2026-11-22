import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  emptyWorkspace,
  newCharacter,
  newConversation,
  type Story,
} from '../../src/harness/index.ts';
import { CompanionSheet } from '../../src/ui/CompanionSheet.tsx';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';
import { DocumentDialog } from '../../src/ui/DocumentDialog.tsx';
import { WelcomeView } from '../../src/ui/WelcomeView.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const story: Story = {
  id: 'story-1',
  title: '雨夜车站',
  rawScript: '',
  blueprint: {
    title: '雨夜车站',
    worldRules: [],
    protagonist: '',
    npcs: [],
    taboos: [],
    openingHook: '',
    extractionStatus: 'partial_fallback',
  },
  nodes: {
    'turn-1': {
      id: 'turn-1',
      parentId: null,
      role: 'user',
      content: '走进站台',
      createdAt: 10,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    },
    'turn-2': {
      id: 'turn-2',
      parentId: 'turn-1',
      role: 'assistant',
      content: '夜风吹动站牌。',
      createdAt: 11,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      diagnostics: { sourceStatus: 'CONTENT_FILTER' },
    },
  },
  rootNodeIds: ['turn-1'],
  activeLeafNodeId: 'turn-2',
  createdAt: 1,
  updatedAt: 1,
};

describe('UI-POLISH-01 V0.2 companion & jargon-free contracts', () => {
  it('renders CharacterPane without exposing raw versionIds or DocumentReadDetails', () => {
    const character = newCharacter('小雨', '人设');
    const active = newConversation(character, 'personal');
    const node = (id: string, parentId: string | null, versionId: string) => ({
      id, parentId, role: 'assistant' as const, content: `回复-${id}`, createdAt: 10,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      documentReads: [{ scope: 'container' as const, name: '人设', versionId, readAt: 10 }],
    });
    active.nodes = {
      root: node('root', null, 'root-version'),
      current: node('current', 'root', 'current-version'),
    };
    active.activeLeafNodeId = 'current';
    character.conversations = [active];
    character.activeConversationId = active.id;
    const workspace = { ...emptyWorkspace(), characters: [character], activeCharacterId: character.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
      mode: 'character', workspace, ready: true, storageError: '',
      save: async () => workspace, read: async () => workspace,
      runtime: {} as never, requestModel: () => undefined, openPublic: () => undefined,
      openDocument: () => undefined, initialTurn: null, onConsumeInitialTurn: () => undefined,
      companionOpen: true, setCompanionOpen: () => undefined,
    }));

    expect(markup).toContain('历史对话');
    expect(markup).toContain('角色设定');
    expect(markup).toContain('我的记忆');
    expect(markup).toContain('分支笔记');
    expect(markup).not.toContain('root-version');
    expect(markup).not.toContain('current-version');
    expect(markup).not.toContain('资料版本详情');
    expect(markup).not.toContain('公共记忆');
  });

  it('renders Story CompanionSheet with 2 tabs, quiet recap, markdown export, and collapsed branch note without jargon', () => {
    const markup = renderToStaticMarkup(createElement(CompanionSheet, {
      open: true,
      story,
      summarySnapshot: { content: '主角已抵达雨夜车站。', coveredUpToNodeId: 'turn-2', summarizedTurnCount: 2 },
      isStreaming: false,
      isSummarizing: false,
      isBranchSwitching: false,
      onSwitchBranch: () => undefined,
      onRenameBranch: () => undefined,
      onEditSetting: () => undefined,
      onOpenMyMemory: () => undefined,
      onEditBranchNote: () => undefined,
      onExportMarkdown: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('data-testid="companion-tab-branches"');
    expect(markup).toContain('data-testid="companion-tab-settings"');
    expect(markup).toContain('当前进展回顾');
    expect(markup).toContain('主角已抵达雨夜车站。');
    expect(markup).toContain('故事设定');
    expect(markup).toContain('我的记忆');
    expect(markup).toContain('导出 Markdown (.md)');
    expect(markup).toContain('分支笔记');
    expect(markup).not.toMatch(/<details[^>]*data-testid="branch-note-details"[^>]*open/);
    for (const forbidden of [
      '故事蓝图',
      '补拆',
      '核对候选剧本',
      '三区上下文',
      '公共记忆',
      '当前路径资料',
      '立即补算剧情摘要',
      'AI 提炼梗概',
      'tokens',
      'CONTENT_FILTER',
      'TIMEOUT',
      'INCOMPLETE',
    ]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it('omits current base version from DocumentDialog history, provides Edit/Preview tabs, and renders single-entry WelcomeView', () => {
    const dialogMarkup = renderToStaticMarkup(createElement(DocumentDialog, {
      onClose: () => undefined,
      edit: {
        title: '作品设定',
        mode: 'writing',
        base: { id: 'v2', previous: 'v1', markdown: 'second', savedAt: 2000, source: 'user' },
        history: [
          { id: 'v1', previous: null, markdown: 'first', savedAt: 1000, source: 'migration' },
          { id: 'v2', previous: 'v1', markdown: 'second', savedAt: 2000, source: 'user' },
        ],
        apply: async () => undefined,
      },
    }));
    expect(dialogMarkup).toContain('历史版本');
    expect(dialogMarkup).toContain('版本迁移');
    expect(dialogMarkup).toContain('>编辑</button>');
    expect(dialogMarkup).toContain('>预览</button>');
    expect(dialogMarkup).not.toContain('手动保存');

    const welcomeMarkup = renderToStaticMarkup(createElement(WelcomeView, {
      stories: [],
      neutralTurns: [],
      isStreaming: false,
      streamContent: '',
      streamReasoning: '',
      onSelectStory: () => undefined,
      recentCreative: [
        { id: 'w1', title: '作品一', kindLabel: '写故事', activate: () => undefined },
        { id: 'c1', title: '角色一', kindLabel: '角色', activate: () => undefined },
        { id: 'w2', title: '作品二', kindLabel: '写故事', activate: () => undefined },
      ],
    }));
    expect(welcomeMarkup).toContain('作品一');
    expect(welcomeMarkup).toContain('角色一');
    expect(welcomeMarkup).toContain('作品二');
    expect(welcomeMarkup).not.toContain('welcome-mode-pill');
    expect(welcomeMarkup).not.toContain('welcome-quick-pill');
    expect(welcomeMarkup).not.toContain('welcome-character-name');
  });
});
