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

const PORT = Number(process.env.LFH_E2E_ISSUE_125_PORT || 4199);
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

function makeEmptySnapshot() {
  return { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 };
}

function buildIssue125BackupPayload() {
  const nodes = {};
  const branchNames = {};
  const baseTs = new Date(2026, 2, 15, 14, 0).getTime();

  const addChain = (prefix, parentId, turns, startTs, labelText) => {
    let prev = parentId;
    let firstId = '';
    let ts = startTs;
    for (let t = 1; t <= turns; t += 1) {
      const uId = `${prefix}-u${t}`;
      const aId = `${prefix}-a${t}`;
      if (!firstId) firstId = uId;
      nodes[uId] = {
        id: uId,
        parentId: prev,
        role: 'user',
        content: `${labelText} 行动 ${t}`,
        createdAt: ts,
        summarySnapshot: makeEmptySnapshot(),
      };
      nodes[aId] = {
        id: aId,
        parentId: uId,
        role: 'assistant',
        content: `${labelText} 回执 ${t}`,
        turnSummary: t === turns ? `${labelText}终点` : undefined,
        createdAt: ts + 1000,
        summarySnapshot: makeEmptySnapshot(),
      };
      ts += 2000;
      prev = aId;
    }
    return { firstId, lastId: prev };
  };

  // 2-turn trunk -> fork at trunk-a2
  const trunk = addChain('trunk', null, 2, baseTs, '主干开局');
  // 65-turn active branch after fork (> SPAN_STAGE_MAX_TURNS = 50)
  const activeBranch = addChain('active', trunk.lastId, 65, baseTs + 100_000, '长线主干');
  branchNames[activeBranch.firstId] = '长线主干路径';

  // 20 single-turn retries at trunk-u2
  for (let r = 1; r <= 20; r += 1) {
    const retryId = `retry-${r}`;
    nodes[retryId] = {
      id: retryId,
      parentId: 'trunk-u2',
      role: 'assistant',
      content: `当轮重抽试错-${r}`,
      createdAt: baseTs + 20_000 + r * 100,
      summarySnapshot: makeEmptySnapshot(),
    };
  }

  // 3-level nested branch: trunk.lastId -> lvl1 -> lvl2 -> (grandchild, alt)
  const lvl1 = addChain('lvl1', trunk.lastId, 3, baseTs + 500_000, '北塔一层');
  branchNames[lvl1.firstId] = '北塔祖先线';
  const lvl2 = addChain('lvl2', lvl1.lastId, 4, baseTs + 600_000, '钟楼二层');
  branchNames[lvl2.firstId] = '钟楼中继线';
  const grandchild = addChain('lvl3-grand', lvl2.lastId, 3, baseTs + 700_000, '星象密匣终章');
  branchNames[grandchild.firstId] = '星象密匣终章';
  addChain('lvl3-alt', lvl2.lastId, 2, baseTs + 650_000, '旁路封存线');

  const story = {
    id: 'issue-125-story',
    title: '双视图剧情树 E2E 故事',
    rawScript: '剧情树长篇分支与重试压测设定。',
    blueprint: {
      title: '双视图剧情树 E2E 故事',
      worldRules: ['保持分支隔离'],
      protagonist: '调查员',
      npcs: [],
      taboos: [],
      openingHook: '长廊尽头有两扇门。',
      extractionStatus: 'complete',
    },
    nodes,
    rootNodeIds: [trunk.firstId],
    activeLeafNodeId: activeBranch.lastId,
    branchNames,
    createdAt: baseTs,
    updatedAt: baseTs + 800_000,
  };

  return {
    schemaVersion: 3,
    exportedAt: baseTs + 900_000,
    appVersion: '0.3.0',
    stories: [story],
    workspace: {
      revision: 1,
      publicDocument: {
        head: 'pub-v1',
        versions: {
          'pub-v1': { id: 'pub-v1', previous: null, markdown: '', savedAt: baseTs, source: 'user' },
        },
      },
      works: [],
      characters: [],
      v2Migrated: true,
    },
  };
}

async function assertNoHorizontalOverflow(page, label) {
  const docMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(
    docMetrics.scrollWidth <= docMetrics.clientWidth,
    `${label}: document horizontal overflow (${docMetrics.scrollWidth} > ${docMetrics.clientWidth})`,
  );

  const sheet = page.locator('[data-testid="story-tree-sheet"]');
  if (await sheet.isVisible().catch(() => false)) {
    const sheetMetrics = await sheet.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert.ok(
      sheetMetrics.scrollWidth <= sheetMetrics.clientWidth,
      `${label}: sheet horizontal overflow (${sheetMetrics.scrollWidth} > ${sheetMetrics.clientWidth})`,
    );
  }
}

async function assertTouchTarget(locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} missing bounding box`);
  assert.ok(box.width >= 44 && box.height >= 44, `${label} touch target too small: ${box.width}x${box.height}`);
}

async function assertLibraryCategoriesSingleRow(dialog, label) {
  const metrics = await dialog.locator('.library-categories').evaluate((group) => {
    const buttons = [...group.querySelectorAll('button')];
    return {
      groupScrollWidth: group.scrollWidth,
      groupClientWidth: group.clientWidth,
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        const lineRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        const uniqueLines = new Set(lineRects.map((r) => Math.round(r.top)));
        return {
          text: button.textContent?.trim() ?? '',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth,
          lineCount: uniqueLines.size,
        };
      }),
    };
  });

  assert.deepEqual(
    metrics.buttons.map((b) => b.text),
    ['文游', '写故事', '角色互动'],
    `${label}: unexpected library category labels`,
  );
  assert.ok(
    metrics.groupScrollWidth <= metrics.groupClientWidth,
    `${label}: .library-categories horizontal overflow (${metrics.groupScrollWidth} > ${metrics.groupClientWidth})`,
  );
  const baseTop = metrics.buttons[0].top;
  for (const btn of metrics.buttons) {
    assert.ok(btn.width >= 44 && btn.height >= 44, `${label} "${btn.text}" touch target too small: ${btn.width}x${btn.height}`);
    assert.ok(Math.abs(btn.top - baseTop) <= 2, `${label} "${btn.text}" wrapped to another row (top ${btn.top} vs ${baseTop})`);
    assert.equal(btn.lineCount, 1, `${label} "${btn.text}" wrapped onto ${btn.lineCount} lines`);
    assert.ok(btn.scrollWidth <= btn.clientWidth, `${label} "${btn.text}" text overflow (${btn.scrollWidth} > ${btn.clientWidth})`);
  }
}

async function runMobileScenario(browser, viewport) {
  const context = await browser.newContext({
    viewport,
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
  const backup = buildIssue125BackupPayload();

  try {
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-view').waitFor();

    // Open mobile drawer -> Settings -> Import v3 backup
    await page.getByTestId('library-drawer-trigger').click();
    const mobileDrawer = page.getByTestId('mobile-library-dialog');
    await mobileDrawer.waitFor({ state: 'visible' });
    await assertLibraryCategoriesSingleRow(mobileDrawer, `${viewport.width}x${viewport.height} mobile drawer`);
    await page.getByTestId('mobile-settings-open').click();
    await page.getByTestId('settings-page').waitFor();

    await page.setInputFiles('[data-testid="backup-import-input"]', {
      name: 'issue-125-tree.folio.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });

    // Select imported story if not already active on timeline
    if (!(await page.getByTestId('story-timeline').isVisible().catch(() => false))) {
      await page.getByTestId('library-drawer-trigger').click();
      await page.getByTestId('mobile-library-dialog').waitFor({ state: 'visible' });
      await page.getByTestId('story-select-button').filter({ hasText: '双视图剧情树 E2E 故事' }).first().click();
    }
    await page.getByTestId('story-timeline').getByText('长线主干 回执 65', { exact: true }).waitFor();

    // Open Story Tree sheet
    await page.getByTestId('open-story-tree').click();
    const sheet = page.getByTestId('story-tree-sheet');
    await sheet.waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} spine initial`);

    // Verify default active tab is '当前脉络'
    assert.equal(await sheet.getByTestId('story-tree-tab-spine').getAttribute('aria-pressed'), 'true');
    await assertTouchTarget(sheet.getByTestId('story-tree-tab-spine'), 'tab spine');
    await assertTouchTarget(sheet.getByTestId('story-tree-tab-overview'), 'tab overview');

    // 1. 65-turn active span uses 50-turn stage segments before revealing individual nodes
    const spans = sheet.getByTestId('story-tree-span');
    const longSpan = spans.last();
    const longSpanToggle = longSpan.getByTestId('story-tree-span-toggle');
    await assertTouchTarget(longSpanToggle, 'long span toggle');
    assert.equal(await longSpan.getByTestId('story-tree-span-segments').count(), 0);
    assert.equal(await longSpan.getByTestId('story-tree-span-preview').count(), 0);

    await longSpanToggle.click();
    await longSpan.getByTestId('story-tree-span-segments').waitFor({ state: 'visible' });
    assert.equal(
      await longSpan.getByTestId('story-tree-span-preview').count(),
      0,
      '65-turn span must show 50-turn stage segments before rendering individual nodes',
    );
    const segmentToggles = longSpan.getByTestId('story-tree-span-segment-toggle');
    assert.equal(await segmentToggles.count(), 2, '65-turn span should split into 2 stage segments');
    await assertTouchTarget(segmentToggles.first(), 'span segment toggle');
    await segmentToggles.first().click();
    await longSpan.getByTestId('story-tree-span-preview').waitFor({ state: 'visible' });
    const revealedNodes = await longSpan.getByTestId('story-tree-span-node').count();
    assert.equal(revealedNodes, 100, 'first 50-turn segment should render 100 nodes');

    // Collapse span back to keep sheet tidy
    await longSpanToggle.click();

    // 2. 20 single-turn retries folded behind story-tree-fork-retries-toggle in 当前脉络
    const forkAtTurn2 = sheet.getByTestId('story-tree-fork-trunk-u2');
    await forkAtTurn2.click();
    await sheet.getByTestId('story-tree-branches').waitFor();
    const forkRetriesToggle = sheet.getByTestId('story-tree-fork-retries-toggle');
    await forkRetriesToggle.waitFor({ state: 'visible' });
    await assertTouchTarget(forkRetriesToggle, 'fork retries toggle');
    assert.ok((await forkRetriesToggle.textContent())?.includes('已收纳 20 次当轮重试'));
    assert.equal(await sheet.getByText('当轮重抽试错-1', { exact: false }).count(), 0);
    await forkRetriesToggle.click();
    await sheet.getByText('当轮重抽试错-1', { exact: false }).first().waitFor();
    await forkRetriesToggle.click();
    assert.equal(await sheet.getByText('当轮重抽试错-1', { exact: false }).count(), 0);

    // 3. 20 single-turn retries folded behind story-tree-retries-toggle in 分支总览
    await sheet.getByTestId('story-tree-tab-overview').click();
    await sheet.getByTestId('story-tree-overview').waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} overview`);
    const overviewRetriesToggle = sheet.getByTestId('story-tree-retries-toggle');
    await overviewRetriesToggle.waitFor({ state: 'visible' });
    await assertTouchTarget(overviewRetriesToggle, 'overview retries toggle');
    assert.ok((await overviewRetriesToggle.textContent())?.includes('已收纳 20 次单轮重试'));
    assert.equal(await sheet.getByTestId('story-tree-overview-branch-retry-1').count(), 0);
    await overviewRetriesToggle.click();
    await sheet.getByTestId('story-tree-overview-branch-retry-1').waitFor({ state: 'visible' });
    await overviewRetriesToggle.click();

    // Verify scale sort button touch target, label & behavior
    const sortRecent = sheet.getByTestId('story-tree-sort-recent');
    const sortScale = sheet.getByTestId('story-tree-sort-scale');
    assert.equal((await sortRecent.textContent())?.trim(), '最近游玩');
    assert.equal((await sortScale.textContent())?.trim(), '最多轮次');
    await assertTouchTarget(sortRecent, 'sort recent');
    await assertTouchTarget(sortScale, 'sort scale');
    await sortScale.click();

    // 4. Find deep nested grandchild branch via search and switch in <= 3 clicks (from spine tab)
    await sheet.getByTestId('story-tree-tab-spine').click();
    await sheet.getByTestId('story-tree-search').fill('北塔祖先线');
    await sheet.getByTestId('story-tree-overview').waitFor({ state: 'visible' });
    const grandchildCard = sheet.getByTestId('story-tree-overview-branch-lvl3-grand-u1');
    await grandchildCard.waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} search results`);

    await grandchildCard.getByRole('button', { name: '切换至此分支' }).click();
    await page.getByTestId('story-timeline').getByText('星象密匣终章 回执 3', { exact: true }).waitFor();

    // 5. Undo switch restores the prior branch
    const undoBanner = sheet.getByTestId('story-tree-undo-banner');
    await undoBanner.waitFor({ state: 'visible' });
    assert.ok((await undoBanner.textContent())?.includes('星象密匣终章'));
    await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} undo banner`);

    const undoBtn = sheet.getByTestId('story-tree-undo-switch');
    await assertTouchTarget(undoBtn, 'undo switch button');
    await undoBtn.click();
    await undoBanner.waitFor({ state: 'detached' });
    await page.getByTestId('story-timeline').getByText('长线主干 回执 65', { exact: true }).waitFor();
    await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} after undo`);
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
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ]) {
      await runMobileScenario(browser, viewport);
    }
    console.log('ISSUE_125_STORY_TREE_E2E_PASSED');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
