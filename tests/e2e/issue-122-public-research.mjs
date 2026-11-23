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

const PORT = Number(process.env.LFH_E2E_ISSUE_122_PORT || 4198);
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

function sseResponse(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

function routeReply({ mode, title, settingMarkdown, body }) {
  return [
    '```lfh-route',
    `mode: ${mode}`,
    `title: ${title}`,
    '---',
    settingMarkdown,
    '```',
    body,
  ].join('\n');
}

const scenarios = [
  {
    prompt: '写一篇《钢之炼金术师》2003 动画版第 51 集后的小说，从第一幕开始，不要写成文游。角色：爱德华·艾尔利克',
    mode: 'writing',
    title: '钢之炼金术师同人',
    settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克',
    testId: 'writing-page',
    body: '雨落在中央市。',
  },
  {
    prompt: '开一个《钢之炼金术师》动画版第 51 集后的文游，角色：爱德华·艾尔利克',
    mode: 'story',
    title: '雨夜重逢',
    settingMarkdown: '原作：《钢之炼金术师》\n版本：动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克',
    testId: 'story-timeline',
    body: '雨落在中央市。',
  },
  {
    prompt: '开一个《钢之炼金术师》2003/2009 动画版、剧情时点：之后的文游。角色：爱德华·艾尔利克',
    mode: 'story',
    title: '雨夜重逢',
    settingMarkdown: '原作：《钢之炼金术师》\n版本：2003/2009 动画版\n剧情时点：之后\n角色：爱德华·艾尔利克',
    testId: 'story-timeline',
    body: '雨落在中央市。',
  },
];

async function runScenario(browser, scenario) {
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
    localStorage.setItem('lfh.model_config.api_key', 'sk-e2e-issue-122');
  });

  const searchRequests = [];
  await page.route('**/v1/tools/search', async (route) => {
    searchRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { results: [] } });
  });

  const completionRequests = [];
  await page.route('**/chat/completions', async (route) => {
    const requestBody = route.request().postDataJSON();
    completionRequests.push(requestBody);
    const content = routeReply(scenario);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseResponse(content),
    });
  });

  try {
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', scenario.prompt);
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId(scenario.testId).waitFor();

    assert.equal(searchRequests.length, 0, `${scenario.mode} prompt must not start public research`);
    assert.equal(completionRequests.length, 1, 'only the routed model request should be sent');
    assert.equal(
      JSON.stringify(completionRequests[0]).includes('公开资料参考'),
      false,
      'the writing/model request must not be decorated by public reference context',
    );
  } finally {
    await context.close();
  }
}

async function main() {
  const server = await startViteServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    for (const scenario of scenarios) await runScenario(browser, scenario);
    console.log('ISSUE_122_PUBLIC_RESEARCH_E2E_PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
