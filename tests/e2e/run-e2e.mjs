import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ||
  '/Users/liuyuxuan/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(playwrightCorePath);

const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER_PATH,
  '/Users/liuyuxuan/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

function resolveBrowserExecutable() {
  const found = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No pre-installed Edge or cached Playwright Chromium binary found.');
  }
  return found;
}

function buildFixtureDocx() {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>星光训练营规则</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>属性</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>初始值</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>人气</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>50</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml) });
}

function buildSyntheticDeepSeekZipE2E() {
  const docxBytes = buildFixtureDocx();
  const fictionSession = {
    id: 'ds-e2e-fiction',
    title: '合成宫斗测试档',
    current_message_id: 4,
    inserted_at: '2026-11-15T10:00:00Z',
    updated_at: '2026-11-15T10:20:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:00:00Z',
        fragments: [
          {
            type: 'FILE',
            files: [
              {
                id: 'f1',
                file_name: '规则附件.docx',
                file_size: docxBytes.length,
                export_path: 'chat_sessions/ds-e2e-fiction/规则附件.docx',
                is_image: false,
              },
              {
                id: 'f2',
                file_name: '立绘.png',
                file_size: 256,
                export_path: 'chat_sessions/ds-e2e-fiction/立绘.png',
                is_image: true,
              },
              {
                id: 'f3',
                file_name: '老版本.doc',
                file_size: 256,
                export_path: 'chat_sessions/ds-e2e-fiction/老版本.doc',
                is_image: false,
              },
            ],
          },
          { type: 'REQUEST', content: '请按附件规则开始演绎第一幕，主角：沈小姐。' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:01:00Z',
        fragments: [
          { type: 'TOOL_OPEN', url: 'https://example.invalid', title: 'skip' },
          { type: 'RESPONSE', content: '第1章 初入星光营\n地点：主大厅\n请选择下一步。' },
        ],
      },
      {
        id: 3,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:05:00Z',
        fragments: [{ type: 'REQUEST', content: '前往东侧练歌房' }],
      },
      {
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-15T10:06:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '平台风控噪音应剥离' },
          { type: 'RESPONSE', content: '原进度抵达东侧练歌房。' },
        ],
      },
      {
        id: 5,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:07:00Z',
        fragments: [{ type: 'REQUEST', content: '前往西侧花园' }],
      },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:08:00Z',
        fragments: [{ type: 'RESPONSE', content: '旁支到达西侧花园。' }],
      },
    ],
  };
  const dailySession = {
    id: 'ds-e2e-null',
    title: null,
    current_message_id: 2,
    inserted_at: '2026-11-14T08:00:00Z',
    updated_at: '2026-11-14T08:01:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-14T08:00:00Z',
        fragments: [{ type: 'REQUEST', content: '解释一下 Promise.all 的用法' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-14T08:01:00Z',
        fragments: [{ type: 'RESPONSE', content: 'Promise.all 并行等待多个异步任务。' }],
      },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/ds-e2e-fiction.json': strToU8(JSON.stringify(fictionSession)),
    'chat_sessions/ds-e2e-null.json': strToU8(JSON.stringify(dailySession)),
    'chat_sessions/ds-e2e-fiction/规则附件.docx': docxBytes,
    'chat_sessions/ds-e2e-fiction/立绘.png': strToU8('fake-png-bytes'),
    'chat_sessions/ds-e2e-fiction/老版本.doc': strToU8('fake-doc-bytes'),
  });
}

function buildAmbiguousOverWindowZipE2E() {
  const messages = [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:00:00Z', fragments: [{ type: 'REQUEST', content: '你好呀' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '你好，请发剧本。' }] },
    { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:02:00Z', fragments: [{ type: 'REQUEST', content: '我准备好了' }] },
    { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:03:00Z', fragments: [{ type: 'RESPONSE', content: '请贴出设定。' }] },
    { id: 5, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:04:00Z', fragments: [{ type: 'REQUEST', content: '【E2E模糊剧本】主角：陆行舟。规则：每轮输出状态栏。' }] },
    { id: 6, parent_id: 5, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:05:00Z', fragments: [{ type: 'RESPONSE', content: '第一幕开始。' }] },
    { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:06:00Z', fragments: [{ type: 'REQUEST', content: '走向码头' }] },
    { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:07:00Z', fragments: [{ type: 'RESPONSE', content: '码头停着货船。' }] },
    { id: 9, parent_id: 8, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:08:00Z', fragments: [{ type: 'REQUEST', content: '登上货船甲板' }] },
    { id: 10, parent_id: 9, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:09:00Z', fragments: [{ type: 'RESPONSE', content: '船长室灯还亮着。' }] },
    { id: 11, parent_id: 10, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:10:00Z', fragments: [{ type: 'REQUEST', content: '敲响船长室门' }] },
    { id: 12, parent_id: 11, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:11:00Z', fragments: [{ type: 'RESPONSE', content: '门后传来脚步声。' }] },
  ];
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/ds-e2e-ambig.json': strToU8(
      JSON.stringify({
        id: 'ds-e2e-ambig',
        title: '模糊开局超窗长档',
        current_message_id: 12,
        inserted_at: '2026-11-16T08:00:00Z',
        updated_at: '2026-11-16T08:11:00Z',
        messages,
      }),
    ),
  });
}

async function startViteServer(port) {
  const srv = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite dev server timeout')), 15000);
    srv.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    srv.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
  return srv;
}

function sseResponse(payloads) {
  const chunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');
  return `${chunks}data: [DONE]\n\n`;
}

async function main() {
  const port = 4177;
  const srv = await startViteServer(port);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfh-e2e-suite-'));
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const replyCounts = new Map();
    let failNextBlueprintWith401 = false;
    let delayNextTurnMs = 0;
    let boundaryCallCount = 0;
    let lastTurnSystemText = '';

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';

      if (
        !sys.includes('严格只输出一个 JSON 对象') &&
        !sys.includes('剧情摘要压缩') &&
        !sys.includes('剧本边界定位') &&
        !sys.includes('分支梗概助手')
      ) {
        lastTurnSystemText = (reqBody.messages || [])
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n');
      }

      if (delayNextTurnMs > 0 && !sys.includes('严格只输出一个 JSON 对象') && !sys.includes('剧情摘要压缩')) {
        const waitMs = delayNextTurnMs;
        delayNextTurnMs = 0;
        await new Promise((r) => setTimeout(r, waitMs));
      }

      if (sys.includes('严格只输出一个 JSON 对象')) {
        if (failNextBlueprintWith401) {
          failNextBlueprintWith401 = false;
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Invalid API key' } }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      title: 'E2E训练营故事',
                      worldRules: ['每轮输出状态面板'],
                      protagonist: '练习生甲',
                      npcs: [{ name: '导师林', role: '声乐导师', traits: '严厉' }],
                      taboos: ['不可缺席公演'],
                      openingHook: '你推开训练室大门。',
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            },
          ]),
        });
        return;
      }

      if (sys.includes('剧本边界定位')) {
        boundaryCallCount += 1;
        const items = JSON.parse(lastMsg || '[]');
        const scriptNode = items.find((i) => String(i.snippet || '').includes('E2E模糊剧本'));
        const playNode = items.find((i) => String(i.snippet || '').includes('第一幕开始'));
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      scriptMessageIds: scriptNode ? [scriptNode.nodeId] : [],
                      firstPlayMessageId: playNode?.nodeId ?? null,
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            },
          ]),
        });
        return;
      }

      if (sys.includes('分支梗概助手')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: 'AI提炼：改道休息线稳妥推进。' }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      if (sys.includes('剧情摘要压缩')) {
        const sumText = lastMsg.includes('黑市线索')
          ? '【分支A摘要】含黑市线索'
          : lastMsg.includes('E2E模糊剧本') || lastMsg.includes('请贴出设定') || lastMsg.includes('码头')
            ? '【激活线压缩摘要】主角登上货船甲板。'
            : '【通用摘要】初入训练营';
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: sumText }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      const nextCount = (replyCounts.get(lastMsg) ?? 0) + 1;
      replyCounts.set(lastMsg, nextCount);
      const replyPrefix = nextCount === 1 ? '回执' : `回执#${nextCount}`;

      const content = [
        `${replyPrefix}：${lastMsg}`,
        '```text',
        `[状态 | 人气: 60 | 节点: ${lastMsg.slice(0, 6)}]`,
        '```',
        'A. 继续训练声乐',
        'B. 前往休息室',
      ].join('\n');

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([
          { choices: [{ delta: { reasoning_content: `推理(${lastMsg.slice(0, 4)})` } }] },
          { choices: [{ delta: { content }, finish_reason: 'stop' }] },
        ]),
      });
    });

    await page.route('https://cdn.deepseek.example/**', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.endsWith('/export-html.zip')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!DOCTYPE html><html><body>请登录 DeepSeek</body></html>',
        });
        return;
      }
      if (reqUrl.endsWith('/export-cors.zip')) {
        await route.abort('failed');
        return;
      }
      if (reqUrl.endsWith('/export-valid.zip')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/zip',
          body: Buffer.from(buildSyntheticDeepSeekZipE2E()),
        });
        return;
      }
      await route.fulfill({ status: 404, body: 'Not Found' });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

    // 0-url. DeepSeek HTTPS export link fetch (HTML login fallback, CORS fallback, and valid ZIP fetch)
    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.click('button[role="tab"]:has-text("粘贴导出 .zip 下载链接")');
    await page.waitForSelector('#deepseek-zip-url-input');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-html.zip');
    await page.click('button:has-text("拉取并预览")');
    await page.waitForSelector('[data-testid="deepseek-import-panel"] .error-banner:has-text("HTML")');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-cors.zip');
    await page.click('button:has-text("拉取并预览")');
    await page.waitForSelector('[data-testid="deepseek-import-panel"] .error-banner:has-text("CORS")');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-valid.zip');
    await page.click('button:has-text("拉取并预览")');
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    const urlPreviewText = await page.locator('[data-testid="deepseek-preview-card"]').textContent();
    if (!urlPreviewText?.includes('合成宫斗测试档')) {
      throw new Error(`Expected fetched ZIP preview, got: ${urlPreviewText}`);
    }
    // Complete story import directly from URL-fetched session list, verify active progress, then clean up
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('.turn-card.assistant:has-text("原进度抵达东侧练歌房")');
    while ((await page.locator('button[aria-label^="删除 "]').count()) > 0) {
      await page.locator('button[aria-label^="删除 "]').first().click();
      await page.waitForTimeout(50);
    }

    // 0. Keyless DeepSeek .zip import -> preview -> batch 1-to-1 import -> Continue This Story -> inline BYOK prompt -> stream
    const dsZipPath = path.join(tmpDir, 'deepseek-export.zip');
    fs.writeFileSync(dsZipPath, buildSyntheticDeepSeekZipE2E());
    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', dsZipPath);
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    const previewCardText = await page.locator('[data-testid="deepseek-preview-card"]').textContent();
    if (
      !previewCardText?.includes('规则附件.docx') ||
      !previewCardText?.includes('另存为 .docx') ||
      !previewCardText?.includes('⑂ 2')
    ) {
      throw new Error(`DeepSeek preview missing attachment/branch cues: ${previewCardText}`);
    }

    // Check 390px narrow mobile viewport on DeepSeek preview panel
    await page.setViewportSize({ width: 390, height: 844 });
    const dsOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (dsOverflow.scrollWidth > dsOverflow.clientWidth) {
      throw new Error(`Horizontal overflow on mobile DeepSeek import (${dsOverflow.scrollWidth} > ${dsOverflow.clientWidth})`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });

    // Also select the second (null-title) session to verify 1-to-1 batch import without API Key
    await page.locator('.ds-session-item', { hasText: 'Promise.all' }).locator('input[type="checkbox"]').check();
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    const receiptText = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!receiptText?.includes('新增 2 部独立故事')) {
      throw new Error(`Expected 2 imported stories in receipt, got: ${receiptText}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('.turn-card.assistant:has-text("原进度抵达东侧练歌房")');
    const diagText = await page.locator('[data-testid="turn-diagnostics"]').textContent();
    if (!diagText?.includes('CONTENT_FILTER') || !diagText?.includes('CONTENT_RISK')) {
      throw new Error(`Expected read-only NodeDiagnostics badge, got: ${diagText}`);
    }

    // Verify IndexedDB reload keeps DeepSeek stories + diagnostics
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.turn-card.assistant:has-text("原进度抵达东侧练歌房")');
    if ((await page.locator('.story-item').count()) !== 2) {
      throw new Error('Expected 2 independent DeepSeek stories persisted in IndexedDB');
    }

    // Trigger next turn without API key -> inline BYOK prompt opens -> fill key -> saves & continues streaming
    await page.fill('#turn-input', '推开练歌房钢琴盖');
    await page.click('button:has-text("发送行动")');
    await page.waitForSelector('[data-testid="byok-inline-prompt"]');
    await page.fill('#byok-api-key', 'sk-e2e-inline');
    await page.click('button:has-text("保存配置并立即继续")');
    await page.waitForSelector('.turn-card.assistant:has-text("回执：推开练歌房钢琴盖")');

    // 0a. Keyless ambiguous + over-window import -> pending_key -> complete summary + blueprint after inline key
    await page.fill('#cfg-api-key', '');
    await page.waitForTimeout(50);
    const ambigZipPath = path.join(tmpDir, 'deepseek-ambiguous-long.zip');
    fs.writeFileSync(ambigZipPath, buildAmbiguousOverWindowZipE2E());
    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', ambigZipPath);
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    // Exercise collapsed manual script range override in preview and then clear back to auto
    await page.locator('details summary:has-text("手动调整原始剧本起点")').click();
    await page.fill('#ds-script-start', '3');
    await page.fill('#ds-script-end', '3');
    const overridePreviewText = await page.locator('[data-testid="deepseek-preview-card"]').textContent();
    if (!overridePreviewText?.includes('已自动锁定剧本')) {
      throw new Error(`Expected manual override to lock script, got: ${overridePreviewText}`);
    }
    await page.fill('#ds-script-start', '');
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    const keylessAmbigReceipt = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!keylessAmbigReceipt?.includes('待配置密钥后补充')) {
      throw new Error(`Expected pending_key badge in receipt, got: ${keylessAmbigReceipt}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('.turn-card.assistant:has-text("门后传来脚步声")');
    await page.click('button:has-text("补算剧情摘要")');
    await page.waitForSelector('[data-testid="byok-inline-prompt"]');
    await page.fill('#byok-api-key', 'sk-e2e-inline');
    await page.click('button:has-text("保存配置并立即继续")');
    await page.waitForSelector('[data-testid="active-plot-summary"]:has-text("【激活线压缩摘要】")');
    await page.locator('details summary:has-text("故事蓝图与原始剧本锚定")').click();
    await page.click('button:has-text("补拆蓝图")');
    await page.waitForSelector('button:has-text("补拆蓝图")', { state: 'detached' });

    // 0b. Keyed imports: strong turn-1 skips boundary locator; ambiguous runs boundary locator once + compresses + carries both on continuation
    boundaryCallCount = 0;
    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', dsZipPath);
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    if (boundaryCallCount !== 0) {
      throw new Error(`Expected 0 boundary LLM calls for strong turn-1 script, got ${boundaryCallCount}`);
    }

    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', ambigZipPath);
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    if (boundaryCallCount !== 1) {
      throw new Error(`Expected 1 boundary LLM call for ambiguous opening, got ${boundaryCallCount}`);
    }
    const ambigReceipt = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!ambigReceipt?.includes('已压缩激活线摘要')) {
      throw new Error(`Expected compressed summary status in receipt, got: ${ambigReceipt}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('.turn-card.assistant:has-text("门后传来脚步声")');
    const ambigSummary = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!ambigSummary?.includes('【激活线压缩摘要】')) {
      throw new Error(`Expected compressed active summary in StoryReview, got: ${ambigSummary}`);
    }
    await page.fill('#turn-input', '推开船长室门');
    await page.click('button:has-text("发送行动")');
    await page.waitForSelector('.turn-card.assistant:has-text("回执：推开船长室门")');
    if (
      !lastTurnSystemText.includes('【E2E模糊剧本】') ||
      !lastTurnSystemText.includes('【激活线压缩摘要】') ||
      lastTurnSystemText.includes('你好呀')
    ) {
      throw new Error(`Continuation system prompt missing refined anchor or summary: ${lastTurnSystemText}`);
    }

    // Clean up DeepSeek stories before running existing script-import workflow assertions
    while ((await page.locator('button[aria-label^="删除 "]').count()) > 0) {
      await page.locator('button[aria-label^="删除 "]').first().click();
      await page.waitForTimeout(50);
    }

    // 1. Security notice + memory-only key toggle
    const notice = await page.locator('.notice-box').textContent();
    if (!notice?.includes('localStorage')) throw new Error('Security notice missing');
    await page.fill('#cfg-api-key', 'sk-e2e-dummy');
    await page.click('#cfg-memory-only');
    if ((await page.evaluate(() => localStorage.getItem('lfh.model_config.api_key'))) !== null) {
      throw new Error('Expected localStorage apiKey purged on memoryOnly');
    }

    // 2. Import synthetic .docx fixture -> extract & tweak blueprint -> confirm story
    const docxPath = path.join(tmpDir, 'fixture.docx');
    fs.writeFileSync(docxPath, buildFixtureDocx());
    await page.click('button:has-text("导入剧本 / 新建故事")');
    await page.setInputFiles('#import-file', docxPath);
    await page.waitForFunction(() => {
      const el = document.querySelector('#import-raw-script');
      return el && 'value' in el && String(el.value).includes('| 人气 | 50 |');
    });
    await page.click('button:has-text("拆解故事蓝图")');
    await page.waitForSelector('#bp-title');
    await page.click('button:has-text("确认蓝图并开始故事")');

    // 3. Play 6 turns (including clicking A choice button & rendering HUD panel + separated reasoning)
    await page.click('button:has-text("开启第一幕")');
    await page.waitForSelector('.hud-panel');
    const firstChoiceActions = [
      '第二轮黑市线索',
      '第三轮打探消息',
      '第四轮进入暗巷',
      '第五轮接头',
    ];
    for (const act of firstChoiceActions) {
      await page.fill('#turn-input', act);
      await page.click('button:has-text("发送行动")');
      await page.waitForSelector(`.turn-card.assistant:has-text("回执：${act}")`);
    }
    await page.click('button.choice-btn:has-text("A. 继续训练声乐")');
    await page.waitForSelector('.turn-card.assistant:has-text("回执：A. 继续训练声乐")');

    // 4. Verify explicit Story Review (visible without opening <details>) & Branch A active
    const reviewVisible = await page.locator('[data-testid="story-review"]').isVisible();
    if (!reviewVisible) {
      throw new Error('Expected Story Review panel to be explicitly visible');
    }
    const sumA = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!sumA?.includes('【分支A摘要】含黑市线索')) {
      throw new Error(`Expected Branch A summary, got: ${sumA}`);
    }

    // 5. Rewind & edit Turn 2 user node to fork Branch B -> verify Plot Summary rolled back & Story Tree fork appears
    const turn2Card = page.locator('.turn-card.user').nth(1);
    await turn2Card.locator('button:has-text("撤回并编辑重发")').click();
    await turn2Card.locator('textarea').fill('第二轮改道休息');
    await turn2Card.locator('button:has-text("提交并生成新分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执：第二轮改道休息")');
    const sumB = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (sumB?.includes('黑市线索')) {
      throw new Error(`Branch A leaked into Branch B summary: ${sumB}`);
    }

    // 5b. Story Tree: verify linear span folding, fork badge ⑂ 2, expand fork, rename Branch B, AI gist, switch back to Branch A
    const spanText = await page.locator('[data-testid="story-tree-span"]').first().textContent();
    if (!spanText?.includes('第 1–2 轮') && !spanText?.includes('第 1')) {
      throw new Error(`Expected folded span in Story Tree, got: ${spanText}`);
    }
    const forkBtn = page.locator('[data-testid^="story-tree-fork-"]').first();
    const forkBtnText = await forkBtn.textContent();
    if (!forkBtnText?.includes('⑂ 2')) {
      throw new Error(`Expected fork badge ⑂ 2 in Story Tree, got: ${forkBtnText}`);
    }
    await forkBtn.click();
    await page.waitForSelector('.story-tree-siblings');
    const siblingB = page.locator('.story-tree-sibling.active');
    await siblingB.locator('button:has-text("重命名")').click();
    await siblingB.locator('input[aria-label="分支名称"]').fill('休息支线');
    await siblingB.locator('button:has-text("保存名称")').click();
    await page.waitForSelector('[data-testid="story-review"]:has-text("休息支线")');

    // On-demand AI gist on active sibling branch
    await siblingB.locator('button:has-text("AI 提炼梗概")').click();
    await page.waitForSelector('.story-tree-gist:has-text("AI提炼：改道休息线稳妥推进")');

    // Switch back to Branch A via Story Tree sibling button
    const nonActiveSibling = page.locator('.story-tree-sibling:not(.active)').first();
    await nonActiveSibling.locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执：A. 继续训练声乐")');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.story-item.active');
    if ((await page.inputValue('#cfg-api-key')) !== '') {
      throw new Error('Expected memoryOnly apiKey cleared on reload');
    }
    const sumAfterReload = await page.locator('[data-testid="active-plot-summary"]').textContent();
    const pagerAfterReload = await page.locator('.turn-card.user').nth(1).locator('.branch-pager').textContent();
    if (!sumAfterReload?.includes('【分支A摘要】含黑市线索') || !pagerAfterReload?.includes('1 / 2')) {
      throw new Error('IndexedDB reload did not restore branch tree & summary');
    }
    // Verify renamed Branch B survived reload in Story Tree
    await page.locator('[data-testid^="story-tree-fork-"]').first().click();
    await page.waitForSelector('.story-tree-siblings:has-text("休息支线")');

    // 7. Export JSON backup -> delete story -> re-import JSON backup
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("导出 JSON")'),
    ]);
    const backupFile = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(backupFile);
    await page.click('button[aria-label^="删除 "]');
    await page.waitForSelector('.story-item', { state: 'detached' });
    await page.setInputFiles('input[aria-label="导入故事 JSON 备份"]', backupFile);
    await page.waitForSelector('.story-item.active');
    await page.waitForSelector('.turn-card.assistant:has-text("回执：A. 继续训练声乐")');

    // 8. Collapsible reasoning panel rendering (.reasoning-content)
    const firstAssistant = page.locator('.turn-card.assistant').first();
    const reasoningDetails = firstAssistant.locator('.reasoning-details');
    const reasoningContent = firstAssistant.locator('.reasoning-content');
    if ((await reasoningDetails.evaluate((el) => el.open)) || (await reasoningContent.isVisible())) {
      throw new Error('Expected .reasoning-details to be collapsed by default');
    }
    await reasoningDetails.locator('summary').click();
    if (!(await reasoningDetails.evaluate((el) => el.open)) || !(await reasoningContent.isVisible())) {
      throw new Error('Expected .reasoning-content visible after expanding');
    }
    const reasoningText = await reasoningContent.textContent();
    if (!reasoningText?.includes('推理(')) {
      throw new Error(`Unexpected reasoning content: ${reasoningText}`);
    }
    await reasoningDetails.locator('summary').click();
    if (await reasoningContent.isVisible()) {
      throw new Error('Expected .reasoning-content hidden after collapsing');
    }

    // 9. regenerateNode & rewindToNode UI actions (re-supply key cleared by memoryOnly reload)
    await page.fill('#cfg-api-key', 'sk-e2e-dummy');
    const lastAssistant = page.locator('.turn-card.assistant').last();
    await lastAssistant.locator('button:has-text("重新生成分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执#2：A. 继续训练声乐")');
    const regenPager = await page.locator('.turn-card.assistant').last().locator('.branch-pager').textContent();
    if (!regenPager?.includes('2 / 2')) {
      throw new Error(`Expected regenerated branch pager 2 / 2, got: ${regenPager}`);
    }
    await page.locator('.turn-card.assistant').last().locator('button[aria-label="上一分支"]').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执：A. 继续训练声乐")');

    await firstAssistant.locator('button:has-text("回溯至此")').click();
    await page.waitForFunction(() => document.querySelectorAll('.turn-card.assistant').length === 1);
    if ((await firstAssistant.locator('button:has-text("回溯至此")').count()) !== 0) {
      throw new Error('Expected active rewound leaf not to show 回溯至此');
    }
    await page.click('[data-testid="context-overview"] summary');
    const rewoundSummary = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!rewoundSummary?.includes('尚未触发压缩')) {
      throw new Error(`Expected rewound summary reset, got: ${rewoundSummary}`);
    }

    // 10. .txt and .md file import + HTTP 401 non-blocking blueprint error banner
    const txtPath = path.join(tmpDir, 'notes.txt');
    const mdPath = path.join(tmpDir, 'camp.md');
    fs.writeFileSync(txtPath, '【纯文本剧本】\n规则：每晚点名。', 'utf8');
    fs.writeFileSync(mdPath, '# 星光练习生 Markdown\n- 不可迟到\n```\n[体力: 100]\n```', 'utf8');

    await page.click('button:has-text("导入剧本 / 新建故事")');
    await page.setInputFiles('#import-file', txtPath);
    await page.waitForFunction(() => {
      const el = document.querySelector('#import-raw-script');
      return el && 'value' in el && String(el.value).includes('【纯文本剧本】');
    });

    await page.setInputFiles('#import-file', mdPath);
    await page.waitForFunction(() => {
      const el = document.querySelector('#import-raw-script');
      return el && 'value' in el && String(el.value).includes('# 星光练习生 Markdown');
    });

    failNextBlueprintWith401 = true;
    await page.fill('#cfg-api-key', 'sk-e2e-invalid');
    await page.click('button:has-text("拆解故事蓝图")');
    await page.waitForSelector('.import-panel .error-banner');
    const bpError = await page.locator('.import-panel .error-banner').textContent();
    if (!bpError?.includes('401')) {
      throw new Error(`Expected 401 error banner in ImportPanel, got: ${bpError}`);
    }
    // Non-blocking: user can still skip to manual blueprint fallback
    await page.click('button:has-text("跳过模型拆解")');
    await page.waitForSelector('#bp-title');
    await page.click('button:has-text("确认蓝图并开始故事")');
    await page.waitForFunction(() => document.querySelectorAll('.story-item').length === 2);

    // 10b. Mid-stream abort via 停止生成 must NOT re-submit the composer form
    delayNextTurnMs = 3000;
    await page.fill('#turn-input', '测试停止生成不重发');
    await page.click('button:has-text("发送行动")');
    await page.waitForSelector('button:has-text("停止生成")');
    await page.click('button:has-text("停止生成")');
    await page.waitForSelector('.main-stage > .error-banner');
    const abortMsg = await page.locator('.main-stage > .error-banner').textContent();
    if (!abortMsg?.includes('已中止本次生成')) {
      throw new Error(`Expected abort banner, got: ${abortMsg}`);
    }
    if ((await page.inputValue('#turn-input')) !== '测试停止生成不重发') {
      throw new Error('Expected aborted input restored cleanly without re-submitting');
    }
    if ((await page.locator('.turn-card.user, .turn-card.assistant').count()) !== 0) {
      throw new Error('Expected aborted turn not to commit any turn card');
    }

    // 11. Mobile narrow viewport check (390x844, no horizontal overflow) on multi-branch story
    await page.locator('.story-select-btn', { hasText: 'E2E训练营故事' }).click();
    await page.waitForSelector('[data-testid^="story-tree-fork-"]');
    await page.setViewportSize({ width: 390, height: 844 });
    const checkNoHorizontalOverflow = async (label) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth) {
        throw new Error(`Horizontal overflow on ${label} (${scrollWidth} > ${clientWidth})`);
      }
    };
    await page.locator('[data-testid="story-review"]').scrollIntoViewIfNeeded();
    await checkNoHorizontalOverflow('mobile main view');
    const treeForkMobile = page.locator('[data-testid^="story-tree-fork-"]').first();
    await treeForkMobile.click();
    await page.waitForSelector('.story-tree-siblings');
    await checkNoHorizontalOverflow('mobile story tree expanded');
    await page.click('button:has-text("导入剧本 / 新建故事")');
    await page.waitForSelector('.import-panel');
    await checkNoHorizontalOverflow('mobile import view');

    await runComprehensiveSpec18MobileE2E(browser, port, tmpDir);

    console.log('ALL_E2E_CHECKS_PASSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await browser.close();
    srv.kill('SIGTERM');
  }
}

function buildComprehensiveSpec18ZipE2E() {
  const docxBytes = buildFixtureDocx();
  const sciSession = {
    id: 'spec18-sci',
    title: '量子退相干数值研究',
    current_message_id: 2,
    inserted_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:02:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-10T08:00:00Z', fragments: [{ type: 'REQUEST', content: 'SELECT * FROM runs;' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-10T08:02:00Z', fragments: [{ type: 'RESPONSE', content: '可以使用主方程估算。' }] },
    ],
  };
  const nullSession = {
    id: 'spec18-null',
    title: null,
    current_message_id: 2,
    inserted_at: '2026-11-11T08:00:00Z',
    updated_at: '2026-11-11T08:01:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-11T08:00:00Z', fragments: [{ type: 'REQUEST', content: '周末高铁时刻查询' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-11T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '周六早九点有车次。' }] },
    ],
  };
  const fictionSession = {
    id: 'spec18-two-fork',
    title: '庄园双线E2E总验',
    current_message_id: 21,
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
              { id: 'd1', file_name: '庄园规则.docx', file_size: docxBytes.length, export_path: 'chat_sessions/spec18-two-fork/庄园规则.docx', is_image: false },
              { id: 'p1', file_name: '封面.png', file_size: 128, export_path: 'chat_sessions/spec18-two-fork/封面.png', is_image: true },
              { id: 'doc1', file_name: '旧设.doc', file_size: 128, export_path: 'chat_sessions/spec18-two-fork/旧设.doc', is_image: false },
            ],
          },
          { type: 'REQUEST', content: '按附件规则开局。' },
        ],
      },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:01:00Z', fragments: [{ type: 'RESPONSE', content: '第1章 雨夜大宅\n地点：门厅' }] },
      { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:02:00Z', fragments: [{ type: 'REQUEST', content: '查看大宅地图' }] },
      { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:03:00Z', fragments: [{ type: 'RESPONSE', content: '大宅分为东楼与西塔。' }] },
      // Fork 1 at id=4 -> Branch A (12 post-fork nodes -> Event X folded into summary!) & Branch B (12 post-fork nodes -> Event Y folded!)
      { id: 5, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:04:00Z', fragments: [{ type: 'REQUEST', content: '走东楼触发事件X_银钥匙' }] },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-12T10:05:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '风控噪声' },
          { type: 'RESPONSE', content: '事件X_银钥匙已获取。' },
        ],
      },
      { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:06:00Z', fragments: [{ type: 'REQUEST', content: '检视银钥匙' }] },
      // Fork 2 at id=7
      { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:07:00Z', fragments: [{ type: 'RESPONSE', content: '银钥匙指向东楼密室。' }] },
      { id: 17, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:07:30Z', fragments: [{ type: 'RESPONSE', content: '银钥匙备选细节。' }] },
      { id: 9, parent_id: 8, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:08:00Z', fragments: [{ type: 'REQUEST', content: '进入东楼密室' }] },
      { id: 10, parent_id: 9, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:00Z', fragments: [{ type: 'RESPONSE', content: '东楼走廊尽头出现暗门。' }] },
      { id: 18, parent_id: 10, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:09:10Z', fragments: [{ type: 'REQUEST', content: '推开东楼暗门' }] },
      { id: 19, parent_id: 18, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:20Z', fragments: [{ type: 'RESPONSE', content: '暗门后是密室石阶。' }] },
      { id: 20, parent_id: 19, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:09:30Z', fragments: [{ type: 'REQUEST', content: '走下密室石阶' }] },
      { id: 21, parent_id: 20, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:40Z', fragments: [{ type: 'RESPONSE', content: '抵达东楼密室终点。' }] },
      // Branch B (mutually exclusive Event Y, 12 post-fork nodes)
      { id: 11, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:10:00Z', fragments: [{ type: 'REQUEST', content: '走西塔触发事件Y_西塔毒药' }] },
      { id: 12, parent_id: 11, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:11:00Z', fragments: [{ type: 'RESPONSE', content: '事件Y_西塔毒药已发现。' }] },
      { id: 13, parent_id: 12, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:12:00Z', fragments: [{ type: 'REQUEST', content: '封存毒药样本' }] },
      { id: 14, parent_id: 13, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:13:00Z', fragments: [{ type: 'RESPONSE', content: '发现毒药来源指向温室。' }] },
      { id: 15, parent_id: 14, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:14:00Z', fragments: [{ type: 'REQUEST', content: '清点西塔笔记' }] },
      { id: 16, parent_id: 15, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:15:00Z', fragments: [{ type: 'RESPONSE', content: '笔记记录了温室配比。' }] },
      { id: 22, parent_id: 16, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:15:10Z', fragments: [{ type: 'REQUEST', content: '收好西塔实验记录' }] },
      { id: 23, parent_id: 22, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:15:20Z', fragments: [{ type: 'RESPONSE', content: '抵达西塔终点。' }] },
    ],
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/spec18-sci.json': strToU8(JSON.stringify(sciSession)),
    'chat_sessions/spec18-null.json': strToU8(JSON.stringify(nullSession)),
    'chat_sessions/spec18-two-fork.json': strToU8(JSON.stringify(fictionSession)),
    'chat_sessions/spec18-two-fork/庄园规则.docx': docxBytes,
    'chat_sessions/spec18-two-fork/封面.png': strToU8('png'),
    'chat_sessions/spec18-two-fork/旧设.doc': strToU8('doc'),
  });
}

async function runComprehensiveSpec18MobileE2E(browser, port, tmpDir) {
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await mobileCtx.newPage();
  const capturedTurns = [];

  try {
    await page.route('https://cdn.deepseek.example/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body>请登录</body></html>',
      });
    });

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const allText = (reqBody.messages || []).map((m) => m.content).join('\n');

      if (sys.includes('剧情摘要压缩')) {
        const summary = allText.includes('事件Y_西塔毒药')
          ? '【西塔线摘要】已发现事件Y_西塔毒药。'
          : allText.includes('事件X_银钥匙')
            ? '【东楼线摘要】已取得事件X_银钥匙。'
            : '【开局摘要】查看大宅地图。';
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: summary }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      if (sys.includes('严格只输出一个 JSON 对象')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      title: '庄园双线E2E总验',
                      worldRules: ['每轮输出状态栏'],
                      protagonist: '调查员',
                      npcs: [],
                      taboos: [],
                      openingHook: '雨夜大宅',
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            },
          ]),
        });
        return;
      }

      capturedTurns.push(allText);
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content: `窄屏续写：${lastMsg}` }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

    const assertNoOverflow = async (label) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth) {
        throw new Error(`390px overflow on ${label} (${scrollWidth} > ${clientWidth})`);
      }
    };

    // 1. Link error fallback -> upload comprehensive zip -> search & preview -> keyless import -> Continue This Story
    await page.click('button:has-text("从 DeepSeek 继续")');
    await page.click('button[role="tab"]:has-text("粘贴导出 .zip 下载链接")');
    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/login.zip');
    await page.click('button:has-text("拉取并预览")');
    await page.waitForSelector('[data-testid="deepseek-import-panel"] .error-banner:has-text("HTML")');
    await page.click('button:has-text("改用本地 .zip 文件导入")');

    const zipPath = path.join(tmpDir, 'spec18-comprehensive.zip');
    fs.writeFileSync(zipPath, buildComprehensiveSpec18ZipE2E());
    await page.setInputFiles('#deepseek-zip-input', zipPath);
    await page.waitForSelector('[data-testid="deepseek-preview-card"]');
    await page.fill('input[aria-label="搜索 DeepSeek 会话"]', '庄园');
    const previewText = await page.locator('[data-testid="deepseek-preview-card"]').textContent();
    if (
      !previewText?.includes('2 处') ||
      !previewText?.includes('庄园规则.docx') ||
      !previewText?.includes('封面.png') ||
      !previewText?.includes('另存为 .docx') ||
      !previewText?.includes('只读平台诊断标记')
    ) {
      throw new Error(`Unexpected comprehensive preview: ${previewText}`);
    }
    await assertNoOverflow('spec18 mobile preview');

    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]:has-text("待配置密钥后补充")');
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('.turn-card.assistant:has-text("抵达东楼密室终点")');
    await page.waitForSelector('[data-testid="turn-diagnostics"]:has-text("CONTENT_FILTER")');
    await assertNoOverflow('spec18 mobile main play');

    // 2. Expand Fork 1 -> rename both branches -> switch to Branch B -> inline BYOK -> continue Branch B
    const fork1Btn = page.locator('[data-testid^="story-tree-fork-"]').first();
    await fork1Btn.click();
    await page.waitForSelector('.story-tree-siblings');

    const branchASibling = page.locator('.story-tree-sibling', { hasText: '东楼' }).first();
    await branchASibling.locator('button:has-text("重命名")').click();
    await branchASibling.locator('input[aria-label="分支名称"]').fill('银钥东楼线');
    await branchASibling.locator('button:has-text("保存名称")').click();

    const branchBSibling = page.locator('.story-tree-sibling', { hasText: '西塔' }).first();
    await branchBSibling.locator('button:has-text("重命名")').click();
    await branchBSibling.locator('input[aria-label="分支名称"]').fill('毒药西塔线');
    await branchBSibling.locator('button:has-text("保存名称")').click();

    await branchBSibling.locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("抵达西塔终点")');

    await page.fill('#turn-input', '追查西塔温室');
    await page.click('button:has-text("发送行动")');
    await page.waitForSelector('[data-testid="byok-inline-prompt"]');
    await page.fill('#byok-api-key', 'sk-spec18-mobile');
    await page.click('button:has-text("保存配置并立即继续")');
    await page.waitForSelector('.turn-card.assistant:has-text("窄屏续写：追查西塔温室")');

    const promptForB = capturedTurns[capturedTurns.length - 1] ?? '';
    if (!promptForB.includes('事件Y_西塔毒药') || promptForB.includes('事件X_银钥匙') || promptForB.includes('CONTENT_FILTER')) {
      throw new Error(`Branch B prompt contaminated: ${promptForB}`);
    }
    const reviewB = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!reviewB?.includes('事件Y_西塔毒药') || reviewB.includes('事件X_银钥匙')) {
      throw new Error(`StoryReview on Branch B not isolated: ${reviewB}`);
    }

    // 3. Switch back to Branch A -> lazy summary + continue Branch A -> verify StoryReview & prompt zero Event Y leak
    const fork1AfterB = page.locator('[data-testid^="story-tree-fork-"]').first();
    if ((await fork1AfterB.getAttribute('aria-expanded')) !== 'true') {
      await fork1AfterB.click();
    }
    await page.locator('.story-tree-sibling', { hasText: '银钥东楼线' }).locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("抵达东楼密室终点")');
    await page.waitForSelector('[data-testid="active-plot-summary"]:has-text("事件X_银钥匙")');
    const reviewA = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!reviewA?.includes('事件X_银钥匙') || reviewA.includes('事件Y_西塔毒药')) {
      throw new Error(`StoryReview on Branch A not isolated: ${reviewA}`);
    }

    await page.fill('#turn-input', '打开东楼密室');
    await page.click('button:has-text("发送行动")');
    await page.waitForSelector('.turn-card.assistant:has-text("窄屏续写：打开东楼密室")');

    const promptForA = capturedTurns[capturedTurns.length - 1] ?? '';
    if (!promptForA.includes('事件X_银钥匙') || promptForA.includes('事件Y_西塔毒药')) {
      throw new Error(`Branch A prompt contaminated: ${promptForA}`);
    }

    // 4. Reload browser -> verify IndexedDB restores branch names, active branch A, StoryReview, diagnostics, and zero 390px overflow
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.turn-card.assistant:has-text("窄屏续写：打开东楼密室")');
    await page.waitForSelector('[data-testid="story-review"]:has-text("银钥东楼线")');
    await page.waitForSelector('[data-testid="active-plot-summary"]:has-text("事件X_银钥匙")');
    await page.waitForSelector('[data-testid="turn-diagnostics"]:has-text("CONTENT_FILTER")');
    await page.locator('[data-testid^="story-tree-fork-"]').first().click();
    await page.waitForSelector('.story-tree-siblings:has-text("毒药西塔线")');
    await assertNoOverflow('spec18 mobile post-reload');
  } finally {
    await mobileCtx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
