import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  EMPTY_SUMMARY_SNAPSHOT,
  ENTRY_ROUTE_SYSTEM_PROMPT,
  assembleThreeZoneContext,
  buildEntryRouteMessages,
  characterContext,
  createDefaultBlueprint,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  workContext,
  type PromptPackLibrary,
  type Story,
} from '../../src/harness/index.ts';

function version(markdown: string) {
  const document = newDocument(markdown);
  return document.versions[document.head];
}

function document(markdown: string) {
  return newDocument(markdown);
}

const library: PromptPackLibrary = {
  packs: [
    {
      ...BUILTIN_NARRATIVE_PROMPT_PACK,
      id: 'test-pack',
      title: '测试包',
      slots: { head: 'PACK_HEAD', mid: 'PACK_MID', tail: 'PACK_TAIL' },
      readOnly: false,
    },
  ],
  activePackId: 'test-pack',
};

function makeStory(): Story {
  return {
    id: 'story-1',
    title: '测试故事',
    rawScript: '当前设定正文',
    blueprint: createDefaultBlueprint('测试故事'),
    nodes: {
      user: {
        id: 'user',
        parentId: null,
        role: 'user',
        content: '近期玩家输入',
        createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      assistant: {
        id: 'assistant',
        parentId: 'user',
        role: 'assistant',
        content: '近期叙事回复',
        createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    },
    rootNodeIds: ['user'],
    activeLeafNodeId: 'assistant',
    createdAt: 1,
    updatedAt: 2,
  };
}

function positions(messages: readonly { content: string }[], markers: string[]): number[] {
  return markers.map((marker) => {
    const index = messages.findIndex((message) => message.content.includes(marker));
    expect(index, `missing marker ${marker}`).toBeGreaterThanOrEqual(0);
    return index;
  });
}

describe('Prompt Pack three-zone physical assembly', () => {
  it('keeps story pack slots, protected prompts, documents, history, tail, and user input ordered', () => {
    const context = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      undefined,
      false,
      {
        publicVersion: version('我的记忆：记忆内容'),
        container: version('当前设定：设定内容'),
        local: version('分支笔记：笔记内容'),
        snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
        promptPackLibrary: library,
        includePromptPackTail: true,
      },
    );
    const [head, base, mid, memory, setting, note, recent, tail, input] = positions(context.messages, [
      'PACK_HEAD',
      'lfh-summary',
      'PACK_MID',
      '我的记忆：记忆内容',
      '当前设定：设定内容',
      '分支笔记：笔记内容',
      '近期玩家输入',
      'PACK_TAIL',
      '本轮 user 输入',
    ]);
    expect(head).toBeLessThan(base);
    expect(base).toBeLessThan(mid);
    expect(mid).toBeLessThan(memory);
    expect(memory).toBeLessThan(setting);
    expect(setting).toBeLessThan(note);
    expect(note).toBeLessThan(recent);
    expect(recent).toBeLessThan(tail);
    expect(tail).toBeLessThan(input);
    expect(context.metrics.anchorChars).toBeGreaterThan('PACK_HEAD'.length + 'PACK_MID'.length);
    expect(context.messages.map((message) => message.content).join('\n')).toContain('lfh-choices');
  });

  it('uses the same pack seam for writing, character interaction, and welcome routing', () => {
    const work = newWork('作品', '作品当前设定');
    const writingContext = workContext(document('记忆'), work, '写作输入', {
      promptPackLibrary: library,
      includePromptPackTail: true,
    });
    expect(writingContext.messages[0].content).toBe('PACK_HEAD');
    expect(writingContext.messages[1].content).toContain('创作搭档');
    expect(writingContext.messages[2].content).toBe('PACK_MID');
    expect(writingContext.messages.at(-2)?.content).toBe('PACK_TAIL');
    expect(writingContext.messages.at(-1)?.content).toBe('写作输入');
    expect(work.title).toBe('作品');

    const character = newCharacter('角色', '角色设定');
    const conversation = newConversation(character, 'personal');
    const interactionContext = characterContext(
      document('记忆'),
      character,
      conversation,
      '角色输入',
      undefined,
      { promptPackLibrary: library },
    );
    expect(interactionContext.messages.slice(0, 3).map((message) => message.content)).toEqual([
      'PACK_HEAD',
      expect.stringContaining('你是该角色本人'),
      'PACK_MID',
    ]);
    expect(character.name).toBe('角色');

    const entry = buildEntryRouteMessages('欢迎输入', [], '欢迎页记忆', {
      promptPackLibrary: library,
      includePromptPackTail: true,
    });
    expect(entry[0].content).toBe('PACK_HEAD');
    expect(entry[1].content).toContain(ENTRY_ROUTE_SYSTEM_PROMPT);
    expect(entry[1].content).toContain('lfh-proposal');
    expect(entry[2].content).toBe('PACK_MID');
    expect(entry.at(-2)?.content).toBe('PACK_TAIL');
    expect(entry.at(-1)).toEqual({ role: 'user', content: '欢迎输入' });
  });
});
