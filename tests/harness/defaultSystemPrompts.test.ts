import { describe, expect, it } from 'vitest';
import {
  CHANGE_PROMPT,
  ENTRY_ROUTE_SYSTEM_PROMPT,
  assembleThreeZoneContext,
  buildEntryRouteMessages,
  buildSystemAnchorPrompt,
  characterContext,
  createFictionHarness,
  createInMemoryStoryStorage,
  documentVersion,
  getManuscriptIntentSystemPrompt,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  parseAssistantMessage,
  parseEntryRouteReply,
  parseManuscriptAssistantReply,
  parseProposalReply,
  workContext,
} from '../../src/harness/index.ts';

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('Issue #105 default anti-DS-ism system prompts & precedence', () => {
  it('builds 文游 system anchor prompt with immersive anti-DS-ism guardrails and setting precedence', async () => {
    const harness = createFictionHarness({
      storage: createInMemoryStoryStorage(),
      transport: {
        async *streamChat() {
          yield { contentDelta: 'ok', finishReason: 'stop' };
        },
      },
    });
    const story = await harness.createAndSaveStory({
      title: '雾港渡口',
      rawScript: '## 故事设定\n\n冷雨不停的港口小镇。',
    });

    const anchor = buildSystemAnchorPrompt(story);
    const context = assembleThreeZoneContext(story, story.activeLeafNodeId, '推开木门', undefined, false, {
      publicVersion: documentVersion(newDocument('文风：冷峻克制，第二人称叙事。')),
      container: documentVersion(story.documents!.container),
      local: documentVersion(story.documents!.local),
      snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    });

    expect(anchor).toContain('你是文游的叙事者');
    expect(anchor).toMatch(/场景|动作|对话/);
    expect(anchor).toMatch(/跳出|评价玩家|总结|升华/);
    expect(anchor).toMatch(/1\/2\/3|菜单|选项/);
    expect(anchor).toContain('lfh-choices');
    expect(anchor).toMatch(/劫持|代写/);
    expect(anchor).toContain('「我的记忆」');
    expect(anchor).toContain('「当前设定」');
    expect(countOccurrences(anchor, CHANGE_PROMPT)).toBe(1);
    expect(anchor).toContain('冷雨不停的港口小镇');
    expect(context.messages[0].content).toBe(
      buildSystemAnchorPrompt(story, story.activeLeafNodeId, undefined, undefined, false),
    );
    expect(context.messages[1].content).toContain('我的记忆');
    expect(context.messages[2].content).toContain('冷雨不停的港口小镇');
  });

  it('builds 角色互动 system prompt with natural voice, anti-DS-ism guardrails, and setting precedence', () => {
    const char = newCharacter('沈砚', '话少但细心的老书店老板');
    const conv = newConversation(char, 'roleplay');
    const ctx = characterContext(newDocument('偏好：多用短句对白。'), char, conv, '今晚关门早吗？');
    const systemPrompt = ctx.messages[0].content;

    expect(systemPrompt).toContain('你是该角色本人');
    expect(systemPrompt).toMatch(/长短|篇幅|自然变化/);
    expect(systemPrompt).toMatch(/客服|客套/);
    expect(systemPrompt).toMatch(/分点|说教/);
    expect(systemPrompt).toMatch(/解释.*原因|为何/);
    expect(systemPrompt).toMatch(/括号|元评论/);
    expect(systemPrompt).toMatch(/自称\s*AI|免责/);
    expect(systemPrompt).toContain('「我的记忆」');
    expect(systemPrompt).toContain('「当前设定」');
    expect(countOccurrences(systemPrompt, CHANGE_PROMPT)).toBe(1);
    expect(ctx.messages[1].content).toContain('我的记忆');
    expect(ctx.messages[2].content).toContain('角色设定');
  });

  it('builds 写故事 chat system prompt with co-writer tone, list exception, clean prose, and precedence', () => {
    const work = newWork('雨夜站台', '## 作品设定\n\n悬疑短篇。');
    const ctx = workContext(newDocument('文风：白描短句，少用形容词。'), work, '这一段节奏是不是太慢了？');
    const systemPrompt = ctx.messages[0].content;

    expect(systemPrompt).toMatch(/创作搭档|编辑/);
    expect(systemPrompt).toMatch(/首先|其次|总结/);
    expect(systemPrompt).toMatch(/大纲|人物表|清单|拆解/);
    expect(systemPrompt).toMatch(/翻译腔|比喻|说教/);
    expect(systemPrompt).toContain('「我的记忆」');
    expect(systemPrompt).toContain('「当前设定」');
    expect(countOccurrences(systemPrompt, CHANGE_PROMPT)).toBe(1);
  });

  it('fixes duplicate CHANGE_PROMPT on manuscript intent path and enforces anti-DS-ism prose/chat rules', () => {
    const manuscriptPrompt = getManuscriptIntentSystemPrompt();
    expect(manuscriptPrompt).toContain('lfh-manuscript-intent');
    expect(manuscriptPrompt).toMatch(/首先|其次|总结/);
    expect(manuscriptPrompt).toMatch(/大纲|人物表|拆解/);
    expect(manuscriptPrompt).toMatch(/翻译腔|比喻|说教/);
    expect(manuscriptPrompt).toContain('「我的记忆」');
    expect(manuscriptPrompt).toContain('「当前设定」');
    expect(countOccurrences(manuscriptPrompt, CHANGE_PROMPT)).toBeLessThanOrEqual(1);

    const work = newWork('雨夜站台', '## 作品设定\n\n悬疑短篇。');
    const ctx = workContext(newDocument(''), work, '帮我续写下一段', {
      systemPrompt: manuscriptPrompt,
      cursorPos: 0,
    });
    expect(countOccurrences(ctx.messages[0].content, CHANGE_PROMPT)).toBe(1);

    // Custom prompt without CHANGE_PROMPT still gets it appended once
    const customCtx = workContext(newDocument(''), work, '测试输入', {
      systemPrompt: '自定义写作提示词。',
    });
    expect(countOccurrences(customCtx.messages[0].content, CHANGE_PROMPT)).toBe(1);
  });

  it('updates ENTRY_ROUTE_SYSTEM_PROMPT with concise anti-DS-ism rules, neutral pickup, and precedence', () => {
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toContain('```lfh-route');
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toContain('ambiguous');
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toMatch(/推销|能力清单|能力菜单|功能/);
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toContain('「我的记忆」');
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toContain('「当前设定」');

    const messages = buildEntryRouteMessages('你好', [], '偏好：简洁自然');
    expect(messages[0]).toEqual({ role: 'system', content: ENTRY_ROUTE_SYSTEM_PROMPT });
    expect(messages[1].content).toContain('我的记忆');
    expect(messages[2]).toEqual({ role: 'user', content: '你好' });
  });

  it('preserves lfh-choices, lfh-proposal, lfh-route, and lfh-manuscript-intent parsing', () => {
    const choicesParsed = parseAssistantMessage(
      '雨丝敲在铁皮棚顶上。\n\n```lfh-choices\n1. 推开仓库门\n2. 绕到后窗\n```',
    );
    expect(choicesParsed.choices).toHaveLength(2);
    expect(choicesParsed.choices[0].label).toBe('推开仓库门');

    const proposalParsed = parseProposalReply(
      '已整理好人物线索。\n\n```lfh-proposal\ntarget: setting\nop: append\nsummary: 补充配角\n---\n- 陈伯：渡口守夜人。\n```',
    );
    expect(proposalParsed.proposals).toHaveLength(1);
    expect(proposalParsed.proposals[0].target).toBe('setting');

    const routeParsed = parseEntryRouteReply(
      '```lfh-route\nmode: ambiguous\ntitle: 新对话\n---\n```\n你好，今天想玩点什么，还是直接聊个想法？',
      '你好',
    );
    expect(routeParsed.mode).toBe('ambiguous');
    expect(routeParsed.usedFallback).toBe(false);

    const manuscriptChat = parseManuscriptAssistantReply(
      '```lfh-manuscript-intent\nintent: chat\n```\n这里节奏偏慢，把对话提前两句会更紧。',
      '这里是不是拖沓了？',
    );
    expect(manuscriptChat.kind).toBe('chat');
  });
});
