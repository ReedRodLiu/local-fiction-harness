import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  EMPTY_SUMMARY_SNAPSHOT,
  createDiagnosticCollector,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { DeepSeekSetupWizard } from '../../src/ui/DeepSeekSetupWizard.tsx';
import { LibraryDrawer } from '../../src/ui/LibraryDrawer.tsx';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';
import { StoryLibrary } from '../../src/ui/StoryLibrary.tsx';
import { TopBar } from '../../src/ui/TopBar.tsx';
import { TurnCard } from '../../src/ui/TurnCard.tsx';
import { WelcomeView } from '../../src/ui/WelcomeView.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readUiSource = (file: string) => readFileSync(join(repoRoot, 'src', 'ui', file), 'utf8');

describe('Folio V0.2 UI contracts & jargon purge', () => {
  it('purges V0.1 Harness & blueprint jargon from all active V0.2 UI surfaces', () => {
    const activeUiFiles = [
      'App.tsx',
      'WelcomeView.tsx',
      'TopBar.tsx',
      'TurnCard.tsx',
      'CompanionSheet.tsx',
      'StoryTree.tsx',
      'DraftPane.tsx',
      'CharacterPane.tsx',
      'LibraryDrawer.tsx',
      'StoryLibrary.tsx',
      'SettingsPage.tsx',
      'DeepSeekSetupWizard.tsx',
      'DocumentDialog.tsx',
      'ProposalCard.tsx',
    ];

    const forbiddenTerms = [
      'StoryBlueprintCard',
      'ContextOverview',
      'DocumentReadDetails',
      '补拆完整故事蓝图',
      '核对候选剧本',
      '立即补算剧情摘要',
      '补算摘要中',
      'AI 提炼梗概',
      '三区上下文',
      '公共记忆',
      '当前路径资料',
      '用手机浏览器打开官网',
      '专属钥匙',
      '你的钥匙',
      '从这里开稿',
      '挑选原话',
      '已引用讨论',
      '引用讨论',
      '本人聊天',
      '扮演对戏',
      '推进量级',
    ];

    for (const file of activeUiFiles) {
      const source = readUiSource(file);
      for (const term of forbiddenTerms) {
        expect(source, `${file} should not contain "${term}"`).not.toContain(term);
      }
    }

    const storyTreeSource = readUiSource('StoryTree.tsx');
    expect(storyTreeSource).toContain('最近游玩');
    expect(storyTreeSource).toContain('最多轮次');
  });

  it('renders Welcome neutral unpersisted timeline and empty guidance without mode pills', () => {
    const emptyMarkup = renderToStaticMarkup(createElement(WelcomeView, {
      stories: [],
      recentCreative: [],
      neutralTurns: [],
      isStreaming: false,
      streamContent: '',
      streamReasoning: '',
      onSelectStory: () => undefined,
    }));
    expect(emptyMarkup).toContain('data-testid="welcome-view"');
    expect(emptyMarkup).toContain('data-testid="welcome-empty-guidance"');
    expect(emptyMarkup).not.toContain('welcome-mode-pill');
    expect(emptyMarkup).not.toContain('welcome-character-name');

    const neutralTurns: TurnNode[] = [
      {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: '你好，我想找点灵感',
        createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content: '随时都可以！你想写小说、玩文字冒险，还是想和某个角色聊天？',
        createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    ];
    const neutralMarkup = renderToStaticMarkup(createElement(WelcomeView, {
      stories: [],
      recentCreative: [],
      neutralTurns,
      isStreaming: false,
      streamContent: '',
      streamReasoning: '',
      onSelectStory: () => undefined,
    }));
    expect(neutralMarkup).toContain('data-testid="neutral-timeline"');
    expect(neutralMarkup).toContain('尚未建档');
    expect(neutralMarkup).toContain('随时都可以');
  });

  it('renders TopBar with subtle mode switcher and zero summary progress text', () => {
    const markup = renderToStaticMarkup(createElement(TopBar, {
      title: '雨夜车站',
      stageMode: 'story',
      showModeSwitcher: true,
      onSwitchStageMode: () => undefined,
      hasStory: true,
      onOpenCreativeCompanion: () => undefined,
      canOpenCreativeCompanion: false,
      branchLabel: '主线',
      forkCount: 1,
      libraryCollapsed: false,
      onOpenLibrary: () => undefined,
      onToggleLibrary: () => undefined,
      onOpenStoryTree: () => undefined,
    }));

    expect(markup).toContain('data-testid="topbar-mode-switcher"');
    expect(markup).toContain('data-testid="open-companion-sheet"');
    expect(markup).not.toContain('summary-progress');
    expect(markup).not.toContain('补算摘要中');
  });

  it('auto-syncs StoryLibrary active category and renders unified .md export in overflow', () => {
    const story: Story = {
      id: 's1',
      title: '测试故事',
      rawScript: '',
      blueprint: {
        title: '测试故事',
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

    const markup = renderToStaticMarkup(createElement(StoryLibrary, {
      stories: [story],
      works: [{ id: 'w1', title: '长篇草稿', subtitle: '正文 120 字' }],
      activeCategory: 'work',
      activeWorkId: 'w1',
      activeStoryId: '',
      onSelectStory: () => undefined,
      onRenameStory: () => undefined,
      onDeleteStory: () => undefined,
      onExportStoryBackup: () => undefined,
    }));

    expect(markup).toContain('>文游</button>');
    expect(markup).toContain('>写故事</button>');
    expect(markup).toContain('>角色互动</button>');
    expect(markup).not.toContain('>角色</button>');
    expect(markup).toContain('我的作品');
    expect(markup).toContain('长篇草稿');
    expect(markup).not.toContain('.lfh.json');

    const characterMarkup = renderToStaticMarkup(createElement(StoryLibrary, {
      stories: [story],
      characters: [{ id: 'c1', title: '岑灯', subtitle: '2 条对话' }],
      activeCategory: 'character',
      activeCharacterId: 'c1',
      activeStoryId: '',
      onSelectStory: () => undefined,
      onRenameStory: () => undefined,
      onDeleteStory: () => undefined,
      onExportStoryBackup: () => undefined,
    }));
    expect(characterMarkup).toContain('<h2>我的角色</h2>');
    expect(characterMarkup).toContain('aria-pressed="true">角色互动</button>');

    const libraryDrawerCss = readUiSource('styles/library-drawer.css');
    expect(libraryDrawerCss).toMatch(/\.library-categories button\s*\{[^}]*min-height:\s*44px;/s);
    expect(libraryDrawerCss).toMatch(/\.library-categories button\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(libraryDrawerCss).toMatch(/\.library-categories button\s*\{[^}]*font-size:\s*1[234]px;/s);
  });

  it('renders TurnCard inline ProposalCard without duplicate PencilLine writeFrom button', () => {
    const node: TurnNode = {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      content: '已为你拟定设定调整。',
      createdAt: 10,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      proposals: [
        {
          id: 'p1',
          target: 'setting',
          op: 'append',
          summary: '补充世界观规则',
          status: 'pending',
          body: '- 禁止使用真名',
        },
      ],
    };

    const markup = renderToStaticMarkup(createElement(TurnCard, {
      node,
      mode: 'story',
      isActiveLeaf: true,
      isLatestTurn: true,
      isSetupNode: false,
      turnNumber: 1,
      isBusy: false,
      isStreaming: false,
      siblings: {
        siblings: [node],
        currentIndex: 0,
        total: 1,
        prevSiblingId: null,
        nextSiblingId: null,
      },
      onSwitchBranch: () => undefined,
      onRewindToNode: () => undefined,
      resolveProposalTargetState: () => ({ currentMarkdown: '初始设定', targetLabel: '故事设定' }),
    }));

    expect(markup).toContain('data-testid="turn-proposals"');
    expect(markup).toContain('data-testid="proposal-card-p1"');
    expect(markup).toContain('补充世界观规则');
    expect(markup).not.toContain('从这里开稿');
  });

  it('renders simplified BYOK copy in DeepSeekSetupWizard, SettingsPage, and LibraryDrawer', () => {
    const wizardMarkup = renderToStaticMarkup(createElement(DeepSeekSetupWizard, {
      open: true,
      verifyUrlBase: 'https://api.deepseek.com',
      onComplete: () => undefined,
      onCancel: () => undefined,
      onExitComplete: () => undefined,
    }));
    expect(wizardMarkup).toContain('连接 DeepSeek');
    expect(wizardMarkup).toContain('前往 DeepSeek 开放平台获取 API Key：');
    expect(wizardMarkup).toContain('id="byok-api-key"');
    expect(wizardMarkup).toContain('data-testid="wizard-verify-save-btn"');
    expect(wizardMarkup).not.toContain('钥匙');
    expect(wizardMarkup).not.toContain('手机浏览器');
    expect(wizardMarkup).not.toContain('一键粘贴');
    expect(wizardMarkup).not.toContain('wizard-paste-btn');
    expect(readUiSource('DeepSeekSetupWizard.tsx')).not.toContain('navigator.clipboard.readText');

    const settingsMarkup = renderToStaticMarkup(createElement(SettingsPage, {
      appVersion: '0.2.0',
      hasCredentials: false,
      config: DEFAULT_MODEL_CONFIG,
      useDevEnvKey: false,
      showDevTestProxy: false,
      themePreference: 'system',
      fontSize: 16,
      canExportCurrentStory: true,
      currentStoryTitle: '雨夜车站',
      canExportFullBackup: true,
      onBack: () => undefined,
      onOpenSetupWizard: () => undefined,
      onClearSavedKey: () => undefined,
      onApplyDevTestConfig: () => undefined,
      onOpenDiagnostics: () => undefined,
      onOpenPublicMemory: () => undefined,
      onExportCurrentStory: () => undefined,
      onExportFullBackup: () => undefined,
      onImportBackupFile: () => undefined,
      onThemePreferenceChange: () => undefined,
      onFontSizeChange: () => undefined,
    }));
    expect(settingsMarkup).toContain('导出全量备份 (.folio.json)');
    expect(settingsMarkup).toContain('导出排障日志');
    expect(settingsMarkup).toContain('Folio v0.2.0');
    expect(settingsMarkup).not.toContain('钥匙');

    const drawerMarkup = renderToStaticMarkup(createElement(LibraryDrawer, {
      stories: [],
      activeStoryId: '',
      collapsed: false,
      mobileOpen: false,
      hasCredentials: false,
      onClose: () => undefined,
      onCollapse: () => undefined,
      onOpenSettings: () => undefined,
      onStartDeepSeekImport: () => undefined,
      onStartScriptImport: () => undefined,
      onSelectStory: () => undefined,
      onRenameStory: () => undefined,
      onDeleteStory: () => undefined,
      onExportStoryBackup: () => undefined,
    }));
    expect(drawerMarkup).toContain('连接 DeepSeek');
    expect(drawerMarkup).not.toContain('密钥');

    const collector = createDiagnosticCollector({ platform: 'web' });
    expect(collector.buildBundle(DEFAULT_MODEL_CONFIG).schemaVersion).toBe(2);
  });
});
