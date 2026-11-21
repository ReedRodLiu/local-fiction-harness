import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticCollector,
  previewDeepSeekSessions,
  scanDeepSeekExportZip,
  type BinaryDownloader,
  type DeepSeekImportBatchResult,
  type LlmTransport,
  type ModelConfig,
  type Story,
} from '../../src/harness/index.ts';
import {
  DeepSeekImportPanel,
  filterMarkedImportSessions,
  selectDefaultImportSessionIds,
  shouldOpenImportedStoryDirectly,
  type DeepSeekImportPanelInitialState,
  type DeepSeekImportPanelProps,
} from '../../src/ui/DeepSeekImportPanel.tsx';
import { ImportPanel } from '../../src/ui/ImportPanel.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({
  useWebHistoryLayer: () => undefined,
}));

const FORBIDDEN_JARGON = [
  '外部会话',
  '原始剧本边界',
  '原始剧本',
  '近期窗口内',
  '将在续写时补齐进度',
  '只读平台诊断',
  '原始剧本定位到最新激活节点',
  'CONTENT_FILTER',
  'TIMEOUT',
  'INCOMPLETE',
  '待配置钥匙',
  '待配置密钥',
  '起始玩家轮次',
  '结束玩家轮次',
  '拆解故事蓝图',
  '确认故事蓝图',
];

function buildTestZip(): Uint8Array {
  const mdBytes = strToU8('# 世界观设定\n主角：沈知微。');
  const pngBytes = strToU8('png-payload');

  const sessionA = {
    id: 'sess-a',
    title: '哨兵向导长篇档',
    current_message_id: 4,
    inserted_at: '2026-10-12T08:00:00Z',
    updated_at: '2026-10-12T10:00:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-10-12T08:00:00Z',
        fragments: [
          {
            type: 'FILE',
            files: [
              { id: 'f1', file_name: '设定集.md', file_size: mdBytes.length, export_path: 'chat_sessions/sess-a/设定集.md', is_image: false },
              { id: 'f2', file_name: '封面.png', file_size: pngBytes.length, export_path: 'chat_sessions/sess-a/封面.png', is_image: true },
            ],
          },
          { type: 'REQUEST', content: '按设定与规则开始第一幕角色扮演。' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-10-12T08:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '第一幕：白塔警报响起，主角沈知微推开走廊尽头的铁门。' }],
      },
      {
        id: 3,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-10-12T08:05:00Z',
        fragments: [{ type: 'REQUEST', content: '查看监控室记录' }],
      },
      {
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        status: 'TIMEOUT',
        inserted_at: '2026-10-12T08:06:00Z',
        fragments: [{ type: 'RESPONSE', content: '屏幕闪烁着雪花。' }],
      },
    ],
  };

  const sessionB = {
    id: 'sess-b',
    title: '古风推理档',
    current_message_id: 2,
    inserted_at: '2026-11-01T08:00:00Z',
    updated_at: '2026-11-01T09:00:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-01T08:00:00Z',
        fragments: [{ type: 'REQUEST', content: '规则：每轮输出角色状态栏，开局在山庄前厅。' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'INCOMPLETE',
        inserted_at: '2026-11-01T08:01:00Z',
        fragments: [{ type: 'RESPONSE', content: '山庄灯笼在风雪中摇晃。' }],
      },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/sess-a.json': strToU8(JSON.stringify(sessionA)),
    'chat_sessions/sess-b.json': strToU8(JSON.stringify(sessionB)),
    'chat_sessions/sess-a/设定集.md': mdBytes,
    'chat_sessions/sess-a/封面.png': pngBytes,
  });
}

const dummyConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  memoryOnly: true,
};

const dummyTransport: LlmTransport = {
  async *streamChat() {
    yield { contentDelta: 'ok', finishReason: 'stop' };
  },
};

const dummyDownloader: BinaryDownloader = {
  async downloadZipBytes() {
    throw new Error('not used');
  },
};

function renderDeepSeekPanel(
  overrides: Partial<DeepSeekImportPanelProps> = {},
  initialState?: DeepSeekImportPanelInitialState,
): string {
  const props: DeepSeekImportPanelProps = {
    config: dummyConfig,
    transport: dummyTransport,
    binaryDownloader: dummyDownloader,
    hasCredentials: true,
    byokOpen: false,
    onRequireByok: () => undefined,
    onImportBatch: async () => ({ stories: [], previews: [], summaryStatuses: {} }),
    onImportBusyChange: () => undefined,
    onContinueStory: () => undefined,
    diagnostics: createDiagnosticCollector({ platform: 'web' }),
    onPackageDiagnostics: () => undefined,
    onCancel: () => undefined,
    ...overrides,
    initialState,
  };
  return renderToStaticMarkup(createElement(DeepSeekImportPanel, props));
}

function expectNoJargon(markup: string) {
  for (const term of FORBIDDEN_JARGON) {
    expect(markup).not.toContain(term);
  }
}

describe('V0.2-08 DeepSeek zero-jargon 2-step import UI & ImportPanel', () => {
  it('renders Step 1 as local .zip first with HTTPS link tucked in a collapsible disclosure and 2-step progress', () => {
    const markup = renderDeepSeekPanel();
    expect(markup).toContain('第 1 步，共 2 步');
    expect(markup).toContain('data-testid="deepseek-zip-picker"');
    expect(markup).toContain('data-testid="deepseek-footer-zip-picker"');
    expect(markup).toContain('<details class="import-url-details"');
    expect(markup).toContain('通过 HTTPS 下载链接导入');
    expect(markup).not.toContain('ds-source-tabs');
    expectNoJargon(markup);
  });

  it('renders Step 2 with new filter tabs, natural-language AI filter bar, duplicate pills, and zero jargon', () => {
    const zipBytes = buildTestZip();
    const scan = scanDeepSeekExportZip(zipBytes);

    const step2Markup = renderDeepSeekPanel(
      {
        existingSessionIds: ['sess-a'],
        hasCredentials: false,
      },
      {
        zipBytes,
        scanResult: scan,
        selectedIds: ['sess-b'],
        filterMode: 'all',
      },
    );

    expect(step2Markup).toContain('第 2 步，共 2 步');
    expect(step2Markup).toContain('推荐导入');
    expect(step2Markup).toContain('全部');
    expect(step2Markup).toContain('AI 帮你挑');
    expect(step2Markup).toContain('已导入过');
    expect(step2Markup).toContain('原平台未完整生成');
    expect(step2Markup).toContain('导入并开始');
    expectNoJargon(step2Markup);

    const aiFilterMarkup = renderDeepSeekPanel(
      {
        existingSessionIds: ['sess-a'],
        hasCredentials: false,
      },
      {
        zipBytes,
        scanResult: scan,
        selectedIds: ['sess-b'],
        filterMode: 'ai',
      },
    );
    expect(aiFilterMarkup).toContain('data-testid="ds-ai-filter-input"');
    expect(aiFilterMarkup).toContain('连接 DeepSeek');
    expectNoJargon(aiFilterMarkup);

    // Default selection leaves already-imported session unchecked
    const marked = scan.sessions.map((s) => ({
      ...s,
      alreadyImported: s.sessionId === 'sess-a',
    }));
    expect(selectDefaultImportSessionIds(marked)).toEqual(['sess-b']);
    expect(
      selectDefaultImportSessionIds(marked.map((s) => ({ ...s, alreadyImported: true }))),
    ).toEqual([]);

    // Filter helper handles 推荐导入 / 全部 / AI 帮你挑 cleanly
    expect(filterMarkedImportSessions(marked, 'all', '', null)).toHaveLength(2);
    expect(filterMarkedImportSessions(marked, 'ai', '', new Set(['sess-a'])).map((s) => s.sessionId)).toEqual(['sess-a']);
  });

  it('renders preview sheet without numeric turn-range inputs and with gentle attachment/interruption copy', () => {
    const zipBytes = buildTestZip();
    const scan = scanDeepSeekExportZip(zipBytes);

    const previewMarkup = renderDeepSeekPanel(
      {},
      {
        zipBytes,
        scanResult: scan,
        selectedIds: ['sess-a'],
        previewSessionId: 'sess-a',
      },
    );

    expect(previewMarkup).toContain('data-testid="deepseek-preview-sheet"');
    expect(previewMarkup).toContain('已整理进故事设定');
    expect(previewMarkup).toContain('设定集.md');
    expect(previewMarkup).toContain('图片与 PDF 仅保留原文件备查');
    expect(previewMarkup).toContain('原平台未完整生成');
    expect(previewMarkup).not.toContain('ds-script-start');
    expect(previewMarkup).not.toContain('ds-script-end');
    expect(previewMarkup).not.toContain('import-range-details');
    expectNoJargon(previewMarkup);
  });

  it('bypasses receipt for single-session import and shows clean multi-session receipt for >= 2 sessions', () => {
    const zipBytes = buildTestZip();
    const scan = scanDeepSeekExportZip(zipBytes);
    const previews = previewDeepSeekSessions(zipBytes, ['sess-a', 'sess-b']);

    const singleBatch: DeepSeekImportBatchResult = {
      stories: [previews[0].story],
      previews: [previews[0]],
      summaryStatuses: { [previews[0].story.id]: 'within_window' },
    };
    const multiBatch: DeepSeekImportBatchResult = {
      stories: [previews[0].story, previews[1].story],
      previews,
      summaryStatuses: {
        [previews[0].story.id]: 'within_window',
        [previews[1].story.id]: 'pending_key',
      },
    };

    expect(shouldOpenImportedStoryDirectly(singleBatch)).toBe(true);
    expect(shouldOpenImportedStoryDirectly(multiBatch)).toBe(false);

    const receiptMarkup = renderDeepSeekPanel(
      {},
      {
        zipBytes,
        scanResult: scan,
        receipt: multiBatch,
      },
    );
    expect(receiptMarkup).toContain('data-testid="deepseek-import-receipt"');
    expect(receiptMarkup).toContain('已导入 2 个故事');
    expect(receiptMarkup).toContain('可直接继续');
    expect(receiptMarkup).toContain('连接 DeepSeek 后可续写');
    expect(receiptMarkup).toContain('已整理进故事设定：设定集.md');
    expect(receiptMarkup).toContain('图片与 PDF 仅保留原文件备查');
    expect(receiptMarkup).toContain(`data-testid="ds-receipt-open-${previews[0].story.id}"`);
    expect(receiptMarkup).toContain(`data-testid="ds-receipt-open-${previews[1].story.id}"`);
    expectNoJargon(receiptMarkup);
  });

  it('renders standalone ImportPanel script mode as a single-step Markdown setting flow with no StoryBlueprint gate', () => {
    const markup = renderToStaticMarkup(
      createElement(ImportPanel, {
        initialMode: 'script',
        config: dummyConfig,
        transport: dummyTransport,
        binaryDownloader: dummyDownloader,
        hasCredentials: false,
        byokOpen: false,
        onRequireByok: () => undefined,
        onImportDeepSeekBatch: async () => ({ stories: [], previews: [], summaryStatuses: {} }),
        onDeepSeekImportBusyChange: () => undefined,
        onContinueStory: () => undefined,
        diagnostics: createDiagnosticCollector({ platform: 'web' }),
        onPackageDiagnostics: () => undefined,
        onConfirmStory: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain('data-testid="import-panel"');
    expect(markup).toContain('data-testid="import-script-picker"');
    expect(markup).toContain('data-testid="import-script-submit"');
    expect(markup).toContain('导入并开始');
    expect(markup).toContain('故事设定');
    expect(markup).not.toContain('overlay-page-progress');
    expectNoJargon(markup);
  });
});
