import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  assembleThreeZoneContext,
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  importDeepSeekSessions,
  importStoryBackup,
  previewDeepSeekSessions,
  type LlmStreamRequest,
  type LlmTransport,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test-key',
  memoryOnly: true,
};

const EMPTY_SNAP = { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };

function buildLongLinearStory(turnCount: number, charPerNode = 220): Story {
  const nodes: Record<string, TurnNode> = {};
  let parentId: string | null = null;
  let rootId = '';

  for (let t = 1; t <= turnCount; t++) {
    const userId = `u-${t}`;
    const assistantId = `a-${t}`;
    const uText = `第${t}轮玩家行动：${'甲'.repeat(charPerNode)}`;
    const aText = `第${t}轮叙事结果：${'乙'.repeat(charPerNode)}`;

    nodes[userId] = {
      id: userId,
      parentId,
      role: 'user',
      content: uText,
      createdAt: t * 2 - 1,
      summarySnapshot: EMPTY_SNAP,
    };
    if (t === 1) rootId = userId;

    nodes[assistantId] = {
      id: assistantId,
      parentId: userId,
      role: 'assistant',
      content: aText,
      createdAt: t * 2,
      summarySnapshot: EMPTY_SNAP,
    };
    parentId = assistantId;
  }

  return {
    id: 'story-long',
    title: '长线测试故事',
    rawScript: '【核心设定】长线世界观与角色铁律。',
    blueprint: {
      title: '长线测试故事',
      worldRules: ['规则一'],
      protagonist: '沈清秋',
      npcs: [],
      taboos: ['禁忌一'],
      openingHook: '山门开启',
      extractionStatus: 'complete',
    },
    nodes,
    rootNodeIds: [rootId],
    activeLeafNodeId: parentId,
    createdAt: 1,
    updatedAt: 100,
  };
}

function createSummaryAwareTransport(
  captured: LlmStreamRequest[],
  summaryText: string,
  replyText: string,
): LlmTransport {
  return {
    async *streamChat(req) {
      captured.push(req);
      if ((req.messages[0]?.content ?? '').includes('剧情摘要压缩')) {
        yield { contentDelta: summaryText, finishReason: 'stop' };
        return;
      }
      yield { contentDelta: replyText, finishReason: 'stop' };
    },
  };
}

describe('Spec #25 Slice 1: Pre-turn catch-up & chunked rolling Plot Summary', () => {
  it('runs chunked rolling summary compression BEFORE main reply when runTurn starts with over-window uncovered history', async () => {
    const captured: LlmStreamRequest[] = [];
    let summaryBatchIndex = 0;

    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('剧情摘要压缩')) {
          summaryBatchIndex += 1;
          yield {
            contentDelta: `滚动摘要第${summaryBatchIndex}批`,
            finishReason: 'stop',
          };
          return;
        }
        yield { contentDelta: '续写主剧情回复。', finishReason: 'stop' };
      },
    };

    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 6, recentMaxChars: 4000 },
    });

    // 32 turns = 64 nodes, all with empty summarySnapshot (e.g. imported without API key)
    const longStory = buildLongLinearStory(32, 220);
    const result = await harness.runTurn(longStory, '第33轮新行动', testConfig);

    // Find the main reply request (the one that is NOT summary compression)
    const mainReqIndex = captured.findIndex(
      (r) => !(r.messages[0]?.content ?? '').includes('剧情摘要压缩'),
    );
    expect(mainReqIndex).toBeGreaterThan(1); // Multiple summary batches ran BEFORE main reply!

    const preTurnSummaryReqs = captured.slice(0, mainReqIndex);
    expect(preTurnSummaryReqs.length).toBeGreaterThanOrEqual(3);

    // Main reply request must already contain Zone 2 summary before sending
    const mainReq = captured[mainReqIndex];
    expect(mainReq.messages[1]?.role).toBe('system');
    expect(mainReq.messages[1]?.content).toContain('滚动剧情摘要');
    expect(mainReq.messages[1]?.content).toContain(`滚动摘要第${preTurnSummaryReqs.length}批`);

    // Recent window in main reply must NOT exceed recentMaxNodes
    const zone3 = mainReq.messages.slice(2);
    expect(zone3.length).toBeLessThanOrEqual(7); // <= 6 recent nodes + 1 pending user input
    expect(result.assistantNode.summarySnapshot.summarizedTurnCount).toBeGreaterThanOrEqual(56);
  });

  it('catches up Plot Summary before main reply when rewinding/branching via editAndBranch or regenerateNode at turn 28', async () => {
    const capturedEdit: LlmStreamRequest[] = [];
    const harnessEdit = createFictionHarness({
      transport: createSummaryAwareTransport(capturedEdit, '回溯前置压缩摘要', '分叉新回复'),
      contextBudget: { recentMaxNodes: 6, recentMaxChars: 4000 },
    });

    const longStory = buildLongLinearStory(32, 200);
    const rewound = await harnessEdit.rewindToNode(longStory, 'a-28');
    const editRes = await harnessEdit.editAndBranch(rewound, 'u-28', '第28轮改写行动', testConfig);
    const editMainIdx = capturedEdit.findIndex(
      (r) => !(r.messages[0]?.content ?? '').includes('剧情摘要压缩'),
    );
    expect(editMainIdx).toBeGreaterThan(1);
    expect(capturedEdit[editMainIdx].messages[1]?.content).toContain('回溯前置压缩摘要');
    expect(editRes.assistantNode.summarySnapshot.coveredUpToNodeId).toBeTruthy();

    const capturedRegen: LlmStreamRequest[] = [];
    const harnessRegen = createFictionHarness({
      transport: createSummaryAwareTransport(capturedRegen, '重生成前置压缩摘要', '重生成回复'),
      contextBudget: { recentMaxNodes: 6, recentMaxChars: 4000 },
    });
    const regenRes = await harnessRegen.regenerateNode(longStory, 'a-28', testConfig);
    const regenMainIdx = capturedRegen.findIndex(
      (r) => !(r.messages[0]?.content ?? '').includes('剧情摘要压缩'),
    );
    expect(regenMainIdx).toBeGreaterThan(1);
    expect(capturedRegen[regenMainIdx].messages[1]?.content).toContain('重生成前置压缩摘要');
    expect(regenRes.assistantNode.summarySnapshot.coveredUpToNodeId).toBeTruthy();
  });

  it('makes zero pre-turn summary calls during normal short-window turn progression', async () => {
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        yield { contentDelta: '短线正常回复。', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 8, recentMaxChars: 6000 },
    });
    const shortStory = buildLongLinearStory(2, 40);
    await harness.runTurn(shortStory, '第三轮行动', testConfig);

    expect(captured).toHaveLength(1);
    expect((captured[0].messages[0]?.content ?? '')).not.toContain('剧情摘要压缩');
  });
});

function buildDocxBytes(text: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml) });
}

describe('Spec #25 Slice 2: Setup Node annotation, deduplication & backup compatibility', () => {
  it('marks setupNodeIds on DeepSeek import and folds setup node content in Zone 3 and summary compression', async () => {
    const uniqueScriptMarker = '【万字剧本唯一锚定标记_DOCX_9981】';
    const longDocxScript = `${uniqueScriptMarker}${'世界观设定与规则条款。'.repeat(500)}`;
    const docxBytes = buildDocxBytes(longDocxScript);

    const session = {
      id: 'sess-docx-setup',
      title: '万字剧本测试',
      pinned: false,
      current_message_id: 4,
      inserted_at: '2026-11-12T10:00:00Z',
      updated_at: '2026-11-12T10:10:00Z',
      messages: [
        {
          id: 1,
          parent_id: null,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:00:00Z',
          fragments: [
            {
              type: 'FILE',
              files: [
                {
                  id: 'f-docx',
                  file_name: 'script.docx',
                  file_size: docxBytes.length,
                  export_path: 'files/script.docx',
                  is_image: false,
                },
              ],
            },
            { type: 'REQUEST', content: '请按附件剧本开局。' },
          ],
        },
        {
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:01:00Z',
          fragments: [{ type: 'RESPONSE', content: '已载入设定，请开始你的第一幕选择。' }],
        },
        {
          id: 3,
          parent_id: 2,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:02:00Z',
          fragments: [{ type: 'REQUEST', content: '推开大门走进大厅。' }],
        },
        {
          id: 4,
          parent_id: 3,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:03:00Z',
          fragments: [{ type: 'RESPONSE', content: '大厅内烛火摇曳。' }],
        },
      ],
    };

    const zipBytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          export_format_version: 3,
          chat_sessions: [{ id: session.id, title: session.title, updated_at: session.updated_at }],
        }),
      ),
      [`chat_sessions/${session.id}.json`]: strToU8(JSON.stringify(session)),
      'files/script.docx': docxBytes,
    });

    const previews = previewDeepSeekSessions(zipBytes, [session.id]);
    expect(previews).toHaveLength(1);
    const story = previews[0].story;
    expect(story.setupNodeIds).toBeDefined();
    expect(story.setupNodeIds!.length).toBeGreaterThanOrEqual(1);

    const setupId = story.setupNodeIds![0];
    // Original setup node content is preserved intact for Story Tree UI inspection
    expect(story.nodes[setupId].content).toContain(uniqueScriptMarker);

    // Three-zone context includes uniqueScriptMarker ONLY ONCE (in Zone 1 system anchor, NOT in Zone 3)
    const ctx = assembleThreeZoneContext(story, story.activeLeafNodeId, '继续探索');
    const systemText = ctx.messages[0].content;
    const nonSystemText = ctx.messages.slice(1).map((m) => m.content).join('\n');
    expect(systemText).toContain(uniqueScriptMarker);
    expect(nonSystemText).not.toContain(uniqueScriptMarker);

    // Running a turn with tight char budget triggers summary compression without duplicating the 10k script
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        if ((req.messages[0]?.content ?? '').includes('剧情摘要压缩')) {
          yield { contentDelta: '精简摘要', finishReason: 'stop' };
          return;
        }
        yield { contentDelta: '新回合叙事。', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage: createInMemoryStoryStorage(),
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
    });
    await harness.runTurn(story, '继续探索大厅', testConfig);
    const summaryReq = captured.find((r) => (r.messages[0]?.content ?? '').includes('剧情摘要压缩'));
    expect(summaryReq).toBeDefined();
    expect(summaryReq!.messages.map((m) => m.content).join('\n')).not.toContain(uniqueScriptMarker);
  });

  it('records setupNodeIds from Level-2 LLM script boundary detection when opening is ambiguous', async () => {
    const session = {
      id: 'sess-ambiguous',
      title: '模糊开局',
      pinned: false,
      current_message_id: 4,
      inserted_at: '2026-11-12T10:00:00Z',
      updated_at: '2026-11-12T10:10:00Z',
      messages: [
        {
          id: 1,
          parent_id: null,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:00:00Z',
          fragments: [{ type: 'REQUEST', content: '你好，准备玩个游戏' }],
        },
        {
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:01:00Z',
          fragments: [{ type: 'RESPONSE', content: '好的，请发设定。' }],
        },
        {
          id: 3,
          parent_id: 2,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:02:00Z',
          fragments: [{ type: 'REQUEST', content: '角色：林晚。规则：每天一次占卜。' }],
        },
        {
          id: 4,
          parent_id: 3,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-12T10:03:00Z',
          fragments: [{ type: 'RESPONSE', content: '占卜屋的门打开了。' }],
        },
      ],
    };

    const zipBytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          export_format_version: 3,
          chat_sessions: [{ id: session.id, title: session.title, updated_at: session.updated_at }],
        }),
      ),
      [`chat_sessions/${session.id}.json`]: strToU8(JSON.stringify(session)),
    });

    let idSeq = 0;
    let boundaryCalled = false;
    const transport: LlmTransport = {
      async *streamChat(req) {
        const sys = req.messages[0]?.content ?? '';
        const prompt = req.messages[1]?.content ?? '';
        if (sys.includes('剧本边界定位')) {
          boundaryCalled = true;
          const parsed = JSON.parse(prompt) as Array<{ nodeId: string; snippet: string }>;
          const introNode = parsed.find((p) => p.snippet.includes('你好'));
          const scriptNode = parsed.find((p) => p.snippet.includes('角色：林晚'));
          const playNode = parsed.find((p) => p.snippet.includes('占卜屋的门打开了'));
          yield {
            contentDelta: JSON.stringify({
              scriptMessageIds: [introNode?.nodeId, scriptNode?.nodeId].filter(Boolean),
              firstPlayMessageId: playNode?.nodeId ?? null,
            }),
            finishReason: 'stop',
          };
          return;
        }
        yield {
          contentDelta: JSON.stringify({
            title: '模糊开局',
            worldRules: ['每天一次占卜'],
            protagonist: '林晚',
            npcs: [],
            taboos: [],
            openingHook: '占卜屋的门打开了。',
          }),
          finishReason: 'stop',
        };
      },
    };

    const harness = createFictionHarness({
      transport,
      storage: createInMemoryStoryStorage(),
      createId: () => `imp-${++idSeq}`,
    });

    const batch = await importDeepSeekSessions(zipBytes, [session.id], harness, {
      modelConfig: testConfig,
    });
    expect(boundaryCalled).toBe(true);
    expect(batch.stories).toHaveLength(1);
    const imported = batch.stories[0];
    expect(imported.setupNodeIds).toHaveLength(2);
    expect(imported.nodes[imported.setupNodeIds![0]].content).toContain('你好');
    expect(imported.nodes[imported.setupNodeIds![1]].content).toContain('角色：林晚');
  });

  it('round-trips setupNodeIds in Story JSON backup, validates node existence, and remains backward-compatible with v1 backups lacking setupNodeIds', () => {
    const story = buildLongLinearStory(2, 30);
    const storyWithSetup: Story = {
      ...story,
      setupNodeIds: ['u-1'],
    };

    const json = exportStoryBackup(storyWithSetup);
    const restored = importStoryBackup(json, []);
    expect(restored.setupNodeIds).toEqual(['u-1']);

    // Legacy v1 backup without setupNodeIds still imports cleanly
    const legacyParsed = JSON.parse(json);
    delete legacyParsed.story.setupNodeIds;
    const legacyRestored = importStoryBackup(JSON.stringify(legacyParsed), []);
    expect(legacyRestored.setupNodeIds).toBeUndefined();

    // Dangling setupNodeIds is rejected
    const badParsed = JSON.parse(json);
    badParsed.story.setupNodeIds = ['non-existent-node'];
    expect(() => importStoryBackup(JSON.stringify(badParsed), [])).toThrow();
  });
});
