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

function proposalReply({ target, summary, name, body }) {
  return [
    '```lfh-proposal',
    `target: ${target}`,
    'op: full',
    `summary: ${summary}`,
    ...(name ? [`name: ${name}`] : []),
    '---',
    body,
    '```',
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
      localStorage.setItem('folio.tutorial.mainDone', 'true');
      localStorage.setItem('folio.tutorial.settingsDone', 'true');
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
      } else if (input.includes('创建一个角色互动对话')) {
        stageInputs.push(input);
        content = `已为你草拟角色互动人设。\n${proposalReply({
          target: 'character',
          summary: '根据雨夜站台故事新建角色「沈默」',
          name: '沈默',
          body: '## 角色设定\n\n雨夜站台的旧表匠沈默。',
        })}\n\n\`\`\`lfh-summary\n整理沈默角色设定提案\n\`\`\``;
      } else if (input.includes('新开一篇写故事稿')) {
        stageInputs.push(input);
        content = `已为你整理新作品大纲。\n${proposalReply({
          target: 'draft',
          summary: '根据沈默人设新开写故事稿「站台外传」',
          name: '站台外传',
          body: '## 作品设定\n\n围绕雨夜站台旧表匠展开的短篇大纲。',
        })}\n\n\`\`\`lfh-summary\n整理站台外传写故事提案\n\`\`\``;
      } else if (input.includes('开成互动文游')) {
        stageInputs.push(input);
        content = `已为你整理互动文游设定。\n${proposalReply({
          target: 'story',
          summary: '根据外传设定新开互动文游「站台夜航」',
          name: '站台夜航',
          body: '## 故事设定\n\n雾夜末班车停靠站台，你手中握着半张旧车票。',
        })}\n\n\`\`\`lfh-summary\n整理站台夜航文游提案\n\`\`\``;
      } else {
        stageInputs.push(input);
        content = `已按当前模式继续处理：${input}\n\n\`\`\`lfh-summary\n继续推演站台上的当前场景\n\`\`\``;
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
    assert.equal(before.characterIds.length, 0);
    assert.equal(await page.getByTestId('topbar-mode-switcher').count(), 0, 'TopBar must not render mode switcher in story view');

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
      await page.getByTestId('turn-assistant').last().getByText(`已按当前模式继续处理：${prompt}`, {
        exact: false,
      }).waitFor();
      assert.ok(
        stageInputs.slice(requestCountBeforeTurn).some((input) => input.includes(prompt)),
        'the normal stage request should carry the exact user message without in-session cloning interception',
      );
      const after = await readPersistedState(page);
      assert.deepEqual(after.storyIds, before.storyIds, 'in-session messages must not create a story');
      assert.equal(after.activeStoryId, before.activeStoryId, 'in-session messages must keep the story active');
      assert.deepEqual(after.workIds, before.workIds, 'in-session messages must not clone into works');
      assert.deepEqual(after.characterIds, before.characterIds, 'in-session messages must not clone into characters');
    }

    // Explicit mode-switch commands in story chat trigger ModalDialog confirmation; canceling preserves state
    for (const [prompt, expectedTarget] of [
      ['请切换到写故事，谢谢。', '写故事'],
      ['切换到角色互动', '角色互动'],
    ]) {
      await page.fill('#turn-input', prompt);
      await page.getByRole('button', { name: '发送行动', exact: true }).click();
      const dialog = page.getByTestId('mode-switch-confirm-dialog');
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByTestId('mode-switch-source').getByText('文游', { exact: true }).waitFor();
      await dialog.getByTestId('mode-switch-target').getByText(expectedTarget, { exact: true }).waitFor();
      await dialog.getByTestId('mode-switch-cancel-btn').click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.inputValue('#turn-input'), prompt);
      const afterCancel = await readPersistedState(page);
      assert.deepEqual(afterCancel.storyIds, before.storyIds);
      assert.deepEqual(afterCancel.workIds, before.workIds);
      assert.deepEqual(afterCancel.characterIds, before.characterIds);
    }

    // 1) Derive character from story via ProposalCard + ModalDialog confirmation (cancel then confirm)
    await page.fill('#turn-input', '我要根据这个故事里的沈默创建一个角色互动对话');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    const charProposal = page.locator('section[data-testid^="proposal-card-"]').filter({ hasText: '新建角色' }).last();
    await charProposal.waitFor();
    await charProposal.getByTestId('proposal-card-toggle').click();
    await charProposal.getByTestId('proposal-apply-btn').click();
    const charConfirmDialog = page.getByTestId('mode-switch-confirm-dialog');
    await charConfirmDialog.waitFor({ state: 'visible' });
    await charConfirmDialog.getByTestId('mode-switch-cancel-btn').click();
    await charConfirmDialog.waitFor({ state: 'hidden' });
    const afterCharCancel = await readPersistedState(page);
    assert.equal(afterCharCancel.characterIds.length, 0, 'canceling cross-mode proposal must not create character');

    await charProposal.getByTestId('proposal-apply-btn').click();
    await charConfirmDialog.waitFor({ state: 'visible' });
    await charConfirmDialog.getByTestId('mode-switch-confirm-btn').click();
    await charConfirmDialog.waitFor({ state: 'hidden' });
    await page.getByTestId('character-page').waitFor();
    const afterCharDerive = await readPersistedState(page);
    assert.equal(afterCharDerive.storyIds.length, 1, 'deriving character must not duplicate source story');
    assert.equal(afterCharDerive.workIds.length, 0);
    assert.equal(afterCharDerive.characterIds.length, 1, 'confirming character proposal must create one character');
    await page.getByTestId('app-topbar').getByRole('heading', { name: '沈默', exact: true }).waitFor();
    assert.equal(await page.getByTestId('topbar-mode-switcher').count(), 0, 'TopBar must not render mode switcher in character view');

    // In character mode, explicit switch phrase triggers ModalDialog; canceling keeps character chat untouched
    await page.getByLabel('发消息').fill('切换到文游');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const charSwitchDialog = page.getByTestId('mode-switch-confirm-dialog');
    await charSwitchDialog.waitFor({ state: 'visible' });
    await charSwitchDialog.getByTestId('mode-switch-source').getByText('角色互动', { exact: true }).waitFor();
    await charSwitchDialog.getByTestId('mode-switch-target').getByText('文游', { exact: true }).waitFor();
    await charSwitchDialog.getByTestId('mode-switch-cancel-btn').click();
    await charSwitchDialog.waitFor({ state: 'hidden' });
    const afterCharSwitchPhrase = await readPersistedState(page);
    assert.equal(afterCharSwitchPhrase.storyIds.length, 1);
    assert.equal(afterCharSwitchPhrase.workIds.length, 0);
    assert.equal(afterCharSwitchPhrase.characterIds.length, 1);

    // 2) Derive writing draft from character via ProposalCard + ModalDialog confirmation
    await page.getByLabel('发消息').fill('按当前人设新开一篇写故事稿');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const draftProposal = page.locator('section[data-testid^="proposal-card-"]').filter({ hasText: '新开写故事' }).last();
    await draftProposal.waitFor();
    await draftProposal.getByTestId('proposal-card-toggle').click();
    await draftProposal.getByTestId('proposal-apply-btn').click();
    const draftConfirmDialog = page.getByTestId('mode-switch-confirm-dialog');
    await draftConfirmDialog.waitFor({ state: 'visible' });
    await draftConfirmDialog.getByTestId('mode-switch-confirm-btn').click();
    await draftConfirmDialog.waitFor({ state: 'hidden' });
    await page.getByTestId('writing-page').waitFor();
    const afterDraftDerive = await readPersistedState(page);
    assert.equal(afterDraftDerive.characterIds.length, 1, 'deriving draft must not duplicate source character');
    assert.equal(afterDraftDerive.storyIds.length, 1);
    assert.equal(afterDraftDerive.workIds.length, 1, 'confirming draft proposal must create one work');
    await page.getByTestId('app-topbar').getByRole('heading', { name: '站台外传', exact: true }).waitFor();
    assert.equal(await page.getByTestId('topbar-mode-switcher').count(), 0, 'TopBar must not render mode switcher in writing view');

    // In writing mode, explicit switch phrase triggers ModalDialog; canceling keeps writing chat untouched
    await page.getByLabel('聊天内容').fill('切换到文游');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const writingSwitchDialog = page.getByTestId('mode-switch-confirm-dialog');
    await writingSwitchDialog.waitFor({ state: 'visible' });
    await writingSwitchDialog.getByTestId('mode-switch-source').getByText('写故事', { exact: true }).waitFor();
    await writingSwitchDialog.getByTestId('mode-switch-target').getByText('文游', { exact: true }).waitFor();
    await writingSwitchDialog.getByTestId('mode-switch-cancel-btn').click();
    await writingSwitchDialog.waitFor({ state: 'hidden' });
    const afterWritingSwitchPhrase = await readPersistedState(page);
    assert.equal(afterWritingSwitchPhrase.storyIds.length, 1);
    assert.equal(afterWritingSwitchPhrase.workIds.length, 1);
    assert.equal(afterWritingSwitchPhrase.characterIds.length, 1);

    // 3) Derive interactive story from writing via ProposalCard + ModalDialog confirmation
    await page.getByLabel('聊天内容').fill('把这个设定开成互动文游');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const storyProposal = page.locator('section[data-testid^="proposal-card-"]').filter({ hasText: '新开文游' }).last();
    await storyProposal.waitFor();
    await storyProposal.getByTestId('proposal-card-toggle').click();
    await storyProposal.getByTestId('proposal-apply-btn').click();
    const storyConfirmDialog = page.getByTestId('mode-switch-confirm-dialog');
    await storyConfirmDialog.waitFor({ state: 'visible' });
    await storyConfirmDialog.getByTestId('mode-switch-confirm-btn').click();
    await storyConfirmDialog.waitFor({ state: 'hidden' });
    await page.getByTestId('story-timeline').waitFor();
    const afterStoryDerive = await readPersistedState(page);
    assert.equal(afterStoryDerive.storyIds.length, 2, 'confirming story proposal must create one independent story');
    assert.equal(afterStoryDerive.workIds.length, 1, 'deriving story must not duplicate source work');
    assert.equal(afterStoryDerive.characterIds.length, 1);
    await page.getByTestId('app-topbar').getByRole('heading', { name: '站台夜航', exact: true }).waitFor();
    await page.getByTestId('story-timeline').getByText('雾夜末班车停靠站台，你手中握着半张旧车票。', { exact: false }).waitFor();

    const diagnosticsEvents = await page.evaluate(() => {
      const raw = localStorage.getItem('lfh.diagnostics.v2');
      return raw ? JSON.parse(raw).events ?? [] : [];
    });
    const derivedEvents = diagnosticsEvents.filter((event) => event.action === 'asset_derived_from_proposal');
    assert.deepEqual(
      derivedEvents.map((event) => event.meta?.target),
      ['character', 'draft', 'story'],
      'diagnostics should record zero-content asset_derived_from_proposal breadcrumbs for each derived target',
    );
    assert.equal(
      diagnosticsEvents.filter((event) => event.action === 'entry_misroute_corrected').length,
      0,
      'proposal-based derivation must not overload entry_misroute_corrected',
    );

    // Source story remains intact in library with its original turns
    const library = page.getByTestId('desktop-library');
    await library.getByRole('button', { name: '文游', exact: true }).click();
    await library.getByTestId('story-select-button').filter({ hasText: '普通消息仍留在当前文游' }).click();
    await page.getByTestId('story-timeline').getByText('把这一段改成小说里的书信体。', { exact: true }).waitFor();
    await page.getByTestId('story-timeline').getByText('下一幕转成角色互动式对话', { exact: true }).waitFor();

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
    const welcomeSwitchDialog = page.getByTestId('mode-switch-confirm-dialog');
    await welcomeSwitchDialog.waitFor({ state: 'visible' });
    await welcomeSwitchDialog.getByTestId('mode-switch-confirm-btn').click();
    await welcomeSwitchDialog.waitFor({ state: 'hidden' });
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
