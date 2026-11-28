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
  path.join(process.env.HOME || '', '.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const { chromium } = require(playwrightCorePath);

const PORT = Number(process.env.LFH_E2E_ISSUE_141_PORT || 4193);
const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER_PATH,
  path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
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

function makeEmptySnapshot() {
  return { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };
}

function makeDoc(id, markdown, ts) {
  return {
    head: id,
    versions: {
      [id]: { id, previous: null, markdown, savedAt: ts, source: 'user' },
    },
  };
}

function buildIssue141BackupPayload() {
  const baseTs = 1_760_000_000_000;

  const storyTelemetryMain = {
    providerKind: 'deepseek-official',
    model: 'deepseek-flash',
    generationUsage: {
      promptCacheHitTokens: 900,
      promptCacheMissTokens: 100,
      completionTokens: 200,
      completionTokensDetails: { reasoningTokens: 40 },
    },
    uncompressedPromptChars: 36000,
    compressedPromptChars: 3000,
    retrievedNodeCount: 2,
  };
  const storyTelemetryRetry = {
    providerKind: 'deepseek-official',
    model: 'deepseek-flash',
    generationUsage: {
      promptCacheHitTokens: 600,
      promptCacheMissTokens: 400,
      completionTokens: 150,
    },
    uncompressedPromptChars: 36000,
    compressedPromptChars: 3000,
  };

  const story = {
    id: 'issue-141-story',
    title: '雾夜回响',
    rawScript: '雾夜回响设定。',
    blueprint: {
      title: '雾夜回响',
      worldRules: ['规则一'],
      protagonist: '旅人',
      npcs: [],
      taboos: [],
      openingHook: '长街雾浓。',
      extractionStatus: 'complete',
    },
    nodes: {
      's-u1': {
        id: 's-u1',
        parentId: null,
        role: 'user',
        content: '推开木门',
        createdAt: baseTs,
        summarySnapshot: makeEmptySnapshot(),
      },
      's-a1': {
        id: 's-a1',
        parentId: 's-u1',
        role: 'assistant',
        content: '门后风声微凉。',
        createdAt: baseTs + 1000,
        summarySnapshot: makeEmptySnapshot(),
        telemetry: storyTelemetryMain,
      },
      's-a1-retry': {
        id: 's-a1-retry',
        parentId: 's-u1',
        role: 'assistant',
        content: '门后灯影摇晃。',
        createdAt: baseTs + 2000,
        summarySnapshot: makeEmptySnapshot(),
        telemetry: storyTelemetryRetry,
      },
    },
    rootNodeIds: ['s-u1'],
    activeLeafNodeId: 's-a1',
    createdAt: baseTs,
    updatedAt: baseTs + 2000,
  };

  const workNode = {
    id: 'w-a1',
    parentId: null,
    role: 'assistant',
    content: '建议收紧结尾段落。',
    createdAt: baseTs + 3000,
    summarySnapshot: makeEmptySnapshot(),
    telemetry: {
      providerKind: 'deepseek-official',
      model: 'deepseek-flash',
      generationUsage: {
        promptCacheHitTokens: 800,
        promptCacheMissTokens: 200,
        completionTokens: 120,
      },
      uncompressedPromptChars: 18000,
      compressedPromptChars: 2500,
      retrievedNodeCount: 1,
    },
  };

  const work = {
    id: 'issue-141-work',
    title: '雪夜草稿',
    document: makeDoc('w-doc-1', '大纲正文', baseTs),
    body: '雪落满窗台。',
    bodyRevision: 1,
    discussion: [workNode],
    discussionNodes: { 'w-a1': workNode },
    activeDiscussionLeafId: 'w-a1',
    suggestions: [],
  };

  const charNode = {
    id: 'c-a1',
    parentId: null,
    role: 'assistant',
    content: '我记得你上次来过。',
    createdAt: baseTs + 4000,
    summarySnapshot: makeEmptySnapshot(),
    telemetry: {
      providerKind: 'deepseek-official',
      model: 'deepseek-flash',
      generationUsage: {
        promptCacheHitTokens: 700,
        promptCacheMissTokens: 300,
        completionTokens: 100,
      },
      uncompressedPromptChars: 12000,
      compressedPromptChars: 2500,
    },
  };

  const character = {
    id: 'issue-141-char',
    name: '沈砚',
    document: makeDoc('c-doc-1', '守夜人设定', baseTs),
    conversations: [
      {
        id: 'conv-1',
        title: '初遇',
        kind: 'personal',
        characterVersion: 'c-doc-1',
        document: makeDoc('conv-doc-1', '', baseTs),
        edits: {},
        nodes: { 'c-a1': charNode },
        activeLeafNodeId: 'c-a1',
      },
      {
        id: 'conv-2',
        title: '重逢',
        kind: 'roleplay',
        characterVersion: 'c-doc-1',
        document: makeDoc('conv-doc-2', '', baseTs),
        edits: {},
        nodes: {},
        activeLeafNodeId: null,
      },
    ],
    activeConversationId: 'conv-1',
  };

  return {
    schemaVersion: 3,
    exportedAt: baseTs + 5000,
    appVersion: '0.4.2',
    stories: [story],
    workspace: {
      revision: 1,
      publicDocument: makeDoc('pub-v1', '', baseTs),
      works: [work],
      characters: [character],
      v2Migrated: true,
    },
  };
}

async function openSettings(page) {
  const desktopBtn = page.getByTestId('desktop-settings-open');
  if (await desktopBtn.isVisible().catch(() => false)) {
    await desktopBtn.click();
  } else {
    await page.getByTestId('library-drawer-trigger').click();
    await page.getByTestId('mobile-library-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('mobile-settings-open').click();
  }
  await page.getByTestId('settings-page').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const stage = document.querySelector('.app-overlay-stage');
    if (!stage) return false;
    const transform = getComputedStyle(stage).transform;
    return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const overview = document.querySelector('[data-testid="settings-usage-overview"]');
    const rect = overview?.getBoundingClientRect();
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      overviewScrollWidth: overview?.scrollWidth ?? 0,
      overviewClientWidth: overview?.clientWidth ?? 0,
      overviewRight: rect?.right ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  assert.ok(
    metrics.docScrollWidth <= metrics.docClientWidth,
    `${label}: document horizontal overflow (${metrics.docScrollWidth} > ${metrics.docClientWidth})`,
  );
  assert.ok(
    metrics.overviewScrollWidth <= metrics.overviewClientWidth + 1,
    `${label}: settings-usage-overview overflow (${metrics.overviewScrollWidth} > ${metrics.overviewClientWidth})`,
  );
  assert.ok(
    metrics.overviewRight <= metrics.viewportWidth + 1,
    `${label}: settings-usage-overview clipped past viewport (${metrics.overviewRight} > ${metrics.viewportWidth})`,
  );
}

async function main() {
  const server = await startViteServer();
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => {
    localStorage.setItem('folio.tutorial.mainDone', 'true');
    localStorage.setItem('folio.tutorial.settingsDone', 'true');
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === `http://localhost:${PORT}`
      ? route.continue()
      : route.abort('internetdisconnected');
  });

  const page = await context.newPage();
  const backup = buildIssue141BackupPayload();

  try {
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('welcome-view').waitFor();

    // 1. Check empty workspace state in Settings on 360x800 mobile
    await openSettings(page);
    const overview = page.getByTestId('settings-usage-overview');
    await overview.waitFor({ state: 'visible' });
    const emptyText = await overview.textContent();
    assert.ok(emptyText?.includes('省 Token 与用量总览'), 'Missing Settings usage overview heading');
    assert.ok(emptyText?.includes('暂无可比省费'), 'Missing honest unavailable label');
    assert.ok(emptyText?.includes('尚无模型返回的实测用量记录'), 'Missing no-usage-data reason');
    assert.ok(!emptyText?.includes('$0') && !emptyText?.includes('US$'), 'Empty state must not fake $0/US$');
    await assertNoHorizontalOverflow(page, 'empty 360x800');

    // 2. Restore backup with historical turns across all 3 modes (including branched/retried turn)
    await page.setInputFiles('[data-testid="backup-import-input"]', {
      name: 'issue-141-usage.folio.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });

    // 3. Reopen Settings and verify aggregated metrics & 3-mode breakdown across themes/viewports
    await openSettings(page);
    await overview.waitFor({ state: 'visible' });
    const populatedText = await overview.textContent();
    assert.ok(populatedText?.includes('累计预计省费'), `Expected hero savings label in: ${populatedText}`);
    assert.ok(populatedText?.includes('US$'), 'Expected USD savings figures');
    assert.ok(populatedText?.includes('4 轮'), `Expected 4 recorded turns (incl. retry) in: ${populatedText}`);
    assert.ok(populatedText?.includes('75.0%'), `Expected 75.0% cache hit rate in: ${populatedText}`);
    assert.ok(populatedText?.includes('4 轮压缩'), `Expected 4 compressed turns in: ${populatedText}`);
    assert.ok(populatedText?.includes('历史引用 3 条（2 轮）'), `Expected retrieved refs in: ${populatedText}`);

    const storyRowText = await overview.getByTestId('workspace-usage-mode-story').textContent();
    assert.ok(storyRowText?.includes('文游') && storyRowText?.includes('1 个故事') && storyRowText?.includes('2 轮'));
    const writingRowText = await overview.getByTestId('workspace-usage-mode-writing').textContent();
    assert.ok(writingRowText?.includes('写故事') && writingRowText?.includes('1 部作品') && writingRowText?.includes('1 轮'));
    const charRowText = await overview.getByTestId('workspace-usage-mode-character').textContent();
    assert.ok(charRowText?.includes('角色互动') && charRowText?.includes('1 位角色 · 2 段对话') && charRowText?.includes('1 轮'));

    for (const theme of ['light', 'dark', 'warm']) {
      await page.getByTestId(`theme-option-${theme}`).click();
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await assertNoHorizontalOverflow(page, `${theme} ${viewport.width}x${viewport.height}`);
      }
    }

    console.log('ISSUE_141_E2E_PASSED');
  } finally {
    await context.close();
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
