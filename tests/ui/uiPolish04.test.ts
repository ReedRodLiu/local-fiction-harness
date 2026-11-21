import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  emptyWorkspace,
  newCharacter,
  newConversation,
} from '../../src/harness/index.ts';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

describe('UI-POLISH-04 minimalist character chat stage', () => {
  it('renders minimalist chat bubbles, progressive history disclosure, and zero per-message details clutter', () => {
    const character = newCharacter('岑灯', '夜航员人设');
    const conv = newConversation(character, 'personal');
    conv.nodes = {
      u1: {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: '第一句问候',
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        createdAt: 10,
      },
      a1: {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content: '渡口起风了。',
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        createdAt: 11,
      },
      u2: {
        id: 'u2',
        parentId: 'a1',
        role: 'user',
        content: '最近还好吗',
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        createdAt: 12,
      },
      a2: {
        id: 'a2',
        parentId: 'u2',
        role: 'assistant',
        content: '灯塔还亮着。',
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        createdAt: 13,
        documentReads: [{ scope: 'container', name: '岑灯', versionId: 'char-v1', readAt: 13 }],
      },
    };
    conv.activeLeafNodeId = 'a2';
    character.conversations = [conv];
    character.activeConversationId = conv.id;

    const workspace = { ...emptyWorkspace(), characters: [character], activeCharacterId: character.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
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
    }));

    expect(markup).toContain('data-testid="character-timeline"');
    expect(markup).toContain('data-testid="user-bubble"');
    expect(markup).toContain('第一句问候');
    expect(markup).toContain('灯塔还亮着。');
    expect(markup).toContain('data-testid="turn-history-toggle"');
    expect(markup).toContain('aria-label="从这里继续"');
    expect(markup).toContain('aria-label="发送"');
    expect(markup).toContain('对话与分支');
    expect(markup).toContain('角色与资料');
    expect(markup).toContain('空白开聊');
    expect(markup).toContain('带资料开新对话');
    expect(markup).toContain('预览导出');
    expect(markup).toContain('删除对话');
    expect(markup).toContain('角色人设 · 新对话采用新版');
    expect(markup).toContain('当前对话资料');
    expect(markup).toContain('资料版本详情');
    expect(markup).not.toContain('<summary>对话操作</summary>');
    expect(markup.match(/<details\b/g)).toHaveLength(1);
    expect(markup).not.toContain('资料审计');
    expect(markup).not.toContain('creative-section');
  });

  it('renders a single quiet opening pill when the conversation has no turns', () => {
    const character = newCharacter('岑灯', '夜航员人设');
    const conv = newConversation(character, 'roleplay');
    character.conversations = [conv];
    character.activeConversationId = conv.id;

    const workspace = { ...emptyWorkspace(), characters: [character], activeCharacterId: character.id };
    const markup = renderToStaticMarkup(createElement(CreativeWorkspace, {
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
      companionOpen: false,
      setCompanionOpen: () => undefined,
    }));

    expect(markup).toContain('让角色先开口');
    expect(markup).not.toContain('creative-section');
  });
});
