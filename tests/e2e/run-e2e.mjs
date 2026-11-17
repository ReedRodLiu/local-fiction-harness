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

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';

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

      if (sys.includes('剧情摘要压缩')) {
        const sumText = lastMsg.includes('黑市线索')
          ? '【分支A摘要】含黑市线索'
          : '【通用摘要】初入训练营';
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: sumText }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      const content = [
        `回执：${lastMsg}`,
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

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

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

    // 4. Verify Plot Summary updated & Branch A active
    await page.click('[data-testid="context-overview"] summary');
    const sumA = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (!sumA?.includes('【分支A摘要】含黑市线索')) {
      throw new Error(`Expected Branch A summary, got: ${sumA}`);
    }

    // 5. Rewind & edit Turn 2 user node to fork Branch B -> verify Plot Summary rolled back
    const turn2Card = page.locator('.turn-card.user').nth(1);
    await turn2Card.locator('button:has-text("撤回并编辑重发")').click();
    await turn2Card.locator('textarea').fill('第二轮改道休息');
    await turn2Card.locator('button:has-text("提交并生成新分支")').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执：第二轮改道休息")');
    const sumB = await page.locator('[data-testid="active-plot-summary"]').textContent();
    if (sumB?.includes('黑市线索')) {
      throw new Error(`Branch A leaked into Branch B summary: ${sumB}`);
    }

    // 6. Switch back to Branch A, reload browser -> IndexedDB restores branch tree & summary
    await page.locator('.turn-card.user').nth(1).locator('button[aria-label="上一分支"]').click();
    await page.waitForSelector('.turn-card.assistant:has-text("回执：A. 继续训练声乐")');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.story-item.active');
    if ((await page.inputValue('#cfg-api-key')) !== '') {
      throw new Error('Expected memoryOnly apiKey cleared on reload');
    }
    await page.click('[data-testid="context-overview"] summary');
    const sumAfterReload = await page.locator('[data-testid="active-plot-summary"]').textContent();
    const pagerAfterReload = await page.locator('.turn-card.user').nth(1).locator('.branch-pager').textContent();
    if (!sumAfterReload?.includes('【分支A摘要】含黑市线索') || !pagerAfterReload?.includes('1 / 2')) {
      throw new Error('IndexedDB reload did not restore branch tree & summary');
    }

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

    console.log('ALL_E2E_CHECKS_PASSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await browser.close();
    srv.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
