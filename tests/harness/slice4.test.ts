import { describe, expect, it } from 'vitest';
import {
  assembleThreeZoneContext,
  createFictionHarness,
  parseAssistantMessage,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

describe('Slice 4: Three-Zone Context & incremental Plot Summary compression', () => {
  it('assembles Zone 1 (rawScript + blueprint) -> Zone 2 (Plot Summary) -> Zone 3 (recent window without reasoning)', async () => {
    const captured: LlmStreamRequest[] = [];
    let replyIndex = 0;

    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sysMsg = req.messages[0]?.content ?? '';
        if (sysMsg.includes('剧情摘要压缩')) {
          yield { reasoningDelta: '压缩推理不应入摘要', contentDelta: '【摘要】主角初入宗门并结识师兄。', finishReason: 'stop' };
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
    });

    // Turn 1 (2 nodes: within recentMaxNodes=2)
    const t1 = await harness.runTurn(story, '第一轮行动', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'k',
      memoryOnly: true,
    });
    story = t1.story;
    expect(t1.assistantNode.summarySnapshot.content).toBe('');

    // Turn 2 (4 uncovered nodes > recentMaxNodes=2 -> triggers incremental Plot Summary folding Turn 1)
    const t2 = await harness.runTurn(story, '第二轮行动', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'k',
      memoryOnly: true,
    });
    story = t2.story;

    // Verify summary call NEVER received reasoningContent
    const summaryReq = captured.find((r) => (r.messages[0]?.content ?? '').includes('剧情摘要压缩'));
    expect(summaryReq).toBeDefined();
    expect(summaryReq!.messages.some((m) => m.content.includes('秘密思考'))).toBe(false);

    // Verify assistantNode froze updated summarySnapshot pointing to Turn 1's assistant node
    expect(t2.assistantNode.summarySnapshot.content).toBe('【摘要】主角初入宗门并结识师兄。');
    expect(t2.assistantNode.summarySnapshot.coveredUpToNodeId).toBe(t1.assistantNode.id);
    expect(t2.assistantNode.summarySnapshot.summarizedTurnCount).toBe(2);

    // Verify Turn 1 node's own snapshot stayed untouched (empty)
    expect(story.nodes[t1.assistantNode.id]?.summarySnapshot.content).toBe('');

    // Verify Three-Zone assembly for Turn 3
    const assembled = assembleThreeZoneContext(story, story.activeLeafNodeId, '第三轮行动', {
      recentMaxNodes: 2,
      recentMaxChars: 4000,
    });

    expect(assembled.messages[0].role).toBe('system');
    expect(assembled.messages[0].content).toContain('【原始设定】绝不违背的铁律。');
    expect(assembled.messages[1].role).toBe('system');
    expect(assembled.messages[1].content).toContain('【摘要】主角初入宗门并结识师兄。');
    // Turn 1 was summarized so only Turn 2 + new user input remain in Zone 3
    const zone3Contents = assembled.messages.slice(2).map((m) => m.content);
    expect(zone3Contents).toEqual(['第二轮行动', '第2轮剧情回复内容。', '第三轮行动']);
    expect(zone3Contents.join('\n')).not.toContain('秘密思考');
  });
});

describe('Slice 4: Pseudo-code HUD panel & A/B/C/D choice parsing', () => {
  it('separates fenced pseudo-code panels and extracts trailing A/B/C/D choices', () => {
    const reply = [
      '你推开议事厅大门，众人的目光齐刷刷投来。',
      '```text',
      '【当前状态】',
      '时间：Day 1 夜 | 体力：85/100',
      '```',
      '请选择你的下一步行动：',
      'A. 礼貌致意并入座',
      'B、冷淡扫视众人后落座',
      'C) 转身退出门外',
      'D: 保持沉默静观其变',
    ].join('\n');

    const parsed = parseAssistantMessage(reply);
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[0]).toEqual({
      type: 'text',
      content: '你推开议事厅大门，众人的目光齐刷刷投来。',
    });
    expect(parsed.segments[1]).toEqual({
      type: 'codeblock',
      lang: 'text',
      code: '【当前状态】\n时间：Day 1 夜 | 体力：85/100',
    });
    expect(parsed.choices).toEqual([
      { key: 'A', label: '礼貌致意并入座', fullText: 'A. 礼貌致意并入座' },
      { key: 'B', label: '冷淡扫视众人后落座', fullText: 'B、冷淡扫视众人后落座' },
      { key: 'C', label: '转身退出门外', fullText: 'C) 转身退出门外' },
      { key: 'D', label: '保持沉默静观其变', fullText: 'D: 保持沉默静观其变' },
    ]);
  });
});
