import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  type LlmStreamRequest,
  type ProviderCapabilities,
  type TurnNode,
} from '../../src/harness/index.ts';
import {
  finalizePrefixContinuation,
  streamPrefixContinuation,
} from '../../src/ui/refusalContinuation.ts';

function makePartialNode(content = '窗外的雨声敲打着玻璃。'): TurnNode {
  return {
    id: 'assistant-1',
    parentId: 'user-1',
    role: 'assistant',
    content,
    createdAt: 100,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    diagnostics: {
      sourceStatus: 'REFUSAL',
      refusalRoute: 'partial_refused',
      matchedRuleId: 'L1-02',
    },
  };
}

describe('Capability-driven refusal continuation', () => {
  it('uses prefixCompletion and forwards capabilities when prefixProtocol is standard_assistant_prefill or deepseek_beta', async () => {
    const requests: LlmStreamRequest[] = [];
    const capabilities: ProviderCapabilities = {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'standard_assistant_prefill',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    };

    const result = await streamPrefixContinuation({
      transport: {
        async *streamChat(req) {
          requests.push(req);
          yield { contentDelta: '门轴发出轻响。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-ex',
        model: 'custom-model',
        reasoningEffort: 'none',
        memoryOnly: false,
        capabilities,
      },
      messages: [{ role: 'user', content: '继续' }],
      prefixContent: '窗外的雨声敲打着玻璃。',
    });

    expect(requests[0]?.capabilities).toEqual(capabilities);
    expect(requests[0]?.prefixCompletion).toEqual({ content: '窗外的雨声敲打着玻璃。' });
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: '继续' }]);
    expect(result.content).toBe('门轴发出轻响。');
  });

  it('falls back to standard assistant+user continuation messages when prefixProtocol is none and stitches cleanly', async () => {
    const requests: LlmStreamRequest[] = [];
    const streamed: string[] = [];
    const capabilities: ProviderCapabilities = {
      thinkingProtocol: 'openai_reasoning_effort',
      prefixProtocol: 'none',
      supportsBalanceQuery: false,
      supportsBuiltinSearch: false,
      supportsBuiltinPricing: false,
    };

    const continued = await streamPrefixContinuation({
      transport: {
        async *streamChat(req) {
          requests.push(req);
          yield { contentDelta: '门外站着一个撑黑伞的人。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        reasoningEffort: 'none',
        memoryOnly: false,
        capabilities,
      },
      messages: [
        { role: 'system', content: '系统设定' },
        { role: 'user', content: '推进剧情' },
      ],
      prefixContent: '窗外的雨声敲打着玻璃。',
      onContentDelta: (delta) => streamed.push(delta),
    });

    expect(requests[0]?.prefixCompletion).toBeUndefined();
    expect(requests[0]?.capabilities).toEqual(capabilities);
    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: '系统设定' },
      { role: 'user', content: '推进剧情' },
      { role: 'assistant', content: '窗外的雨声敲打着玻璃。' },
      {
        role: 'user',
        content: '请紧接上一句自然续写后续正文，不要重复已写内容，也不要输出说明或免责声明。',
      },
    ]);
    expect(streamed.join('')).toBe('门外站着一个撑黑伞的人。');

    const node = makePartialNode('窗外的雨声敲打着玻璃。');
    const finalized = finalizePrefixContinuation(node, continued, { mode: 'story' });
    expect(finalized.content).toBe('窗外的雨声敲打着玻璃。门外站着一个撑黑伞的人。');
    expect(finalized.diagnostics).toEqual({ refusalRoute: 'pass' });
  });

  it('infers prefixProtocol none for third-party baseUrl without explicit capabilities', async () => {
    const requests: LlmStreamRequest[] = [];
    await streamPrefixContinuation({
      transport: {
        async *streamChat(req) {
          requests.push(req);
          yield { contentDelta: '他推开了门。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-key',
        model: 'openai/gpt-4o-mini',
        reasoningEffort: 'none',
        memoryOnly: false,
      },
      messages: [{ role: 'user', content: '继续' }],
      prefixContent: '廊灯忽然暗了。',
    });

    expect(requests[0]?.prefixCompletion).toBeUndefined();
    expect(requests[0]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '廊灯忽然暗了。' },
      {
        role: 'user',
        content: '请紧接上一句自然续写后续正文，不要重复已写内容，也不要输出说明或免责声明。',
      },
    ]);
  });

  it('downgrades prefix completion to standard assistant+user continuation for openai_responses', async () => {
    const requests: LlmStreamRequest[] = [];
    await streamPrefixContinuation({
      transport: {
        async *streamChat(req) {
          requests.push(req);
          yield { contentDelta: '续写成功。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oa',
        model: 'gpt-4.1',
        reasoningEffort: 'none',
        memoryOnly: false,
        capabilities: {
          apiProtocol: 'openai_responses',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'standard_assistant_prefill',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
      },
      messages: [{ role: 'user', content: '继续' }],
      prefixContent: '前文半句。',
    });

    expect(requests[0]?.prefixCompletion).toBeUndefined();
    expect(requests[0]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '前文半句。' },
      {
        role: 'user',
        content: '请紧接上一句自然续写后续正文，不要重复已写内容，也不要输出说明或免责声明。',
      },
    ]);
  });

  it('downgrades prefix completion to standard assistant+user continuation for gemini_native', async () => {
    const requests: LlmStreamRequest[] = [];
    await streamPrefixContinuation({
      transport: {
        async *streamChat(req) {
          requests.push(req);
          yield { contentDelta: '续写成功。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-gem',
        model: 'gemini-2.5-flash',
        reasoningEffort: 'none',
        memoryOnly: false,
        capabilities: {
          apiProtocol: 'gemini_native',
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'standard_assistant_prefill',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
      },
      messages: [{ role: 'user', content: '继续' }],
      prefixContent: '前文半句。',
    });

    expect(requests[0]?.prefixCompletion).toBeUndefined();
    expect(requests[0]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '前文半句。' },
      {
        role: 'user',
        content: '请紧接上一句自然续写后续正文，不要重复已写内容，也不要输出说明或免责声明。',
      },
    ]);
  });
});
