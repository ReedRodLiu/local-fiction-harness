import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  scanDeepSeekExportZip,
  previewDeepSeekSessions,
  importDeepSeekSessions,
  assistFilterDeepSeekSessions,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

function buildMinimalDocxBytes(text: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml) });
}

/**
 * Replaces the compressed payload of an entry in a ZIP buffer with garbage bytes
 * while keeping the headers intact. Any attempt to decompress that entry will throw.
 */
function corruptZipEntryPayload(zipBytes: Uint8Array, markerBytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(zipBytes);
  outer: for (let i = 0; i <= copy.length - markerBytes.length; i++) {
    for (let j = 0; j < markerBytes.length; j++) {
      if (copy[i + j] !== markerBytes[j]) continue outer;
    }
    for (let k = 0; k < Math.min(8, markerBytes.length); k++) {
      copy[i + k] ^= 0xff;
    }
    return copy;
  }
  throw new Error('Marker bytes not found in ZIP');
}

function buildSyntheticDeepSeekZip(): Uint8Array {
  const docxBytes = buildMinimalDocxBytes('【宫廷剧本】主角：沈知微。禁忌：不可私出冷宫。');
  const txtBytes = strToU8('补充设定：每晚子时触发随机事件。', false);
  const pngTrap = strToU8('TRAP_PNG_DO_NOT_DECOMPRESS_PAYLOAD_'.repeat(6));
  const pdfTrap = strToU8('TRAP_PDF_DO_NOT_DECOMPRESS_PAYLOAD_'.repeat(6));
  const docTrap = strToU8('TRAP_DOC_DO_NOT_DECOMPRESS_PAYLOAD_'.repeat(6));

  const techSession = {
    id: 'sess-tech-null',
    title: null,
    pinned: false,
    current_message_id: 2,
    inserted_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:05:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-10T08:00:00Z',
        fragments: [{ type: 'REQUEST', content: '请解释 tsconfig.json 的 strict 参数怎么配置？' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-10T08:05:00Z',
        fragments: [
          { type: 'TOOL_SEARCH', queries: ['tsconfig strict'], results: [] },
          { type: 'RESPONSE', content: 'strict: true 会同时开启 strictNullChecks 等选项。' },
        ],
      },
    ],
  };

  const fictionSession = {
    id: 'sess-fiction-1',
    title: '深宫棋局（合成测试）',
    pinned: false,
    current_message_id: 6,
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
              {
                id: 'f-docx',
                file_name: '剧本设定.docx',
                file_size: docxBytes.length,
                export_path: 'chat_sessions/sess-fiction-1/剧本设定.docx',
                is_image: false,
              },
              {
                id: 'f-txt',
                file_name: '补充.txt',
                file_size: txtBytes.length,
                export_path: 'chat_sessions/sess-fiction-1/补充.txt',
                is_image: false,
              },
              {
                id: 'f-png',
                file_name: '立绘.png',
                file_size: 4096,
                export_path: 'chat_sessions/sess-fiction-1/立绘.png',
                is_image: true,
              },
              {
                id: 'f-pdf',
                file_name: '地图.pdf',
                file_size: 8192,
                export_path: 'chat_sessions/sess-fiction-1/地图.pdf',
                is_image: false,
              },
              {
                id: 'f-doc',
                file_name: '旧版大纲.doc',
                file_size: 2048,
                export_path: 'chat_sessions/sess-fiction-1/旧版大纲.doc',
                is_image: false,
              },
            ],
          },
          { type: 'REQUEST', content: '请按附件规则、主角设定与状态栏格式开始第一幕。' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:01:00Z',
        fragments: [
          { type: 'THINK', content: '内部思考：布置冷宫开场氛围' },
          { type: 'TOOL_OPEN', url: 'https://example.invalid', title: 'skip me' },
          { type: 'TIP', content: '平台提示噪音不应入正文' },
          {
            type: 'RESPONSE',
            content: '第一幕：雪落冷宫。\n```text\n[好感度: 50 | 声望: 10]\n```\nA. 推门观雪\nB. 围炉读信',
          },
        ],
      },
      // Fork at message 2: Branch A (3->4->5->6, active current_message_id = 6) vs Branch B (7->8)
      {
        id: 3,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:05:00Z',
        fragments: [{ type: 'REQUEST', content: 'A. 推门观雪' }],
      },
      {
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-12T10:06:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '检测到敏感内容提示' },
          { type: 'RESPONSE', content: '梅影之下，有人递来一封密信。' },
          { type: 'TEMPLATE_RESPONSE', content: '模板噪声应剥离' },
        ],
      },
      {
        id: 5,
        parent_id: 4,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:10:00Z',
        fragments: [{ type: 'REQUEST', content: '拆开密信查看落款' }],
      },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'TIMEOUT',
        inserted_at: '2026-11-12T10:12:00Z',
        fragments: [{ type: 'RESPONSE', content: '落款写着“旧日故人”。' }],
      },
      {
        id: 7,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:15:00Z',
        fragments: [{ type: 'REQUEST', content: 'B. 围炉读信' }],
      },
      {
        id: 8,
        parent_id: 7,
        role: 'ASSISTANT',
        status: 'INCOMPLETE',
        inserted_at: '2026-11-12T10:16:00Z',
        fragments: [{ type: 'RESPONSE', content: '炉火噼啪作响，信纸角落烧焦。' }],
      },
    ],
  };

  const dailySession = {
    id: 'sess-daily-2',
    title: '周末买菜清单',
    pinned: false,
    current_message_id: 2,
    inserted_at: '2026-11-13T09:00:00Z',
    updated_at: '2026-11-13T09:01:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-13T09:00:00Z',
        fragments: [{ type: 'REQUEST', content: '帮我列一个番茄炒蛋的买菜清单。' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-13T09:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '西红柿 3 个，鸡蛋 4 枚，小葱适量。' }],
      },
    ],
  };

  // Store PNG/PDF/DOC uncompressed (`level: 0`) and corrupt their bytes after `zipSync`.
  // Wait: to guarantee `unzipSync` throws if it ever touches those entries, compress at level 0?
  // Wait: fflate `unzipSync` slices stored (level 0) entries without CRC check; so instead we compress
  // with level 6 and flip the bytes right after the filename in the local file header!
  const rawZip = zipSync(
    {
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'user.json': strToU8(JSON.stringify({ phone: '13800000000' })),
      'chat_sessions/sess-tech-null.json': strToU8(JSON.stringify(techSession)),
      'chat_sessions/sess-fiction-1.json': strToU8(JSON.stringify(fictionSession)),
      'chat_sessions/sess-daily-2.json': strToU8(JSON.stringify(dailySession)),
      'chat_sessions/sess-fiction-1/剧本设定.docx': docxBytes,
      'chat_sessions/sess-fiction-1/补充.txt': txtBytes,
      'chat_sessions/sess-fiction-1/立绘.png': pngTrap,
      'chat_sessions/sess-fiction-1/地图.pdf': pdfTrap,
      'chat_sessions/sess-fiction-1/旧版大纲.doc': docTrap,
    },
    { level: 6 },
  );

  let corrupted: Uint8Array = rawZip;
  for (const name of ['立绘.png', '地图.pdf', '旧版大纲.doc']) {
    const marker = strToU8(name);
    const idx = corrupted.findIndex((_, i) => marker.every((b, j) => corrupted[i + j] === b));
    if (idx !== -1) {
      // Corrupt compressed deflate stream right after the filename in the local header
      const payloadIdx = idx + marker.length + 2;
      corrupted = corruptZipEntryPayload(corrupted, corrupted.slice(payloadIdx, payloadIdx + 6));
    }
  }
  return corrupted;
}

describe('Slice 2 (#20): DeepSeek v3 two-stage .zip scan, sanitization, Node Diagnostics, and keyless 1-to-1 import', () => {
  it('scans only manifest and session JSONs in Stage 1, ranks likely fiction on top, and handles null titles', () => {
    const zipBytes = buildSyntheticDeepSeekZip();
    const scan = scanDeepSeekExportZip(zipBytes);

    expect(scan.exportFormatVersion).toBe(3);
    expect(scan.sessions).toHaveLength(3);
    // Likely fiction session should be ranked first despite older updated_at
    expect(scan.sessions[0].sessionId).toBe('sess-fiction-1');
    expect(scan.sessions[0].isLikelyFiction).toBe(true);
    expect(scan.sessions[0].forkCount).toBe(1);
    expect(scan.sessions[0].diagnosticCount).toBe(3);

    const nullTitleSession = scan.sessions.find((s) => s.sessionId === 'sess-tech-null');
    expect(nullTitleSession).toBeDefined();
    expect(nullTitleSession!.title).toContain('tsconfig');
  });

  it('extracts .docx/.txt on demand in Stage 2, skips media/.doc with hints, strips platform noise, and imports 1-to-1 without API key', async () => {
    const zipBytes = buildSyntheticDeepSeekZip();
    let llmCalls = 0;
    const captured: LlmStreamRequest[] = [];
    const transport: LlmTransport = {
      async *streamChat(req) {
        llmCalls += 1;
        captured.push(req);
        yield { contentDelta: '续写下一幕', finishReason: 'stop' };
      },
    };
    const storage = createInMemoryStoryStorage();
    let idSeq = 0;
    const harness = createFictionHarness({
      transport,
      storage,
      now: () => 1700000000000 + ++idSeq * 1000,
      createId: () => `ds-story-${idSeq}`,
    });

    // Stage 2 preview (purely local, 0 LLM calls)
    const previews = previewDeepSeekSessions(zipBytes, ['sess-fiction-1']);
    expect(previews).toHaveLength(1);
    const p = previews[0];
    expect(p.recoveredAttachments.map((a) => a.fileName)).toEqual(['剧本设定.docx', '补充.txt']);
    expect(p.skippedAttachments.map((a) => a.fileName)).toEqual(['立绘.png', '地图.pdf', '旧版大纲.doc']);
    expect(p.skippedAttachments.find((a) => a.fileName === '旧版大纲.doc')?.hint).toContain('.docx');
    expect(p.rawScript).toContain('【宫廷剧本】主角：沈知微');
    expect(p.rawScript).toContain('补充设定：每晚子时触发随机事件');
    expect(p.scriptConfidence).toBe('strong');
    expect(p.story.activeLeafNodeId).toBeTruthy();

    // Check sanitized content & read-only NodeDiagnostics
    const nodesList = Object.values(p.story.nodes);
    const combinedContent = nodesList.map((n) => n.content).join('\n');
    expect(combinedContent).not.toContain('检测到敏感内容提示');
    expect(combinedContent).not.toContain('平台提示噪音');
    expect(combinedContent).not.toContain('模板噪声应剥离');
    expect(combinedContent).not.toContain('skip me');
    expect(combinedContent).toContain('落款写着“旧日故人”');

    const activeLeaf = p.story.nodes[p.story.activeLeafNodeId!];
    expect(activeLeaf.content).toContain('旧日故人');
    expect(activeLeaf.diagnostics?.sourceStatus).toBe('TIMEOUT');

    const filterNode = nodesList.find((n) => n.content.includes('密信'));
    expect(filterNode?.diagnostics).toEqual({ sourceStatus: 'CONTENT_FILTER', contentRisk: true });

    const thinkNode = nodesList.find((n) => n.content.includes('雪落冷宫'));
    expect(thinkNode?.reasoningContent).toContain('内部思考');

    // Confirm 1-to-1 import of 2 sessions without API key -> 0 LLM calls
    const imported = await importDeepSeekSessions(
      zipBytes,
      ['sess-fiction-1', 'sess-daily-2'],
      harness,
    );
    expect(llmCalls).toBe(0);
    expect(imported.stories).toHaveLength(2);

    const savedList = await harness.listStories();
    expect(savedList).toHaveLength(2);
    const restoredFiction = savedList.find((s) => s.title === '深宫棋局（合成测试）')!;
    expect(restoredFiction.blueprint.extractionStatus).toBe('partial_fallback');

    // Context assembly strictly excludes NodeDiagnostics and THINK reasoningContent
    const ctx = harness.assembleContext(restoredFiction, restoredFiction.activeLeafNodeId, '询问故人身份');
    const promptText = ctx.messages.map((m) => m.content).join('\n');
    expect(promptText).toContain('【宫廷剧本】主角：沈知微');
    expect(promptText).toContain('落款写着“旧日故人”');
    expect(promptText).not.toContain('CONTENT_FILTER');
    expect(promptText).not.toContain('CONTENT_RISK');
    expect(promptText).not.toContain('TIMEOUT');
    expect(promptText).not.toContain('内部思考');
  });

  it('supports optional AI-assisted session filtering via LlmTransport', async () => {
    const zipBytes = buildSyntheticDeepSeekZip();
    const scan = scanDeepSeekExportZip(zipBytes);

    const transport: LlmTransport = {
      async *streamChat() {
        yield {
          contentDelta: '{"fictionSessionIds":["sess-fiction-1"]}',
          finishReason: 'stop',
        };
      },
    };

    const matchedIds = await assistFilterDeepSeekSessions(scan.sessions, transport, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'k',
      memoryOnly: true,
    });
    expect(matchedIds).toEqual(['sess-fiction-1']);
  });
});
