import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  documentVersion,
  editStoryDocument,
  getActiveSummarySnapshot,
  importDeepSeekSessions,
  locateDeepSeekScriptBoundary,
  previewDeepSeekSessions,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k',
  memoryOnly: true,
};

function buildAmbiguousAndLongBranchZip(): Uint8Array {
  const chitchatAndScriptSession = {
    id: 'sess-ambiguous-long',
    title: '闲聊后开局的长存档',
    current_message_id: 12,
    inserted_at: '2026-11-16T10:00:00Z',
    updated_at: '2026-11-16T12:00:00Z',
    messages: [
      // Turns 1-2: short chitchat (should NOT be treated as Raw Script)
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:00:00Z',
        fragments: [{ type: 'REQUEST', content: '在吗？想玩个古风推理文游' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '在的，请把剧本发给我。' }],
      },
      {
        id: 3,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:02:00Z',
        fragments: [{ type: 'REQUEST', content: '稍等我复制一下文档内容' }],
      },
      {
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:03:00Z',
        fragments: [{ type: 'RESPONSE', content: '好的，发来后我就开始。' }],
      },
      // Turn 3: actual Raw Script pasted here
      {
        id: 5,
        parent_id: 4,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:04:00Z',
        fragments: [
          {
            type: 'REQUEST',
            content: '【雾隐山庄剧本】主角：顾长风。规则：每轮输出状态栏；禁忌：不可夜半独自出门。',
          },
        ],
      },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:05:00Z',
        fragments: [{ type: 'RESPONSE', content: '第一幕：山庄大门在暴雨中开启。' }],
      },
      // Fork at id=6: Active Branch A (7->8->9->10->11->12, current_message_id=12) vs Inactive Branch B (13->14->15->16)
      {
        id: 7,
        parent_id: 6,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:06:00Z',
        fragments: [{ type: 'REQUEST', content: '支线A：进入正厅拜见庄主' }],
      },
      {
        id: 8,
        parent_id: 7,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:07:00Z',
        fragments: [{ type: 'RESPONSE', content: '庄主交给你一把铜钥匙。' }],
      },
      {
        id: 9,
        parent_id: 8,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:08:00Z',
        fragments: [{ type: 'REQUEST', content: '询问铜钥匙来历' }],
      },
      {
        id: 10,
        parent_id: 9,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:09:00Z',
        fragments: [{ type: 'RESPONSE', content: '庄主压低声音指向阁楼。' }],
      },
      {
        id: 11,
        parent_id: 10,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:10:00Z',
        fragments: [{ type: 'REQUEST', content: '登上阁楼查看' }],
      },
      {
        id: 12,
        parent_id: 11,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:11:00Z',
        fragments: [{ type: 'RESPONSE', content: '阁楼桌上放着账册。' }],
      },
      // Inactive Branch B
      {
        id: 13,
        parent_id: 6,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:12:00Z',
        fragments: [{ type: 'REQUEST', content: '支线B：潜入后院马厩' }],
      },
      {
        id: 14,
        parent_id: 13,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:13:00Z',
        fragments: [{ type: 'RESPONSE', content: '马厩里藏着一匹黑马。' }],
      },
      {
        id: 15,
        parent_id: 14,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:14:00Z',
        fragments: [{ type: 'REQUEST', content: '检查马鞍暗袋' }],
      },
      {
        id: 16,
        parent_id: 15,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-16T10:15:00Z',
        fragments: [{ type: 'RESPONSE', content: '暗袋里有一封密信。' }],
      },
    ],
  };

  const strongFirstTurnSession = {
    id: 'sess-strong-first',
    title: '首轮即剧本',
    current_message_id: 2,
    inserted_at: '2026-11-17T08:00:00Z',
    updated_at: '2026-11-17T08:05:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-17T08:00:00Z',
        fragments: [
          {
            type: 'REQUEST',
            content:
              '【强信号开局剧本】主角：林晚。世界观规则：每轮必须输出状态栏并保持角色一致性。禁忌：严禁代替玩家做决定。开局场景：清晨的茶馆。',
          },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-17T08:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '茶馆里掌柜正在擦拭柜台。' }],
      },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/sess-ambiguous-long.json': strToU8(JSON.stringify(chitchatAndScriptSession)),
    'chat_sessions/sess-strong-first.json': strToU8(JSON.stringify(strongFirstTurnSession)),
  });
}

describe('Slice 3 (#21): Two-level Raw Script boundary detection & active-path summary compression on import', () => {
  it('skips boundary lookup for confirmed excerpts and keeps model-selected excerpts pending review', async () => {
    const zipBytes = buildAmbiguousAndLongBranchZip();
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧本边界定位')) {
          const previewJson = JSON.parse(req.messages[1]?.content ?? '[]') as Array<{
            nodeId: string;
            snippet: string;
          }>;
          const scriptNode = previewJson.find((item) => item.snippet.includes('雾隐山庄剧本'));
          const playNode = previewJson.find((item) => item.snippet.includes('山庄大门'));
          yield {
            contentDelta: JSON.stringify({
              scriptMessageIds: scriptNode ? [scriptNode.nodeId] : [],
              firstPlayMessageId: playNode?.nodeId ?? null,
            }),
            finishReason: 'stop',
          };
          return;
        }
        if (sys.includes('严格只输出一个 JSON 对象')) {
          yield {
            contentDelta: JSON.stringify({
              title: '雾隐山庄',
              worldRules: ['每轮输出状态栏'],
              protagonist: '顾长风',
              npcs: [],
              taboos: ['不可夜半独自出门'],
              openingHook: '山庄大门开启',
            }),
            finishReason: 'stop',
          };
          return;
        }
        if (sys.includes('剧情摘要压缩')) {
          yield {
            contentDelta: '【激活线摘要】顾长风自庄主处得铜钥匙。',
            finishReason: 'stop',
          };
          return;
        }
        yield { contentDelta: '续写：账册中记载着密室机关。', finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harness = createFictionHarness({
      transport,
      storage,
      contextBudget: { recentMaxNodes: 4, recentMaxChars: 4000 },
      now: () => 1700000000000 + ++seq * 1000,
      createId: () => `s3-${seq}`,
    });

    // 1. Local preview flags ambiguous opening and allows manual range override (e.g. turn 3..3)
    const localPreview = previewDeepSeekSessions(zipBytes, ['sess-ambiguous-long'])[0];
    expect(localPreview.story.sourceKind).toBe('deepseek_import');
    expect(localPreview.scriptConfidence).toBe('ambiguous');
    const manualPreview = previewDeepSeekSessions(zipBytes, ['sess-ambiguous-long'], {
      scriptRangeOverrides: { 'sess-ambiguous-long': { startTurn: 3, endTurn: 3 } },
    })[0];
    expect(manualPreview.rawScript).toContain('【雾隐山庄剧本】');
    expect(manualPreview.rawScript).not.toContain('在吗？想玩个古风推理文游');

    // 2. Strong turn-1 session makes ZERO boundary-locator LLM calls even when modelConfig is passed
    await importDeepSeekSessions(zipBytes, ['sess-strong-first'], harness, {
      modelConfig: testConfig,
      scriptRangeOverrides: { 'sess-strong-first': { startTurn: 1, endTurn: 1 } },
    });
    expect(captured.some((r) => (r.messages[0]?.content ?? '').includes('剧本边界定位'))).toBe(false);
    expect(captured.some((r) => (r.messages[0]?.content ?? '').includes('剧情摘要压缩'))).toBe(false);

    // The model proposes a candidate; the user may adopt it later.
    captured.length = 0;
    const result = await importDeepSeekSessions(zipBytes, ['sess-ambiguous-long'], harness, {
      modelConfig: testConfig,
    });

    const boundaryReqs = captured.filter((r) =>
      (r.messages[0]?.content ?? '').includes('剧本边界定位'),
    );
    expect(boundaryReqs).toHaveLength(1);
    const boundaryPayload = boundaryReqs[0].messages[1]?.content ?? '';
    expect(boundaryPayload).not.toContain('潜入后院马厩');
    expect(boundaryPayload).not.toContain('账册');

    const summaryReqs = captured.filter((r) =>
      (r.messages[0]?.content ?? '').includes('剧情摘要压缩'),
    );
    expect(summaryReqs).toHaveLength(0);

    const importedStory = result.stories[0];
    expect(importedStory.sourceKind).toBe('deepseek_import');
    expect(importedStory.sourceSessionId).toBe('sess-ambiguous-long');
    expect(importedStory.rawScript).toBe('');
    expect(importedStory.importCandidate).toBeUndefined();
    expect(importedStory.v2Migrated).toBe(true);
    const settingMarkdown = documentVersion(importedStory.documents!.container, 'story-original').markdown;
    expect(settingMarkdown).toContain('【雾隐山庄剧本】');
    expect(settingMarkdown).not.toContain('在吗？想玩个古风推理文游');
    expect(result.summaryStatuses[importedStory.id]).toBe('pending_summary');
    expect(getActiveSummarySnapshot(importedStory).content).toBe('');

    // Verify inactive branch B leaf remains uncompressed
    const branchBLeaf = Object.values(importedStory.nodes).find((n) =>
      n.content.includes('暗袋里有一封密信'),
    );
    expect(branchBLeaf?.summarySnapshot.content).toBe('');

    // Continue one turn -> prompt includes canonical 「故事设定」 Markdown and compressed Plot Summary
    captured.length = 0;
    await harness.runTurn(importedStory, '翻开账册第一页', testConfig);
    const turnReq = captured.find((r) =>
      r.messages.some((m) => m.content === '翻开账册第一页'),
    )!;
    const fullPrompt = turnReq.messages.map((m) => m.content).join('\n');
    expect(turnReq.messages[0].content).toContain('【雾隐山庄剧本】');
    expect(fullPrompt).toContain('【激活线摘要】顾长风自庄主处得铜钥匙。');
  });

  it('allows keyless import of ambiguous over-window session with pending_key status and supports later boundary/blueprint/summary completion', async () => {
    const zipBytes = buildAmbiguousAndLongBranchZip();
    let llmCalls = 0;
    const transport: LlmTransport = {
      async *streamChat(req) {
        llmCalls += 1;
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧本边界定位')) {
          yield {
            contentDelta: JSON.stringify({ scriptMessageIds: [], firstPlayMessageId: null }),
            finishReason: 'stop',
          };
          return;
        }
        if (sys.includes('严格只输出一个 JSON 对象')) {
          yield {
            contentDelta: JSON.stringify({
              title: '雾隐山庄补拆',
              worldRules: ['规则补全'],
              protagonist: '顾长风',
              npcs: [],
              taboos: [],
              openingHook: '山庄雨夜',
            }),
            finishReason: 'stop',
          };
          return;
        }
        yield { contentDelta: '补算后摘要', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage: createInMemoryStoryStorage(),
      contextBudget: { recentMaxNodes: 4, recentMaxChars: 4000 },
    });

    const keylessResult = await importDeepSeekSessions(zipBytes, ['sess-ambiguous-long'], harness);
    expect(llmCalls).toBe(0);
    const story = keylessResult.stories[0];
    expect(keylessResult.summaryStatuses[story.id]).toBe('pending_key');
    expect(story.blueprint.extractionStatus).toBe('partial_fallback');

    // Later after configuring key, canonical 「故事设定」 can be edited directly as Markdown and lazy summary completion succeeds
    const settingText = documentVersion(story.documents!.container, 'story-original').markdown;
    const edited = editStoryDocument(story, 'container', 'story-original', `${settingText}\n\n## 补充规则\n每轮需记录线索。`);
    const completed = await harness.ensureActiveBranchSummary(edited, testConfig);
    expect(getActiveSummarySnapshot(completed).content).toBe('补算后摘要');

    // Direct call to locateDeepSeekScriptBoundary handles empty/invalid fallback gracefully
    const fallbackBoundary = await locateDeepSeekScriptBoundary(completed, transport, testConfig);
    expect(fallbackBoundary.usedFallback).toBe(true);
  });
});
