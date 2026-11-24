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

const PORT = Number(process.env.LFH_E2E_ISSUE_127_PORT || 4197);
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
      const readAll = (storeName) => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stories = await readAll('stories');
      const meta = await readAll('meta');
      const creativeEntry = meta.find((entry) => entry.key === 'creativeWorkspace');
      const activeEntry = meta.find((entry) => entry.key === 'activeStoryId');
      return {
        storyIds: stories.map((story) => story.id),
        storyTitles: stories.map((story) => story.title),
        activeStoryId: activeEntry?.value ?? null,
        activeWorkId: creativeEntry?.value?.activeWorkId ?? null,
        workIds: creativeEntry?.value?.works?.map((work) => work.id) ?? [],
        workTitles: creativeEntry?.value?.works?.map((work) => work.title) ?? [],
        characterIds: creativeEntry?.value?.characters?.map((character) => character.id) ?? [],
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
      localStorage.setItem('lfh.model_config.meta', JSON.stringify({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        reasoningEffort: 'none',
        memoryOnly: false,
      }));
      localStorage.setItem('lfh.model_config.api_key', 'sk-e2e-issue-127');
    });

    const stageInputs = [];
    await page.route('**/chat/completions', async (route) => {
      const requestBody = route.request().postDataJSON();
      const systemText = (requestBody.messages ?? [])
        .filter((item) => item.role === 'system')
        .map((item) => item.content ?? '')
        .join('\n');
      const input = requestBody.messages?.at(-1)?.content ?? '';
      let content;
      if (systemText.includes('Folio 的自然语言第一入口助手')) {
        content = input.includes('先随便聊聊')
          ? routeReply({
              mode: 'ambiguous',
              title: '未命名创作',
              body: '可以，先说说你现在想写什么。',
            })
          : routeReply({
              mode: 'story',
              title: '普通消息仍留在当前文游',
              settingMarkdown: '## 故事设定\n\n雨夜站台上，两人正等待末班车。',
              body: '第一幕开始，站台广播忽然中断。',
            });
      } else {
        stageInputs.push(input);
        content = `已按当前文游继续处理：${input}\n\n\`\`\`lfh-summary\n继续推演站台上的当前场景\n\`\`\``;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '创建一个雨夜站台的文游');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', {
      name: '普通消息仍留在当前文游',
      exact: true,
    }).waitFor();

    const before = await readPersistedState(page);
    assert.equal(before.storyIds.length, 1, 'welcome first-message routing should create one story');
    assert.equal(before.workIds.length, 0);

    for (const prompt of [
      '请帮我改成小说',
      '把故事改成小说',
      '改成小说',
      '把这一段改成小说里的书信体。',
      '下一幕转成角色互动式对话',
    ]) {
      const requestCountBeforeTurn = stageInputs.length;
      await page.fill('#turn-input', prompt);
      await page.getByRole('button', { name: '发送行动', exact: true }).click();
      await page.getByTestId('turn-assistant').last().getByText(`已按当前文游继续处理：${prompt}`, {
        exact: false,
      }).waitFor();
      assert.ok(
        stageInputs.slice(requestCountBeforeTurn).some((input) => input.includes(prompt)),
        'the normal stage request should carry the exact user message',
      );
      const after = await readPersistedState(page);
      assert.deepEqual(after.storyIds, before.storyIds, 'ordinary stage instructions must not create a story');
      assert.equal(after.activeStoryId, before.activeStoryId, 'ordinary stage instructions must keep the story active');
      assert.deepEqual(after.workIds, before.workIds, 'ordinary stage instructions must not create a work');
      assert.deepEqual(after.characterIds, before.characterIds, 'ordinary stage instructions must not create a character');
    }

    await page.getByTestId('topbar-mode-switcher').click();
    await page.getByTestId('topbar-mode-option-writing').click();
    await page.getByTestId('writing-page').waitFor();
    const afterTopBar = await readPersistedState(page);
    assert.deepEqual(afterTopBar.storyIds, before.storyIds, 'top-bar conversion must preserve the source story');
    assert.equal(afterTopBar.workIds.length, 1, 'top-bar conversion should create one target work');

    await page.getByTestId('topbar-mode-switcher').click();
    await page.getByTestId('topbar-mode-option-story').click();
    await page.getByTestId('story-timeline').waitFor();
    await page.fill('#turn-input', '请切换到写故事，谢谢。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('writing-page').waitFor();
    const afterExplicitSwitch = await readPersistedState(page);
    assert.equal(afterExplicitSwitch.workIds.length, 2, 'an explicit natural-language switch should create one target work');

    const library = page.getByTestId('desktop-library');
    await library.getByRole('button', { name: '文游', exact: true }).click();
    await library.getByTestId('story-select-button').first().click();
    await page.getByTestId('story-timeline').waitFor();

    await page.getByTestId('topbar-mode-switcher').click();
    const writingOption = page.getByTestId('topbar-mode-option-writing');
    await writingOption.evaluate((button) => {
      button.click();
      button.click();
    });
    await page.getByTestId('writing-page').waitFor();
    await page.getByTestId('status-notice-banner').getByText('已切换为「写故事」', { exact: false }).waitFor();
    const afterDuplicateDispatch = await readPersistedState(page);
    assert.equal(
      afterDuplicateDispatch.workIds.length,
      afterExplicitSwitch.workIds.length + 1,
      'duplicate dispatch of one conversion must persist one target work',
    );
    assert.deepEqual(
      afterDuplicateDispatch.characterIds,
      afterExplicitSwitch.characterIds,
      'duplicate story-to-writing dispatch must not create another mode',
    );

    await library.getByRole('button', { name: '写故事', exact: true }).click();
    const sameNameRows = library.getByTestId('story-list-item').filter({ hasText: '普通消息仍留在当前文游' });
    assert.equal(await sameNameRows.count(), 3, 'independently created same-title works should all remain listed');
    const openedWorkIds = [];
    for (let index = 0; index < 3; index += 1) {
      await sameNameRows.nth(index).getByTestId('story-select-button').click();
      await page.getByTestId('writing-page').waitFor();
      await page.getByText('下一幕转成角色互动式对话', { exact: true }).waitFor();
      await page.waitForTimeout(120);
      openedWorkIds.push((await readPersistedState(page)).activeWorkId);
    }
    assert.equal(new Set(openedWorkIds).size, 3, 'each same-title work must remain independently openable');
    assert.deepEqual(
      [...openedWorkIds].sort(),
      [...afterDuplicateDispatch.workIds].sort(),
      'opening same-title works should address stable distinct IDs',
    );

    await library.getByRole('button', { name: '文游', exact: true }).click();
    const sameNameStoryRows = library.getByTestId('story-list-item').filter({ hasText: '普通消息仍留在当前文游' });
    assert.equal(await sameNameStoryRows.count(), 2, 'both source stories should remain available after conversions');
    for (let index = 0; index < 2; index += 1) {
      await sameNameStoryRows.nth(index).getByTestId('story-select-button').click();
      await page.getByTestId('story-timeline').waitFor();
      await page.getByTestId('story-timeline').getByText('把这一段改成小说里的书信体。', { exact: true }).waitFor();
      await page.getByTestId('story-timeline').getByText('下一幕转成角色互动式对话', { exact: true }).waitFor();
    }

    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '先随便聊聊');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('neutral-timeline').waitFor();
    const beforeWelcomeSwitch = await readPersistedState(page);
    await page.fill('#turn-input', '我希望把模式切换成写故事');
    await page.locator('#turn-input').evaluate((inputElement) => {
      inputElement.form.requestSubmit();
      inputElement.form.requestSubmit();
    });
    await page.getByTestId('writing-page').waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '先随便聊聊', exact: true }).waitFor();
    const afterWelcomeSwitch = await readPersistedState(page);
    assert.equal(
      afterWelcomeSwitch.workIds.length,
      beforeWelcomeSwitch.workIds.length + 1,
      'duplicate welcome-stage dispatch must persist one target work',
    );

    console.log('ISSUE_127_NORMAL_FLOW_E2E_PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
