import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  getActiveSummarySnapshot,
  importStoryBackup,
  projectStoryTreeSpine,
  getForkSiblingBranches,
  computeActiveReviewState,
  type LlmStreamRequest,
  type LlmTransport,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

function makeEmptySnapshot() {
  return { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };
}

describe('Slice 1 (#19): Focused vertical Story Tree, lazy branch cues, Story Review & Node Diagnostics', () => {
  it('loads legacy Story JSON backups without branchNames/diagnostics and round-trips new metadata', () => {
    const legacyStory: Story = {
      id: 'legacy-1',
      title: '旧版存档',
      rawScript: '规则：保持人设。',
      blueprint: {
        title: '旧版存档',
        worldRules: ['规则一'],
        protagonist: '林晚',
        npcs: [],
        taboos: [],
        openingHook: '雨夜敲门',
        extractionStatus: 'complete',
      },
      nodes: {
        u1: {
          id: 'u1',
          parentId: null,
          role: 'user',
          content: '推开大门',
          createdAt: 1000,
          summarySnapshot: makeEmptySnapshot(),
        },
        a1: {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          content: '门后站着管家。',
          createdAt: 2000,
          summarySnapshot: makeEmptySnapshot(),
        },
      },
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a1',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const legacyJson = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 3000,
      story: legacyStory,
    });

    const restoredLegacy = importStoryBackup(legacyJson, []);
    expect(restoredLegacy.id).toBe('legacy-1');
    expect(restoredLegacy.nodes.a1.content).toBe('门后站着管家。');
    expect(restoredLegacy.branchNames).toBeUndefined();

    const enhancedStory: Story = {
      ...restoredLegacy,
      branchNames: { u1: '正门路线' },
      branchSummaries: { u1: '主角从正门进入庄园。' },
      nodes: {
        ...restoredLegacy.nodes,
        a1: {
          ...restoredLegacy.nodes.a1,
          diagnostics: { sourceStatus: 'CONTENT_FILTER', contentRisk: true },
        },
      },
    };

    const roundTripped = importStoryBackup(exportStoryBackup(enhancedStory), []);
    expect(roundTripped.branchNames).toEqual({ u1: '正门路线' });
    expect(roundTripped.branchSummaries).toEqual({ u1: '主角从正门进入庄园。' });
    expect(roundTripped.nodes.a1.diagnostics).toEqual({
      sourceStatus: 'CONTENT_FILTER',
      contentRisk: true,
    });
  });

  it('projects a focused spine collapsing linear spans with fork badges, zero LLM calls on unopened branches, and lazy local cues', async () => {
    let llmCallCount = 0;
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        llmCallCount += 1;
        captured.push(req);
        yield { contentDelta: '提炼梗概：主线前往书房查账。', finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    const harness = createFictionHarness({ transport, storage });

    // Construct a tree with 2 forks:
    // Turns 1-3 linear (u1->a1->u2->a2->u3->a3) -> Fork 1 at a3:
    //   Branch A: u4A->a4A->u5A->a5A -> Fork 2 at u5A (regenerated replies: a5A, a5A_alt)
    //   Branch B: u4B->a4B (mutually exclusive event Y)
    const nodes: Record<string, TurnNode> = {
      u1: { id: 'u1', parentId: null, role: 'user', content: '第一轮入府', createdAt: 1, summarySnapshot: makeEmptySnapshot() },
      a1: { id: 'a1', parentId: 'u1', role: 'assistant', content: '府门开启。', createdAt: 2, summarySnapshot: makeEmptySnapshot() },
      u2: { id: 'u2', parentId: 'a1', role: 'user', content: '第二轮问安', createdAt: 3, summarySnapshot: makeEmptySnapshot() },
      a2: { id: 'a2', parentId: 'u2', role: 'assistant', content: '老夫人点头。', createdAt: 4, summarySnapshot: makeEmptySnapshot() },
      u3: { id: 'u3', parentId: 'a2', role: 'user', content: '第三轮巡查', createdAt: 5, summarySnapshot: makeEmptySnapshot() },
      a3: { id: 'a3', parentId: 'u3', role: 'assistant', content: '夜色已深，面临抉择。', createdAt: 6, summarySnapshot: makeEmptySnapshot() },
      u4A: { id: 'u4A', parentId: 'a3', role: 'user', content: '走支线A：潜入东厢房', createdAt: 7, summarySnapshot: makeEmptySnapshot() },
      a4A: {
        id: 'a4A',
        parentId: 'u4A',
        role: 'assistant',
        content: '第4章 东厢暗格\n时间：Day 2 深夜\n地点：东厢书房\n发现事件X：密室账簿。\n```text\n[好感度: 80 | 体力: 70]\n```',
        createdAt: 8,
        summarySnapshot: makeEmptySnapshot(),
      },
      u5A: { id: 'u5A', parentId: 'a4A', role: 'user', content: '翻看账簿最后一页', createdAt: 9, summarySnapshot: makeEmptySnapshot() },
      a5A: { id: 'a5A', parentId: 'u5A', role: 'assistant', content: '账簿揭露了管家秘密。', createdAt: 10, summarySnapshot: makeEmptySnapshot() },
      a5A_alt: {
        id: 'a5A_alt',
        parentId: 'u5A',
        role: 'assistant',
        content: '第4章 警报骤响\n地点：偏院回廊\n账簿被锁住，门外脚步逼近。',
        createdAt: 11,
        diagnostics: { sourceStatus: 'TIMEOUT', contentRisk: true },
        summarySnapshot: makeEmptySnapshot(),
      },
      u4B: { id: 'u4B', parentId: 'a3', role: 'user', content: '走支线B：前往西花厅', createdAt: 12, summarySnapshot: makeEmptySnapshot() },
      a4B: {
        id: 'a4B',
        parentId: 'u4B',
        role: 'assistant',
        content: '第4章 花厅夜宴\n时间：Day 2 子时\n地点：西花厅\n触发事件Y：宾客失踪案。\n```text\n[声望: 45]\n```',
        createdAt: 13,
        diagnostics: { sourceStatus: 'CONTENT_FILTER' },
        summarySnapshot: makeEmptySnapshot(),
      },
    };

    const story: Story = {
      id: 'tree-1',
      title: '双分叉测试',
      rawScript: '豪门悬疑规则',
      blueprint: {
        title: '双分叉测试',
        worldRules: ['不可泄密'],
        protagonist: '沈小姐',
        npcs: [],
        taboos: [],
        openingHook: '夜幕降临',
        extractionStatus: 'complete',
      },
      nodes,
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a5A',
      createdAt: 1,
      updatedAt: 13,
    };
    await harness.saveStory(story);

    // 1. Spine projection collapses turns 1-3, shows Fork 1 (⑂ 2), then turn 4-5 up to Fork 2 (⑂ 2), then active leaf
    const spine = projectStoryTreeSpine(story);
    expect(llmCallCount).toBe(0);
    expect(spine.forkCount).toBe(2);
    expect(spine.totalActiveTurns).toBe(5);
    expect(spine.items.map((item) => item.kind)).toEqual(['span', 'fork', 'span', 'fork', 'span']);

    const firstSpan = spine.items[0];
    if (firstSpan.kind !== 'span') throw new Error('Expected first item to be span');
    expect(firstSpan.startTurn).toBe(1);
    expect(firstSpan.endTurn).toBe(3);
    expect(firstSpan.nodeCount).toBe(6);

    const firstFork = spine.items[1];
    if (firstFork.kind !== 'fork') throw new Error('Expected second item to be fork');
    expect(firstFork.parentNodeId).toBe('a3');
    expect(firstFork.branchCount).toBe(2);
    expect(firstFork.activeChildId).toBe('u4A');

    const secondFork = spine.items[3];
    if (secondFork.kind !== 'fork') throw new Error('Expected fourth item to be fork');
    expect(secondFork.parentNodeId).toBe('u5A');
    expect(secondFork.branchCount).toBe(2);

    // 2. Lazily expand Fork 1 -> zero-cost cues + diagnostics without calling LLM
    const fork1Siblings = getForkSiblingBranches(story, 'a3');
    expect(llmCallCount).toBe(0);
    expect(fork1Siblings).toHaveLength(2);
    expect(fork1Siblings[0].entryNodeId).toBe('u4A');
    expect(fork1Siblings[0].isActive).toBe(true);
    expect(fork1Siblings[0].cues.join(' ')).toContain('东厢书房');
    expect(fork1Siblings[1].entryNodeId).toBe('u4B');
    expect(fork1Siblings[1].isActive).toBe(false);
    expect(fork1Siblings[1].cues.join(' ')).toContain('西花厅');
    expect(fork1Siblings[1].cues.join(' ')).toContain('声望: 45');
    expect(fork1Siblings[1].diagnostics).toEqual(['CONTENT_FILTER']);

    // 3. Manual branch rename persists and survives backup round-trip
    const renamed = await harness.renameBranch(story, 'u4B', '花厅失踪线');
    const siblingsAfterRename = getForkSiblingBranches(renamed, 'a3');
    expect(siblingsAfterRename[1].label).toBe('花厅失踪线');
    const reloaded = await storage.getStory('tree-1');
    expect(reloaded?.branchNames?.u4B).toBe('花厅失踪线');

    // 4. On-demand AI gist extraction works only when explicitly requested and strips diagnostics
    const withGist = await harness.extractBranchGist(renamed, 'u4B', testConfig);
    expect(llmCallCount).toBe(1);
    expect(withGist.branchSummaries?.u4B).toBe('提炼梗概：主线前往书房查账。');
    const gistPrompt = captured[0].messages.map((m) => m.content).join('\n');
    expect(gistPrompt).not.toContain('CONTENT_FILTER');
    expect(gistPrompt).not.toContain('CONTENT_RISK');
  });

  it('isolates mutually exclusive branches (Event X vs Event Y), excludes Node Diagnostics from LLM, and lazily summarizes over-window branches', async () => {
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        const body = req.messages.map((m) => m.content).join('\n');
        if (sys.includes('剧情摘要压缩')) {
          if (body.includes('事件X')) {
            yield { contentDelta: '【支线A摘要】主角已取得事件X证物。', finishReason: 'stop' };
          } else if (body.includes('事件Y')) {
            yield { contentDelta: '【支线B摘要】主角正在调查事件Y谜案。', finishReason: 'stop' };
          } else {
            yield { contentDelta: '【通用摘要】开局入府。', finishReason: 'stop' };
          }
          return;
        }
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        yield { contentDelta: `续写回应：${lastUser}`, finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harness = createFictionHarness({
      transport,
      storage,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
      now: () => 1700000000000 + ++seq * 1000,
      createId: () => `iso-${seq}`,
    });

    // Build an imported-like multi-branch story where Branch A and Branch B are both > recentMaxNodes (4 nodes each after root)
    // and Branch B has NOT been compressed yet (summarySnapshot empty) and carries Node Diagnostics.
    const nodes: Record<string, TurnNode> = {
      u1: { id: 'u1', parentId: null, role: 'user', content: '共同开局', createdAt: 1, summarySnapshot: makeEmptySnapshot() },
      a1: { id: 'a1', parentId: 'u1', role: 'assistant', content: '抵达分叉路口。', createdAt: 2, summarySnapshot: makeEmptySnapshot() },
      // Branch A (compressed)
      u2A: { id: 'u2A', parentId: 'a1', role: 'user', content: '支线A触发事件X', createdAt: 3, summarySnapshot: makeEmptySnapshot() },
      a2A: {
        id: 'a2A',
        parentId: 'u2A',
        role: 'assistant',
        content: '事件X已完成：拿到银钥匙。',
        reasoningContent: '秘密推理A',
        diagnostics: { sourceStatus: 'INCOMPLETE', contentRisk: true },
        createdAt: 4,
        summarySnapshot: makeEmptySnapshot(),
      },
      u3A: { id: 'u3A', parentId: 'a2A', role: 'user', content: '支线A第三轮', createdAt: 5, summarySnapshot: makeEmptySnapshot() },
      a3A: {
        id: 'a3A',
        parentId: 'u3A',
        role: 'assistant',
        content: '支线A推进到密室门前。',
        createdAt: 6,
        summarySnapshot: {
          content: '【支线A摘要】主角已取得事件X证物。',
          coveredUpToNodeId: 'a2A',
          summarizedTurnCount: 4,
        },
      },
      // Branch B (uncompressed over-window: 6 nodes total, recentMaxNodes = 2)
      u2B: { id: 'u2B', parentId: 'a1', role: 'user', content: '支线B触发事件Y', createdAt: 7, summarySnapshot: makeEmptySnapshot() },
      a2B: {
        id: 'a2B',
        parentId: 'u2B',
        role: 'assistant',
        content: '事件Y已发生：宾客中毒。',
        diagnostics: { sourceStatus: 'CONTENT_FILTER', contentRisk: true },
        createdAt: 8,
        summarySnapshot: makeEmptySnapshot(),
      },
      u3B: { id: 'u3B', parentId: 'a2B', role: 'user', content: '支线B第三轮追查', createdAt: 9, summarySnapshot: makeEmptySnapshot() },
      a3B: { id: 'a3B', parentId: 'u3B', role: 'assistant', content: '在药柜找到毒药瓶。', createdAt: 10, summarySnapshot: makeEmptySnapshot() },
    };

    const story: Story = {
      id: 'iso-story',
      title: '互斥隔离测试',
      rawScript: '严格隔离双线记忆',
      blueprint: {
        title: '互斥隔离测试',
        worldRules: ['不得串线'],
        protagonist: '调查员',
        npcs: [],
        taboos: [],
        openingHook: '进入大宅',
        extractionStatus: 'complete',
      },
      nodes,
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a3A',
      createdAt: 1,
      updatedAt: 10,
    };
    await harness.saveStory(story);

    // 1. Continue on Branch A -> context & Story Review have Event X, no Event Y, and no diagnostics strings
    const turnA = await harness.runTurn(story, '用银钥匙开门', testConfig);
    const turnAReq = captured.find((r) => r.messages.some((m) => m.content === '用银钥匙开门'));
    const turnAPrompt = turnAReq!.messages.map((m) => m.content).join('\n');
    expect(turnAPrompt).toContain('事件X');
    expect(turnAPrompt).not.toContain('事件Y');
    expect(turnAPrompt).not.toContain('INCOMPLETE');
    expect(turnAPrompt).not.toContain('CONTENT_RISK');
    expect(turnAPrompt).not.toContain('秘密推理A');

    // 2. Switch to Branch B without config -> 0 LLM calls, Story Review flags pending compression
    const prevCaptureLen = captured.length;
    const switchedBNoKey = await harness.switchBranch(turnA.story, 'u2B');
    expect(captured.length).toBe(prevCaptureLen);
    expect(switchedBNoKey.activeLeafNodeId).toBe('a3B');
    const reviewPending = computeActiveReviewState(switchedBNoKey, { recentMaxNodes: 2, recentMaxChars: 4000 });
    expect(reviewPending.needsSummaryCompression).toBe(true);
    expect(reviewPending.totalTurns).toBe(3);

    // 3. Lazy summary compression on Branch B freezes Plot Summary onto a3B and isolates Event X out
    const summarizedB = await harness.ensureActiveBranchSummary(switchedBNoKey, testConfig);
    const snapB = getActiveSummarySnapshot(summarizedB);
    expect(snapB.content).toBe('【支线B摘要】主角正在调查事件Y谜案。');
    expect(snapB.coveredUpToNodeId).toBe('a2B');
    expect(snapB.summarizedTurnCount).toBe(4);
    expect(snapB.content).not.toContain('事件X');

    const reviewReady = computeActiveReviewState(summarizedB, { recentMaxNodes: 2, recentMaxChars: 4000 });
    expect(reviewReady.needsSummaryCompression).toBe(false);
    expect(reviewReady.coveredTurnRange).toEqual({ startTurn: 1, endTurn: 2 });
    expect(reviewReady.recentTurnRange).toEqual({ startTurn: 3, endTurn: 3 });

    // 4. Continue on Branch B -> context contains Event Y, never Event X, never CONTENT_FILTER
    const turnB = await harness.runTurn(summarizedB, '化验毒药瓶', testConfig);
    const turnBReq = captured.find((r) => r.messages.some((m) => m.content === '化验毒药瓶'));
    const turnBPrompt = turnBReq!.messages.map((m) => m.content).join('\n');
    expect(turnBPrompt).toContain('事件Y');
    expect(turnBPrompt).not.toContain('事件X');
    expect(turnBPrompt).not.toContain('CONTENT_FILTER');
    expect(turnBPrompt).not.toContain('CONTENT_RISK');

    // 5. Switch back to Branch A -> Story Review restores Branch A's summary cleanly
    const switchedBackA = await harness.switchBranch(turnB.story, 'u2A');
    expect(getActiveSummarySnapshot(switchedBackA).content).toContain('事件X');
    expect(getActiveSummarySnapshot(switchedBackA).content).not.toContain('事件Y');
  });
});
