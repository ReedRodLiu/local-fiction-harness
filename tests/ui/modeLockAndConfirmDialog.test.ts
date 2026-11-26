import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_SUMMARY_SNAPSHOT, type TurnNode } from '../../src/harness/index.ts';
import { ModeSwitchConfirmDialog } from '../../src/ui/ModeSwitchConfirmDialog.tsx';
import { StoryLibrary } from '../../src/ui/StoryLibrary.tsx';
import { WelcomeView } from '../../src/ui/WelcomeView.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

describe('Issue #147: Welcome mode lock indicator & ModeSwitchConfirmDialog', () => {
  it('displays the currently locked mode on WelcomeView in empty and neutral-chat states', () => {
    const writingWelcome = renderToStaticMarkup(
      createElement(WelcomeView, {
        stories: [],
        recentCreative: [],
        neutralTurns: [],
        selectedMode: 'writing',
        isStreaming: false,
        streamContent: '',
        streamReasoning: '',
        onSelectStory: () => undefined,
      }),
    );

    expect(writingWelcome).toContain('data-testid="welcome-locked-mode"');
    expect(writingWelcome).toContain('写故事');
    expect(writingWelcome).not.toContain('welcome-mode-pill');

    const neutralTurns: TurnNode[] = [
      {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: '你好',
        createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content: '你好，想聊什么方向？',
        createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    ];
    const characterNeutral = renderToStaticMarkup(
      createElement(WelcomeView, {
        stories: [],
        recentCreative: [],
        neutralTurns,
        selectedMode: 'character',
        isStreaming: false,
        streamContent: '',
        streamReasoning: '',
        onSelectStory: () => undefined,
      }),
    );
    expect(characterNeutral).toContain('data-testid="welcome-locked-mode"');
    expect(characterNeutral).toContain('角色互动');
    expect(characterNeutral).toContain('data-testid="neutral-timeline"');
  });

  it('renders ModeSwitchConfirmDialog with source mode, target mode, target title, and confirm/cancel controls', () => {
    const closedMarkup = renderToStaticMarkup(
      createElement(ModeSwitchConfirmDialog, {
        request: null,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(closedMarkup).toContain('data-testid="mode-switch-confirm-dialog"');
    expect(closedMarkup).not.toContain('data-testid="mode-switch-confirm-btn"');

    const openMarkup = renderToStaticMarkup(
      createElement(ModeSwitchConfirmDialog, {
        request: {
          sourceMode: 'writing',
          targetMode: 'character',
          targetTitle: '沈默',
          reasonLabel: '跨模式派生新会话',
          description: '将根据当前内容在「角色互动」新建独立角色「沈默」并跳转。',
        },
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(openMarkup).toContain('data-testid="mode-switch-confirm-dialog"');
    expect(openMarkup).toContain('data-testid="mode-switch-source"');
    expect(openMarkup).toContain('写故事');
    expect(openMarkup).toContain('data-testid="mode-switch-target"');
    expect(openMarkup).toContain('角色互动');
    expect(openMarkup).toContain('沈默');
    expect(openMarkup).toContain('data-testid="mode-switch-confirm-btn"');
    expect(openMarkup).toContain('data-testid="mode-switch-cancel-btn"');
  });

  it('keeps StoryLibrary synced with activeCategory across three modes', () => {
    const markup = renderToStaticMarkup(
      createElement(StoryLibrary, {
        stories: [],
        activeCategory: 'character',
        activeStoryId: '',
        onSelectCategory: () => undefined,
        onSelectStory: () => undefined,
        onRenameStory: () => undefined,
        onDeleteStory: () => undefined,
        onExportStoryBackup: () => undefined,
      }),
    );
    expect(markup).toContain('aria-pressed="true">角色互动</button>');
    expect(markup).toContain('aria-pressed="false">文游</button>');
    expect(markup).toContain('aria-pressed="false">写故事</button>');
  });
});
