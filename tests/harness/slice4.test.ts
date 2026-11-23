import { describe, expect, it } from 'vitest';
import {
  assembleThreeZoneContext,
  createFictionHarness,
  extractAssistantChoices,
  parseAssistantMessage,
  type LlmStreamRequest,
  type LlmTransport,
  type TurnNode,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

describe('Slice 4: Three-Zone Context & incremental Plot Summary compression', () => {
  it('assembles Zone 1 (rawScript + blueprint + anti-OOC) -> Zone 2 (Plot Summary) -> Zone 3 (recent window without reasoning)', async () => {
    const captured: LlmStreamRequest[] = [];
    let replyIndex = 0;

    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sysMsg = req.messages[0]?.content ?? '';
        if (sysMsg.includes('剧情摘要压缩')) {
          const prevPrompt = req.messages[1]?.content ?? '';
          if (prevPrompt.includes('主角初入宗门')) {
            yield { contentDelta: '【增量摘要】主角结识师兄并赢得内门比试。', finishReason: 'stop' };
          } else {
            yield {
              reasoningDelta: '压缩推理不应入摘要',
              contentDelta: '【摘要】主角初入宗门并结识师兄。',
              finishReason: 'stop',
            };
          }
          return;
        }
        replyIndex += 1;
        yield {
          reasoningDelta: `秘密思考#${replyIndex}`,
          contentDelta: `第${replyIndex}轮剧情回复内容。`,
          finishReason: 'stop',
        };
      },
    };

    let seq = 0;
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
      now: () => 1700000000000 + seq * 1000,
      createId: () => `n-${++seq}`,
    });

    let story = harness.createStory({
      title: '仙门测试',
      rawScript: '【原始设定】绝不违背的铁律。',
      blueprint: {
        title: '仙门测试',
        worldRules: ['灵根决定资质'],
        protagonist: '沈清秋',
        npcs: [],
        taboos: ['禁止私下窃听'],
        openingHook: '山门大开',
        extractionStatus: 'complete',
      },
    });

    // Turn 1 (2 nodes: within recentMaxNodes=2)
    const t1 = await harness.runTurn(story, '第一轮行动', testConfig);
    story = t1.story;
    expect(t1.assistantNode.summarySnapshot.content).toBe('');

    // Turn 2 -> folds Turn 1 into summary
    const t2 = await harness.runTurn(story, '第二轮行动', testConfig);
    story = t2.story;

    const summaryReq = captured.find((r) => (r.messages[0]?.content ?? '').includes('剧情摘要压缩'));
    expect(summaryReq).toBeDefined();
    expect(summaryReq!.messages.some((m) => m.content.includes('秘密思考'))).toBe(false);

    expect(t2.assistantNode.summarySnapshot.content).toBe('【摘要】主角初入宗门并结识师兄。');
    expect(t2.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t1.assistantNode.id);
    expect(t2.assistantNode.summarySnapshot.summarizedTurnCount).toBe(2);
    expect(story.nodes[t1.assistantNode.id]?.summarySnapshot.content).toBe('');

    // Turn 3 -> incrementally merges Turn 2 into the existing non-empty summary
    const t3 = await harness.runTurn(story, '第三轮行动', testConfig);
    story = t3.story;
    expect(t3.assistantNode.summarySnapshot.content).toBe('【增量摘要】主角结识师兄并赢得内门比试。');
    expect(t3.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t2.assistantNode.id);
    expect(t3.assistantNode.summarySnapshot.summarizedTurnCount).toBe(4);

    // Verify Three-Zone assembly for Turn 4
    const assembled = harness.assembleContext(story, story.activeLeafNodeId, '第四轮行动');
    expect(assembled.messages[0].role).toBe('system');
    const systemPrompt = assembled.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemPrompt).toContain('【原始设定】绝不违背的铁律。');
    expect(systemPrompt).toContain('灵根决定资质');
    expect(systemPrompt).toContain('禁止私下窃听');
    expect(systemPrompt).toContain('保持角色与设定一致');
    expect(systemPrompt).toContain('【增量摘要】主角结识师兄并赢得内门比试。');
    const zone3Contents = assembled.messages.filter((message) => message.role !== 'system').map((m) => m.content);
    expect(zone3Contents).toEqual(['第三轮行动', '第3轮剧情回复内容。', '第四轮行动']);
    expect(zone3Contents.join('\n')).not.toContain('秘密思考');
  });

  it('triggers incremental compression when recentMaxChars is exceeded even under recentMaxNodes', async () => {
    const longContent = '长剧情'.repeat(30); // 90 chars
    const transport: LlmTransport = {
      async *streamChat(req) {
        if ((req.messages[0]?.content ?? '').includes('剧情摘要压缩')) {
          yield { contentDelta: '字符超限触发压缩摘要', finishReason: 'stop' };
          return;
        }
        yield { contentDelta: longContent, finishReason: 'stop' };
      },
    };

    let seq = 0;
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 10, recentMaxChars: 120 },
      createId: () => `c-${++seq}`,
    });

    const t1 = await harness.runTurn(harness.createStory({ title: '字符预算测试' }), '甲', testConfig);
    const t2 = await harness.runTurn(t1.story, '乙', testConfig);
    expect(t2.assistantNode.summarySnapshot.content).toBe('字符超限触发压缩摘要');
    expect(t2.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t1.assistantNode.id);

    const ctx = assembleThreeZoneContext(t2.story, t2.story.activeLeafNodeId, '丙', {
      recentMaxNodes: 10,
      recentMaxChars: 120,
    });
    expect(ctx.metrics.totalEstimatedTokens).toBeGreaterThan(0);
  });

  it('propagates AbortError during summary compression instead of silently swallowing cancellation', async () => {
    const controller = new AbortController();
    const transport: LlmTransport = {
      async *streamChat(req) {
        if ((req.messages[0]?.content ?? '').includes('剧情摘要压缩')) {
          controller.abort();
          yield { contentDelta: '不会提交', finishReason: 'stop' };
          return;
        }
        yield { contentDelta: '足够长'.repeat(30), finishReason: 'stop' };
      },
    };

    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 40 },
    });
    const t1 = await harness.runTurn(harness.createStory({ title: '中止测试' }), '一', testConfig);

    await expect(
      harness.runTurn(t1.story, '二', testConfig, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('trims recent window in user+assistant pairs for pendingUserChars without leaving an orphaned assistant after system', async () => {
    let turn = 0;
    const transport: LlmTransport = {
      async *streamChat() {
        turn += 1;
        yield {
          contentDelta: turn === 1 ? 'A'.repeat(40) : 'B'.repeat(20),
          finishReason: 'stop',
        };
      },
    };
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 8, recentMaxChars: 500 },
    });

    const t1 = await harness.runTurn(harness.createStory({ title: '配对裁剪' }), 'U'.repeat(40), testConfig);
    const t2 = await harness.runTurn(t1.story, 'V'.repeat(20), testConfig);

    // 40+40+20+20 = 120; pending 20 -> 140 > 100. Dropping only U(40) would leave orphaned A(40) right after system!
    const ctx = assembleThreeZoneContext(t2.story, t2.story.activeLeafNodeId, 'W'.repeat(20), {
      recentMaxNodes: 8,
      recentMaxChars: 100,
    });
    const nonSystem = ctx.messages.filter((m) => m.role !== 'system');
    expect(nonSystem[0]?.role).toBe('user');
    expect(nonSystem.map((m) => m.content)).toEqual(['V'.repeat(20), 'B'.repeat(20), 'W'.repeat(20)]);
    expect(ctx.metrics.recentNodeCount).toBe(2);

    // Even when pending input alone exceeds recentMaxChars, keep at least MIN_RECENT_NODES_PER_TURN (2)
    const minKept = assembleThreeZoneContext(t2.story, t2.story.activeLeafNodeId, 'Z'.repeat(200), {
      recentMaxNodes: 8,
      recentMaxChars: 100,
    });
    expect(minKept.metrics.recentNodeCount).toBe(2);
    expect(minKept.messages.filter((m) => m.role !== 'system')[0]?.role).toBe('user');
  });


});

describe('Slice 4: Pseudo-code HUD panel & A/B/C/D or numbered choice parsing', () => {
  it('separates fenced pseudo-code panels and extracts trailing A/B/C/D and numbered choices', () => {
    const reply = [
      '你推开议事厅大门，众人的目光齐刷刷投来。',
      '```text',
      '【当前状态】',
      '时间：Day 1 夜 | 体力：85/100',
      '```',
      '请选择你的下一步行动：',
      '```lfh-choices',
      'A. 礼貌致意并入座',
      'B、冷淡扫视众人后落座',
      'C) 转身退出门外',
      'D: 保持沉默静观其变',
      '```',
    ].join('\n');

    const parsed = parseAssistantMessage(reply);
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[0]).toEqual({
      type: 'text',
      content: '你推开议事厅大门，众人的目光齐刷刷投来。',
    });
    expect(parsed.segments[1]).toEqual({
      type: 'codeblock',
      code: '【当前状态】\n时间：Day 1 夜 | 体力：85/100',
    });
    expect(parsed.choices).toEqual([
      { key: 'A', label: '礼貌致意并入座', fullText: 'A. 礼貌致意并入座' },
      { key: 'B', label: '冷淡扫视众人后落座', fullText: 'B、冷淡扫视众人后落座' },
      { key: 'C', label: '转身退出门外', fullText: 'C) 转身退出门外' },
      { key: 'D', label: '保持沉默静观其变', fullText: 'D: 保持沉默静观其变' },
    ]);

    expect(parseAssistantMessage('1. 物品\n2. 笔记').choices).toEqual([]);
    const numbered = parseAssistantMessage('```lfh-choices\n1. 调查书桌\n2. 询问管家\n3. 推窗观察\n4. 离开走廊\n5. 直接休息\n```');
    expect(numbered.choices).toHaveLength(5);
    expect(numbered.choices[4]).toEqual({ key: '5', label: '直接休息', fullText: '5. 直接休息' });
  });

  it('extracts fenced lfh-choices with 4+ backticks and trailing spaces on the opening line', () => {
    const reply = [
      '夜色渐深。',
      '',
      '````lfh-choices   \t',
      'A. 推门进入',
      'B. 留在门外',
      '````',
    ].join('\n');

    const extracted = extractAssistantChoices(reply);
    expect(extracted.choices).toEqual([
      { key: 'A', label: '推门进入', fullText: 'A. 推门进入' },
      { key: 'B', label: '留在门外', fullText: 'B. 留在门外' },
    ]);
    expect(extracted.displayContent).toBe('夜色渐深。\nA. 推门进入\nB. 留在门外');
  });

  it('extracts unclosed terminal fenced lfh-choices while ignoring non-terminal fenced blocks', () => {
    const unclosed = [
      '走廊尽头传来脚步声。',
      '',
      '```lfh-choices  ',
      'A. 躲进衣柜',
      'B. 迎面走去',
      '',
    ].join('\n');

    const extracted = extractAssistantChoices(unclosed);
    expect(extracted.choices).toEqual([
      { key: 'A', label: '躲进衣柜', fullText: 'A. 躲进衣柜' },
      { key: 'B', label: '迎面走去', fullText: 'B. 迎面走去' },
    ]);
    expect(extracted.displayContent).toBe('走廊尽头传来脚步声。\nA. 躲进衣柜\nB. 迎面走去');

    const nonTerminal = [
      '示例格式如下：',
      '```lfh-choices',
      'A. 示例一',
      'B. 示例二',
      '```',
      '以上只是说明文字，并非本轮行动选项。',
    ].join('\n');

    expect(extractAssistantChoices(nonTerminal)).toEqual({
      displayContent: nonTerminal,
      choices: [],
    });
  });

  it('extracts bare lfh-choices blocks without backticks at the end of a reply', () => {
    const bare = [
      '雨点敲打着窗棂。',
      '',
      'lfh-choices   ',
      'A. 检查窗外',
      'B. 锁上房门',
      'C. 点亮蜡烛',
    ].join('\n');

    const extracted = extractAssistantChoices(bare);
    expect(extracted.choices).toEqual([
      { key: 'A', label: '检查窗外', fullText: 'A. 检查窗外' },
      { key: 'B', label: '锁上房门', fullText: 'B. 锁上房门' },
      { key: 'C', label: '点亮蜡烛', fullText: 'C. 点亮蜡烛' },
    ]);
    expect(extracted.displayContent).toBe('雨点敲打着窗棂。\nA. 检查窗外\nB. 锁上房门\nC. 点亮蜡烛');

    const spacedBare = [
      'lfh-choices',
      '',
      '1. 查看书架',
      '',
      '2. 离开书房',
      '',
    ].join('\n');

    const spacedExtracted = extractAssistantChoices(spacedBare);
    expect(spacedExtracted.choices).toEqual([
      { key: '1', label: '查看书架', fullText: '1. 查看书架' },
      { key: '2', label: '离开书房', fullText: '2. 离开书房' },
    ]);
    expect(spacedExtracted.displayContent).toBe('1. 查看书架\n2. 离开书房');
  });

  it('does not swallow unrelated trailing prose after bare lfh-choices or match plain markdown lists', () => {
    const bareWithTrailingProse = [
      '你推开大门。',
      '',
      'lfh-choices',
      'A. 走进大厅',
      'B. 转身离开',
      '',
      '大厅的吊灯忽然熄灭，四周陷入一片漆黑。',
      '',
      '远处传来低沉的钟声，仿佛在警告来访者。',
    ].join('\n');

    expect(extractAssistantChoices(bareWithTrailingProse)).toEqual({
      displayContent: bareWithTrailingProse,
      choices: [],
    });

    const insideCodeFence = [
      '参考示例：',
      '```markdown',
      'lfh-choices',
      'A. 选项一',
      'B. 选项二',
      '```',
    ].join('\n');

    expect(extractAssistantChoices(insideCodeFence)).toEqual({
      displayContent: insideCodeFence,
      choices: [],
    });

    expect(extractAssistantChoices('随身物品：\n- 火柴\n- 铜钥匙')).toEqual({
      displayContent: '随身物品：\n- 火柴\n- 铜钥匙',
      choices: [],
    });

    expect(extractAssistantChoices('```lfh-choices\nA. 唯一选项\n```').choices).toEqual([]);
  });
});
