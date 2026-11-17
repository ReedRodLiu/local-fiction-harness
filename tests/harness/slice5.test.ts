import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getBranchTreeSummary,
  getSiblingBranchInfo,
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
  it('rolls back Plot Summary when editing/branching from an earlier node and isolates Branch B from Branch A', async () => {
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        if (sys.includes('剧情摘要压缩')) {
          if (lastUser.includes('分支A独有事件')) {
            yield { contentDelta: '【分支A摘要】玩家选择加入黑市联盟。', finishReason: 'stop' };
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
    // Turn 1 (shared fork base)
    const t1 = await harness.runTurn(initial, '来到十字路口', testConfig);
    // Turn 2 & Turn 3 on Branch A -> folds Turn 2's Branch A event into Branch A's Plot Summary
    const t2A = await harness.runTurn(t1.story, '分支A独有事件：潜入黑市', testConfig);
    const t3A = await harness.runTurn(t2A.story, '继续推进黑市任务', testConfig);
    expect(getActiveSummarySnapshot(t3A.story).content).toBe('【分支A摘要】玩家选择加入黑市联盟。');

    // Edit & resend Turn 2 user node to spawn Branch B from Turn 1 assistant node
    const branchB = await harness.editAndBranch(
      t3A.story,
      t2A.userNode.id,
      '分支B独有事件：前往官府报案',
      testConfig,
    );

    const turnReqForB = captured.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes('分支B独有事件')),
    );
    expect(turnReqForB).toBeDefined();
    const joinedMessagesB = turnReqForB!.messages.map((m) => m.content).join('\n');
    expect(joinedMessagesB).not.toContain('分支A摘要');
    expect(joinedMessagesB).not.toContain('潜入黑市');

    // Branch B's summary rolled back to Turn 1's snapshot (then folded Turn 1 only, NOT Branch A)
    expect(getActiveSummarySnapshot(branchB.story).content).toBe('【通用摘要】玩家来到十字路口。');

    // Sibling inspection at fork point (Turn 2 user nodes)
    const siblings = getSiblingBranchInfo(branchB.story, branchB.userNode.id);
    expect(siblings.total).toBe(2);
    expect(siblings.currentIndex).toBe(1);

    // Switch back to Branch A via sibling user node -> restores Branch A's leaf (t3A) and summary!
    const switchedToA = await harness.switchBranch(branchB.story, t2A.userNode.id);
    expect(switchedToA.activeLeafNodeId).toBe(t3A.assistantNode.id);
    expect(getActiveSummarySnapshot(switchedToA).content).toBe('【分支A摘要】玩家选择加入黑市联盟。');
    expect(getActiveBranchNodes(switchedToA).map((n) => n.content)).toContain('继续推进黑市任务');

    // Rewind directly to Turn 1 assistant node -> immediately rolls back active summary to empty snapshot
    const rewound = await harness.rewindToNode(switchedToA, t1.assistantNode.id);
    expect(rewound.activeLeafNodeId).toBe(t1.assistantNode.id);
    expect(getActiveSummarySnapshot(rewound).content).toBe('');
    expect(getBranchTreeSummary(rewound)).toHaveLength(2);
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
});
