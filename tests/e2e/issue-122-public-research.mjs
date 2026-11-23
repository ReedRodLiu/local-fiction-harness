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
    prompt: '开一个原创角色站在雨夜车站的文游，从现在开始。',
    mode: 'story',
    title: '原创雨夜',
    settingMarkdown: '原创角色站在雨夜车站。',
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
  {
    prompt: [
      '开一个《钢之炼金术师》文游。',
      '原作：**《钢之炼金术师》**',
      '版本：**2003 动画版**。',
      '剧情时点：第 51 集结局后。',
      '角色：**爱德华·艾尔利克**，私密关系设定。',
      '角色：阿尔冯斯·艾尔利克，阿信。',
      '同人改设：两人可能还在寻找回家的办法，后续尚未确定。',
      '私密备注：不要发送这段。',
    ].join('\n'),
    mode: 'story',
    title: '炼金术师雨夜',
    settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集结局后\n角色：爱德华·艾尔利克，私密关系设定\n角色：阿尔冯斯·艾尔利克，阿信\n同人改设：两人仍在寻找回家的办法。',
    testId: 'story-timeline',
    body: '阿尔冯斯说：“哥哥，雨小了。”',
    searchScope: ['钢之炼金术师', '2003 动画版', '第 51 集结局后'],
    research: {
      firstReplyText: '称呼弟弟为「阿尔」',
      summary: [
        '### 爱德华·艾尔利克',
        '- 称呼弟弟为「阿尔」，急躁时句子短促。',
        '### 阿尔冯斯·艾尔利克',
        '- 说话温和，习惯称对方为「哥哥」。',
      ].join('\n'),
    },
  },
  {
    prompt: '开一个《钢之炼金术师》2003 动画版第 51 集后的文游。角色：爱德华·艾尔利克',
    mode: 'story',
    title: '炼金术师版本切换',
    settingMarkdown: '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克',
    testId: 'story-timeline',
    body: '2003 年的雨落在中央市。',
    searchScope: ['钢之炼金术师', '2003 动画版', '第 51 集后'],
    followUps: [
      { input: '版本：2009 动画版', body: '2009 年版的雨落在中央市。', research: true },
      { input: '请继续。', body: '普通推进。', research: false },
      { input: '切换到 2010 动画版', body: '2010 年版的雨落在中央市。', research: true },
      { input: '继续推进。', body: '继续普通推进。', research: false },
    ],
    research: {
      firstReplyText: '说话短促',
      summary: '### 爱德华·艾尔利克\n- 说话短促，习惯先观察四周。',
    },
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
    await route.fulfill({
      status: 200,
      json: scenario.research
        ? {
            results: [{
              rerank_score: 2.8,
              authority: 4,
              title: '官方角色资料',
              url: 'https://official.example/alchemy/characters',
              snippet: '公开角色介绍',
              summary: '公开角色介绍',
              content: '',
              site_name: 'Official',
              site_icon: null,
              date: null,
            }],
          }
        : { results: [] },
    });
  });

  const fetchRequests = [];
  await page.route('**/v1/tools/fetch', async (route) => {
    fetchRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      json: {
        title: '官方角色资料',
        content: '爱德华·艾尔利克称呼弟弟阿尔冯斯·艾尔利克为「阿尔」。阿尔冯斯·艾尔利克说话温和。',
      },
    });
  });

  const completionRequests = [];
  let mainReplyCount = 0;
  let followUpReplyIndex = 0;
  await page.route('**/chat/completions', async (route) => {
    const requestBody = route.request().postDataJSON();
    completionRequests.push(requestBody);
    const isSynthesis = scenario.research && JSON.stringify(requestBody.messages).includes('公开角色资料提炼器');
    let content;
    if (isSynthesis) {
      content = scenario.research.summary;
    } else if (!scenario.followUps?.length || mainReplyCount++ === 0) {
      content = routeReply(scenario);
    } else {
      content = scenario.followUps[followUpReplyIndex++]?.body ?? routeReply(scenario);
    }
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

    if (!scenario.research) {
      assert.equal(searchRequests.length, 0, `${scenario.mode} prompt must not start public research`);
      assert.equal(fetchRequests.length, 0, 'the negative path must not fetch a public source');
      assert.equal(completionRequests.length, 1, 'only the routed model request should be sent');
      assert.equal(
        JSON.stringify(completionRequests[0]).includes('公开资料参考'),
        false,
        'the writing/model request must not be decorated by public reference context',
      );
    } else {
      assert.equal(searchRequests.length, 1, 'the known IP should start one public search');
      assert.equal(fetchRequests.length, 1, 'the accepted public result should be fetched once');
      assert.equal(completionRequests.length, 2, 'one synthesis call and one routed first reply should be sent');

      const searchBody = searchRequests[0];
      assert.deepEqual(Object.keys(searchBody).sort(), ['count', 'need_content', 'query']);
      assert.equal(searchBody.need_content, false);
      const query = String(searchBody.query);
      for (const expected of scenario.searchScope) {
        assert.ok(query.includes(expected), `search query should include ${expected}`);
      }
      for (const privateText of [
        '爱德华·艾尔利克',
        '阿尔冯斯·艾尔利克',
        '私密关系设定',
        '阿信',
        '同人改设',
        '私密备注',
        '不要发送',
        '后续尚未确定',
        '。',
      ]) {
        assert.equal(query.includes(privateText), false, `search query must not include ${privateText}`);
      }
      assert.deepEqual(fetchRequests[0], { url: 'https://official.example/alchemy/characters' });

      const synthesisRequest = completionRequests.find((request) =>
        JSON.stringify(request.messages).includes('公开角色资料提炼器'));
      const firstReplyRequest = completionRequests.find((request) => request !== synthesisRequest);
      assert.ok(synthesisRequest, 'the public evidence should be synthesized before the first reply');
      assert.ok(firstReplyRequest, 'the routed first reply request should exist');
      const synthesisPayload = JSON.stringify(synthesisRequest.messages);
      assert.ok(synthesisPayload.includes('爱德华·艾尔利克'), 'verified character names should reach synthesis');
      assert.ok(synthesisPayload.includes('阿尔冯斯·艾尔利克'), 'all verified character names should reach synthesis');
      assert.equal(synthesisPayload.includes('私密关系设定'), false, 'private annotation text must not reach synthesis');
      assert.equal(synthesisPayload.includes('阿信'), false, 'an unverified short tail must not reach synthesis');
      const firstReplyPayload = JSON.stringify(firstReplyRequest.messages);
      assert.ok(firstReplyPayload.includes('公开资料参考'), 'the first reply should receive the researched reference');
      assert.ok(
        firstReplyPayload.includes(scenario.research.firstReplyText),
        'the first reply should receive role-specific voice notes',
      );
      assert.ok(firstReplyPayload.includes('以用户已确认内容为准'), 'confirmed local setting should remain authoritative');
      if (scenario.settingMarkdown.includes('同人改设')) {
        assert.ok(firstReplyPayload.includes('同人改设'), 'the local fan-AU setting should remain in context');
      }
      await page.getByTestId('turn-body').getByText(scenario.body, { exact: false }).first().waitFor();

      for (const followUp of scenario.followUps ?? []) {
        await page.fill('#turn-input', followUp.input);
        await page.getByRole('button', { name: '发送行动', exact: true }).click();
        await page.getByTestId('turn-body').getByText(followUp.body, { exact: true }).last().waitFor();
      }

      if (scenario.followUps?.length) {
        const researchFollowUps = scenario.followUps.filter((followUp) => followUp.research);
        assert.equal(searchRequests.length, 1 + researchFollowUps.length, 'each concrete pivot should search once');
        assert.equal(fetchRequests.length, 1 + researchFollowUps.length, 'each accepted pivot should fetch once');
        assert.ok(
          completionRequests.length >= 2 + scenario.followUps.length + researchFollowUps.length,
          'pivots should add synthesis and main-generation calls while ordinary turns reuse the reference',
        );
        for (const request of searchRequests) {
          assert.equal(String(request.query).includes('爱德华·艾尔利克'), false);
        }
        const synthesisPayloads = completionRequests
          .filter((request) => JSON.stringify(request.messages).includes('公开角色资料提炼器'));
        assert.equal(synthesisPayloads.length, 1 + researchFollowUps.length);
        for (const [index, followUp] of researchFollowUps.entries()) {
          const query = String(searchRequests[index + 1].query);
          const version = followUp.input.match(/\d{4}\s*动画版/)?.[0];
          assert.ok(version, 'the pivot should contain a concrete version');
          assert.ok(query.includes(version), 'the pivot search should use the changed version');
          assert.ok(query.includes(scenario.searchScope[2]), 'the pivot search should inherit the saved timeline');
        }
        for (const request of synthesisPayloads) {
          assert.ok(JSON.stringify(request.messages).includes('爱德华·艾尔利克'));
        }
      }
    }
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
