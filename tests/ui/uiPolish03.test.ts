import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_SUMMARY_SNAPSHOT, emptyWorkspace, newWork } from '../../src/harness/index.ts';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

describe('UI-POLISH-03 V0.2 unified writing stage', () => {
  it('renders chat view using unified TurnCard with branch/copy/regenerate/push-to-manuscript and zero forced gate', () => {
    const work = {
      ...newWork('纸月车站'),
      discussion: [
        {
          id: 'u1',
          parentId: null,
          role: 'user' as const,
          content: '讨论开篇节奏',
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          createdAt: 100,
        },
        {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant' as const,
          content: '可以从失物招领处的一只旧皮箱切入。\n\n```ts\nconst x = 1;\n```',
          reasoningContent: '先铺垫悬疑氛围。',
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          createdAt: 101,
          documentReads: [{ scope: 'container' as const, name: '纸月车站', versionId: 'work-v1', readAt: 101 }],
        },
      ],
    };
    const workspace = { ...emptyWorkspace(), works: [work], activeWorkId: work.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
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
      manuscript: false,
      initialTurn: null,
      onConsumeInitialTurn: () => undefined,
      companionOpen: false,
      setCompanionOpen: () => undefined,
    }));

    expect(markup).toContain('data-testid="writing-discussion-timeline"');
    expect(markup).toContain('data-testid="user-bubble"');
    expect(markup).toContain('讨论开篇节奏');
    expect(markup).toContain('可以从失物招领处的一只旧皮箱切入。');
    expect(markup).toContain('data-testid="reasoning-toggle"');
    expect(markup).toContain('aria-label="复制正文"');
    expect(markup).toContain('aria-label="重新生成分支"');
    expect(markup).toContain('aria-label="编辑并生成新分支"');
    expect(markup).toContain('data-testid="push-to-manuscript-btn"');
    expect(markup).toContain('写入正文');
    // Code blocks in 写故事 must NOT become HUD terminals
    expect(markup).toContain('class="md-code-block"');
    expect(markup).not.toContain('data-testid="hud-panel"');
    expect(markup).not.toContain('开始写');
    expect(markup).not.toContain('进入正文写作');
    expect(markup).not.toContain('creative-section');
    expect(markup).not.toContain('资料审计');
  });

  it('renders manuscript view with borderless canvas, single suggestion card, zero manual citation pills, and 2-tab companion sheet', () => {
    const work = {
      ...newWork('纸月车站'),
      writingStarted: true,
      body: '夜风吹过站台。',
      discussion: [
        {
          id: 'u1',
          parentId: null,
          role: 'user' as const,
          content: '保持悬疑气氛',
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          createdAt: 100,
        },
      ],
      suggestions: [
        {
          id: 's1',
          instruction: '续写一句',
          text: '站钟忽然停在十二点前。',
          revision: 0,
          start: 0,
          end: 0,
          documentReads: [{ scope: 'container' as const, name: '纸月车站', versionId: 'work-v2', readAt: 102 }],
        },
      ],
    };
    const workspace = { ...emptyWorkspace(), works: [work], activeWorkId: work.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
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
      manuscript: true,
      initialTurn: null,
      onConsumeInitialTurn: () => undefined,
      companionOpen: true,
      setCompanionOpen: () => undefined,
    }));

    expect(markup).toContain('data-testid="creative-manuscript"');
    expect(markup).toContain('data-testid="writing-suggestion-card"');
    expect(markup).toContain('站钟忽然停在十二点前。');
    expect(markup).toContain('采纳建议');
    expect(markup).toContain('灵感与版本');
    expect(markup).toContain('设定');
    expect(markup).toContain('作品设定');
    expect(markup).toContain('我的记忆');
    expect(markup).toContain('导出正文 Markdown (.md)');
    expect(markup).toContain('分支笔记');
    for (const retired of ['引用讨论', '已引用讨论', '挑选原话', '引用这一段', '资料版本详情', '公共记忆', 'creative-section']) {
      expect(markup).not.toContain(retired);
    }
    expect(markup).not.toContain('type="checkbox"');
  });
});
