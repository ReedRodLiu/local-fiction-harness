import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  characterContext,
  classifyEntryHeuristic,
  conversationLocalVersion,
  convertActiveAssetMode,
  createFictionHarness,
  createInMemoryStoryStorage,
  detectNaturalModeSwitchIntent,
  documentVersion,
  formatCharacterConversationTitle,
  materializeAssetFromNodes,
  newCharacter,
  newConversation,
  newDocument,
  parseEntryRouteReply,
  parseManuscriptAssistantReply,
  routeEntryMessage,
  storyExportMarkdown,
  visibleEntryRoutePrefix,
  writeDocument,
  type LlmTransport,
  type ModelConfig,
  type TurnNode,
} from '../../src/harness/index.ts';

const testConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test-123456',
  memoryOnly: false,
};

function makeFakeTransport(chunks: string[]): LlmTransport {
  return {
    async *streamChat() {
      for (const chunk of chunks) {
        yield { contentDelta: chunk };
      }
      yield { finishReason: 'stop' };
    },
  };
}

describe('V0.2 entryRouter & unified mode helpers', () => {
  it('hides lfh-route fence during streaming and routes story/writing/character/ambiguous in one step', async () => {
    const raw = [
      '```lfh-route\n',
      'mode: writing\n',
      'title: 雨夜回声\n',
      '---\n',
      '## 故事设定\n\n雨夜站台的一场偶遇。\n',
      '```\n\n',
      '这个雨夜站台的开篇很有画面感，我们可以先从主角等待末班车写起。',
    ];

    expect(visibleEntryRoutePrefix('```lfh-r')).toBe('');
    expect(visibleEntryRoutePrefix('```lfh-route\nmode: writing\n')).toBe('');
    expect(visibleEntryRoutePrefix(raw.join(''))).toBe(
      '这个雨夜站台的开篇很有画面感，我们可以先从主角等待末班车写起。',
    );

    const streamedVisible: string[] = [];
    const result = await routeEntryMessage(
      '我想写一个雨夜站台偶遇的短篇小说',
      [],
      makeFakeTransport(raw),
      testConfig,
      {
        onContentDelta: (delta) => streamedVisible.push(delta),
      },
    );

    expect(result.mode).toBe('writing');
    expect(result.title).toBe('雨夜回声');
    expect(result.settingMarkdown).toContain('雨夜站台的一场偶遇');
    expect(result.assistantReply).toBe('这个雨夜站台的开篇很有画面感，我们可以先从主角等待末班车写起。');
    expect(streamedVisible.join('')).toBe(result.assistantReply);
    expect(result.usedFallback).toBe(false);
  });

  it('falls back gracefully to heuristics when model omits lfh-route fence', () => {
    const ambiguous = parseEntryRouteReply('你好呀，今天想聊点什么？', '你好', []);
    expect(ambiguous.mode).toBe('ambiguous');
    expect(ambiguous.usedFallback).toBe(true);

    expect(classifyEntryHeuristic('我想创建一个温柔毒舌的猫系角色聊天')).toBe('character');
    expect(classifyEntryHeuristic('帮我开一个修仙世界观的文游')).toBe('story');
    expect(classifyEntryHeuristic('我想写一篇同人小说大纲')).toBe('writing');
  });

  it('detects explicit mode-switch commands without hijacking normal character creation', () => {
    expect(detectNaturalModeSwitchIntent('转成写故事')).toBe('writing');
    expect(detectNaturalModeSwitchIntent('帮我切换到文游')).toBe('story');
    expect(detectNaturalModeSwitchIntent('改成角色互动')).toBe('character');
    // Normal prompt asking to create an NPC during story must NOT be treated as a mode switch
    expect(detectNaturalModeSwitchIntent('根据刚才的剧情帮我建个叫沈默的角色并记录设定')).toBeNull();
  });

  it('materializes neutral unpersisted turns into target asset and converts modes losslessly', () => {
    const neutralTurns: TurnNode[] = [
      {
        id: 'n1',
        parentId: null,
        role: 'user',
        content: '你好',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      {
        id: 'n2',
        parentId: 'n1',
        role: 'assistant',
        content: '你好！想聊点什么或者写点什么呢？',
        createdAt: 101,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      {
        id: 'n3',
        parentId: 'n2',
        role: 'user',
        content: '我想写个灯塔守夜人的故事',
        createdAt: 102,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      {
        id: 'n4',
        parentId: 'n3',
        role: 'assistant',
        content: '灯塔守夜人很有氛围，主角为什么会独自留在塔里？',
        createdAt: 103,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    ];

    const materialized = materializeAssetFromNodes({
      targetMode: 'writing',
      title: '灯塔守夜人',
      settingMarkdown: '## 设定\n\n孤岛灯塔。',
      turns: neutralTurns,
    });
    expect(materialized.work).toBeDefined();
    expect(materialized.work!.title).toBe('灯塔守夜人');
    expect(documentVersion(materialized.work!.document).markdown).toContain('孤岛灯塔');
    expect(materialized.work!.discussion).toHaveLength(4);
    expect(Object.keys(materialized.work!.discussionNodes ?? {})).toHaveLength(4);

    // Losslessly convert writing -> story -> character
    const asStory = convertActiveAssetMode({
      fromMode: 'writing',
      toMode: 'story',
      work: materialized.work,
    });
    expect(asStory.story).toBeDefined();
    expect(asStory.story!.title).toBe('灯塔守夜人');
    expect(Object.keys(asStory.story!.nodes)).toHaveLength(4);

    const asCharacter = convertActiveAssetMode({
      fromMode: 'story',
      toMode: 'character',
      story: asStory.story,
    });
    expect(asCharacter.character).toBeDefined();
    expect(asCharacter.character!.name).toBe('灯塔守夜人');
    expect(documentVersion(asCharacter.character!.document).markdown).toContain('孤岛灯塔');
    expect(Object.keys(asCharacter.character!.conversations[0].nodes)).toHaveLength(4);
  });

  it('keeps story branch-note history readable after converting to character interaction', () => {
    const materialized = materializeAssetFromNodes({
      targetMode: 'story',
      title: '灯塔守夜人',
      settingMarkdown: '## 设定\n\n孤岛灯塔。',
      turns: [
        {
          id: 'n1',
          parentId: null,
          role: 'user',
          content: '推开灯塔的门。',
          createdAt: 100,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
        {
          id: 'n2',
          parentId: 'n1',
          role: 'assistant',
          content: '门轴在潮湿空气里发出低鸣。',
          createdAt: 101,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
      ],
    });
    const story = materialized.story!;
    const branchNote = writeDocument(
      story.documents!.local,
      story.documents!.local.head,
      '## 当前进度\n\n灯塔门锁已经打开。',
      'user',
      'story-local-v2',
    );
    const activeLeaf = story.nodes[story.activeLeafNodeId!];
    const storyWithHistory = {
      ...story,
      documents: { ...story.documents!, local: branchNote },
      nodes: {
        ...story.nodes,
        [activeLeaf.id]: {
          ...activeLeaf,
          documents: { ...activeLeaf.documents!, local: 'story-local-v2' },
        },
      },
    };

    const converted = convertActiveAssetMode({
      fromMode: 'story',
      toMode: 'character',
      story: storyWithHistory,
    });
    const conversation = converted.character!.conversations[0];
    const localVersion = documentVersion(conversation.document, conversationLocalVersion(conversation));
    const context = characterContext(newDocument('偏好自然对白'), converted.character!, conversation, '继续往里走');
    const contextText = context.messages.map((message) => message.content).join('\n');

    expect(localVersion.markdown).toContain('灯塔门锁已经打开');
    expect(contextText).toContain('孤岛灯塔');
    expect(contextText).toContain('灯塔门锁已经打开');
    expect(Object.values(conversation.nodes).every((node) => (
      Object.hasOwn(conversation.document.versions, node.documents!.local) &&
      Object.hasOwn(converted.character!.document.versions, node.documents!.container)
    ))).toBe(true);
    expect(documentVersion(storyWithHistory.documents.local, 'story-local-v2').markdown).toContain('灯塔门锁已经打开');
    expect(Object.values(conversation.nodes).map((node) => node.content)).toEqual([
      '推开灯塔的门。',
      '门轴在潮湿空气里发出低鸣。',
    ]);
  });

  it('keeps document references valid across empty, writing, and reverse mode conversions', () => {
    const emptyWork = materializeAssetFromNodes({
      targetMode: 'writing',
      title: '空白作品',
      settingMarkdown: '## 设定\n\n尚未开始。',
      turns: [],
    }).work!;
    const emptyCharacter = convertActiveAssetMode({
      fromMode: 'writing',
      toMode: 'character',
      work: emptyWork,
    }).character!;
    expect(emptyCharacter.conversations[0].nodes).toEqual({});
    expect(documentVersion(
      emptyCharacter.conversations[0].document,
      conversationLocalVersion(emptyCharacter.conversations[0]),
    ).markdown).toBe('');

    const character = newCharacter('岑灯', '## 设定\n\n守塔人。');
    const conversation = newConversation(character, 'personal', '## 当前进度\n\n收到了远航船的回信。');
    conversation.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'user',
        content: '灯塔今晚亮吗？',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: { container: character.document.head, local: conversation.document.head },
      },
    };
    conversation.activeLeafNodeId = 'c1';
    character.conversations = [conversation];
    character.activeConversationId = conversation.id;

    const asStory = convertActiveAssetMode({
      fromMode: 'character',
      toMode: 'story',
      character,
    }).story!;
    expect(documentVersion(asStory.documents!.local).markdown).toContain('收到了远航船的回信');
    expect(Object.values(asStory.nodes).every((node) => (
      Object.hasOwn(asStory.documents!.local.versions, node.documents!.local) &&
      Object.hasOwn(asStory.documents!.container.versions, node.documents!.container)
    ))).toBe(true);
    expect(documentVersion(character.document).markdown).toContain('守塔人');

    const writing = materializeAssetFromNodes({
      targetMode: 'writing',
      title: '灯塔来信',
      settingMarkdown: '## 设定\n\n远航船。',
      turns: [
        {
          id: 'w1',
          parentId: null,
          role: 'assistant',
          content: '海面先亮了起来。',
          createdAt: 200,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
      ],
    }).work!;
    const asCharacter = convertActiveAssetMode({
      fromMode: 'writing',
      toMode: 'character',
      work: writing,
    }).character!;
    const loadedConversation = asCharacter.conversations[0];
    expect(Object.values(loadedConversation.nodes).every((node) => (
      Object.hasOwn(loadedConversation.document.versions, node.documents!.local) &&
      Object.hasOwn(asCharacter.document.versions, node.documents!.container)
    ))).toBe(true);
  });

  it('routes manuscript bottom composer replies into suggestion, chat, and proposal intents', () => {
    const proposalRaw = [
      '已为你整理设定补丁。\n\n',
      '```lfh-proposal\n',
      'target: setting\n',
      'op: append\n',
      'summary: 新增反派线索\n',
      '---\n',
      '- 顾沉曾在三年前失踪。\n',
      '```',
    ].join('');
    const pRes = parseManuscriptAssistantReply(proposalRaw, '把顾沉三年前失踪写进设定');
    expect(pRes.kind).toBe('proposal');
    if (pRes.kind === 'proposal') {
      expect(pRes.proposals).toHaveLength(1);
      expect(pRes.proposals[0].summary).toBe('新增反派线索');
    }

    const chatRaw = '```lfh-manuscript-intent\nintent: chat\n```\n他留在车站是为了等那班不存在的列车。';
    const cRes = parseManuscriptAssistantReply(chatRaw, '主角为什么会去车站？');
    expect(cRes.kind).toBe('chat');
    if (cRes.kind === 'chat') {
      expect(cRes.content).toBe('他留在车站是为了等那班不存在的列车。');
    }

    // Untagged replies default safely to chat (never a raw one-click suggestion splice)
    const untaggedChat = parseManuscriptAssistantReply('站台上的时钟忽然倒转了半圈。', '帮我续写下一句');
    expect(untaggedChat.kind).toBe('chat');

    // Explicit target: manuscript lfh-proposal parses as proposal targeting manuscript
    const manuscriptProposalRaw = [
      '已为你试写下一段：\n\n',
      '```lfh-proposal\n',
      'target: manuscript\n',
      'op: append\n',
      'summary: 续写站台倒转段落\n',
      '---\n',
      '站台上的时钟忽然倒转了半圈。\n',
      '```',
    ].join('');
    const mpRes = parseManuscriptAssistantReply(manuscriptProposalRaw, '帮我续写下一句');
    expect(mpRes.kind).toBe('proposal');
    if (mpRes.kind === 'proposal') {
      expect(mpRes.proposals).toHaveLength(1);
      expect(mpRes.proposals[0].target).toBe('manuscript');
      expect(mpRes.proposals[0].op).toBe('append');
    }

    // Explicit legacy intent: suggestion still parses as suggestion
    const explicitSug = parseManuscriptAssistantReply(
      '```lfh-manuscript-intent\nintent: suggestion\n```\n站台上的时钟忽然倒转了半圈。',
      '帮我续写下一句',
    );
    expect(explicitSug.kind).toBe('suggestion');
    if (explicitSug.kind === 'suggestion') {
      expect(explicitSug.text).toBe('站台上的时钟忽然倒转了半圈。');
    }
  });

  it('persists TurnNode.proposals in FictionHarness and uses unified character prompt & story Markdown export', async () => {
    const storage = createInMemoryStoryStorage();
    const transport = makeFakeTransport([
      '雨停了。\n\n```lfh-proposal\ntarget: setting\nop: append\nsummary: 记录雨停线索\n---\n- 车站东侧亮起微光。\n```',
    ]);
    const harness = createFictionHarness({ transport, storage });
    const story = await harness.createAndSaveStory({ title: '测试文游', rawScript: '初始设定' });
    const res = await harness.runTurn(story, '四处看看并记录线索', testConfig);

    expect(res.assistantNode.proposals).toHaveLength(1);
    expect(res.assistantNode.proposals?.[0].status).toBe('pending');
    expect(res.assistantNode.proposals?.[0].summary).toBe('记录雨停线索');

    const md = storyExportMarkdown(res.story);
    expect(md).toContain('# 测试文游');
    expect(md).toContain('## 故事设定');
    expect(md).toContain('四处看看并记录线索');
    expect(md).toContain('雨停了。');

    const char = newCharacter('岑灯', '灯塔守夜人');
    const conv = newConversation(char, 'roleplay');
    conv.nodes = {
      u1: {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: '今晚海浪大吗？',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    };
    conv.activeLeafNodeId = 'u1';
    expect(formatCharacterConversationTitle(char, conv)).toBe('今晚海浪大吗？');

    const ctx = characterContext(newDocument('偏好自然对白'), char, conv, '我换上邮差制服敲门');
    expect(ctx.messages[0].content).toContain('你是该角色本人');
    expect(ctx.messages[1].content).toContain('我的记忆');
    expect(ctx.messages[2].content).toContain('角色设定');
  });
});
