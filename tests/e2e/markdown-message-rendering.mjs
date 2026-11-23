import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ||
  '/Users/liuyuxuan/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(playwrightCorePath);

const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER_PATH,
  '/Users/liuyuxuan/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const CANARY = 'MARKDOWN-MATRIX-123';
const COMMON_MARKDOWN = [
  `## Markdown 标题 ${CANARY}`,
  '',
  '**粗体内容**',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '> 引用段落',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| 名称 | 状态 |',
  '| --- | --- |',
  '| 表格 | 正常 |',
].join('\n');
const STORY_MARKDOWN = [
  COMMON_MARKDOWN,
  '',
  '```lfh-hud',
  '地点: 渡口',
  '线索: 铜锁',
  '```',
  '',
  'lfh-choices',
  'A. 继续调查',
  'B. 暂时离开',
].join('\n');
const MANUSCRIPT_MARKDOWN = `${[
  '```lfh-manuscript-intent',
  'intent: chat',
  '```',
  COMMON_MARKDOWN,
].join('\n')}`;

const MODES = [
  {
    name: '文游',
    entryPrompt: 'MARKDOWN_STORY_ENTRY 开启一个新的互动文游',
    streamPrompt: 'MARKDOWN_STREAM_STORY 展示合成 Markdown',
    followUpPrompt: 'MARKDOWN_HISTORY_FOLLOWUP 文游继续',
    expectedMode: 'story',
    title: 'Markdown 文游',
    screenTestId: 'story-timeline',
    inputSelector: '#turn-input',
    sendName: '发送行动',
    content: STORY_MARKDOWN,
    storyProtocols: true,
  },
  {
    name: '写故事',
    entryPrompt: 'MARKDOWN_WRITING_ENTRY 帮我写一个叫 Markdown 手稿的小说',
    streamPrompt: 'MARKDOWN_STREAM_WRITING 展示合成 Markdown',
    followUpPrompt: 'MARKDOWN_HISTORY_FOLLOWUP 写故事继续',
    expectedMode: 'writing',
    title: 'Markdown 手稿',
    screenTestId: 'writing-page',
    inputSelector: '#writing-discussion-input',
    sendName: '发送',
    content: COMMON_MARKDOWN,
    storyProtocols: false,
  },
  {
    name: '角色互动',
    entryPrompt: 'MARKDOWN_CHARACTER_ENTRY 创建一个叫渡舟的角色',
    streamPrompt: 'MARKDOWN_STREAM_CHARACTER 展示合成 Markdown',
    followUpPrompt: 'MARKDOWN_HISTORY_FOLLOWUP 角色继续',
    expectedMode: 'character',
    title: '渡舟',
    screenTestId: 'character-page',
    inputSelector: '#character-chat-input',
    sendName: '发送',
    content: COMMON_MARKDOWN,
    storyProtocols: false,
  },
];

function resolveBrowserExecutable() {
  const found = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('No pre-installed Edge or cached Playwright Chromium binary found.');
  return found;
}

async function startViteServer(port) {
  const viteArguments = process.env.LFH_E2E_PRODUCTION === '1'
    ? ['vite', 'preview', '--port', String(port), '--strictPort']
    : ['vite', '--port', String(port), '--strictPort'];
  const server = spawn('npx', viteArguments, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite dev server timeout')), 15000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
  return server;
}

async function newOfflineContext(browser, port, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  context.setDefaultTimeout(12000);
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === `http://localhost:${port}`
      ? route.continue()
      : route.abort('internetdisconnected'),
  );
  return context;
}

async function installFixtureFetch(context, streamContent) {
  await context.addInitScript(({ fixtureContent }) => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const sseEvent = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
    const contentEvent = (content) => sseEvent({ choices: [{ delta: { content } }] });
    const finishEvent = () => sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    const completeResponse = (content) => new Response(
      `${contentEvent(content)}${finishEvent()}data: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
    const routeReply = ({ mode, title, characterName, body }) => [
      '```lfh-route',
      `mode: ${mode}`,
      `title: ${title}`,
      ...(characterName ? [`character_name: ${characterName}`] : []),
      '---',
      mode === 'story' ? '## 故事设定\n合成 Markdown 测试故事。' : `## ${mode === 'writing' ? '作品' : '角色'}设定\n合成 Markdown 测试资料。`,
      '```',
      body,
    ].join('\n');

    window.__lfhMarkdownStreamStarted = false;
    window.__lfhReleaseMarkdownStream = null;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (!url.endsWith('/chat/completions') || typeof init.body !== 'string') {
        return nativeFetch(input, init);
      }

      const request = JSON.parse(init.body);
      const system = request.messages?.[0]?.content ?? '';
      const prompt = request.messages?.at(-1)?.content ?? '';

      if (system.includes('正文稿纸界面') && prompt.includes('MARKDOWN_MANUSCRIPT_ANSWER')) {
        return completeResponse(fixtureContent.manuscript);
      }

      if (system.includes('自然语言第一入口助手')) {
        if (prompt.includes('MARKDOWN_STORY_ENTRY')) {
          return completeResponse(routeReply({
            mode: 'story',
            title: 'Markdown 文游',
            body: '故事入口已建立。',
          }));
        }
        if (prompt.includes('MARKDOWN_WRITING_ENTRY')) {
          return completeResponse(routeReply({
            mode: 'writing',
            title: 'Markdown 手稿',
            body: '写作入口已建立。',
          }));
        }
        if (prompt.includes('MARKDOWN_CHARACTER_ENTRY')) {
          return completeResponse(routeReply({
            mode: 'character',
            title: '渡舟',
            characterName: '渡舟',
            body: '角色入口已建立。',
          }));
        }
      }

      if (/MARKDOWN_STREAM_(STORY|WRITING|CHARACTER)/.test(prompt)) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(contentEvent(fixtureContent.common)));
            window.__lfhMarkdownStreamStarted = true;
            window.__lfhReleaseMarkdownStream = () => {
              controller.enqueue(encoder.encode(`${finishEvent()}data: [DONE]\n\n`));
              controller.close();
              window.__lfhReleaseMarkdownStream = null;
            };
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }

      if (prompt.includes('MARKDOWN_HISTORY_FOLLOWUP')) {
        return completeResponse('后续消息已保存。');
      }

      return completeResponse('合成辅助回复。');
    };
  }, { fixtureContent: { common: streamContent, manuscript: MANUSCRIPT_MARKDOWN } });
}

async function mockKeyVerification(page) {
  await page.route('https://api.deepseek.com/models', (route) =>
    route.fulfill({ status: 200, json: { data: [{ id: 'deepseek-flash' }] } }),
  );
}

async function completePendingSetup(page) {
  const wizard = page.getByTestId('deepseek-setup-wizard');
  await wizard.locator('#byok-api-key').fill('sk-markdown-matrix-123');
  await wizard.getByTestId('wizard-verify-save-btn').click();
  await wizard.waitFor({ state: 'detached' });
}

async function assertSemanticMarkup(card, label, storyProtocols) {
  const result = await card.evaluate((root, expectStoryProtocols) => {
    const text = root.textContent ?? '';
    return {
      heading: [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .some((node) => node.textContent?.includes('MARKDOWN-MATRIX-123')),
      strong: [...root.querySelectorAll('strong')].some((node) => node.textContent === '粗体内容'),
      list: root.querySelectorAll('ul > li').length >= 2,
      quote: Boolean(root.querySelector('blockquote')),
      code: Boolean(root.querySelector('pre.md-code-block code')) && text.includes('const answer = 42;'),
      table: Boolean(root.querySelector('table.md-table')) && text.includes('表格') && text.includes('正常'),
      hud: Boolean(root.querySelector('[data-testid="hud-panel"]')),
      choices: root.querySelectorAll('[data-testid="choice-option"]').length,
      rawBold: text.includes('**粗体内容**'),
      rawFence: text.includes('```'),
      rawHud: text.includes('lfh-hud'),
      rawChoices: text.includes('lfh-choices'),
      expectStoryProtocols,
    };
  }, storyProtocols);

  assert.equal(result.heading, true, `${label}: heading was not rendered as HTML`);
  assert.equal(result.strong, true, `${label}: strong text was not rendered as HTML`);
  assert.equal(result.list, true, `${label}: list was not rendered as HTML`);
  assert.equal(result.quote, true, `${label}: quote was not rendered as HTML`);
  assert.equal(result.code, true, `${label}: fenced code was not rendered as HTML`);
  assert.equal(result.table, true, `${label}: table was not rendered as HTML`);
  assert.equal(result.rawBold, false, `${label}: raw strong markers were visible`);
  assert.equal(result.rawFence, false, `${label}: raw code fences were visible`);
  assert.equal(result.rawHud, false, `${label}: raw HUD protocol was visible`);
  assert.equal(result.rawChoices, false, `${label}: raw choice protocol was visible`);
  if (storyProtocols) assert.equal(result.hud, true, `${label}: HUD protocol was not rendered`);
}

async function assertCompletedStoryProtocols(card, label) {
  assert.equal(await card.getByTestId('choice-row').count(), 1, `${label}: active choice row missing`);
  assert.equal(await card.getByTestId('choice-option').count(), 2, `${label}: choice options missing`);
  assert.equal(await card.getByTestId('hud-panel').count(), 1, `${label}: HUD panel missing`);
}

async function reopenSavedMode(page, mode) {
  const screen = page.getByTestId(mode.screenTestId);
  if (await screen.isVisible().catch(() => false)) return screen;

  const category = mode.expectedMode === 'writing'
    ? '写故事'
    : mode.expectedMode === 'character'
      ? '角色'
      : '文游';
  const library = page.getByTestId('desktop-library');
  await library.getByRole('button', { name: category, exact: true }).click();
  await library.getByTestId('story-select-button').filter({ hasText: mode.title }).first().click();
  await screen.waitFor({ state: 'visible' });
  return screen;
}

async function runMode(browser, port, mode) {
  const context = await newOfflineContext(browser, port, { width: 1280, height: 800 });
  try {
    await installFixtureFetch(context, mode.content);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await mockKeyVerification(page);
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

    await page.fill('#turn-input', mode.entryPrompt);
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await completePendingSetup(page);
    const screen = page.getByTestId(mode.screenTestId);
    await screen.waitFor({ state: 'visible' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: mode.title, exact: true }).waitFor();

    await page.fill(mode.inputSelector, mode.streamPrompt);
    await page.getByRole('button', { name: mode.sendName, exact: true }).click();
    await page.waitForFunction(() => window.__lfhMarkdownStreamStarted === true);
    const streamingCard = page.locator('[data-testid="turn-assistant"].turn-streaming').filter({ hasText: CANARY }).last();
    await streamingCard.waitFor({ state: 'visible' });
    await assertSemanticMarkup(streamingCard, `${mode.name} 流式中`, mode.storyProtocols);

    await page.evaluate(() => window.__lfhReleaseMarkdownStream?.());
    await page.waitForFunction(() => typeof window.__lfhReleaseMarkdownStream !== 'function');
    await page.locator('[data-testid="turn-assistant"].turn-streaming').filter({ hasText: CANARY }).waitFor({ state: 'detached' });

    const completedCard = screen.locator('[data-testid="turn-assistant"][data-node-id]').filter({ hasText: CANARY }).last();
    await completedCard.waitFor({ state: 'visible' });
    await assertSemanticMarkup(completedCard, `${mode.name} 完成`, mode.storyProtocols);
    if (mode.storyProtocols) await assertCompletedStoryProtocols(completedCard, `${mode.name} 完成`);

    await page.fill(mode.inputSelector, mode.followUpPrompt);
    await page.getByRole('button', { name: mode.sendName, exact: true }).click();
    await screen
      .locator('[data-testid="turn-assistant"][data-node-id]')
      .filter({ hasText: '后续消息已保存。' })
      .last()
      .waitFor({ state: 'visible' });
    await completedCard.waitFor({ state: 'visible' });
    assert.match(await completedCard.getAttribute('class'), /is-history/, `${mode.name}: sample did not become historical`);

    await page.reload({ waitUntil: 'networkidle' });
    await reopenSavedMode(page, mode);
    const reopenedCard = screen.locator('[data-testid="turn-assistant"][data-node-id]').filter({ hasText: CANARY }).last();
    await reopenedCard.waitFor({ state: 'visible' });
    assert.match(await reopenedCard.getAttribute('class'), /is-history/, `${mode.name}: reopened sample was not historical`);
    await assertSemanticMarkup(reopenedCard, `${mode.name} 存档重开`, mode.storyProtocols);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertSemanticMarkup(reopenedCard, `${mode.name} 手机窄屏`, mode.storyProtocols);

    if (mode.expectedMode === 'writing') {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '正文', exact: true }).click();
      await screen.getByTestId('creative-manuscript').waitFor({ state: 'visible' });
      await page.fill('#writing-suggestion-input', 'MARKDOWN_MANUSCRIPT_ANSWER 请回答一个剧情问题');
      await page.getByRole('button', { name: '发送请求', exact: true }).click();
      const answer = screen.getByTestId('manuscript-chat-answer');
      await answer.waitFor({ state: 'visible' });
      await assertSemanticMarkup(answer, '写故事正文页问答', false);

      await page.setViewportSize({ width: 390, height: 844 });
      await assertSemanticMarkup(answer, '写故事正文页问答手机窄屏', false);
    }

    console.log(`MARKDOWN_MESSAGE_${mode.expectedMode.toUpperCase()}_PASSED`);
  } finally {
    await context.close();
  }
}

async function main() {
  const port = Number(process.env.LFH_MARKDOWN_E2E_PORT || 4193);
  const server = await startViteServer(port);
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    for (const mode of MODES) await runMode(browser, port, mode);
    console.log('MARKDOWN_MESSAGE_E2E_PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
