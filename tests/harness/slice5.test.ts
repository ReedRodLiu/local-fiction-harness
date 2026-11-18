import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getBranchTreeSummary,
  getSiblingBranchInfo,
  importStoryBackup,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

describe('Slice 5: Branching, rewind, edit-resend, regenerate, and Plot Summary snapshot rollback', () => {
  it('rolls back Plot Summary on branch fork, isolates Branch B continuation, and preserves branch tree in JSON backup', async () => {
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        if (sys.includes('剧情摘要压缩')) {
          if (lastUser.includes('继续推进黑市任务')) {
            yield { contentDelta: '【分支A摘要】深入黑市密会接头。', finishReason: 'stop' };
          } else if (lastUser.includes('分支A独有事件')) {
            yield { contentDelta: '【分支A初阶】潜入黑市外围。', finishReason: 'stop' };
          } else {
            yield { contentDelta: '【通用摘要】玩家来到十字路口。', finishReason: 'stop' };
          }
          return;
        }
        yield { contentDelta: `AI回应：${lastUser}`, finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harness = createFictionHarness({
      transport,
      storage,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
      now: () => 1700000000000 + seq * 1000,
      createId: () => `node-${++seq}`,
    });

    const initial = await harness.createAndSaveStory({ title: '双线风云', rawScript: '基础规则' });
    const t1 = await harness.runTurn(initial, '来到十字路口', testConfig);
    const t2A = await harness.runTurn(t1.story, '分支A独有事件：潜入黑市', testConfig);
    const t3A = await harness.runTurn(t2A.story, '继续推进黑市任务', testConfig);
    expect(getActiveSummarySnapshot(t3A.story).content).toBe('【分支A初阶】潜入黑市外围。');

    // Fork Branch B from Turn 2 assistant node (after Turn 3 had already overwritten active summary)
    // Wait: first verify Turn 2 -> Turn 3 -> Turn 4 advances Branch A's summary, then fork at Turn 3
    const t4A = await harness.runTurn(t3A.story, '进入黑市密室', testConfig);
    expect(getActiveSummarySnapshot(t4A.story).coveredUpToNodeId).toBe(t3A.assistantNode.id);

    // Fork Branch B by editing Turn 3 user node (fork parent = t2A.assistantNode, whose coveredUpToNodeId is t1.assistantNode.id!)
    const branchB = await harness.editAndBranch(
      t4A.story,
      t3A.userNode.id,
      '分支B独有事件：前往官府报案',
      testConfig,
    );

    const turnReqForB = captured.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes('分支B独有事件')),
    );
    expect(turnReqForB).toBeDefined();
    const joinedMessagesB = turnReqForB!.messages.map((m) => m.content).join('\n');
    expect(joinedMessagesB).not.toContain('分支A摘要');
    expect(joinedMessagesB).toContain('【通用摘要】玩家来到十字路口。');
    expect(branchB.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t2A.assistantNode.id);

    // Continue on Branch B and confirm subsequent turns only see pre-fork history + Branch B's summary
    const branchBNext = await harness.runTurn(branchB.story, '呈递官府证物', testConfig);
    const branchBNextReq = captured.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content === '呈递官府证物'),
    );
    const joinedNextB = branchBNextReq!.messages.map((m) => m.content).join('\n');
    expect(joinedNextB).toContain('【分支A初阶】潜入黑市外围。');
    expect(joinedNextB).not.toContain('分支A摘要');
    expect(joinedNextB).not.toContain('继续推进黑市任务');
    expect(joinedNextB).not.toContain('黑市密室');

    // Sibling inspection at fork point (Turn 3 user nodes)
    const siblings = getSiblingBranchInfo(branchBNext.story, branchB.userNode.id);
    expect(siblings.total).toBe(2);
    expect(siblings.currentIndex).toBe(1);
    expect(siblings.prevSiblingId).toBe(t3A.userNode.id);

    // JSON backup round-trip preserves multi-branch tree & activeLeafNodeId
    const exported = exportStoryBackup(branchBNext.story);
    const restored = importStoryBackup(exported, []);
    expect(restored.activeLeafNodeId).toBe(branchBNext.assistantNode.id);
    expect(getBranchTreeSummary(restored)).toHaveLength(2);

    // Switch back to Branch A -> restores Branch A's leaf (t4A) & summary
    const switchedToA = await harness.switchBranch(restored, t3A.userNode.id);
    expect(switchedToA.activeLeafNodeId).toBe(t4A.assistantNode.id);
    expect(getActiveSummarySnapshot(switchedToA).coveredUpToNodeId).toBe(t3A.assistantNode.id);
    expect(getActiveBranchNodes(switchedToA).map((n) => n.content)).toContain('进入黑市密室');

    // Rewind to Turn 1 assistant node and also to root (null)
    const rewoundT1 = await harness.rewindToNode(switchedToA, t1.assistantNode.id);
    expect(rewoundT1.activeLeafNodeId).toBe(t1.assistantNode.id);
    expect(getActiveSummarySnapshot(rewoundT1).content).toBe('');
    expect(getActiveSummarySnapshot(rewoundT1).coveredUpToNodeId).toBeNull();

    const rewoundRoot = await harness.rewindToNode(rewoundT1, null);
    expect(rewoundRoot.activeLeafNodeId).toBeNull();
    expect(getActiveBranchNodes(rewoundRoot)).toEqual([]);
  });

  it('regenerates an assistant reply as a parallel sibling branch under the same user node', async () => {
    let genCount = 0;
    const transport: LlmTransport = {
      async *streamChat() {
        genCount += 1;
        yield { contentDelta: `第${genCount}版AI结局`, finishReason: 'stop' };
      },
    };

    let seq = 0;
    const harness = createFictionHarness({
      transport,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `r-${++seq}`,
    });

    const story = harness.createStory({ title: '重生成测试' });
    const t1 = await harness.runTurn(story, '推开石门', testConfig);
    const regen = await harness.regenerateNode(t1.story, t1.assistantNode.id, testConfig);

    expect(regen.assistantNode.parentId).toBe(t1.userNode.id);
    expect(regen.assistantNode.content).toBe('第2版AI结局');
    const siblings = getSiblingBranchInfo(regen.story, regen.assistantNode.id);
    expect(siblings.total).toBe(2);
    expect(siblings.currentIndex).toBe(1);

    const switchedBack = await harness.switchBranch(regen.story, t1.assistantNode.id);
    expect(switchedBack.activeLeafNodeId).toBe(t1.assistantNode.id);
  });

  it('regenerates an assistant reply cleanly after prior summary compression without orphaning recent turns', async () => {
    const captured: LlmStreamRequest[] = [];
    let regenSeq = 0;
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧情摘要压缩')) {
          const body = req.messages[1]?.content ?? '';
          yield {
            contentDelta: body.includes('第二轮行动') ? '【摘要2】含第二轮' : '【摘要1】含第一轮',
            finishReason: 'stop',
          };
          return;
        }
        regenSeq += 1;
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        yield { contentDelta: `第${regenSeq}次响应:${lastUser}`, finishReason: 'stop' };
      },
    };

    let seq = 0;
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
      now: () => 1700000000000 + seq * 1000,
      createId: () => `rc-${++seq}`,
    });

    const s0 = harness.createStory({ title: '压缩后重生成' });
    const t1 = await harness.runTurn(s0, '第一轮行动', testConfig);
    const t2 = await harness.runTurn(t1.story, '第二轮行动', testConfig);
    const t3 = await harness.runTurn(t2.story, '第三轮行动', testConfig);

    captured.length = 0;
    const regen = await harness.regenerateNode(t3.story, t3.assistantNode.id, testConfig);

    const regenTurnReq = captured.find((r) => !(r.messages[0]?.content ?? '').includes('剧情摘要压缩'));
    expect(regenTurnReq).toBeDefined();
    const nonSystemRoles = regenTurnReq!.messages.filter((m) => m.role !== 'system').map((m) => m.role);
    expect(nonSystemRoles).toEqual(['user', 'assistant', 'user']);
    expect(regenTurnReq!.messages.map((m) => m.content)).toContain('第二轮行动');
    expect(regen.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t2.assistantNode.id);
    expect(regen.assistantNode.summarySnapshot.content).toBe('【摘要2】含第二轮');
  });

  it('forks a second root branch when editAndBranch targets Turn 1 user node (parentId: null)', async () => {
    const transport: LlmTransport = {
      async *streamChat(req) {
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        yield { contentDelta: `开局分支：${lastUser}`, finishReason: 'stop' };
      },
    };
    let seq = 0;
    const harness = createFictionHarness({
      transport,
      now: () => 1700000000000 + seq * 1000,
      createId: () => `r1-${++seq}`,
    });

    const story = harness.createStory({ title: '首轮分叉测试' });
    const t1 = await harness.runTurn(story, '原始开局选择A', testConfig);
    expect(t1.userNode.parentId).toBeNull();

    const forked = await harness.editAndBranch(t1.story, t1.userNode.id, '改走开局选择B', testConfig);
    expect(forked.userNode.parentId).toBeNull();
    expect(forked.story.rootNodeIds).toEqual([t1.userNode.id, forked.userNode.id]);

    const rootSiblings = getSiblingBranchInfo(forked.story, forked.userNode.id);
    expect(rootSiblings.total).toBe(2);
    expect(rootSiblings.currentIndex).toBe(1);
    expect(rootSiblings.prevSiblingId).toBe(t1.userNode.id);
    expect(getActiveBranchNodes(forked.story).map((n) => n.content)).toEqual([
      '改走开局选择B',
      '开局分支：改走开局选择B',
    ]);
  });
});
