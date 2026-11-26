import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viteBinary = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ||
  '/Users/liuyuxuan/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(playwrightCorePath);

const PORT = Number(process.env.LFH_E2E_ISSUE_147_PORT || 4198);
const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER_PATH,
  '/Users/liuyuxuan/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

function resolveBrowserExecutable() {
  const executablePath = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('No pre-installed Chromium or Edge binary found.');
  return executablePath;
}

async function startViteServer() {
  const server = spawn(process.execPath, [viteBinary, '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      server.kill('SIGTERM');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Vite dev server timeout')), 15000);
    server.stdout.on('data', (chunk) => {
      if (settled || !chunk.toString().includes(String(PORT))) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`Vite exited before startup with code ${code ?? 'unknown'}.`));
    });
  });
  return server;
}

function sseResponse(payloads) {
  return `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
}

function routeReply({ mode, title, characterName, settingMarkdown = '', body }) {
  return [
    '```lfh-route',
    `mode: ${mode}`,
    `title: ${title}`,
    ...(characterName ? [`character_name: ${characterName}`] : []),
    '---',
    settingMarkdown,
    '```',
    body,
  ].join('\n');
}

async function readPersistedState(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('local-fiction-harness');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const readAll = (storeName) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const stories = await readAll('stories');
      const meta = await readAll('meta');
      const creativeEntry = meta.find((entry) => entry.key === 'creativeWorkspace');
      const activeEntry = meta.find((entry) => entry.key === 'activeStoryId');
      return {
        storyIds: stories.map((story) => story.id),
        activeStoryId: activeEntry?.value ?? null,
        workIds: creativeEntry?.value?.works?.map((work) => work.id) ?? [],
        workTitles: creativeEntry?.value?.works?.map((work) => work.title) ?? [],
        characterIds: creativeEntry?.value?.characters?.map((ch) => ch.id) ?? [],
        characterNames: creativeEntry?.value?.characters?.map((ch) => ch.name) ?? [],
      };
    } finally {
      db.close();
    }
  });
}

async function main() {
  const server = await startViteServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(12000);
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === `http://localhost:${PORT}`
        ? route.continue()
        : route.abort('internetdisconnected');
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem(
        'lfh.model_config.meta',
        JSON.stringify({
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          reasoningEffort: 'none',
          memoryOnly: false,
        }),
      );
      localStorage.setItem('lfh.model_config.api_key', 'sk-e2e-issue-147');
      localStorage.setItem('folio.tutorial.mainDone', 'true');
      localStorage.setItem('folio.tutorial.settingsDone', 'true');
    });

    const entrySystemPrompts = [];
    await page.route('**/chat/completions', async (route) => {
      const requestBody = route.request().postDataJSON();
      const systemText = (requestBody.messages ?? [])
        .filter((item) => item.role === 'system')
        .map((item) => item.content ?? '')
        .join('\n');
      const input = requestBody.messages?.at(-1)?.content ?? '';
      let content;

      if (systemText.includes('Folio 的自然语言第一入口助手')) {
        entrySystemPrompts.push(systemText);
        if (input.includes('用角色互动模式开启')) {
          content = routeReply({
            mode: 'character',
            title: '沈默',
            characterName: '沈默',
            settingMarkdown: '## 角色设定\n退役夜航员沈默。',
            body: '（点亮油灯）这么晚还来渡口，是迷路了吗？',
          });
        } else {
          // Intentionally emit mode: story to prove lockedMode clamps unrequested LLM drift
          content = routeReply({
            mode: 'story',
            title: input.includes('雾港') ? '雾港守夜人' : '雨夜车站手记',
            settingMarkdown: `## 设定\n\n${input}`,
            body: '雨声落在站台顶棚上，我们从这里继续。',
          });
        }
      } else {
        content = `已按当前会话继续：${input}`;
      }

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    const library = page.getByTestId('desktop-library');

    // 1. Default lock is 文游; switching library tab to 写故事 syncs WelcomeView & locks new creation
    await page.getByTestId('welcome-locked-mode').getByText('文游', { exact: true }).waitFor();
    await library.getByRole('button', { name: '写故事', exact: true }).click();
    await page.getByTestId('welcome-locked-mode').getByText('写故事', { exact: true }).waitFor();

    // Vague prompt with story keywords must stay strictly in locked 写故事 even if LLM tries to drift to story
    await page.fill('#turn-input', '雨夜车站的悬疑开局，主角发现了一张旧车票');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('writing-page').waitFor();
    assert.ok(entrySystemPrompts.at(-1)?.includes('写故事'), 'entry route prompt must receive lockedMode=writing');

    const afterLockedWriting = await readPersistedState(page);
    assert.equal(afterLockedWriting.workIds.length, 1, 'vague opening under locked 写故事 must create a work');
    assert.equal(afterLockedWriting.storyIds.length, 0, 'vague opening under locked 写故事 must not drift to story');

    // 2. Clicking + 新建创作 from 写故事 preserves 写故事 lock
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-locked-mode').getByText('写故事', { exact: true }).waitFor();

    // Scenario A: Explicit switch request in locked mode pops ModalDialog; Cancel creates zero orphan records
    const switchPrompt = '用角色互动模式开启：沈默，雾港守夜人';
    await page.fill('#turn-input', switchPrompt);
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    const confirmDialog = page.getByTestId('mode-switch-confirm-dialog');
    await confirmDialog.waitFor({ state: 'visible' });
    await confirmDialog.getByTestId('mode-switch-source').getByText('写故事', { exact: true }).waitFor();
    await confirmDialog.getByTestId('mode-switch-target').getByText('角色互动', { exact: true }).waitFor();
    await confirmDialog.getByTestId('mode-switch-cancel-btn').click();
    await confirmDialog.waitFor({ state: 'hidden' });

    await page.getByTestId('welcome-locked-mode').getByText('写故事', { exact: true }).waitFor();
    assert.equal(await page.inputValue('#turn-input'), switchPrompt);
    const afterCancelA = await readPersistedState(page);
    assert.equal(afterCancelA.characterIds.length, 0, 'Scenario A cancel must not create character');
    assert.equal(afterCancelA.workIds.length, 1, 'Scenario A cancel must not create extra work');

    // Resend and confirm Scenario A -> creates character and jumps to character-page
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await confirmDialog.waitFor({ state: 'visible' });
    await confirmDialog.getByTestId('mode-switch-confirm-btn').click();
    await confirmDialog.waitFor({ state: 'hidden' });
    await page.getByTestId('character-page').waitFor();
    const afterConfirmA = await readPersistedState(page);
    assert.equal(afterConfirmA.characterIds.length, 1);
    assert.deepEqual(afterConfirmA.characterNames, ['沈默']);

    // 3. Locking 角色互动 via library tab + 新建创作 prevents LLM drift to story
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-locked-mode').getByText('角色互动', { exact: true }).waitFor();
    await page.fill('#turn-input', '雾港守夜人站在雨里，只看了一眼来客');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('character-page').waitFor();
    const afterLockedChar = await readPersistedState(page);
    assert.equal(afterLockedChar.characterIds.length, 2);
    assert.equal(afterLockedChar.storyIds.length, 0);

    // 4. Scenario B: In-chat natural-language switch pops ModalDialog; Cancel keeps active character, Confirm creates independent story
    await page.getByLabel('发消息').fill('切换到文游');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await confirmDialog.waitFor({ state: 'visible' });
    await confirmDialog.getByTestId('mode-switch-source').getByText('角色互动', { exact: true }).waitFor();
    await confirmDialog.getByTestId('mode-switch-target').getByText('文游', { exact: true }).waitFor();
    await confirmDialog.getByTestId('mode-switch-cancel-btn').click();
    await confirmDialog.waitFor({ state: 'hidden' });
    const afterCancelB = await readPersistedState(page);
    assert.equal(afterCancelB.storyIds.length, 0, 'Scenario B cancel must not create target story');
    assert.equal(await page.getByLabel('发消息').inputValue(), '切换到文游');

    // Mobile viewport check with modal open across themes
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await confirmDialog.waitFor({ state: 'visible' });
    for (const theme of ['light', 'dark', 'warm']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.equal(overflow.scrollWidth, overflow.clientWidth, `No horizontal overflow in ${theme} mobile modal`);
    }

    await confirmDialog.getByTestId('mode-switch-confirm-btn').click();
    await confirmDialog.waitFor({ state: 'hidden' });
    await page.getByTestId('story-timeline').waitFor();
    const afterConfirmB = await readPersistedState(page);
    assert.equal(afterConfirmB.storyIds.length, 1, 'Scenario B confirm creates independent target story');
    assert.equal(afterConfirmB.characterIds.length, 2, 'Scenario B confirm keeps existing characters intact');

    console.log('ISSUE_147_MODE_LOCK_E2E_PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
