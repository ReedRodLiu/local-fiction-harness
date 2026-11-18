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
    const replyCounts = new Map();
    let failNextBlueprintWith401 = false;
    let delayNextTurnMs = 0;

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';

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

    // 9. regenerateNode & rewindToNode UI actions
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
