import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  exportStoryBackup,
  getActiveSummarySnapshot,
  getForkSiblingBranches,
  importDeepSeekSessions,
  importStoryBackup,
  projectStoryTreeSpine,
  scanDeepSeekExportZip,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'k-spec18',
  memoryOnly: true,
};

function buildDocx(text: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml) });
}

function buildSpec18IntegrationZip(): Uint8Array {
  const docx = buildDocx('【庄园推理规则】主角：沈清。禁忌：不可在午夜单独进入钟楼。');
  const sciSession = {
    id: 'sci-1',
    title: '量子退相干数值模拟',
    current_message_id: 2,
    inserted_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:02:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-10T08:00:00Z', fragments: [{ type: 'REQUEST', content: 'SELECT * FROM decoherence_runs;' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-10T08:02:00Z', fragments: [{ type: 'RESPONSE', content: '可以用 Lindblad 主方程估算退相干时间。' }] },
    ],
  };
  const nullSession = {
    id: 'null-1',
    title: null,
    current_message_id: 2,
    inserted_at: '2026-11-11T08:00:00Z',
    updated_at: '2026-11-11T08:01:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-11T08:00:00Z', fragments: [{ type: 'REQUEST', content: '周末去超市买什么？' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-11T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '牛奶与面包。' }] },
    ],
  };

  // Multi-branch fiction session with 2 forks and mutually exclusive Event X (Branch A) vs Event Y (Branch B)
  const fictionSession = {
    id: 'fic-two-fork',
    title: '庄园双线集成测试',
    current_message_id: 10,
    inserted_at: '2026-11-12T10:00:00Z',
    updated_at: '2026-11-12T12:00:00Z',
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
              { id: 'd1', file_name: '庄园规则.docx', file_size: docx.length, export_path: 'chat_sessions/fic-two-fork/庄园规则.docx', is_image: false },
              { id: 'p1', file_name: '平面图.png', file_size: 128, export_path: 'chat_sessions/fic-two-fork/平面图.png', is_image: true },
            ],
          },
          { type: 'REQUEST', content: '按照附件规则开始第一幕。' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '第1章 抵达大宅\n地点：前厅\n大雨倾盆。' }],
      },
      { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:02:00Z', fragments: [{ type: 'REQUEST', content: '询问管家钥匙去向' }] },
      { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:03:00Z', fragments: [{ type: 'RESPONSE', content: '管家提及东楼与西塔两条线索。' }] },
      // Fork 1 at id=4: Branch A (5->6->7->8->9->10) vs Branch B (11->12->13->14)
      { id: 5, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:04:00Z', fragments: [{ type: 'REQUEST', content: '选择东楼：调查事件X银钥' }] },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-12T10:05:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '敏感风控提示' },
          { type: 'RESPONSE', content: '第2章 东楼暗室\n地点：东楼密室\n触发事件X：取得银钥匙。' },
        ],
      },
      { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:06:00Z', fragments: [{ type: 'REQUEST', content: '核对银钥匙刻字' }] },
      // Fork 2 at id=7 (regenerated reply 8 vs 15)
      { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:07:00Z', fragments: [{ type: 'RESPONSE', content: '刻字写着“书房保险柜”。' }] },
      { id: 15, parent_id: 7, role: 'ASSISTANT', status: 'TIMEOUT', inserted_at: '2026-11-12T10:07:30Z', fragments: [{ type: 'RESPONSE', content: '刻字模糊不清（超时备选）。' }] },
      { id: 9, parent_id: 8, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:08:00Z', fragments: [{ type: 'REQUEST', content: '前往书房保险柜' }] },
      { id: 10, parent_id: 9, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:00Z', fragments: [{ type: 'RESPONSE', content: '抵达保险柜前（当前进度）。' }] },
      // Branch B (mutually exclusive Event Y)
      { id: 11, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:10:00Z', fragments: [{ type: 'REQUEST', content: '选择西塔：调查事件Y毒药' }] },
      { id: 12, parent_id: 11, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:11:00Z', fragments: [{ type: 'RESPONSE', content: '第2章 西塔药房\n地点：西塔实验室\n触发事件Y：发现致命毒药。' }] },
      { id: 13, parent_id: 12, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:12:00Z', fragments: [{ type: 'REQUEST', content: '化验毒药成分' }] },
      { id: 14, parent_id: 13, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:13:00Z', fragments: [{ type: 'RESPONSE', content: '确认毒药来自地下温室。' }] },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/sci-1.json': strToU8(JSON.stringify(sciSession)),
    'chat_sessions/null-1.json': strToU8(JSON.stringify(nullSession)),
    'chat_sessions/fic-two-fork.json': strToU8(JSON.stringify(fictionSession)),
    'chat_sessions/fic-two-fork/庄园规则.docx': docx,
    'chat_sessions/fic-two-fork/平面图.png': strToU8('png-bytes'),
  });
}

describe('Slice 5 (#23): Spec #18 end-to-end DeepSeek import -> 2-fork Story Tree -> mutual-exclusion continuation regression', () => {
  it('completes full pipeline from keyless DeepSeek import through lazy summaries, branch rename, mutual-exclusion continuation, and backup round-trip', async () => {
    const zipBytes = buildSpec18IntegrationZip();
    const scan = scanDeepSeekExportZip(zipBytes);
    expect(scan.sessions[0].sessionId).toBe('fic-two-fork');
    expect(scan.sessions[0].forkCount).toBe(2);

    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        captured.push(req);
        const sys = req.messages[0]?.content ?? '';
        const body = req.messages.map((m) => m.content).join('\n');
        if (sys.includes('剧情摘要压缩')) {
          if (body.includes('事件X')) {
            yield { contentDelta: '【支线A摘要】已触发事件X拿到银钥匙。', finishReason: 'stop' };
          } else if (body.includes('事件Y')) {
            yield { contentDelta: '【支线B摘要】已触发事件Y查出毒药。', finishReason: 'stop' };
          } else {
            yield { contentDelta: '【通用摘要】管家提及两条线索。', finishReason: 'stop' };
          }
          return;
        }
        const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
        yield { contentDelta: `继续演绎：${lastUser}`, finishReason: 'stop' };
      },
    };

    const storage = createInMemoryStoryStorage();
    let seq = 0;
    const harness = createFictionHarness({
      transport,
      storage,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 4000 },
      now: () => 1700000000000 + ++seq * 1000,
      createId: () => `s18-${seq}`,
    });

    // 1. Keyless import -> 0 LLM calls, pending_key status, activeLeaf at current_message_id (id=10)
    const keyless = await importDeepSeekSessions(zipBytes, ['fic-two-fork'], harness, {
      scriptRangeOverrides: { 'fic-two-fork': { startTurn: 1, endTurn: 1 } },
    });
    expect(captured).toHaveLength(0);
    let story = keyless.stories[0];
    expect(keyless.summaryStatuses[story.id]).toBe('pending_key');
    expect(story.nodes[story.activeLeafNodeId!]?.content).toContain('抵达保险柜前');

    // 2. Story Tree spine shows 2 forks without LLM calls
    const spine = projectStoryTreeSpine(story);
    expect(spine.forkCount).toBe(2);
    expect(captured).toHaveLength(0);

    // 3. Rename Branch A & Branch B via Fork 1
    const fork1 = spine.items.find((item) => item.kind === 'fork')!;
    const siblings1 = getForkSiblingBranches(story, fork1.parentNodeId);
    expect(siblings1).toHaveLength(2);
    story = await harness.renameBranch(story, siblings1[0].entryNodeId, '银钥东楼线');
    story = await harness.renameBranch(story, siblings1[1].entryNodeId, '毒药西塔线');

    // 4. Switch to Branch B -> lazily compress Branch B -> continue turn -> Event Y only, no Event X, no diagnostics
    story = await harness.switchBranch(story, siblings1[1].entryNodeId);
    story = await harness.ensureActiveBranchSummary(story, testConfig);
    expect(getActiveSummarySnapshot(story).content).toContain('事件Y');
    expect(getActiveSummarySnapshot(story).content).not.toContain('事件X');

    const turnB = await harness.runTurn(story, '进入地下温室追查', testConfig);
    story = turnB.story;
    const reqB = captured.find((r) => r.messages.some((m) => m.content === '进入地下温室追查'))!;
    const promptB = reqB.messages.map((m) => m.content).join('\n');
    expect(promptB).toContain('庄园推理规则');
    expect(promptB).toContain('事件Y');
    expect(promptB).not.toContain('事件X');
    expect(promptB).not.toContain('CONTENT_FILTER');
    expect(promptB).not.toContain('CONTENT_RISK');

    // 5. Switch back to Branch A -> lazily compress Branch A -> continue turn -> Event X only, no Event Y
    story = await harness.switchBranch(story, siblings1[0].entryNodeId);
    story = await harness.ensureActiveBranchSummary(story, testConfig);
    expect(getActiveSummarySnapshot(story).content).toContain('事件X');
    expect(getActiveSummarySnapshot(story).content).not.toContain('事件Y');

    const turnA = await harness.runTurn(story, '用银钥匙打开保险柜', testConfig);
    story = turnA.story;
    const reqA = captured.find((r) => r.messages.some((m) => m.content === '用银钥匙打开保险柜'))!;
    const promptA = reqA.messages.map((m) => m.content).join('\n');
    expect(promptA).toContain('庄园推理规则');
    expect(promptA).toContain('事件X');
    expect(promptA).not.toContain('事件Y');
    expect(promptA).not.toContain('CONTENT_FILTER');

    // 6. Backup round-trip preserves branch names, diagnostics, and isolated summaries
    const restored = importStoryBackup(exportStoryBackup(story), []);
    expect(Object.values(restored.branchNames ?? {})).toContain('银钥东楼线');
    expect(Object.values(restored.branchNames ?? {})).toContain('毒药西塔线');
    expect(
      Object.values(restored.nodes).some(
        (n) => n.diagnostics?.sourceStatus === 'CONTENT_FILTER' && n.diagnostics?.contentRisk,
      ),
    ).toBe(true);
  });
});
