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

const PORT = Number(process.env.LFH_E2E_ISSUE_145_PORT || 4195);
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

async function startViteServer(port) {
  const server = spawn(process.execPath, [viteBinary, '--port', String(port), '--strictPort'], {
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
      if (settled || !chunk.toString().includes(String(port))) return;
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

async function assertCanonicalCopy(page) {
  const text = await page.getByTestId('spotlight-card').textContent();
  assert.ok(text, 'Spotlight card text missing');
  assert.ok(!text.includes('破甲'), `Forbidden wording "破甲" in tutorial copy: ${text}`);
  assert.ok(!text.includes('防拒答'), `Forbidden wording "防拒答" in tutorial copy: ${text}`);
  assert.ok(!text.includes('顶部模式'), `Stale TopBar mode switcher copy found: ${text}`);
}

async function assertCardAndTargetGeometry(page, label, expectedTargets) {
  const metrics = await page.evaluate((selectors) => {
    const card = document.querySelector('[data-testid="spotlight-card"]');
    if (!card) return { missingCard: true };
    const cardRect = card.getBoundingClientRect();
    const buttons = [...card.querySelectorAll('button')].map((btn) => {
      const r = btn.getBoundingClientRect();
      return {
        testId: btn.getAttribute('data-testid') || btn.getAttribute('aria-label') || btn.textContent?.trim(),
        width: r.width,
        height: r.height,
      };
    });
    const targets = selectors.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return { selector, missing: true };
      const r = el.getBoundingClientRect();
      return {
        selector,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    });
    const cutouts = [...document.querySelectorAll('[data-testid^="spotlight-cutout"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      card: {
        left: cardRect.left,
        right: cardRect.right,
        top: cardRect.top,
        bottom: cardRect.bottom,
        width: cardRect.width,
        height: cardRect.height,
      },
      buttons,
      targets,
      cutouts,
    };
  }, expectedTargets);

  assert.ok(!metrics.missingCard, `${label}: spotlight-card missing`);
  assert.ok(
    metrics.card.left >= 0 &&
      metrics.card.right <= metrics.viewportWidth + 1 &&
      metrics.card.top >= 0 &&
      metrics.card.bottom <= metrics.viewportHeight + 1,
    `${label}: spotlight-card clipped outside viewport (${JSON.stringify(metrics.card)} vs ${metrics.viewportWidth}x${metrics.viewportHeight})`,
  );
  assert.ok(metrics.cutouts.length >= expectedTargets.length, `${label}: expected at least ${expectedTargets.length} spotlight cutouts`);
  for (const btn of metrics.buttons) {
    assert.ok(
      btn.width >= 44 && btn.height >= 44,
      `${label}: button "${btn.testId}" smaller than 44x44 (${btn.width}x${btn.height})`,
    );
  }
  for (const target of metrics.targets) {
    assert.ok(!target.missing, `${label}: target ${target.selector} missing`);
    assert.ok(target.width > 0 && target.height > 0, `${label}: target ${target.selector} has zero dimensions`);
    const intersectsViewport =
      target.bottom > 0 &&
      target.top < metrics.viewportHeight &&
      target.right > 0 &&
      target.left < metrics.viewportWidth;
    assert.ok(intersectsViewport, `${label}: target ${target.selector} is not scrolled into view (${JSON.stringify(target)})`);
  }
}

async function createTutorialContext(browser, port, viewport, { newOfflineContext } = {}) {
  if (newOfflineContext) {
    return newOfflineContext(browser, port, { viewport, skipTutorial: false });
  }
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  context.setDefaultTimeout(15000);
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === `http://localhost:${port}`
      ? route.continue()
      : route.abort('internetdisconnected'),
  );
  return context;
}

export async function verifyIssue145SpotlightTutorial(browser, port, helpers = {}) {
  // 1. Mobile 360x800: Stage 1 fresh launch -> step through -> complete -> reload -> Stage 2 -> replay -> Escape/Back
  {
    const context = await createTutorialContext(browser, port, { width: 360, height: 800 }, helpers);
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
      await page.getByTestId('welcome-view').waitFor({ state: 'visible' });

      const tutorial = page.getByTestId('spotlight-tutorial');
      await tutorial.waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '1 / 4');
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage1 step1', [
        '#turn-input',
        '[data-testid="library-drawer-trigger"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '2 / 4');
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage1 step2', [
        '[data-testid="composer-generation-controls"]',
      ]);

      // Verify Prev returns to step 1 and Next returns to step 2 -> 3
      await page.getByTestId('spotlight-prev-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '1 / 4');
      await page.getByTestId('spotlight-next-btn').click();
      await page.getByTestId('spotlight-next-btn').click();

      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '3 / 4');
      await assertCanonicalCopy(page);
      const step3Text = await page.getByTestId('spotlight-card').textContent();
      assert.ok(step3Text?.includes('叙事预设') && step3Text?.includes('叙事连贯保护'));
      await assertCardAndTargetGeometry(page, 'mobile stage1 step3', [
        '[data-testid="composer-narrative-preset-trigger"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '4 / 4');
      await page.getByTestId('tutorial-connect-cta').waitFor({ state: 'visible' });
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage1 step4', [
        '[data-testid="welcome-key-hint"]',
      ]);

      await page.getByTestId('spotlight-finish-btn').click();
      await tutorial.waitFor({ state: 'detached' });

      const persistedAfterMain = await page.evaluate(() => ({
        mainDone: localStorage.getItem('folio.tutorial.mainDone'),
        settingsDone: localStorage.getItem('folio.tutorial.settingsDone'),
      }));
      assert.equal(persistedAfterMain.mainDone, 'true');
      assert.equal(persistedAfterMain.settingsDone, null);

      // Reload: Stage 1 must not reappear
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('welcome-view').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      assert.equal(await tutorial.count(), 0, 'Stage 1 reappeared after completion and reload');

      // Open Settings for the first time -> Stage 2 appears and scrolls each target into view
      await page.getByTestId('library-drawer-trigger').click();
      await page.getByTestId('mobile-settings-open').click();
      await page.getByTestId('settings-page').waitFor({ state: 'visible' });

      await tutorial.waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '1 / 4');
      await assertCanonicalCopy(page);
      await page.waitForTimeout(450);
      await assertCardAndTargetGeometry(page, 'mobile stage2 step1', [
        '[data-testid="settings-connection-group"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '2 / 4');
      await page.waitForTimeout(450);
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage2 step2', [
        '[data-testid="settings-usage-overview"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '3 / 4');
      await page.waitForTimeout(450);
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage2 step3', [
        '[data-testid="settings-narrative-presets-group"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '4 / 4');
      await page.waitForTimeout(450);
      await assertCanonicalCopy(page);
      await assertCardAndTargetGeometry(page, 'mobile stage2 step4', [
        '[data-testid="settings-backup-group"]',
        '[data-testid="replay-tutorial-btn"]',
      ]);

      await page.getByTestId('spotlight-finish-btn').click();
      await tutorial.waitFor({ state: 'detached' });

      const persistedAfterSettings = await page.evaluate(() => ({
        mainDone: localStorage.getItem('folio.tutorial.mainDone'),
        settingsDone: localStorage.getItem('folio.tutorial.settingsDone'),
      }));
      assert.equal(persistedAfterSettings.mainDone, 'true');
      assert.equal(persistedAfterSettings.settingsDone, 'true');

      // Reload and re-enter Settings -> Stage 2 must not reappear
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('library-drawer-trigger').click();
      await page.getByTestId('mobile-settings-open').click();
      await page.getByTestId('settings-page').waitFor({ state: 'visible' });
      await page.waitForTimeout(450);
      assert.equal(await tutorial.count(), 0, 'Stage 2 reappeared after completion and reload');

      // Replay from Settings resets both flags, returns to main screen, and launches Stage 1
      const replayBtn = page.getByTestId('replay-tutorial-btn');
      await replayBtn.scrollIntoViewIfNeeded();
      await replayBtn.click();
      await page.getByTestId('settings-page').waitFor({ state: 'detached' });
      await tutorial.waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '1 / 4');

      // Escape dismisses Stage 1 cleanly via useWebHistoryLayer
      await page.keyboard.press('Escape');
      await tutorial.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => localStorage.getItem('folio.tutorial.mainDone')), 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('folio.tutorial.settingsDone')), 'false');

      // Opening Settings after replay triggers Stage 2 again, and Escape dismisses Stage 2 without closing Settings
      await page.getByTestId('library-drawer-trigger').click();
      await page.getByTestId('mobile-settings-open').click();
      await page.getByTestId('settings-page').waitFor({ state: 'visible' });
      await tutorial.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await tutorial.waitFor({ state: 'detached' });
      assert.equal(await page.getByTestId('settings-page').isVisible(), true);
      assert.equal(await page.evaluate(() => localStorage.getItem('folio.tutorial.settingsDone')), 'true');
    } finally {
      await context.close();
    }
  }

  // 2. Desktop 1280x800: sidebar spotlight + "去连接 DeepSeek" CTA + history back dismissal
  {
    const context = await createTutorialContext(browser, port, { width: 1280, height: 800 }, helpers);
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
      await page.getByTestId('welcome-view').waitFor({ state: 'visible' });

      const tutorial = page.getByTestId('spotlight-tutorial');
      await tutorial.waitFor({ state: 'visible' });
      await assertCardAndTargetGeometry(page, 'desktop stage1 step1', [
        '#turn-input',
        '[data-testid="desktop-library"]',
      ]);

      await page.getByTestId('spotlight-next-btn').click();
      await page.getByTestId('spotlight-next-btn').click();
      await page.getByTestId('spotlight-next-btn').click();
      assert.equal(await page.getByTestId('spotlight-step-counter').textContent(), '4 / 4');

      await page.getByTestId('tutorial-connect-cta').click();
      await tutorial.waitFor({ state: 'detached' });
      await page.getByTestId('deepseek-setup-wizard').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => localStorage.getItem('folio.tutorial.mainDone')), 'true');

      // Close wizard, reset flags via Settings replay, then test Skip and Android/Web history back (popstate)
      await page.keyboard.press('Escape');
      await page.getByTestId('deepseek-setup-wizard').waitFor({ state: 'detached' });

      await page.getByTestId('desktop-settings-open').click();
      await page.getByTestId('settings-page').waitFor({ state: 'visible' });
      await tutorial.waitFor({ state: 'visible' });
      await page.getByTestId('spotlight-skip-btn').click();
      await tutorial.waitFor({ state: 'detached' });

      await page.getByTestId('replay-tutorial-btn').scrollIntoViewIfNeeded();
      await page.getByTestId('replay-tutorial-btn').click();
      await page.getByTestId('settings-page').waitFor({ state: 'detached' });
      await tutorial.waitFor({ state: 'visible' });

      // Simulate Android hardware back / browser back via window.history.back()
      await page.waitForTimeout(50);
      await page.evaluate(() => window.history.back());
      await tutorial.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => localStorage.getItem('folio.tutorial.mainDone')), 'true');
    } finally {
      await context.close();
    }
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const srv = await startViteServer(PORT);
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });
  try {
    await verifyIssue145SpotlightTutorial(browser, PORT);
    console.log('ISSUE_145_SPOTLIGHT_TUTORIAL_E2E_PASSED');
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
  }
}
