import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  convertActiveAssetMode,
  emptyWorkspace,
  materializeAssetFromNodes,
  newCharacter,
  newConversation,
} from '../../src/harness/index.ts';
import { CreativeWorkspace } from '../../src/ui/CreativeWorkspace.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

describe('UI-POLISH-04 V0.2 unified character chat stage', () => {
  it('renders unified TurnCard capabilities, hides rewind on active leaf, and exposes 2-tab companion without personal/roleplay split', () => {
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
        content: '灯塔还亮着。\n\n```text\nstatus: ok\nlevel: 1\n```',
        reasoningContent: '保持温和口吻。',
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
    expect(markup).toContain('data-testid="reasoning-toggle"');
    expect(markup).toContain('aria-label="复制正文"');
    expect(markup).toContain('aria-label="重新生成分支"');
    expect(markup).toContain('aria-label="编辑并生成新分支"');
    // Active leaf must NOT render rewind button
    expect(markup).not.toContain('aria-label="回溯至此"');
    // Code blocks in character mode stay code blocks instead of HUD terminals
    expect(markup).toContain('class="md-code-block"');
    expect(markup).not.toContain('data-testid="hud-panel"');
    // 2-tab companion without personal/roleplay split or blank/with-docs split
    expect(markup).toContain('data-testid="character-tab-conversations"');
    expect(markup).toContain('data-testid="character-tab-profile"');
    expect(markup).toContain('新开一段对话');
    expect(markup).toContain('第一句问候');
    expect(markup).toContain('角色设定');
    expect(markup).toContain('我的记忆');
    expect(markup).toContain('分支笔记');
    for (const retired of [
      '本人聊天',
      '扮演对戏',
      '空白开聊',
      '带资料开新对话',
      '资料版本详情',
      '公共记忆',
      'creative-section',
    ]) {
      expect(markup).not.toContain(retired);
    }
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

  it('renders a story converted to character interaction without a missing branch-note version', () => {
    const story = materializeAssetFromNodes({
      targetMode: 'story',
      title: '岑灯',
      settingMarkdown: '夜航员人设',
      turns: [{
        id: 's1',
        parentId: null,
        role: 'assistant',
        content: '渡口的灯刚刚亮起。',
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        createdAt: 20,
      }],
    }).story!;
    const character = convertActiveAssetMode({
      fromMode: 'story',
      toMode: 'character',
      story,
    }).character!;
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
    expect(markup).toContain('渡口的灯刚刚亮起。');
    expect(markup).toContain('夜航员人设');
  });
});
