import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  appendWorkDiscussionTurn,
  assembleCreativeThreeZoneContext,
  characterContext,
  createFictionHarness,
  isSummaryTargetUnchanged,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  summarizeCharacterConversation,
  summarizeCreativeTurnNodes,
  summarizeStoryBranchSilent,
  summarizeWorkDiscussion,
  workContext,
  type LlmStreamRequest,
  type LlmTransport,
  type ModelConfig,
  type TurnNode,
} from '../../src/harness/index.ts';

const modelConfig: ModelConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  memoryOnly: true,
};

function makeTurnChain(
  prefix: string,
  pairs: number,
  contentSize = 60,
): { nodes: Record<string, TurnNode>; leafId: string; nodeIds: string[] } {
  const nodes: Record<string, TurnNode> = {};
  const nodeIds: string[] = [];
  let parentId: string | null = null;

  for (let i = 1; i <= pairs; i++) {
    const userId = `${prefix}-u${i}`;
    const assistantId = `${prefix}-a${i}`;
    nodes[userId] = {
      id: userId,
      parentId,
      role: 'user',
      content: `[${prefix}-轮${i}-问] ${'甲'.repeat(contentSize)}`,
      createdAt: i * 10,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    nodes[assistantId] = {
      id: assistantId,
      parentId: userId,
      role: 'assistant',
      content: `[${prefix}-轮${i}-答] ${'乙'.repeat(contentSize)}`,
      reasoningContent: `HIDDEN_REASONING_${prefix}_${i}`,
      createdAt: i * 10 + 5,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    nodeIds.push(userId, assistantId);
    parentId = assistantId;
  }

  return { nodes, leafId: parentId!, nodeIds };
}

describe('All-mode TurnNode trees & silent background rolling summary', () => {
  it('rejects a background summary when the target turn changed after it started', () => {
    const started: TurnNode = {
      id: 'leaf',
      parentId: 'parent',
      role: 'assistant',
      content: '摘要开始时的旧正文',
      createdAt: 1,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };

    expect(isSummaryTargetUnchanged(started, { ...started })).toBe(true);
    expect(isSummaryTargetUnchanged(started, { ...started, content: '追要后的新正文' })).toBe(false);
    expect(isSummaryTargetUnchanged(started, { ...started, parentId: 'other-parent' })).toBe(false);
    expect(isSummaryTargetUnchanged(started, undefined)).toBe(false);
  });

  it('persists refusal diagnostics and prefix prefill metadata on appended assistant nodes', () => {
    const appended = appendWorkDiscussionTurn(newWork('诊断保存测试'), {
      role: 'assistant',
      content: '重拟后的正文。',
      diagnostics: {
        refusalRoute: 'retry',
        recoveredFromText: '抱歉，我不能继续。',
        retriedWithPrefix: true,
      },
      prefillContent: '她抬起眼，',
    });

    expect(appended.node.diagnostics).toMatchObject({
      refusalRoute: 'retry',
      recoveredFromText: '抱歉，我不能继续。',
    });
    expect(appended.node.prefillContent).toBe('她抬起眼，');
    expect(appended.work.discussionNodes?.[appended.node.id]).toMatchObject({
      diagnostics: appended.node.diagnostics,
      prefillContent: '她抬起眼，',
    });
  });

  it('compresses long 写故事 discussion silently in background and isolates sibling branches', async () => {
    let work = newWork('长河夜行', '# 作品设定\n\n民国悬疑短篇');
    work.body = '第一章：码头的雾比往年更浓。';
    const publicDoc = newDocument('文风克制，少用感叹号。');

    // Branch A: 3 turn pairs
    const a1 = appendWorkDiscussionTurn(work, { role: 'user', content: 'A线第一问：码头主角是谁？', id: 'a-u1', createdAt: 10 });
    work = a1.work;
    const a2 = appendWorkDiscussionTurn(work, { role: 'assistant', content: 'A线第一答：码头守夜人陈昼。', id: 'a-a1', createdAt: 20 });
    work = a2.work;
    const a3 = appendWorkDiscussionTurn(work, { role: 'user', content: 'A线第二问：他手里拿什么？', id: 'a-u2', createdAt: 30 });
    work = a3.work;
    const a4 = appendWorkDiscussionTurn(work, { role: 'assistant', content: 'A线第二答：半截铜哨。', id: 'a-a2', createdAt: 40 });
    work = a4.work;
    const a5 = appendWorkDiscussionTurn(work, { role: 'user', content: 'A线第三问：远处来船了吗？', id: 'a-u3', createdAt: 50 });
    work = a5.work;
    const a6 = appendWorkDiscussionTurn(work, { role: 'assistant', content: 'A线第三答：一艘无灯货船靠岸。', id: 'a-a3', createdAt: 60 });
    work = a6.work;

    // Fork Branch B from a-a1
    const b1 = appendWorkDiscussionTurn(work, {
      role: 'user',
      content: 'B线分支问：如果守夜人不在码头呢？',
      parentId: 'a-a1',
      id: 'b-u2',
      createdAt: 70,
    });
    work = b1.work;
    const b2 = appendWorkDiscussionTurn(work, {
      role: 'assistant',
      content: 'B线分支答：只有一只黑猫蹲在缆桩上。',
      parentId: 'b-u2',
      id: 'b-a2',
      createdAt: 80,
    });
    work = b2.work;

    const summaryTransport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '分支B摘要：守夜人缺席，仅黑猫现身。', finishReason: 'stop' };
      },
    };

    // Summarize Branch B with tight budget
    const summarizedB = await summarizeWorkDiscussion(work, summaryTransport, modelConfig, {
      targetLeafId: 'b-a2',
      budget: { recentMaxNodes: 2, recentMaxChars: 500 },
    });
    expect(summarizedB.status).toBe('done');
    expect(summarizedB.work.discussionNodes!['b-a2'].summarySnapshot.content).toBe(
      '分支B摘要：守夜人缺席，仅黑猫现身。',
    );
    // Sibling Branch A leaf MUST remain untouched / unpolluted!
    expect(summarizedB.work.discussionNodes!['a-a3'].summarySnapshot.content).toBe('');
    expect(summarizedB.work.discussionNodes!['a-a3'].summarySnapshot.coveredUpToNodeId).toBeNull();

    // Context for Branch A must NOT see Branch B's summary or turns
    const ctxA = workContext(publicDoc, summarizedB.work, '继续完善A线', {
      targetParentId: 'a-a3',
      budgetOverrides: { recentMaxNodes: 2, recentMaxChars: 500 },
    });
    const serializedA = JSON.stringify(ctxA.messages);
    expect(serializedA).toContain('文风克制，少用感叹号');
    expect(serializedA).toContain('民国悬疑短篇');
    expect(serializedA).toContain('第一章：码头的雾比往年更浓');
    expect(serializedA).toContain('一艘无灯货船靠岸');
    expect(serializedA).not.toContain('黑猫');
    expect(serializedA).not.toContain('分支B摘要');

    // Context for Branch B uses Branch B's rolling summary + recent window
    const ctxB = workContext(publicDoc, summarizedB.work, '继续完善B线', {
      targetParentId: 'b-a2',
      budgetOverrides: { recentMaxNodes: 2, recentMaxChars: 500 },
    });
    const serializedB = JSON.stringify(ctxB.messages);
    expect(serializedB).toContain('分支B摘要：守夜人缺席，仅黑猫现身');
    expect(serializedB).toContain('黑猫蹲在缆桩上');
    expect(serializedB).not.toContain('无灯货船');
  });

  it('compresses long 角色互动 conversations via rolling summary and strips reasoningContent', async () => {
    const character = newCharacter('顾砚', '# 角色设定\n\n夜班急诊医生');
    const conversation = newConversation(character, 'personal', '认识三年的老同学');
    const chain = makeTurnChain('char', 4, 40);
    conversation.nodes = chain.nodes;
    conversation.activeLeafNodeId = chain.leafId;

    const requests: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        requests.push(req);
        yield { contentDelta: '前几轮两人聊了值班往事与旧照片。', finishReason: 'stop' };
      },
    };

    const compressed = await summarizeCharacterConversation(conversation, transport, modelConfig, {
      budget: { recentMaxNodes: 2, recentMaxChars: 400 },
    });

    expect(compressed.updated).toBe(true);
    expect(compressed.snapshot.content).toBe('前几轮两人聊了值班往事与旧照片。');
    expect(requests[0].messages[0].content).toContain('剧情摘要压缩');

    const ctx = characterContext(
      newDocument('记住用户喜欢喝热美式'),
      character,
      compressed.conversation,
      '今晚下班吃什么？',
      { recentMaxNodes: 2, recentMaxChars: 400 },
    );

    const payload = JSON.stringify(ctx.messages);
    expect(payload).toContain('记住用户喜欢喝热美式');
    expect(payload).toContain('夜班急诊医生');
    expect(payload).toContain('认识三年的老同学');
    expect(payload).toContain('前几轮两人聊了值班往事与旧照片');
    expect(payload).toContain('[char-轮4-答]');
    expect(payload).not.toContain('[char-轮1-问]');
    expect(payload).not.toContain('HIDDEN_REASONING_char');
  });

  it('falls back silently when background compression fails or aborts without blocking future turns', async () => {
    const chain = makeTurnChain('fail', 4, 50);
    // Seed an earlier successful summary on node u2/a2 and leaf
    chain.nodes[chain.leafId] = {
      ...chain.nodes[chain.leafId],
      summarySnapshot: {
        content: '上一次成功的可靠摘要',
        coveredUpToNodeId: chain.nodeIds[1], // fail-a1
        summarizedTurnCount: 2,
      },
    };

    // Case 1: transport throws error
    const errorTransport: LlmTransport = {
      async *streamChat() {
        throw new Error('network timeout');
      },
    };
    const errorResult = await summarizeCreativeTurnNodes({
      nodes: chain.nodes,
      targetLeafId: chain.leafId,
      transport: errorTransport,
      config: modelConfig,
      budget: { recentMaxNodes: 2, recentMaxChars: 400 },
    });
    expect(errorResult.status).toBe('failed');
    expect(errorResult.snapshot.content).toBe('上一次成功的可靠摘要');
    expect(errorResult.snapshot.coveredUpToNodeId).toBe(chain.nodeIds[1]);

    // Case 2: signal already aborted — must NOT throw!
    const abortedResult = await summarizeCreativeTurnNodes({
      nodes: chain.nodes,
      targetLeafId: chain.leafId,
      transport: errorTransport,
      config: modelConfig,
      signal: { aborted: true },
      budget: { recentMaxNodes: 2, recentMaxChars: 400 },
    });
    expect(abortedResult.status).toBe('failed');
    expect(abortedResult.snapshot.content).toBe('上一次成功的可靠摘要');

    // Case 3: assembling context after compression failure still succeeds and gently trims recent window
    const assembled = assembleCreativeThreeZoneContext({
      systemPrompt: '系统规则',
      nodes: abortedResult.nodes,
      targetParentId: chain.leafId,
      userInput: '下一句对话',
      budgetOverrides: { recentMaxNodes: 2, recentMaxChars: 400 },
    });
    expect(assembled.metrics.recentNodeCount).toBeLessThanOrEqual(2);
    const json = JSON.stringify(assembled.messages);
    expect(json).toContain('上一次成功的可靠摘要');
    expect(json).toContain('[fail-轮4-答]');
    expect(json).not.toContain('[fail-轮2-问]');
    expect(json).toContain('下一句对话');
  });

  it('also provides silent non-blocking branch summary helper for 文游 Story', async () => {
    const harness = createFictionHarness({
      transport: {
        async *streamChat() {
          yield { contentDelta: 'ok', finishReason: 'stop' };
        },
      },
    });
    let story = harness.createStory({ title: '山海驿', rawScript: '古驿站规则' });
    const chain = makeTurnChain('story', 4, 40);
    story = {
      ...story,
      nodes: chain.nodes,
      rootNodeIds: [chain.nodeIds[0]],
      activeLeafNodeId: chain.leafId,
    };

    const transport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '文游静默摘要：主角抵达山海驿。', finishReason: 'stop' };
      },
    };

    const updatedStory = await summarizeStoryBranchSilent(story, story.activeLeafNodeId, transport, modelConfig, {
      budget: { recentMaxNodes: 2, recentMaxChars: 400 },
    });
    expect(updatedStory.nodes[chain.leafId].summarySnapshot.content).toBe('文游静默摘要：主角抵达山海驿。');
  });

  it('preserves first successful batch when a later summary batch fails, and centers workBodyWindow around cursor', async () => {
    const chain = makeTurnChain('multi', 5, 30);
    let calls = 0;
    const partialTransport: LlmTransport = {
      async *streamChat() {
        calls += 1;
        if (calls === 1) {
          yield { contentDelta: '第一批压缩成功摘要', finishReason: 'stop' };
          return;
        }
        yield { contentDelta: '截断失效摘要', finishReason: 'length' };
      },
    };

    const result = await summarizeCreativeTurnNodes({
      nodes: chain.nodes,
      targetLeafId: chain.leafId,
      transport: partialTransport,
      config: modelConfig,
      budget: {
        recentMaxNodes: 2,
        recentMaxChars: 500,
        summaryBatchMaxNodes: 4,
        summaryBatchMaxChars: 5000,
      },
    });

    expect(result.status).toBe('failed');
    expect(result.updated).toBe(true);
    expect(result.snapshot.content).toBe('第一批压缩成功摘要');
    expect(result.snapshot.coveredUpToNodeId).toBe(chain.nodeIds[3]); // multi-a2
    expect(result.snapshot.summarizedTurnCount).toBe(4);

    const longWork = newWork('长正文测试');
    longWork.body = 'A'.repeat(100) + 'TARGET_MARKER' + 'B'.repeat(100);
    const ctx = workContext(newDocument(''), longWork, '润色光标附近', {
      cursorPos: 105,
      bodyWindowMaxChars: 40,
    });
    expect(JSON.stringify(ctx.messages)).toContain('TARGET_MARKER');
  });
});
