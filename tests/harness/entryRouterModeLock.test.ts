import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  buildEntryRouteMessages,
  classifyEntryHeuristic,
  detectExplicitEntryModeSwitch,
  parseEntryRouteReply,
  routeEntryMessage,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
} from '../../src/harness/index.ts';

const testConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test-lock-147',
  memoryOnly: false,
};

function makeStaticTransport(reply: string, capture?: (req: LlmStreamRequest) => void): LlmTransport {
  return {
    async *streamChat(request) {
      capture?.(request);
      yield { contentDelta: reply };
      yield { finishReason: 'stop' };
    },
  };
}

describe('Issue #147: entryRouter mode lock & explicit switch detection', () => {
  it('detects explicit entry mode switches without drifting on topic-only prompts', () => {
    expect(detectExplicitEntryModeSwitch('改为写故事模式')).toBe('writing');
    expect(detectExplicitEntryModeSwitch('帮我用这个角色开一个角色互动')).toBe('character');
    expect(detectExplicitEntryModeSwitch('用角色互动模式开启：沈默，守夜人')).toBe('character');
    expect(detectExplicitEntryModeSwitch('请切换到文游模式，开启雨夜车站')).toBe('story');
    expect(detectExplicitEntryModeSwitch('以写故事模式写一个关于灯塔的短篇')).toBe('writing');
    expect(detectExplicitEntryModeSwitch('不要角色互动，改成写故事模式')).toBe('writing');

    // Topic-only or ambiguous openings must NOT count as explicit mode switches
    expect(detectExplicitEntryModeSwitch('一个雨夜车站的悬疑故事，主角是失忆的列车员')).toBeNull();
    expect(detectExplicitEntryModeSwitch('帮我建个毒舌猫系角色')).toBeNull();
    expect(detectExplicitEntryModeSwitch('我想写一段关于灯塔的开篇')).toBeNull();
    expect(detectExplicitEntryModeSwitch('不要切换到角色互动')).toBeNull();
  });

  it('keeps heuristic classification locked to lockedMode unless explicitly switched', () => {
    // Normally "主线/开局" triggers story, but locked writing stays writing
    expect(classifyEntryHeuristic('主角在雨夜开局调查灯塔失踪案', [], 'writing')).toBe('writing');
    // Normally generic prose falls back to story, but locked character stays character
    expect(classifyEntryHeuristic('寡言的守夜人站在渡口边', [], 'character')).toBe('character');
    // Short greetings remain ambiguous for neutral chat
    expect(classifyEntryHeuristic('你好', [], 'writing')).toBe('ambiguous');
    // Explicit switch overrides lockedMode
    expect(classifyEntryHeuristic('用角色互动模式开启：沈默', [], 'writing')).toBe('character');
  });

  it('injects lockedMode constraint into entry route messages and clamps unrequested LLM drift', async () => {
    let capturedRequest: LlmStreamRequest | undefined;
    // Simulate an LLM ignoring the lock and returning mode: story for a vague writing prompt
    const driftingTransport = makeStaticTransport(
      [
        '```lfh-route',
        'mode: story',
        'title: 雾港渡口',
        '---',
        '## 设定\n雾港渡口。',
        '```',
        '第一幕在雾里开始了。',
      ].join('\n'),
      (req) => {
        capturedRequest = req;
      },
    );

    const messages = buildEntryRouteMessages('雾港渡口的故事', [], '', undefined, undefined, 'writing');
    expect(messages.some((m) => m.role === 'system' && m.content.includes('写故事') && m.content.includes('writing'))).toBe(true);

    const result = await routeEntryMessage(
      '雾港渡口的故事，主角在雨夜里等船',
      [],
      driftingTransport,
      testConfig,
      {},
      '',
      {
        promptPackLibrary: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
          activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
        },
        generationPreference: { prefixCompletion: 'always' },
        lockedMode: 'writing',
      },
    );

    expect(capturedRequest?.prefixCompletion?.content).toBe('```lfh-route\nmode: writing\n');
    expect(result.mode).toBe('writing');
    expect(result.title).toBe('雾港渡口');
  });

  it('allows explicit natural-language mode switch when lockedMode is set', async () => {
    const switchTransport = makeStaticTransport(
      [
        '```lfh-route',
        'mode: character',
        'title: 沈默',
        'character_name: 沈默',
        '---',
        '## 角色设定\n守夜人沈默。',
        '```',
        '你好，这么晚还没睡？',
      ].join('\n'),
    );

    const result = await routeEntryMessage(
      '帮我用这个角色开一个角色互动：沈默',
      [],
      switchTransport,
      testConfig,
      {},
      '',
      undefined,
      undefined,
      { lockedMode: 'writing' },
    );

    expect(result.mode).toBe('character');
    expect(result.characterName).toBe('沈默');

    // Even if LLM fails to emit the requested switch mode, explicit switch directive takes precedence
    const stubbornParsed = parseEntryRouteReply(
      '```lfh-route\nmode: writing\ntitle: 沈默\n---\n## 设定\n沈默。\n```\n你好。',
      '用角色互动模式开启：沈默',
      [],
      '',
      'writing',
    );
    expect(stubbornParsed.mode).toBe('character');
    expect(stubbornParsed.characterName).toBe('沈默');
  });

  it('preserves ambiguous neutral chat when lockedMode is set and greeting is unclear', async () => {
    const ambiguousTransport = makeStaticTransport(
      [
        '```lfh-route',
        'mode: ambiguous',
        'title: 未命名创作',
        '---',
        '',
        '```',
        '你好！你想先聊聊什么方向？',
      ].join('\n'),
    );

    const result = await routeEntryMessage(
      '你好，我有点犹豫',
      [],
      ambiguousTransport,
      testConfig,
      {},
      '',
      undefined,
      undefined,
      { lockedMode: 'character' },
    );

    expect(result.mode).toBe('ambiguous');
  });
});
