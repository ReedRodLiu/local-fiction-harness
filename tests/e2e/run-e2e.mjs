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

function buildSyntheticDeepSeekZipE2E() {
  const docxBytes = buildFixtureDocx();
  const fictionSession = {
    id: 'ds-e2e-fiction',
    title: '合成宫斗测试档',
    current_message_id: 4,
    inserted_at: '2026-11-15T10:00:00Z',
    updated_at: '2026-11-15T10:20:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:00:00Z',
        fragments: [
          {
            type: 'FILE',
            files: [
              {
                id: 'f1',
                file_name: '规则附件.docx',
                file_size: docxBytes.length,
                export_path: 'chat_sessions/ds-e2e-fiction/规则附件.docx',
                is_image: false,
              },
              {
                id: 'f2',
                file_name: '立绘.png',
                file_size: 256,
                export_path: 'chat_sessions/ds-e2e-fiction/立绘.png',
                is_image: true,
              },
              {
                id: 'f3',
                file_name: '老版本.doc',
                file_size: 256,
                export_path: 'chat_sessions/ds-e2e-fiction/老版本.doc',
                is_image: false,
              },
            ],
          },
          { type: 'REQUEST', content: '请按附件规则开始演绎第一幕，主角：沈小姐。' },
        ],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:01:00Z',
        fragments: [
          { type: 'TOOL_OPEN', url: 'https://example.invalid', title: 'skip' },
          { type: 'RESPONSE', content: '第1章 初入星光营\n地点：主大厅\n请选择下一步。' },
        ],
      },
      {
        id: 3,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:05:00Z',
        fragments: [{ type: 'REQUEST', content: '前往东侧练歌房' }],
      },
      {
        id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-15T10:06:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '平台风控噪音应剥离' },
          { type: 'RESPONSE', content: '原进度抵达东侧练歌房。' },
        ],
      },
      {
        id: 5,
        parent_id: 2,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:07:00Z',
        fragments: [{ type: 'REQUEST', content: '前往西侧花园' }],
      },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-15T10:08:00Z',
        fragments: [{ type: 'RESPONSE', content: '旁支到达西侧花园。' }],
      },
    ],
  };
  const dailySession = {
    id: 'ds-e2e-null',
    title: null,
    current_message_id: 2,
    inserted_at: '2026-11-14T08:00:00Z',
    updated_at: '2026-11-14T08:01:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-14T08:00:00Z',
        fragments: [{ type: 'REQUEST', content: '解释一下 Promise.all 的用法' }],
      },
      {
        id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        inserted_at: '2026-11-14T08:01:00Z',
        fragments: [{ type: 'RESPONSE', content: 'Promise.all 并行等待多个异步任务。' }],
      },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/ds-e2e-fiction.json': strToU8(JSON.stringify(fictionSession)),
    'chat_sessions/ds-e2e-null.json': strToU8(JSON.stringify(dailySession)),
    'chat_sessions/ds-e2e-fiction/规则附件.docx': docxBytes,
    'chat_sessions/ds-e2e-fiction/立绘.png': strToU8('fake-png-bytes'),
    'chat_sessions/ds-e2e-fiction/老版本.doc': strToU8('fake-doc-bytes'),
  });
}

function buildNamedDeepSeekZipE2E(id, title, snippet) {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    [`chat_sessions/${id}.json`]: strToU8(JSON.stringify({
      id,
      title,
      current_message_id: 2,
      inserted_at: '2026-11-19T08:00:00Z',
      updated_at: '2026-11-19T08:01:00Z',
      messages: [
        {
          id: 1,
          parent_id: null,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-19T08:00:00Z',
          fragments: [{ type: 'REQUEST', content: snippet }],
        },
        {
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-19T08:01:00Z',
          fragments: [{ type: 'RESPONSE', content: `${snippet} 的合成回执。` }],
        },
      ],
    })),
  });
}

function buildEmptyDeepSeekZipE2E() {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
  });
}

function buildAmbiguousOverWindowZipE2E() {
  const messages = [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:00:00Z', fragments: [{ type: 'REQUEST', content: '你好呀' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '你好，请发剧本。' }] },
    { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:02:00Z', fragments: [{ type: 'REQUEST', content: '我准备好了' }] },
    { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:03:00Z', fragments: [{ type: 'RESPONSE', content: '请贴出设定。' }] },
    { id: 5, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:04:00Z', fragments: [{ type: 'REQUEST', content: '【E2E模糊剧本】主角：陆行舟。规则：每轮输出状态栏。' }] },
    { id: 6, parent_id: 5, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:05:00Z', fragments: [{ type: 'RESPONSE', content: '第一幕开始。' }] },
    { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:06:00Z', fragments: [{ type: 'REQUEST', content: '走向码头' }] },
    { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:07:00Z', fragments: [{ type: 'RESPONSE', content: '码头停着货船。' }] },
    { id: 9, parent_id: 8, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:08:00Z', fragments: [{ type: 'REQUEST', content: '登上货船甲板' }] },
    { id: 10, parent_id: 9, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:09:00Z', fragments: [{ type: 'RESPONSE', content: '船长室灯还亮着。' }] },
    { id: 11, parent_id: 10, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:10:00Z', fragments: [{ type: 'REQUEST', content: '敲响船长室门' }] },
    { id: 12, parent_id: 11, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:11:00Z', fragments: [{ type: 'RESPONSE', content: '门后传来脚步声。' }] },
  ];
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/ds-e2e-ambig.json': strToU8(
      JSON.stringify({
        id: 'ds-e2e-ambig',
        title: '模糊开局超窗长档',
        current_message_id: 12,
        inserted_at: '2026-11-16T08:00:00Z',
        updated_at: '2026-11-16T08:11:00Z',
        messages,
      }),
    ),
  });
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

async function newOfflineContext(browser, port, options) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  // Page-level fixture routes take precedence. Unmocked HTTP traffic stays on the local Vite origin.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === `http://localhost:${port}`
      ? route.continue()
      : route.abort('internetdisconnected'),
  );
  return context;
}

async function mockSuccessfulKeyVerification(page) {
  await page.route('https://api.deepseek.com/models', (route) =>
    route.fulfill({ status: 200, json: { data: [{ id: 'deepseek-flash' }] } }),
  );
}

async function completePendingSetup(page, key) {
  const wizard = page.getByTestId('deepseek-setup-wizard');
  await wizard.locator('#byok-api-key').fill(key);
  await wizard.getByTestId('wizard-verify-save-btn').click();
  await wizard.waitFor({ state: 'detached' });
}

async function expectTouchTarget(locator, label) {
  const box = await locator.boundingBox();
  if (!box || box.width < 43.99 || box.height < 43.99) {
    throw new Error(`${label} is below 44×44px: ${JSON.stringify(box)}`);
  }
}

async function assertUploadControlHasVisibleKeyboardFocus(page, backButton, targetTestId, tabCount, label) {
  await backButton.focus();
  for (let i = 0; i < tabCount; i += 1) await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    const style = active ? getComputedStyle(active) : null;
    return {
      testId: active?.getAttribute('data-testid'),
      outlineStyle: style?.outlineStyle,
      outlineWidth: style?.outlineWidth,
    };
  });
  if (focus.testId !== targetTestId || focus.outlineStyle === 'none' || focus.outlineWidth === '0px') {
    throw new Error(`${label} was not a visible keyboard focus stop: ${JSON.stringify(focus)}`);
  }
}

async function holdNextStoryStorageCommit(page) {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    if (!descriptor?.get || !descriptor.set) {
      throw new Error('IDBTransaction.oncomplete cannot be controlled in this browser.');
    }
    let armed = true;
    window.__lfhStoryCommitControl = { release: null };
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(handler) {
        if (typeof handler !== 'function') {
          descriptor.set.call(this, handler);
          return;
        }
        const transaction = this;
        descriptor.set.call(this, (event) => {
          if (
            armed &&
            transaction.objectStoreNames.contains('stories') &&
            typeof window.__lfhStoryCommitControl?.release !== 'function'
          ) {
            armed = false;
            window.__lfhStoryCommitControl.release = () => {
              Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor);
              handler.call(transaction, event);
            };
            return;
          }
          handler.call(transaction, event);
        });
      },
    });
  });
}

async function releaseHeldStoryStorageCommit(page) {
  await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
  await page.evaluate(() => window.__lfhStoryCommitControl.release());
}

async function prepareAiFilterAbortProbe(page) {
  await page.evaluate(() => {
    if (!window.__lfhOriginalFetchForAiProbe) {
      window.__lfhOriginalFetchForAiProbe = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const body = typeof init.body === 'string' ? init.body : '';
        if (body.includes('互动叙事文游识别助手')) {
          init.signal?.addEventListener('abort', () => {
            window.__lfhAiFilterAbortCount += 1;
          }, { once: true });
        }
        return window.__lfhOriginalFetchForAiProbe(input, init);
      };
    }
    window.__lfhAiFilterAbortCount = 0;
  });
}

async function verifySliceOneViewportMatrix(page) {
  if ((await page.getByTestId('app-topbar').count()) !== 1) {
    throw new Error('Expected the mobile-first top navigation shell.');
  }
  if ((await page.getByTestId('welcome-view').count()) !== 1) {
    throw new Error('Expected the welcome view when no story is active.');
  }

  for (const theme of ['light', 'dark', 'warm']) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate((selectedTheme) => {
        document.documentElement.dataset.theme = selectedTheme;
      }, theme);
      const layout = await page.evaluate(() => {
        const topbar = document.querySelector('[data-testid="app-topbar"]');
        const menu = document.querySelector('[data-testid="library-drawer-trigger"]');
        const sidebar = document.querySelector('[data-testid="desktop-library"]');
        const sheet = document.querySelector('[data-testid="story-tree-sheet"]');
        const welcome = document.querySelector('[data-testid="welcome-view"]');
        const menuRect = menu?.getBoundingClientRect();
        const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
        const welcomeRect = welcome?.getBoundingClientRect();
        const welcomeHit = welcomeRect
          ? document.elementFromPoint(welcomeRect.left + welcomeRect.width / 2, welcomeRect.top + welcomeRect.height / 2)
          : null;
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          topbarVisible: Boolean(topbar && getComputedStyle(topbar).display !== 'none'),
          menuSize: menuRect ? Math.min(menuRect.width, menuRect.height) : 0,
          sidebarWidth: sidebarStyle?.display === 'none' ? 0 : sidebar?.getBoundingClientRect().width ?? 0,
          sheetHidden: Boolean(sheet && !sheet.open && getComputedStyle(sheet).display === 'none'),
          welcomeCoveredBySheet: Boolean(sheet && welcomeHit && sheet.contains(welcomeHit)),
        };
      });
      if (layout.scrollWidth > layout.clientWidth) {
        throw new Error(`Horizontal overflow in ${theme} ${viewport.width}x${viewport.height}: ${layout.scrollWidth} > ${layout.clientWidth}`);
      }
      if (!layout.topbarVisible) {
        throw new Error(`Top bar was hidden in ${theme} ${viewport.width}x${viewport.height}.`);
      }
      if (viewport.width < 960 && layout.menuSize < 44) {
        throw new Error(`Mobile drawer control is below 44px in ${theme}: ${layout.menuSize}px.`);
      }
      if (viewport.width >= 960 && layout.sidebarWidth < 44) {
        throw new Error(`Desktop library is missing in ${theme} ${viewport.width}px.`);
      }
      if (!layout.sheetHidden || layout.welcomeCoveredBySheet) {
        throw new Error(`Closed story sheet obscures the welcome view in ${theme} ${viewport.width}px.`);
      }

      if (viewport.width >= 960) {
        const libraryToggle = page.getByTestId('desktop-library-toggle');
        await libraryToggle.click();
        if ((await page.getByRole('button', { name: '设置与模型密钥' }).count()) !== 1) {
          throw new Error(`${cell} collapsed Settings button has no accessible name.`);
        }
        await libraryToggle.click();
      }

      await openSettings(page);
      const settingsLayout = await page.evaluate(() => {
        const pageShell = document.querySelector('[data-testid="settings-page"]');
        const workspace = document.querySelector('.app-workspace');
        const sheet = document.querySelector('[data-testid="story-tree-sheet"]');
        return {
          width: pageShell?.getBoundingClientRect().width ?? 0,
          columns: workspace ? getComputedStyle(workspace).gridTemplateColumns.split(' ').length : 0,
          sheetHidden: Boolean(sheet && !sheet.open && getComputedStyle(sheet).display === 'none'),
        };
      });
      const minSettingsWidth = viewport.width < 960 ? viewport.width - 24 : 640;
      if (settingsLayout.width < minSettingsWidth || settingsLayout.columns !== 1 || !settingsLayout.sheetHidden) {
        throw new Error(`Settings layout is constrained or covered in ${theme} ${viewport.width}px (width=${settingsLayout.width}, columns=${settingsLayout.columns}).`);
      }
      await closeSettings(page);
    }
  }

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function startDeepSeekImport(page) {
  await leaveImportView(page);
  const welcomeAction = page.getByTestId('welcome-deepseek-import');
  if (await welcomeAction.isVisible()) {
    await welcomeAction.click();
    return;
  }
  const desktopAction = page.getByTestId('desktop-library-start-deepseek');
  if (await desktopAction.isVisible()) {
    await desktopAction.click();
    return;
  }
  await page.getByTestId('library-drawer-trigger').click();
  await page.getByTestId('mobile-library-start-deepseek').click();
}

async function startScriptImport(page) {
  await leaveImportView(page);
  const welcomeAction = page.getByTestId('welcome-script-import');
  if (await welcomeAction.isVisible()) {
    await welcomeAction.click();
    return;
  }
  const desktopAction = page.getByTestId('desktop-library-start-script');
  if (await desktopAction.isVisible()) {
    await desktopAction.click();
    return;
  }
  await page.getByTestId('library-drawer-trigger').click();
  await page.getByTestId('mobile-library-start-script').click();
}

async function leaveImportView(page) {
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const deepseek = page.getByTestId('deepseek-import-panel');
    const script = page.getByTestId('import-panel');
    const shell = await deepseek.isVisible().catch(() => false)
      ? deepseek
      : await script.isVisible().catch(() => false)
        ? script
        : null;
    if (!shell) return;
    const currentStep = Number(await shell.getByRole('progressbar').getAttribute('aria-valuenow'));
    await shell.getByRole('button', { name: '返回' }).click();
    if (currentStep > 1) {
      await page.waitForFunction((expectedStep) =>
        Number(document.querySelector('[data-testid="deepseek-import-panel"] [role="progressbar"], [data-testid="import-panel"] [role="progressbar"]')?.getAttribute('aria-valuenow')) === expectedStep,
      currentStep - 1);
    } else {
      await shell.waitFor({ state: 'hidden' });
    }
  }
  throw new Error('Import wizard did not return to the story stage after four Back actions.');
}

async function openSessionPreview(page, title) {
  const row = page.getByTestId('ds-session-item').filter({ hasText: title }).first();
  await row.getByTestId('ds-session-preview-trigger').click();
  const sheet = page.getByTestId('deepseek-preview-sheet');
  await sheet.waitFor({ state: 'visible' });
  return { sheet, card: page.getByTestId('deepseek-preview-card') };
}

async function closeSessionPreview(sheet) {
  await sheet.getByRole('button', { name: '关闭剧情面板' }).click();
  await sheet.waitFor({ state: 'hidden' });
}

async function assertImportWizardLayout(page, testId, step, viewport) {
  const shell = page.getByTestId(testId);
  await shell.waitFor({ state: 'visible' });
  const layout = await shell.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const progress = element.querySelector('[role="progressbar"]');
    const footer = element.querySelector('.overlay-page-footer');
    const footerBounds = footer?.getBoundingClientRect();
    return {
      width: bounds.width,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      progressValue: Number(progress?.getAttribute('aria-valuenow')),
      footerVisible: Boolean(footerBounds && footerBounds.top < innerHeight && footerBounds.bottom <= innerHeight + 1),
      footerTop: footerBounds?.top ?? null,
      footerBottom: footerBounds?.bottom ?? null,
      shellHeight: bounds.height,
    };
  });
  if (layout.width > Math.min(640, viewport.width) + 1) {
    throw new Error(`${testId} exceeded its ${viewport.width}px viewport width: ${layout.width}px.`);
  }
  if (layout.scrollWidth > layout.clientWidth) {
    throw new Error(`Horizontal overflow in ${testId} at ${viewport.width}px.`);
  }
  if (layout.progressValue !== step) {
    throw new Error(`${testId} should report step ${step}, got ${layout.progressValue}.`);
  }
  if (!layout.footerVisible) {
    throw new Error(`${testId} primary actions are outside the ${viewport.height}px viewport: ${JSON.stringify(layout)}.`);
  }
}

async function assertImportThemeMatrix(page, testId, step, viewport) {
  for (const theme of ['light', 'dark', 'warm']) {
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme;
    }, theme);
    await assertImportWizardLayout(page, testId, step, viewport);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

async function runImportWizardE2E(browser, port, tmpDir) {
  const context = await newOfflineContext(browser, port, { acceptDownloads: true });
  const page = await context.newPage();
  try {
    await mockSuccessfulKeyVerification(page);
    let blueprintRequestCount = 0;
    let nextBlueprintRequestGate = null;
    let failNextAiRequest = false;
    let nextAiRequestGate = null;
    await page.route('https://cdn.deepseek.example/export-valid.zip', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/zip',
        body: Buffer.from(buildSyntheticDeepSeekZipE2E()),
      }),
    );
    await page.route('https://cdn.deepseek.example/export-fail.zip', (route) => route.abort('failed'));
    await page.route('**/chat/completions', async (route) => {
      const body = route.request().postDataJSON();
      const systemPrompt = body.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('严格只输出一个 JSON 对象')) {
        blueprintRequestCount += 1;
        const gate = nextBlueprintRequestGate;
        if (gate) {
          nextBlueprintRequestGate = null;
          gate.onStarted();
          await gate.waitForRelease;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{
            choices: [{
              delta: { content: JSON.stringify({
                title: '导入向导合成故事',
                worldRules: ['每轮保留状态面板'],
                protagonist: '沈知夏',
                npcs: [{ name: '顾老师', role: '导师', traits: '谨慎' }],
                taboos: ['不跳过关键线索'],
                openingHook: '你走进排练室。',
              }) },
              finish_reason: 'stop',
            }],
          }]),
        });
        gate?.onFinished();
        return;
      }
      if (systemPrompt.includes('互动叙事文游识别助手')) {
        if (failNextAiRequest) {
          failNextAiRequest = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'synthetic AI filter failure' } }),
          });
          return;
        }
        const gate = nextAiRequestGate;
        if (gate) {
          nextAiRequestGate = null;
          gate.onStarted();
          await gate.waitForRelease;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{
            choices: [{
              delta: { content: JSON.stringify({ fictionSessionIds: ['ds-e2e-fiction'] }) },
              finish_reason: 'stop',
            }],
          }]),
        });
        gate?.onFinished();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content: '合成续玩回执。' }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 1280, height: 800 });

    await startDeepSeekImport(page);
    await page.evaluate(() => {
      const originalArrayBuffer = File.prototype.arrayBuffer;
      const pendingReads = new Map();
      const completedReads = [];
      window.__lfhControlledFileReads = {
        completedReads,
        release(name) {
          const releaseRead = pendingReads.get(name);
          if (!releaseRead) throw new Error(`No pending file read for ${name}`);
          pendingReads.delete(name);
          releaseRead();
        },
      };
      File.prototype.arrayBuffer = function controlledArrayBuffer() {
        if (this.name !== 'late-old.zip' && this.name !== 'late-new.zip') {
          return originalArrayBuffer.call(this);
        }
        return new Promise((resolve, reject) => {
          pendingReads.set(this.name, () => {
            originalArrayBuffer.call(this).then((buffer) => {
              completedReads.push(this.name);
              resolve(buffer);
            }, reject);
          });
        });
      };
    });
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'late-old.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildNamedDeepSeekZipE2E('late-old', '迟到的旧压缩包', '旧会话正文')),
    });
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'late-new.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildNamedDeepSeekZipE2E('late-new', '最新选择的压缩包', '新会话正文')),
    });
    await page.evaluate(() => window.__lfhControlledFileReads.release('late-new.zip'));
    await page.getByTestId('ds-session-item').getByText('最新选择的压缩包').waitFor();
    await page.evaluate(() => window.__lfhControlledFileReads.release('late-old.zip'));
    await page.waitForFunction(() =>
      window.__lfhControlledFileReads?.completedReads.includes('late-old.zip'),
    );
    const lateZipListText = await page.getByTestId('ds-session-list').textContent();
    if (!lateZipListText?.includes('最新选择的压缩包') || lateZipListText.includes('迟到的旧压缩包')) {
      throw new Error(`A late older ZIP read replaced the newest selected ZIP: ${lateZipListText}`);
    }
    await leaveImportView(page);

    await startDeepSeekImport(page);
    await page.getByTestId('deepseek-source-url').click();
    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-fail.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    const urlError = page.getByTestId('import-error');
    await urlError.getByRole('button', { name: '改用本地 .zip 文件' }).waitFor();
    await urlError.getByRole('button', { name: '重试拉取' }).waitFor();
    if (await urlError.getByRole('button', { name: '重试导入' }).count() !== 0) {
      throw new Error('URL fetch failure offered final import retry.');
    }
    await leaveImportView(page);

    await startDeepSeekImport(page);
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'invalid-scan.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a zip archive'),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const scanError = page.getByTestId('import-error');
    const replaceZipAction = scanError.getByRole('button', { name: '重新选择导出包' });
    await replaceZipAction.waitFor();
    await expectTouchTarget(replaceZipAction, 'mobile ZIP replacement recovery action');
    await expectTouchTarget(
      scanError.getByRole('button', { name: '打包排障日志' }),
      'mobile import diagnostics action',
    );
    if (await scanError.getByRole('button', { name: '重试导入' }).count() !== 0) {
      throw new Error('ZIP scan failure offered final import retry.');
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await leaveImportView(page);

    await startDeepSeekImport(page);
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'empty-sessions.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildEmptyDeepSeekZipE2E()),
    });
    const emptyZipError = page.getByTestId('import-error');
    await emptyZipError.getByRole('button', { name: '重新选择导出包' }).waitFor();
    if (await emptyZipError.getByRole('button', { name: '重试导入' }).count() !== 0) {
      throw new Error('Empty ZIP failure offered final import retry.');
    }
    await leaveImportView(page);

    await startDeepSeekImport(page);
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'partial-import-error.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildSyntheticDeepSeekZipE2E()),
    });
    await page.getByTestId('ds-session-list').waitFor();
    await page.getByRole('button', { name: '全选' }).click();
    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put;
      let storyPutCount = 0;
      let failed = false;
      IDBObjectStore.prototype.put = function putWithSecondStoryFailure(...args) {
        if (this.name === 'stories') {
          storyPutCount += 1;
        }
        if (!failed && this.name === 'stories' && storyPutCount === 2) {
          failed = true;
          throw new Error('Synthetic second-story storage failure');
        }
        return originalPut.apply(this, args);
      };
      window.__lfhRestoreStoryPut = () => {
        IDBObjectStore.prototype.put = originalPut;
      };
    });
    await page.getByTestId('ds-confirm-import-btn').click();
    const importError = page.getByTestId('import-error');
    const retryImport = importError.getByRole('button', { name: /重试.*未完成/ });
    await retryImport.waitFor();
    await page.evaluate(() => window.__lfhRestoreStoryPut?.());
    await retryImport.click();
    const partialReceipt = page.getByTestId('deepseek-import-receipt');
    await partialReceipt.waitFor();
    const partialReceiptText = await partialReceipt.textContent();
    if (
      !partialReceiptText?.includes('合成宫斗测试档') ||
      !partialReceiptText.includes('解释一下 Promise.all 的用法')
    ) {
      throw new Error(`Partial import retry did not combine both saved stories: ${partialReceiptText}`);
    }
    await page.getByRole('button', { name: '继续这条故事' }).click();
    await page.getByTestId('deepseek-import-panel').waitFor({ state: 'detached' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: '合成宫斗测试档', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const persistedRows = await visibleStoryRows(page);
    if ((await persistedRows.count()) !== 2) {
      throw new Error(
        `A partial import retry duplicated an already saved story: ${await persistedRows.allTextContents()}`,
      );
    }
    for (const title of ['合成宫斗测试档', '解释一下 Promise.all 的用法']) {
      if ((await persistedRows.filter({ hasText: title }).count()) !== 1) {
        throw new Error(`Expected one persisted story row for ${title}.`);
      }
    }
    await deleteAllStories(page);
    const mobileLibrary = page.getByTestId('mobile-library-dialog');
    if (await mobileLibrary.isVisible().catch(() => false)) {
      await mobileLibrary.getByRole('button', { name: '关闭书架' }).click();
      await mobileLibrary.waitFor({ state: 'hidden' });
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await startDeepSeekImport(page);
    await page.getByTestId('deepseek-import-panel').waitFor();
    await assertImportThemeMatrix(page, 'deepseek-import-panel', 1, { width: 1280, height: 800 });
    const deepSeekBackButton = page.getByRole('button', { name: '返回' });
    await assertUploadControlHasVisibleKeyboardFocus(page, deepSeekBackButton, 'deepseek-zip-picker', 3, 'DeepSeek upload card');
    await assertUploadControlHasVisibleKeyboardFocus(page, deepSeekBackButton, 'deepseek-footer-zip-picker', 4, 'DeepSeek footer upload action');
    const sourceTablist = page.getByRole('tablist', { name: '导入来源' });
    const fileSourceTab = sourceTablist.getByRole('tab', { name: '本地 .zip' });
    const urlSourceTab = sourceTablist.getByRole('tab', { name: 'HTTPS 下载链接' });
    await fileSourceTab.focus();
    await page.keyboard.press('ArrowRight');
    if (
      await urlSourceTab.getAttribute('aria-selected') !== 'true' ||
      await urlSourceTab.getAttribute('tabindex') !== '0' ||
      await page.evaluate(() => document.activeElement?.id) !== await urlSourceTab.getAttribute('id')
    ) {
      throw new Error('Import source tabs did not move selection and focus with ArrowRight.');
    }
    const sourcePanelId = await urlSourceTab.getAttribute('aria-controls');
    if (!sourcePanelId || await page.locator(`#${sourcePanelId}`).getAttribute('role') !== 'tabpanel') {
      throw new Error('Import source tab does not control a semantic tabpanel.');
    }
    await page.keyboard.press('ArrowLeft');
    if (
      await fileSourceTab.getAttribute('aria-selected') !== 'true' ||
      await fileSourceTab.getAttribute('tabindex') !== '0' ||
      await urlSourceTab.getAttribute('tabindex') !== '-1'
    ) {
      throw new Error('Import source tabs did not move back with ArrowLeft.');
    }
    await fileSourceTab.focus();
    await page.keyboard.press('End');
    if (
      await urlSourceTab.getAttribute('aria-selected') !== 'true' ||
      await urlSourceTab.getAttribute('tabindex') !== '0' ||
      await fileSourceTab.getAttribute('tabindex') !== '-1' ||
      await page.evaluate(() => document.activeElement?.id) !== await urlSourceTab.getAttribute('id')
    ) {
      throw new Error('Import source tabs did not select the last tab with End.');
    }
    await page.keyboard.press('Home');
    if (
      await fileSourceTab.getAttribute('aria-selected') !== 'true' ||
      await fileSourceTab.getAttribute('tabindex') !== '0' ||
      await urlSourceTab.getAttribute('tabindex') !== '-1' ||
      await page.evaluate(() => document.activeElement?.id) !== await fileSourceTab.getAttribute('id')
    ) {
      throw new Error('Import source tabs did not select the first tab with Home.');
    }
    await page.getByTestId('deepseek-source-url').click();
    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-valid.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    await page.getByTestId('ds-session-list').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertImportThemeMatrix(page, 'deepseek-import-panel', 2, { width: 390, height: 844 });
    const mobileSearchHeight = await page.getByRole('searchbox', { name: '搜索外部会话' }).evaluate((input) =>
      input.getBoundingClientRect().height,
    );
    if (mobileSearchHeight > 52) {
      throw new Error(`DeepSeek search field is too tall on mobile: ${mobileSearchHeight}px.`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await assertImportWizardLayout(page, 'deepseek-import-panel', 2, { width: 1280, height: 800 });
    const desktopSearchHeight = await page.getByRole('searchbox', { name: '搜索外部会话' }).evaluate((input) =>
      input.getBoundingClientRect().height,
    );
    if (desktopSearchHeight > 52) {
      throw new Error(`DeepSeek search field is too tall on desktop: ${desktopSearchHeight}px.`);
    }
    const filterTablist = page.getByRole('tablist', { name: '筛选会话' });
    const allFilterTab = filterTablist.getByRole('tab', { name: '全部' });
    const likelyFilterTab = filterTablist.getByRole('tab', { name: '疑似文游' });
    const aiFilterTabAtMobile = filterTablist.getByRole('tab', { name: 'AI 辅助筛选' });
    await expectTouchTarget(allFilterTab, 'mobile session filter All tab');
    await expectTouchTarget(likelyFilterTab, 'mobile session filter Likely tab');
    await expectTouchTarget(aiFilterTabAtMobile, 'mobile session filter AI tab');
    if (
      await allFilterTab.getAttribute('tabindex') !== '0' ||
      await likelyFilterTab.getAttribute('tabindex') !== '-1'
    ) {
      throw new Error('Session filter tabs do not use roving tabIndex.');
    }
    const filterPanelId = await allFilterTab.getAttribute('aria-controls');
    if (!filterPanelId || await page.locator(`#${filterPanelId}`).getAttribute('role') !== 'tabpanel') {
      throw new Error('Session filter tab does not control a semantic tabpanel.');
    }
    await allFilterTab.focus();
    await page.keyboard.press('ArrowRight');
    if (
      await likelyFilterTab.getAttribute('aria-selected') !== 'true' ||
      await likelyFilterTab.getAttribute('tabindex') !== '0' ||
      await page.evaluate(() => document.activeElement?.id) !== await likelyFilterTab.getAttribute('id')
    ) {
      throw new Error('Session filter tabs did not move selection and focus with ArrowRight.');
    }
    await page.keyboard.press('ArrowLeft');
    if (await allFilterTab.getAttribute('aria-selected') !== 'true') {
      throw new Error('Session filter tabs did not move back with ArrowLeft.');
    }

    await page.getByRole('tab', { name: '疑似文游' }).click();
    await page.getByRole('tab', { name: 'AI 辅助筛选' }).click();
    const aiByokWizard = page.getByTestId('deepseek-setup-wizard');
    await aiByokWizard.waitFor();
    await aiByokWizard.getByRole('button', { name: '取消' }).click();
    await aiByokWizard.waitFor({ state: 'detached' });
    if (await page.getByRole('tab', { name: '疑似文游' }).getAttribute('aria-selected') !== 'true') {
      throw new Error('Canceling AI filter BYOK changed the current session category.');
    }
    if (await page.getByTestId('ds-session-item').count() !== 1) {
      throw new Error('Canceling AI filter BYOK hid the current session results.');
    }
    await page.getByRole('tab', { name: '全部', exact: true }).click();

    const firstSession = page.getByTestId('ds-session-item').filter({ hasText: '合成宫斗测试档' });
    await firstSession.getByTestId('ds-session-preview-trigger').click();
    const previewSheet = page.getByTestId('deepseek-preview-sheet');
    await previewSheet.waitFor({ state: 'visible' });
    const previewText = await page.getByTestId('deepseek-preview-card').textContent();
    if (!previewText?.includes('规则附件.docx') || !previewText.includes('另存为 .docx') || !previewText.includes('原进度抵达东侧练歌房')) {
      throw new Error(`DeepSeek preview omitted story, attachment, or legacy .doc guidance: ${previewText}`);
    }
    await previewSheet.getByText('手动调整原始剧本起点/终点').click();
    await page.fill('#ds-script-start', '2');
    await page.fill('#ds-script-end', '2');
    if (!(await previewSheet.getByTestId('ds-script-range-status').textContent())?.includes('已手动调整')) {
      throw new Error('Manual script-range edits were not reflected in the preview.');
    }
    await previewSheet.getByRole('button', { name: '关闭剧情面板' }).click();
    await page.getByTestId('ds-confirm-import-btn').click();
    await page.getByTestId('deepseek-import-receipt').waitFor();
    await assertImportWizardLayout(page, 'deepseek-import-panel', 3, { width: 1280, height: 800 });
    const receipt = await page.getByTestId('deepseek-import-receipt').textContent();
    if (!receipt?.includes('老版本.doc') || !receipt.includes('另存为 .docx')) {
      throw new Error(`DeepSeek receipt omitted the skipped attachment conversion advice: ${receipt}`);
    }
    await page.getByRole('button', { name: '继续这条故事' }).click();
    await page.getByTestId('main-stage').getByText('原进度抵达东侧练歌房').waitFor();

    await startScriptImport(page);
    await page.getByTestId('import-panel').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertImportThemeMatrix(page, 'import-panel', 1, { width: 390, height: 844 });
    await assertUploadControlHasVisibleKeyboardFocus(
      page,
      page.getByRole('button', { name: '返回' }),
      'import-script-picker',
      1,
      'Free-script upload card',
    );
    const scriptFileTypes = (await page.locator('#import-file').getAttribute('accept'))?.split(',') ?? [];
    const scriptPickerText = await page.getByTestId('import-script-picker').textContent();
    if (!scriptFileTypes.includes('.doc') ||
        !scriptPickerText?.includes('旧版 .doc') ||
        !scriptPickerText.includes('另存为 .docx')) {
      throw new Error('The free-script picker does not expose .doc conversion guidance before selection.');
    }
    await page.setInputFiles('#import-file', {
      name: 'legacy-story.doc',
      mimeType: 'application/msword',
      buffer: Buffer.from('synthetic legacy Word document'),
    });
    await page.getByTestId('import-error').getByText('另存为 .docx').waitFor();
    await page.fill('#import-raw-script', '【本地直接开局】\n主角：沈知夏。');
    await page.getByText('填写故事标题（可选）').click();
    await page.fill('#import-title', '无密钥开局测试');
    await page.getByRole('button', { name: '暂不拆解，直接开始' }).click();
    await page.getByTestId('import-panel').waitFor({ state: 'detached' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: '无密钥开局测试', exact: true }).waitFor();
    if (blueprintRequestCount !== 0) throw new Error('Direct start without extraction should not make a model request.');

    await startScriptImport(page);
    await page.fill('#import-raw-script', '【创建锁定直接开局】\n主角：沈知夏。');
    await holdNextStoryStorageCommit(page);
    await page.getByRole('button', { name: '暂不拆解，直接开始' }).click();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    const directStartBack = page.getByTestId('import-panel').getByRole('button', { name: '返回' });
    if (
      !(await directStartBack.isDisabled()) ||
      !(await page.getByTestId('import-panel').locator('.import-step-content').evaluate((element) => element.inert))
    ) {
      throw new Error('Direct story creation left wizard exit controls enabled.');
    }
    await directStartBack.evaluate((button) => button.click());
    if (
      !(await page.getByTestId('import-panel').isVisible()) ||
      await page.getByTestId('import-panel').getByRole('progressbar').getAttribute('aria-valuenow') !== '1'
    ) {
      throw new Error('Direct story creation left its current wizard step while the save was pending.');
    }
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('import-panel').waitFor({ state: 'detached' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: '创建锁定直接开局', exact: true }).waitFor();

    await startScriptImport(page);
    await page.getByTestId('import-panel').waitFor();
    await assertImportWizardLayout(page, 'import-panel', 1, { width: 390, height: 844 });
    await page.fill('#import-raw-script', '【合成导入剧本】\n主角：沈知夏。\n规则：每轮保留状态面板。');
    await page.getByRole('button', { name: '拆解故事蓝图' }).click();
    await page.getByTestId('deepseek-setup-wizard').waitFor();
    await completePendingSetup(page, 'sk-e2e-import-wizard');
    await page.getByTestId('import-panel').getByTestId('story-blueprint-card').waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    await assertImportThemeMatrix(page, 'import-panel', 2, { width: 1280, height: 800 });
    const blueprint = page.getByTestId('import-panel').getByTestId('story-blueprint-card');
    if (!(await blueprint.textContent())?.includes('导入向导合成故事')) {
      throw new Error('The extracted story blueprint was not shown as a read-only card.');
    }
    await page.getByTestId('import-panel').getByRole('button', { name: '微调' }).click();
    await page.fill('#bp-title', '已微调的合成故事');
    await page.fill('#bp-protagonist', '沈知夏（已微调）');
    await page.fill('#bp-npcs-name-0', '顾老师（已微调）');
    await page.getByRole('button', { name: '保存蓝图微调' }).click();
    if (!(await blueprint.textContent())?.includes('沈知夏（已微调）')) {
      throw new Error('Structured blueprint edits were not reflected in the read-only card.');
    }
    if (blueprintRequestCount !== 1) throw new Error('BYOK resume did not issue exactly one mocked blueprint request.');
    await holdNextStoryStorageCommit(page);
    await page.getByRole('button', { name: '确认并开启第一幕' }).click();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    const confirmBack = page.getByTestId('import-panel').getByRole('button', { name: '返回' });
    if (
      !(await confirmBack.isDisabled()) ||
      !(await page.getByTestId('import-panel').locator('.import-step-content').evaluate((element) => element.inert))
    ) {
      throw new Error('Blueprint confirmation left the wizard Back action enabled.');
    }
    await confirmBack.evaluate((button) => button.click());
    if (
      !(await page.getByTestId('import-panel').isVisible()) ||
      await page.getByTestId('import-panel').getByRole('progressbar').getAttribute('aria-valuenow') !== '2'
    ) {
      throw new Error('Blueprint confirmation left its current wizard step while the save was pending.');
    }
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('import-panel').waitFor({ state: 'detached' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: '已微调的合成故事', exact: true }).waitFor();

    await startDeepSeekImport(page);
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'ai-filter-source.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildSyntheticDeepSeekZipE2E()),
    });
    await page.getByTestId('ds-session-list').waitFor();
    await page.getByRole('tab', { name: '疑似文游' }).click();
    failNextAiRequest = true;
    await page.getByRole('tab', { name: 'AI 辅助筛选' }).click();
    const aiFilterError = page.getByTestId('import-error');
    await aiFilterError.getByRole('button', { name: '重试 AI 筛选' }).waitFor();
    if (await aiFilterError.getByRole('button', { name: '重试导入' }).count() !== 0) {
      throw new Error('AI filter failure offered final import retry.');
    }
    if (await page.getByRole('tab', { name: '疑似文游' }).getAttribute('aria-selected') !== 'true' ||
        await page.getByTestId('ds-session-item').count() !== 1) {
      throw new Error('A failed AI filter changed the current session category or results.');
    }
    await page.getByRole('tab', { name: '全部', exact: true }).click();

    let startHeldAllRequest;
    let releaseHeldAllRequest;
    let heldAllRequestFinished;
    let finishHeldAllRequest;
    const heldAllRequestStarted = new Promise((resolve) => { startHeldAllRequest = resolve; });
    const heldAllRequestWait = new Promise((resolve) => { releaseHeldAllRequest = resolve; });
    const heldAllRequestDone = new Promise((resolve) => { finishHeldAllRequest = resolve; });
    nextAiRequestGate = {
      onStarted: startHeldAllRequest,
      waitForRelease: heldAllRequestWait,
      onFinished: finishHeldAllRequest,
    };
    await prepareAiFilterAbortProbe(page);
    await page.getByRole('tab', { name: 'AI 辅助筛选' }).click();
    await heldAllRequestStarted;
    if (
      await page.getByRole('tab', { name: 'AI 筛选中…' }).getAttribute('aria-selected') !== 'true' ||
      await page.getByRole('tab', { name: 'AI 筛选中…' }).getAttribute('tabindex') !== '0'
    ) {
      throw new Error('AI filtering did not synchronize its selected tab and roving tabIndex.');
    }
    await page.getByRole('tab', { name: '全部', exact: true }).click();
    await page.waitForFunction(() => window.__lfhAiFilterAbortCount === 1);
    releaseHeldAllRequest();
    await heldAllRequestDone;
    await page.waitForFunction(() =>
      document.querySelector('.ds-filter-tabs [aria-selected="true"]')?.textContent?.trim() === '全部' &&
      document.querySelectorAll('[data-testid="ds-session-item"]').length === 2,
    );

    let startHeldLikelyRequest;
    let releaseHeldLikelyRequest;
    let heldLikelyRequestFinished;
    let finishHeldLikelyRequest;
    const heldLikelyRequestStarted = new Promise((resolve) => { startHeldLikelyRequest = resolve; });
    const heldLikelyRequestWait = new Promise((resolve) => { releaseHeldLikelyRequest = resolve; });
    const heldLikelyRequestDone = new Promise((resolve) => { finishHeldLikelyRequest = resolve; });
    nextAiRequestGate = {
      onStarted: startHeldLikelyRequest,
      waitForRelease: heldLikelyRequestWait,
      onFinished: finishHeldLikelyRequest,
    };
    await page.getByRole('tab', { name: 'AI 辅助筛选' }).click();
    await heldLikelyRequestStarted;
    if (
      await page.getByRole('tab', { name: 'AI 筛选中…' }).getAttribute('aria-selected') !== 'true' ||
      await page.getByRole('tab', { name: 'AI 筛选中…' }).getAttribute('tabindex') !== '0'
    ) {
      throw new Error('A second AI filtering request did not synchronize its tab state.');
    }
    await page.getByRole('tab', { name: '疑似文游' }).click();
    await page.waitForFunction(() => window.__lfhAiFilterAbortCount === 2);
    releaseHeldLikelyRequest();
    await heldLikelyRequestDone;
    await page.waitForFunction(() =>
      document.querySelector('.ds-filter-tabs [aria-selected="true"]')?.textContent?.trim() === '疑似文游' &&
      document.querySelectorAll('[data-testid="ds-session-item"]').length === 1,
    );

    let startHeldAiRequest;
    let releaseHeldAiRequest;
    let heldAiRequestFinished;
    let finishHeldAiRequest;
    const heldAiRequestStarted = new Promise((resolve) => { startHeldAiRequest = resolve; });
    const heldAiRequestWait = new Promise((resolve) => { releaseHeldAiRequest = resolve; });
    const heldAiRequestDone = new Promise((resolve) => { finishHeldAiRequest = resolve; });
    nextAiRequestGate = {
      onStarted: startHeldAiRequest,
      waitForRelease: heldAiRequestWait,
      onFinished: finishHeldAiRequest,
    };
    await prepareAiFilterAbortProbe(page);
    await page.getByRole('tab', { name: 'AI 辅助筛选' }).click();
    await heldAiRequestStarted;
    await page.getByRole('button', { name: '返回' }).click();
    await page.waitForFunction(() => window.__lfhAiFilterAbortCount === 1);
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="deepseek-import-panel"] [role="progressbar"]')?.getAttribute('aria-valuenow') === '1',
    );
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'ai-filter-replacement.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildAmbiguousOverWindowZipE2E()),
    });
    await page.getByTestId('ds-session-list').getByText('模糊开局超窗长档').waitFor();
    releaseHeldAiRequest();
    await heldAiRequestDone;
    await page.waitForFunction(() =>
      document.querySelector('.ds-filter-tabs [aria-selected="true"]')?.textContent?.trim() === '全部' &&
      document.querySelector('[data-testid="ds-session-item"]')?.textContent?.includes('模糊开局超窗长档'),
    );
    const aiFilterTab = page.getByRole('tab', { name: 'AI 辅助筛选' });
    await allFilterTab.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() =>
      document.querySelector('.ds-filter-tabs [aria-selected="true"]')?.textContent?.trim() === 'AI 辅助筛选',
    );
    if (
      await aiFilterTab.getAttribute('tabindex') !== '0' ||
      await allFilterTab.getAttribute('tabindex') !== '-1' ||
      await page.evaluate(() => document.activeElement?.id) !== await aiFilterTab.getAttribute('id')
    ) {
      throw new Error(`Session filter tabs did not select the last tab with End: ${JSON.stringify({
        aiTabIndex: await aiFilterTab.getAttribute('tabindex'),
        allTabIndex: await allFilterTab.getAttribute('tabindex'),
        activeId: await page.evaluate(() => document.activeElement?.id),
        aiId: await aiFilterTab.getAttribute('id'),
      })}`);
    }
    await page.keyboard.press('Home');
    if (
      await allFilterTab.getAttribute('aria-selected') !== 'true' ||
      await allFilterTab.getAttribute('tabindex') !== '0' ||
      await aiFilterTab.getAttribute('tabindex') !== '-1' ||
      await page.evaluate(() => document.activeElement?.id) !== await allFilterTab.getAttribute('id')
    ) {
      throw new Error('Session filter tabs did not select the first tab with Home.');
    }
    await page.keyboard.press('End');
    if (
      await aiFilterTab.getAttribute('aria-selected') !== 'true' ||
      await aiFilterTab.getAttribute('tabindex') !== '0' ||
      await allFilterTab.getAttribute('tabindex') !== '-1'
    ) {
      throw new Error('Session filter tabs did not return to the cached AI result with End.');
    }

    await page.getByRole('button', { name: '返回' }).click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="deepseek-import-panel"] [role="progressbar"]')?.getAttribute('aria-valuenow') === '1',
    );
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'pending-model-import.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildSyntheticDeepSeekZipE2E()),
    });
    await page.getByTestId('ds-session-list').waitFor();
    let startHeldBlueprintRequest;
    let releaseHeldBlueprintRequest;
    let finishHeldBlueprintRequest;
    const heldBlueprintRequestStarted = new Promise((resolve) => { startHeldBlueprintRequest = resolve; });
    const heldBlueprintRequestWait = new Promise((resolve) => { releaseHeldBlueprintRequest = resolve; });
    const heldBlueprintRequestDone = new Promise((resolve) => { finishHeldBlueprintRequest = resolve; });
    nextBlueprintRequestGate = {
      onStarted: startHeldBlueprintRequest,
      waitForRelease: heldBlueprintRequestWait,
      onFinished: finishHeldBlueprintRequest,
    };
    await page.getByTestId('ds-confirm-import-btn').click();
    await heldBlueprintRequestStarted;
    const importBackButton = page.getByRole('button', { name: '返回' });
    if (!(await importBackButton.isDisabled())) {
      throw new Error('Back remained enabled while the DeepSeek import was committing.');
    }
    await page.getByTestId('deepseek-import-busy').waitFor();
    await importBackButton.evaluate((button) => button.click());
    if (await page.getByTestId('deepseek-import-panel').getByRole('progressbar').getAttribute('aria-valuenow') !== '2') {
      throw new Error('The import wizard left its committing step while import was pending.');
    }
    releaseHeldBlueprintRequest();
    await heldBlueprintRequestDone;
    await page.getByTestId('deepseek-import-receipt').waitFor();
    await page.getByRole('button', { name: '继续这条故事' }).click();
    await page.getByTestId('main-stage').getByText('原进度抵达东侧练歌房').waitFor();

    const fixturePath = process.env.LFH_SYNTHETIC_UI_STORY_ZIP;
    if (fixturePath && fs.existsSync(fixturePath)) {
      await startDeepSeekImport(page);
      await page.setInputFiles('#deepseek-zip-input', fixturePath);
      await page.getByTestId('ds-session-list').waitFor();
      const count = await page.getByTestId('ds-session-item').count();
      if (count === 0) throw new Error('The supplied synthetic long-story archive had no sessions.');
      await page.getByTestId('ds-session-item').first().getByTestId('ds-session-preview-trigger').click();
      await page.getByTestId('deepseek-preview-card').waitFor();
      await page.getByTestId('deepseek-preview-sheet').getByRole('button', { name: '关闭剧情面板' }).click();
      await page.getByTestId('ds-confirm-import-btn').click();
      await page.getByTestId('deepseek-import-receipt').waitFor();
      console.log(`SYNTHETIC_LONG_IMPORT_PASSED sessions=${count}`);
    }
  } finally {
    await context.close();
  }
}

async function openSettings(page) {
  if (await page.getByTestId('settings-page').isVisible().catch(() => false)) return;
  const desktopEntry = page.getByTestId('desktop-settings-open');
  if (await desktopEntry.isVisible().catch(() => false)) {
    await expectTouchTarget(desktopEntry, 'desktop settings entry');
    await desktopEntry.click();
  } else {
    await page.getByTestId('library-drawer-trigger').click();
    const drawer = page.getByTestId('mobile-library-dialog');
    await drawer.waitFor({ state: 'visible' });
    const entry = page.getByTestId('mobile-settings-open');
    await expectTouchTarget(entry, 'mobile settings entry');
    await entry.click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="mobile-library-dialog"]');
      return dialog?.dataset.closing === 'true' || !dialog?.open;
    });
    if (await drawer.evaluate((dialog) => dialog.open)) {
      if (!(await drawer.getAttribute('data-closing'))) {
        throw new Error('Mobile drawer remained open without an exit state.');
      }
      await drawer.waitFor({ state: 'hidden' });
    }
  }
  await page.getByTestId('settings-page').waitFor({ state: 'visible' });
}

async function closeSettings(page) {
  const settings = page.getByTestId('settings-page');
  if (await settings.isVisible().catch(() => false)) {
    await settings.getByRole('button', { name: '返回' }).click();
    await settings.waitFor({ state: 'detached' });
  }
}

async function visibleStoryRows(page) {
  let rows = page.locator('[data-testid="story-list-item"]:visible');
  if ((await rows.count()) === 0 && await page.getByTestId('library-drawer-trigger').isVisible().catch(() => false)) {
    await page.getByTestId('library-drawer-trigger').click();
    rows = page.locator('[data-testid="story-list-item"]:visible');
  }
  return rows;
}

async function deleteAllStories(page) {
  let rows = await visibleStoryRows(page);
  while ((await rows.count()) > 0) {
    const previousCount = await rows.count();
    const row = rows.first();
    await row.getByTestId('story-menu-trigger').click();
    await row.getByRole('menuitem', { name: '删除故事' }).click();
    await page.waitForFunction((count) =>
      [...document.querySelectorAll('[data-testid="story-list-item"]')]
        .filter((item) => item.getClientRects().length > 0).length < count,
    previousCount);
    rows = page.locator('[data-testid="story-list-item"]:visible');
  }
}

async function selectStoryByTitle(page, title) {
  const rows = await visibleStoryRows(page);
  const row = rows.filter({ hasText: title }).first();
  await row.getByTestId('story-select-button').click();
}

const verifiedMobileSheetInteractions = new WeakSet();

async function openCompanionSheet(page) {
  const sheet = page.getByTestId('story-tree-sheet');
  if (!(await sheet.isVisible().catch(() => false))) {
    await page.getByTestId('open-story-tree').click();
    await sheet.waitFor({ state: 'visible' });
    const bounds = await sheet.evaluate((dialog) => dialog.getBoundingClientRect().toJSON());
    if ((await page.evaluate(() => window.innerWidth)) < 768) {
      const expectedHeight = await page.evaluate(() => window.innerHeight * 0.74);
      if (Math.abs(bounds.height - expectedHeight) > 8) {
        throw new Error(`Mobile companion sheet should open at 74dvh: ${bounds.height}px vs ${expectedHeight}px.`);
      }
    } else {
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      const expectedWidth = Math.min(440, viewportWidth);
      if (Math.abs(bounds.width - expectedWidth) > 1 || Math.abs(bounds.right - viewportWidth) > 1) {
        throw new Error(`Desktop companion sheet should occupy a 440px right rail: ${JSON.stringify(bounds)}.`);
      }
    }
  }
  const tablist = sheet.getByRole('tablist', { name: '故事信息' });
  const companionTabs = await Promise.all(
    ['剧情树', '剧情回顾', '故事蓝图'].map((name) =>
      sheet.getByRole('tab', { name }).count(),
    ),
  );
  if ((await tablist.count()) !== 1 || companionTabs.some((count) => count !== 1)) {
    throw new Error('The companion sheet must expose its story tree, review, and blueprint tabs');
  }
  return sheet;
}

async function openCompanionTab(page, name) {
  const sheet = await openCompanionSheet(page);
  const tab = sheet.getByRole('tab', { name });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  return sheet;
}

async function openStoryTree(page) {
  let sheet = await openCompanionTab(page, '剧情树');
  if ((await page.evaluate(() => window.innerWidth)) < 768) {
    const dragHandle = sheet.getByTestId('sheet-drag-handle');
    await expectTouchTarget(dragHandle, 'mobile sheet drag handle');
    await expectTouchTarget(sheet.getByRole('button', { name: '关闭剧情面板' }), 'mobile sheet close');
    if (!(await sheet.evaluate((dialog) => dialog.classList.contains('is-expanded')))) {
      await dragHandle.click();
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="story-tree-sheet"]')?.classList.contains('is-expanded'));
    await page.waitForTimeout(200);
    const height = await sheet.evaluate((dialog) => dialog.getBoundingClientRect().height);
    if (height < await page.evaluate(() => window.innerHeight * 0.9)) {
      throw new Error(`Expanded mobile story sheet is shorter than 90vh: ${height}px.`);
    }
    if (!verifiedMobileSheetInteractions.has(page)) {
      const waitUntilSheetCollapsed = () => page.waitForFunction(() => {
        const dialog = document.querySelector('[data-testid="story-tree-sheet"]');
        return Boolean(
          dialog &&
          !dialog.classList.contains('is-expanded') &&
          dialog.getBoundingClientRect().height < window.innerHeight * 0.8,
        );
      });
      await dragHandle.focus();
      await page.keyboard.press('ArrowDown');
      await waitUntilSheetCollapsed();
      await page.keyboard.press('ArrowUp');
      await page.waitForFunction(() => document.querySelector('[data-testid="story-tree-sheet"]')?.classList.contains('is-expanded'));
      await page.keyboard.press('ArrowDown');
      await waitUntilSheetCollapsed();
      const fallbackStartHeight = await sheet.evaluate((dialog) => dialog.getBoundingClientRect().height);
      await dragHandle.dispatchEvent('pointerdown', {
        bubbles: true,
        pointerId: 91,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        clientY: 500,
      });
      await dragHandle.dispatchEvent('pointermove', {
        bubbles: true,
        pointerId: 91,
        pointerType: 'mouse',
        isPrimary: true,
        clientY: 440,
      });
      const fallbackDrag = await sheet.evaluate((dialog) => ({
        dragging: dialog.dataset.dragging,
        growth: Number.parseFloat(dialog.style.getPropertyValue('--sheet-grow-by')),
      }));
      if (fallbackDrag.dragging !== 'true' || fallbackDrag.growth < 40) {
        throw new Error(`Pointer event fallback did not track the drag: ${JSON.stringify({ fallbackStartHeight, ...fallbackDrag })}.`);
      }
      await dragHandle.dispatchEvent('pointercancel', {
        bubbles: true,
        pointerId: 91,
        pointerType: 'mouse',
        isPrimary: true,
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="story-tree-sheet"]')?.dataset.dragging);
      await waitUntilSheetCollapsed();
      if (await sheet.evaluate((dialog) => dialog.classList.contains('is-expanded'))) {
        throw new Error('Cancelling a sheet drag should restore the collapsed height.');
      }

      const handleBounds = await dragHandle.boundingBox();
      if (!handleBounds) throw new Error('The sheet drag handle has no visible bounds.');
      const startX = handleBounds.x + handleBounds.width / 2;
      const startY = handleBounds.y + handleBounds.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY - 60, { steps: 4 });
      const liveDrag = await sheet.evaluate((dialog) => ({
        dragging: dialog.dataset.dragging,
        growth: Number.parseFloat(dialog.style.getPropertyValue('--sheet-grow-by')),
      }));
      if (liveDrag.dragging !== 'true' || liveDrag.growth < 45) {
        throw new Error(`Dragging should update the sheet height before release: ${JSON.stringify(liveDrag)}.`);
      }
      await page.mouse.up();
      await page.waitForFunction(() => {
        const dialog = document.querySelector('[data-testid="story-tree-sheet"]');
        return Boolean(
          dialog?.classList.contains('is-expanded') &&
          Math.abs(dialog.getBoundingClientRect().height - window.innerHeight * 0.92) < 12,
        );
      });

      const expandedBounds = await dragHandle.boundingBox();
      if (!expandedBounds) throw new Error('The expanded sheet drag handle has no visible bounds.');
      const closeX = expandedBounds.x + expandedBounds.width / 2;
      const closeY = expandedBounds.y + expandedBounds.height / 2;
      await page.mouse.move(closeX, closeY);
      await page.mouse.down();
      await page.mouse.move(closeX, closeY + 90, { steps: 4 });
      await page.mouse.up();
      await sheet.waitFor({ state: 'hidden' });

      sheet = await openCompanionTab(page, '剧情树');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.mouse.click(10, 10);
      await sheet.waitFor({ state: 'hidden' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      sheet = await openCompanionTab(page, '剧情树');
      verifiedMobileSheetInteractions.add(page);
    }
  }
  return sheet;
}

async function openStoryReview(page) {
  return openCompanionTab(page, '剧情回顾');
}

async function openStoryBlueprint(page) {
  return openCompanionTab(page, '故事蓝图');
}

async function assertNoSummaryProgress(page, sheet, label) {
  const statuses = [
    page.locator('[data-testid="app-topbar"] .summary-progress'),
    sheet.getByTestId('companion-summary-progress'),
  ];
  if (await Promise.all(statuses.map((status) => status.isVisible())).then((visible) => visible.some(Boolean))) {
    throw new Error(`${label} was incorrectly announced as summary progress.`);
  }
}

async function readActivePlotSummary(page) {
  const sheet = await openStoryReview(page);
  const text = await sheet.getByTestId('active-plot-summary').textContent();
  await closeCompanionSheet(page);
  return text;
}

async function waitForActivePlotSummary(page, text) {
  const sheet = await openStoryReview(page);
  await sheet.getByTestId('active-plot-summary').getByText(text, { exact: false }).waitFor();
  const summary = await sheet.getByTestId('active-plot-summary').textContent();
  await closeCompanionSheet(page);
  return summary;
}

async function closeCompanionSheet(page) {
  const sheet = page.getByTestId('story-tree-sheet');
  if (await sheet.isVisible().catch(() => false)) {
    await sheet.getByRole('button', { name: '关闭剧情面板' }).click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="story-tree-sheet"]');
      return dialog?.dataset.closing === 'true' || !dialog?.open;
    });
    await sheet.waitFor({ state: 'hidden' });
  }
}

async function closeStoryTree(page) {
  await closeCompanionSheet(page);
}

async function verifyModalDialogLifecycle(context, port) {
  const page = await context.newPage();
  await page.goto(`http://localhost:${port}/tests/e2e/modal-dialog-fixture.html`);
  const dialog = page.getByRole('dialog', { name: 'Fixture dialog' });
  await dialog.waitFor({ state: 'visible' });
  const bounds = await dialog.boundingBox();
  if (!bounds) throw new Error('Modal dialog has no visible bounds.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 12, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  if ((await page.getByTestId('close-count').textContent()) !== '0' || !(await dialog.evaluate((element) => element.open))) {
    throw new Error('Dragging from inside the dialog onto the backdrop should not close it.');
  }
  await page.mouse.click(4, 4);
  await page.waitForFunction(() => document.querySelector('dialog')?.dataset.closing === 'true');
  if ((await page.getByTestId('close-count').textContent()) !== '1') {
    throw new Error('A pointer press and release on the backdrop should close the dialog once.');
  }
  await page.waitForFunction(() => !document.querySelector('dialog')?.open);

  await page.goto(`http://localhost:${port}/tests/e2e/modal-dialog-fixture.html`);
  await page.getByRole('dialog', { name: 'Fixture dialog' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Request close' }).click();
  await page.waitForFunction(() => document.querySelector('dialog')?.dataset.closing === 'true');
  if (!(await dialog.evaluate((element) => element.open))) {
    throw new Error('Modal dialog left the Top Layer before the exit animation finished.');
  }
  if ((await page.getByTestId('close-count').textContent()) !== '1') {
    throw new Error('Controlled modal close notified its owner more than once.');
  }
  await page.waitForFunction(() => !document.querySelector('dialog')?.open);
  await page.waitForTimeout(220);
  if ((await page.getByTestId('close-count').textContent()) !== '1') {
    throw new Error('Programmatic close event notified its owner a second time.');
  }

  await page.goto(`http://localhost:${port}/tests/e2e/modal-dialog-fixture.html`);
  await page.getByRole('dialog', { name: 'Fixture dialog' }).waitFor({ state: 'visible' });
  await page.evaluate(() => document.querySelector('dialog')?.close());
  await page.waitForFunction(() => document.querySelector('[data-testid="close-count"]')?.textContent === '1');
  await page.waitForTimeout(220);
  if ((await page.getByTestId('close-count').textContent()) !== '1') {
    throw new Error('Native close path notified its owner more than once.');
  }
  await page.close();
}

async function verifyBranchSwitchBlocksImmediateSend(page) {
  const branchUser = page.getByTestId('turn-user').nth(1);
  const initialPager = await branchUser.getByTestId('branch-pager').textContent();
  if (!initialPager?.includes('2 / 2')) {
    throw new Error(`Expected Branch B active before switch-lock check, got: ${initialPager}`);
  }

  const stage = page.getByTestId('main-stage');
  const scrollTopBeforeSwitch = await stage.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    element.scrollTop = Math.min(200, element.scrollHeight - element.clientHeight - 100);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return element.scrollTop;
  });
  await page.getByTestId('scroll-to-bottom').waitFor({ state: 'visible' });

  const prompt = '分支切换期间不应发送';
  await page.fill('#turn-input', prompt);
  const racedRequests = [];
  const recordRequest = (request) => {
    if (request.url().includes('/chat/completions') && request.postData()?.includes(prompt)) {
      racedRequests.push(request.url());
    }
  };
  page.on('request', recordRequest);
  await page.evaluate(() => {
    const pager = document.querySelectorAll('[data-testid="turn-user"]')[1]
      ?.querySelector('[data-testid="branch-pager"]');
    pager?.querySelector('button[aria-label="上一分支"]')?.click();
    document.querySelector('[data-testid="stage-composer"]')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(300);
  page.off('request', recordRequest);

  if (racedRequests.length || (await page.inputValue('#turn-input')) !== prompt) {
    throw new Error('A send during branch switching started or cleared the composer draft.');
  }
  const switchedUser = page.getByTestId('turn-user').nth(1);
  const switchedLabel = await switchedUser.getByTestId('turn-history-toggle').textContent();
  if (!switchedLabel?.includes('分支 1/2')) {
    throw new Error(`Branch switch did not settle on the requested sibling: ${switchedLabel}`);
  }
  const scrollTopAfterSwitch = await stage.evaluate((element) => element.scrollTop);
  if (Math.abs(scrollTopAfterSwitch - scrollTopBeforeSwitch) > 1) {
    throw new Error(`Same-story branch switching changed the paused scroll position: ${scrollTopBeforeSwitch}px -> ${scrollTopAfterSwitch}px.`);
  }

  await switchedUser.getByTestId('turn-history-toggle').click();
  await switchedUser.getByRole('button', { name: '下一分支' }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="turn-user"]')[1]
      ?.querySelector('[data-testid="branch-pager"]')?.textContent?.includes('2 / 2'),
  );
  await page.fill('#turn-input', '');
}

async function verifyStoppedSendPreservesNewerDraft(page, delayNextTurn) {
  const submittedPrompt = '停止时不覆盖后续草稿';
  const newerDraft = '停止生成后仍要保留的草稿';
  delayNextTurn();
  await page.fill('#turn-input', submittedPrompt);
  await page.getByRole('button', { name: '发送行动' }).click();
  await page.getByRole('button', { name: '停止生成' }).waitFor();
  await page.fill('#turn-input', newerDraft);
  await page.getByRole('button', { name: '停止生成' }).click();
  await page.getByTestId('main-error-banner').waitFor();
  if ((await page.inputValue('#turn-input')) !== newerDraft) {
    throw new Error('Stopping a turn replaced a newer composer draft with the submitted action.');
  }
  await page.fill('#turn-input', '');
}

async function verifyScrollDetachAndResumeThreshold(page, delayNextTurn) {
  const stage = page.getByTestId('main-stage');
  await stage.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await stage.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    element.scrollTop = element.scrollHeight - element.clientHeight - 100;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.getByTestId('scroll-to-bottom').waitFor({ state: 'visible' });
  await stage.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
    element.scrollTop = element.scrollHeight - element.clientHeight - 40;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  if (!(await page.getByTestId('scroll-to-bottom').isVisible().catch(() => false))) {
    throw new Error('Manual scrolling back to 40px from the bottom should remain paused until 24px or closer.');
  }

  delayNextTurn();
  await page.fill('#turn-input', '验证滚动暂停阈值');
  await page.locator('#turn-input').press('Enter');
  await page.getByRole('button', { name: '停止生成' }).waitFor();
  const gapWhileStreaming = await stage.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  if (gapWhileStreaming <= 24) {
    throw new Error(`Streaming output resumed follow above the 24px threshold: ${gapWhileStreaming}px.`);
  }
  await page.getByRole('button', { name: '停止生成' }).click();
  await page.getByTestId('main-error-banner').waitFor();
  await page.fill('#turn-input', '');

  await stage.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
    element.scrollTop = element.scrollHeight - element.clientHeight - 20;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.getByTestId('scroll-to-bottom').waitFor({ state: 'hidden' });
}

async function main() {
  const port = 4185;
  const srv = await startViteServer(port);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfh-e2e-suite-'));
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });

  try {
    const context = await newOfflineContext(browser, port, { acceptDownloads: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: `http://localhost:${port}`,
    });
    await verifyModalDialogLifecycle(context, port);
    const page = await context.newPage();
    const replyCounts = new Map();
    let failNextBlueprintWith401 = false;
    let delayNextTurnMs = 0;
    let delayNextSummaryMs = 0;
    let delayNextBlueprintMs = 0;
    let delayNextGistMs = 0;
    let boundaryCallCount = 0;
    let lastTurnSystemText = '';

    await page.route('https://api.deepseek.com/models', async (route) => {
      const auth = route.request().headers().authorization || '';
      if (auth === 'Bearer sk-e2e-401') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Invalid API key' } }),
        });
        return;
      }
      if (auth === 'Bearer sk-e2e-netfail') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Service Unavailable' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 'deepseek-flash' }] }),
      });
    });

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';

      if (
        !sys.includes('严格只输出一个 JSON 对象') &&
        !sys.includes('剧情摘要压缩') &&
        !sys.includes('剧本边界定位') &&
        !sys.includes('分支梗概助手')
      ) {
        lastTurnSystemText = (reqBody.messages || [])
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n');
      }

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
        if (delayNextBlueprintMs > 0) {
          const waitMs = delayNextBlueprintMs;
          delayNextBlueprintMs = 0;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
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

      if (sys.includes('剧本边界定位')) {
        boundaryCallCount += 1;
        const items = JSON.parse(lastMsg || '[]');
        const scriptNode = items.find((i) => String(i.snippet || '').includes('E2E模糊剧本'));
        const playNode = items.find((i) => String(i.snippet || '').includes('第一幕开始'));
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      scriptMessageIds: scriptNode ? [scriptNode.nodeId] : [],
                      firstPlayMessageId: playNode?.nodeId ?? null,
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
        if (delayNextGistMs > 0) {
          const waitMs = delayNextGistMs;
          delayNextGistMs = 0;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: 'AI提炼：改道休息线稳妥推进。' }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      if (sys.includes('剧情摘要压缩')) {
        if (delayNextSummaryMs > 0) {
          const waitMs = delayNextSummaryMs;
          delayNextSummaryMs = 0;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        const sumText = lastMsg.includes('黑市线索')
          ? '【分支A摘要】含黑市线索'
          : lastMsg.includes('E2E模糊剧本') || lastMsg.includes('请贴出设定') || lastMsg.includes('码头')
            ? '【激活线压缩摘要】主角登上货船甲板。'
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
        `[状态 | 人气: 60 | 节点: ${lastMsg.slice(0, 6)} | 长线索: 东侧走廊尽头的控制室仍亮着灯，巡夜人留下的值班记录尚未归档，门外还有未解锁的线索]`,
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

    await page.route('https://cdn.deepseek.example/**', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.endsWith('/export-html.zip')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!DOCTYPE html><html><body>请登录 DeepSeek</body></html>',
        });
        return;
      }
      if (reqUrl.endsWith('/export-cors.zip')) {
        await route.abort('failed');
        return;
      }
      if (reqUrl.endsWith('/export-valid.zip')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/zip',
          body: Buffer.from(buildSyntheticDeepSeekZipE2E()),
        });
        return;
      }
      await route.fulfill({ status: 404, body: 'Not Found' });
    });

    if (process.env.LFH_IMPORT_WIZARD_ONLY === '1') {
      await runImportWizardE2E(browser, port, tmpDir);
      console.log('IMPORT_WIZARD_E2E_PASSED');
      return;
    }

    await runImportWizardE2E(browser, port, tmpDir);
    console.log('IMPORT_WIZARD_E2E_PASSED');

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await verifySliceOneViewportMatrix(page);

    // 0-url. DeepSeek HTTPS export link fetch (HTML login fallback, CORS fallback, and valid ZIP fetch)
    await startDeepSeekImport(page);
    await page.getByTestId('deepseek-source-url').click();
    await page.waitForSelector('#deepseek-zip-url-input');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-html.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    await page.waitForSelector('[data-testid="import-error"]:has-text("HTML")');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-cors.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    await page.waitForSelector('[data-testid="import-error"]:has-text("CORS")');

    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/export-valid.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    await page.getByTestId('ds-session-list').waitFor();
    const { sheet: urlPreviewSheet } = await openSessionPreview(page, '合成宫斗测试档');
    const urlPreviewText = await urlPreviewSheet.textContent();
    if (!urlPreviewText?.includes('合成宫斗测试档')) {
      throw new Error(`Expected fetched ZIP preview, got: ${urlPreviewText}`);
    }
    await closeSessionPreview(urlPreviewSheet);
    // Complete story import directly from URL-fetched session list, verify active progress, then clean up
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("原进度抵达东侧练歌房")');
    await deleteAllStories(page);

    // 0. Keyless DeepSeek .zip import -> preview -> batch 1-to-1 import -> Continue This Story -> inline BYOK prompt -> stream
    const dsZipPath = path.join(tmpDir, 'deepseek-export.zip');
    fs.writeFileSync(dsZipPath, buildSyntheticDeepSeekZipE2E());
    await startDeepSeekImport(page);
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', dsZipPath);
    await page.getByTestId('ds-session-list').waitFor();
    const { sheet: dsPreviewSheet, card: dsPreviewCard } = await openSessionPreview(page, '合成宫斗测试档');
    const previewCardText = await dsPreviewCard.textContent();
    if (
      !previewCardText?.includes('规则附件.docx') ||
      !previewCardText?.includes('另存为 .docx') ||
      !previewCardText?.includes('⑂ 2')
    ) {
      throw new Error(`DeepSeek preview missing attachment/branch cues: ${previewCardText}`);
    }
    await closeSessionPreview(dsPreviewSheet);

    // Check 390px narrow mobile viewport on DeepSeek preview panel
    await page.setViewportSize({ width: 390, height: 844 });
    const dsOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (dsOverflow.scrollWidth > dsOverflow.clientWidth) {
      throw new Error(`Horizontal overflow on mobile DeepSeek import (${dsOverflow.scrollWidth} > ${dsOverflow.clientWidth})`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });

    // Also select the second (null-title) session to verify 1-to-1 batch import without API Key
    await page.getByTestId('ds-session-item').filter({ hasText: 'Promise.all' }).locator('input[type="checkbox"]').check();
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    const receiptText = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!receiptText?.includes('新增 2 部独立故事')) {
      throw new Error(`Expected 2 imported stories in receipt, got: ${receiptText}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("原进度抵达东侧练歌房")');
    const setupTurn = page.getByTestId('turn-user').first();
    const setupNode = setupTurn.getByTestId('setup-node');
    const setupLabel = await setupNode.locator('summary').textContent();
    if (!setupLabel?.includes('设定')) {
      throw new Error(`Collapsed setup node should identify itself directly: ${setupLabel}`);
    }
    await setupNode.waitFor();
    await setupNode.locator('summary').click();
    if (!(await setupNode.textContent())?.includes('请按附件规则开始演绎第一幕')) {
      throw new Error('Setup node did not preserve its original submitted text.');
    }
    const diagText = await page.locator('[data-testid="turn-diagnostics"]').textContent();
    if (!diagText?.includes('CONTENT_FILTER') || !diagText?.includes('CONTENT_RISK')) {
      throw new Error(`Expected read-only NodeDiagnostics badge, got: ${diagText}`);
    }

    // Verify IndexedDB reload keeps DeepSeek stories + diagnostics
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("原进度抵达东侧练歌房")');
    if ((await (await visibleStoryRows(page)).count()) !== 2) {
      throw new Error('Expected 2 independent DeepSeek stories persisted in IndexedDB');
    }

    // Trigger next turn without API key -> guided setup wizard opens -> test 401 block & valid save & auto-continue
    await page.fill('#turn-input', '推开练歌房钢琴盖');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.waitForSelector('[data-testid="deepseek-setup-wizard"]');
    const wizardText = await page.locator('[data-testid="deepseek-setup-wizard"]').textContent();
    if (!wizardText?.includes('新注册用户通常有免费额度')) {
      throw new Error(`Expected free-quota hint in wizard, got: ${wizardText}`);
    }
    // 401 invalid key must block saving and not show fallback save button
    await page.fill('#byok-api-key', 'sk-e2e-401');
    await page.click('[data-testid="wizard-verify-save-btn"]');
    await page.waitForSelector('[data-testid="wizard-error"]');
    if ((await page.locator('[data-testid="wizard-fallback-save-btn"]').count()) !== 0) {
      throw new Error('Expected 401 invalid_key not to allow fallback save');
    }
    // Valid key verifies and resumes streaming automatically
    await page.fill('#byok-api-key', 'sk-e2e-inline');
    await page.click('[data-testid="wizard-verify-save-btn"]');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：推开练歌房钢琴盖")');
    await openSettings(page);
    const maskText = await page.locator('[data-testid="connected-key-mask"]').textContent();
    if (!maskText?.includes('••••line')) {
      throw new Error(`Expected masked key tail in connected card, got: ${maskText}`);
    }
    await closeSettings(page);

    // 0a. Keyless ambiguous + over-window import -> pending_key -> complete summary + blueprint after wizard
    await openSettings(page);
    await page.click('[data-testid="clear-key-btn"]');
    await page.waitForSelector('[data-testid="open-setup-wizard-btn"]');
    await closeSettings(page);
    const ambigZipPath = path.join(tmpDir, 'deepseek-ambiguous-long.zip');
    fs.writeFileSync(ambigZipPath, buildAmbiguousOverWindowZipE2E());
    await startDeepSeekImport(page);
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', ambigZipPath);
    await page.getByTestId('ds-session-list').waitFor();
    const { sheet: ambigPreviewSheet, card: ambigPreviewCard } = await openSessionPreview(page, '模糊开局超窗长档');
    // Exercise collapsed manual script range override in preview and then clear back to auto
    await ambigPreviewSheet.getByText('手动调整原始剧本起点/终点').click();
    await page.fill('#ds-script-start', '3');
    await page.fill('#ds-script-end', '3');
    const overridePreviewText = await ambigPreviewCard.textContent();
    if (!overridePreviewText?.includes('已手动调整原始剧本边界')) {
      throw new Error(`Expected manual override to lock script, got: ${overridePreviewText}`);
    }
    await page.fill('#ds-script-start', '');
    await closeSessionPreview(ambigPreviewSheet);
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    const keylessAmbigReceipt = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!keylessAmbigReceipt?.includes('待配置密钥')) {
      throw new Error(`Expected pending_key badge in receipt, got: ${keylessAmbigReceipt}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("门后传来脚步声")');
    await page.setViewportSize({ width: 390, height: 844 });
    let reviewSheet = await openStoryReview(page);
    await reviewSheet.getByTestId('summary-needed-indicator').waitFor({ state: 'visible' });
    await reviewSheet.getByRole('button', { name: '立即补算剧情摘要' }).click();
    await page.waitForSelector('[data-testid="deepseek-setup-wizard"]');
    await page.fill('#byok-api-key', 'sk-e2e-inline');
    delayNextSummaryMs = 1200;
    await page.click('[data-testid="wizard-verify-save-btn"]');
    await page.getByTestId('deepseek-setup-wizard').waitFor({ state: 'hidden' });
    await reviewSheet.waitFor({ state: 'hidden' });
    const progress = page.locator('[data-testid="app-topbar"] .summary-progress');
    await progress.waitFor({ state: 'visible' });
    const progressLayout = await page.evaluate(() => {
      const topbar = document.querySelector('[data-testid="app-topbar"]');
      const status = topbar?.querySelector('.summary-progress');
      const statusRect = status?.getBoundingClientRect();
      const topbarRect = topbar?.getBoundingClientRect();
      return {
        display: status ? getComputedStyle(status).display : 'none',
        statusWidth: statusRect?.width ?? 0,
        insideTopbar: Boolean(statusRect && topbarRect && statusRect.left >= topbarRect.left && statusRect.right <= topbarRect.right),
        storySheetOpen: Boolean(document.querySelector('[data-testid="story-tree-sheet"]')?.open),
      };
    });
    if (progressLayout.display === 'none' || progressLayout.statusWidth <= 0 || !progressLayout.insideTopbar || progressLayout.storySheetOpen) {
      throw new Error(`Mobile summary progress is not visible in the top bar while the sheet is closed: ${JSON.stringify(progressLayout)}`);
    }
    await waitForActivePlotSummary(page, '【激活线压缩摘要】');
    await page.setViewportSize({ width: 1280, height: 720 });
    const blueprintSheet = await openStoryBlueprint(page);
    delayNextBlueprintMs = 1200;
    await blueprintSheet.getByTestId('story-blueprint-card').getByRole('button', { name: '补拆完整故事蓝图' }).click();
    await blueprintSheet.getByRole('button', { name: '补拆蓝图中…' }).waitFor({ state: 'visible' });
    await assertNoSummaryProgress(page, blueprintSheet, 'Blueprint re-extraction');
    await blueprintSheet.getByRole('button', { name: '补拆蓝图中…' }).waitFor({ state: 'detached' });
    await closeCompanionSheet(page);

    // 0b. Keyed imports: strong turn-1 skips boundary locator; ambiguous runs boundary locator once + compresses + carries both on continuation
    boundaryCallCount = 0;
    await startDeepSeekImport(page);
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', dsZipPath);
    await page.getByTestId('ds-session-list').waitFor();
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    if (boundaryCallCount !== 0) {
      throw new Error(`Expected 0 boundary LLM calls for strong turn-1 script, got ${boundaryCallCount}`);
    }

    await startDeepSeekImport(page);
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', ambigZipPath);
    await page.getByTestId('ds-session-list').waitFor();
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');
    if (boundaryCallCount !== 1) {
      throw new Error(`Expected 1 boundary LLM call for ambiguous opening, got ${boundaryCallCount}`);
    }
    const ambigReceipt = await page.locator('[data-testid="deepseek-import-receipt"]').textContent();
    if (!ambigReceipt?.includes('已压缩')) {
      throw new Error(`Expected compressed summary status in receipt, got: ${ambigReceipt}`);
    }
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("门后传来脚步声")');
    const ambigSummary = await readActivePlotSummary(page);
    if (!ambigSummary?.includes('【激活线压缩摘要】')) {
      throw new Error(`Expected compressed active summary in StoryReview, got: ${ambigSummary}`);
    }
    await page.fill('#turn-input', '推开船长室门');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：推开船长室门")');
    if (
      !lastTurnSystemText.includes('【E2E模糊剧本】') ||
      !lastTurnSystemText.includes('【激活线压缩摘要】') ||
      lastTurnSystemText.includes('你好呀')
    ) {
      throw new Error(`Continuation system prompt missing refined anchor or summary: ${lastTurnSystemText}`);
    }

    // Clean up DeepSeek stories before running existing script-import workflow assertions
    await deleteAllStories(page);

    // 1. Privacy note + clear key + network-error fallback save via wizard
    await openSettings(page);
    const cardText = await page.locator('[data-testid="deepseek-connection-card"]').textContent();
    if (!cardText?.includes('不会上传到任何第三方服务器')) {
      throw new Error(`Plain-language privacy note missing: ${cardText}`);
    }
    await page.click('[data-testid="clear-key-btn"]');
    await page.waitForSelector('[data-testid="open-setup-wizard-btn"]');
    if ((await page.evaluate(() => localStorage.getItem('lfh.model_config.api_key'))) !== null) {
      throw new Error('Expected localStorage apiKey purged on clear-key-btn');
    }
    await page.click('[data-testid="open-setup-wizard-btn"]');
    await page.waitForSelector('[data-testid="deepseek-setup-wizard"]');
    await page.fill('#byok-api-key', 'sk-e2e-netfail');
    await page.click('[data-testid="wizard-verify-save-btn"]');
    await page.waitForSelector('[data-testid="wizard-fallback-save-btn"]');
    await page.click('[data-testid="wizard-fallback-save-btn"]');
    await page.waitForSelector('[data-testid="connected-key-mask"]');
    await closeSettings(page);

    // 2. Import synthetic .docx fixture -> extract & tweak blueprint -> confirm story
    const docxPath = path.join(tmpDir, 'fixture.docx');
    fs.writeFileSync(docxPath, buildFixtureDocx());
    await startScriptImport(page);
    await page.setInputFiles('#import-file', docxPath);
    await page.waitForFunction(() => {
      const el = document.querySelector('#import-raw-script');
      return el && 'value' in el && String(el.value).includes('| 人气 | 50 |');
    });
    await page.click('button:has-text("拆解故事蓝图")');
    await page.getByTestId('import-panel').getByTestId('story-blueprint-card').waitFor();
    await page.getByTestId('import-panel').getByRole('button', { name: '微调' }).click();
    await page.fill('#bp-title', 'E2E训练营故事');
    await page.getByRole('button', { name: '保存蓝图微调' }).click();
    await page.getByRole('button', { name: '确认并开启第一幕' }).click();

    // 3. Play turns and verify the immersive stage contract.
    await page.click('button:has-text("开启第一幕")');
    await page.getByTestId('hud-panel').waitFor();
    await page.getByRole('button', { name: '发送行动' }).waitFor();
    const firstUserCard = page.getByTestId('turn-user').last();
    const firstAssistantCard = page.getByTestId('turn-assistant').last();
    const choiceToolbarOrder = await firstAssistantCard.evaluate((card) => {
      const toolbar = card.querySelector('.turn-actions');
      const choices = card.querySelector('[data-testid="choice-row"]');
      return Boolean(toolbar && choices &&
        (toolbar.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    if (!choiceToolbarOrder) {
      throw new Error('Quick choices should follow the narrative action toolbar.');
    }
    const bubbleAlignment = await firstUserCard.getByTestId('user-bubble').evaluate((bubble) =>
      getComputedStyle(bubble.parentElement).justifyContent,
    );
    if (bubbleAlignment !== 'flex-end') {
      throw new Error(`Player action bubble was not right aligned: ${bubbleAlignment}`);
    }
    const assistantSurface = await firstAssistantCard.evaluate((card) => ({
      background: getComputedStyle(card).backgroundColor,
      borderWidth: getComputedStyle(card).borderTopWidth,
    }));
    if (assistantSurface.background !== 'rgba(0, 0, 0, 0)' || assistantSurface.borderWidth !== '0px') {
      throw new Error(`Narrative turn has a card surface: ${JSON.stringify(assistantSurface)}`);
    }
    await firstAssistantCard.getByRole('button', { name: '复制正文' }).click();
    const copiedNarrative = await page.evaluate(() => navigator.clipboard.readText());
    if (!copiedNarrative.includes('回执：开始故事')) {
      throw new Error(`Copy action did not place the full narrative on the clipboard: ${copiedNarrative}`);
    }

    const firstReasoning = firstAssistantCard.getByTestId('reasoning-details');
    if (await firstReasoning.evaluate((details) => details.open)) {
      throw new Error('Completed reasoning should start collapsed.');
    }
    const reasoningLabel = await firstReasoning.getByTestId('reasoning-toggle').textContent();
    if (!reasoningLabel?.match(/已思考\s+\d+\s+秒/)) {
      throw new Error(`Missing measured reasoning duration: ${reasoningLabel}`);
    }
    await firstReasoning.getByTestId('reasoning-toggle').click();
    await firstAssistantCard.locator('.reasoning-content').waitFor({ state: 'visible' });
    await firstReasoning.getByTestId('reasoning-toggle').click();
    await firstAssistantCard.locator('.reasoning-content').waitFor({ state: 'hidden' });

    const firstHud = firstAssistantCard.getByTestId('hud-panel').first();
    const grid = firstHud.getByTestId('hud-grid');
    await grid.waitFor();
    if ((await grid.locator('.hud-field-wide').count()) !== 1) {
      throw new Error('Long HUD values should span both grid columns.');
    }
    await firstHud.getByRole('button', { name: '原始格式' }).click();
    await firstHud.getByTestId('hud-raw-view').waitFor();
    if (await firstHud.getByTestId('hud-grid').count()) {
      throw new Error('Raw HUD view should replace the grid view.');
    }
    await firstHud.getByRole('button', { name: '网格视图' }).click();
    await firstHud.getByTestId('hud-grid').waitFor();
    await firstHud.getByTestId('hud-collapse-toggle').click();
    if (await firstHud.getByTestId('hud-grid').count()) {
      throw new Error('Collapsed HUD should hide its values.');
    }
    await firstHud.getByTestId('hud-collapse-toggle').click();
    await firstAssistantCard.getByTestId('choice-row').getByRole('button', { name: 'A. 继续训练声乐' }).waitFor();

    const firstChoiceActions = [
      '第二轮黑市线索',
      '第三轮打探消息',
      '第四轮进入暗巷',
      '第五轮接头',
    ];
    for (const act of firstChoiceActions) {
      await page.fill('#turn-input', act);
      await page.getByRole('button', { name: '发送行动' }).click();
      await page.waitForSelector(`[data-testid="turn-assistant"]:has-text("回执：${act}")`);
    }
    await page.getByTestId('choice-row').getByRole('button', { name: 'A. 继续训练声乐' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：A. 继续训练声乐")');

    const stage = page.getByTestId('main-stage');
    const userCountBeforeIme = await page.getByTestId('turn-user').count();
    await page.fill('#turn-input', '组合输入候选');
    await page.locator('#turn-input').evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        which: 229,
        bubbles: true,
      }));
    });
    if (await page.getByTestId('turn-user').count() !== userCountBeforeIme ||
        await page.inputValue('#turn-input') !== '组合输入候选') {
      throw new Error('IME composition Enter incorrectly submitted the player action.');
    }
    await page.locator('#turn-input').press('Shift+Enter');
    if (!(await page.inputValue('#turn-input')).includes('\n')) {
      throw new Error('Shift+Enter should insert a newline into the composer.');
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill('#turn-input', 'Enter键提交行动');
    await page.locator('#turn-input').press('Enter');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：Enter键提交行动")');
    try {
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="main-stage"]');
        return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
      }, undefined, { timeout: 5000 });
    } catch {
      const metrics = await stage.evaluate((element) => ({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        documentScrollTop: document.documentElement.scrollTop,
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientHeight: document.documentElement.clientHeight,
        display: getComputedStyle(element).display,
        height: getComputedStyle(element).height,
        overflowY: getComputedStyle(element).overflowY,
      }));
      throw new Error(`Stage did not follow to the bottom: ${JSON.stringify(metrics)}`);
    }

    await stage.hover({ position: { x: 80, y: 200 } });
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="main-stage"]');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight > 80;
    });
    await page.getByTestId('scroll-to-bottom').waitFor({ state: 'visible' });
    await page.fill('#turn-input', Array(10).fill('仍在编辑的长草稿').join('\n'));
    const returnButtonHitTest = await page.getByTestId('scroll-to-bottom').evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        buttonTop: rect.top,
        textareaTop: document.querySelector('#turn-input')?.getBoundingClientRect().top,
        hitButton: Boolean(hit && button.contains(hit)),
      };
    });
    if (!returnButtonHitTest.hitButton || returnButtonHitTest.buttonTop >= (returnButtonHitTest.textareaTop ?? Infinity)) {
      throw new Error(`Return-to-bottom button is covered or below the composer input: ${JSON.stringify(returnButtonHitTest)}`);
    }
    await page.getByTestId('scroll-to-bottom').click();
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="main-stage"]');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    });
    await stage.hover({ position: { x: 80, y: 200 } });
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="main-stage"]');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight > 80;
    });
    await page.getByTestId('scroll-to-bottom').waitFor({ state: 'visible' });
    const gapAfterManualWheel = await stage.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    delayNextTurnMs = 1000;
    await page.fill('#turn-input', '上滑后暂停跟随');
    await page.locator('#turn-input').press('Enter');
    await page.getByRole('button', { name: '停止生成' }).waitFor();
    const pausedGap = await stage.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    if (pausedGap <= 80) {
      throw new Error(`Timeline followed streaming output after manual scroll: gap ${gapAfterManualWheel}px -> ${pausedGap}px`);
    }
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：上滑后暂停跟随")');
    await page.getByTestId('scroll-to-bottom').click();
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="main-stage"]');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    });
    await verifyScrollDetachAndResumeThreshold(page, () => { delayNextTurnMs = 10000; });
    await page.setViewportSize({ width: 1280, height: 720 });

    // 4. Verify explicit Story Review (visible without opening <details>) & Branch A active
    reviewSheet = await openStoryReview(page);
    const reviewVisible = await reviewSheet.getByTestId('story-review').isVisible();
    if (!reviewVisible) {
      throw new Error('Expected Story Review panel to be explicitly visible');
    }
    const sumA = await reviewSheet.getByTestId('active-plot-summary').textContent();
    if (!sumA?.includes('【分支A摘要】含黑市线索')) {
      throw new Error(`Expected Branch A summary, got: ${sumA}`);
    }
    await closeCompanionSheet(page);

    const savedBlueprintSheet = await openStoryBlueprint(page);
    const blueprintCard = savedBlueprintSheet.getByTestId('story-blueprint-card');
    await blueprintCard.getByRole('heading', { name: 'E2E训练营故事' }).waitFor();
    await blueprintCard.getByText('每轮输出状态面板', { exact: true }).waitFor();
    await blueprintCard.getByText('导师林（声乐导师）', { exact: true }).waitFor();
    await blueprintCard.getByText('不可缺席公演', { exact: true }).waitFor();
    const contextDetails = savedBlueprintSheet.getByTestId('context-overview');
    if (await contextDetails.evaluate((element) => element.open)) {
      throw new Error('Three-zone context details should be collapsed by default.');
    }
    await blueprintCard.getByRole('button', { name: '微调蓝图' }).click();
    await page.fill('#tweak-protagonist', '练习生甲（已微调）');
    await page.fill('#tweak-taboos', '不可缺席公演\n未经同意不离开训练营');
    await blueprintCard.getByRole('button', { name: '保存蓝图微调' }).click();
    await blueprintCard.getByText('练习生甲（已微调）', { exact: true }).waitFor();
    await blueprintCard.getByText('未经同意不离开训练营', { exact: true }).waitFor();
    await contextDetails.locator('summary').click();
    if (!(await contextDetails.evaluate((element) => element.open))) {
      throw new Error('Three-zone context details did not open on request.');
    }
    await closeCompanionSheet(page);

    // 5. Rewind & edit Turn 2 user node to fork Branch B -> verify Plot Summary rolled back & Story Tree fork appears
    const turn2Card = page.getByTestId('turn-assistant').nth(1);
    if (!(await page.getByTestId('turn-assistant').first().getByTestId('turn-history-toggle').isVisible())) {
      throw new Error('Older narrative operation rows should start collapsed.');
    }
    if (!(await turn2Card.locator('.turn-body').first().isVisible()) || await turn2Card.locator('.turn-actions').count()) {
      throw new Error('Historical narrative should stay visible while its operation row starts folded.');
    }
    await turn2Card.getByTestId('turn-history-toggle').click();
    await turn2Card.getByRole('button', { name: '编辑并生成新分支' }).waitFor();
    await turn2Card.getByRole('button', { name: '编辑并生成新分支' }).click();
    await turn2Card.locator('textarea').fill('第二轮改道休息');
    await turn2Card.getByRole('button', { name: '提交并生成新分支' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：第二轮改道休息")');
    const historicalEditPager = await page.getByTestId('turn-user').nth(1).getByTestId('branch-pager').textContent();
    if (!historicalEditPager?.includes('2 / 2')) {
      throw new Error(`Historical edit did not expose its sibling branch pager: ${historicalEditPager}`);
    }
    const sumB = await readActivePlotSummary(page);
    if (sumB?.includes('黑市线索')) {
      throw new Error(`Branch A leaked into Branch B summary: ${sumB}`);
    }

    await verifyBranchSwitchBlocksImmediateSend(page);

    // 5b. Story Tree: verify linear span folding, fork badge ⑂ 2, expand fork, rename Branch B, AI gist, switch back to Branch A
    const storyTreeSheet = await openStoryTree(page);
    const spanText = await storyTreeSheet.locator('[data-testid="story-tree-span"]').first().textContent();
    if (!spanText?.includes('第 1–2 轮') && !spanText?.includes('第 1')) {
      throw new Error(`Expected folded span in Story Tree, got: ${spanText}`);
    }
    const forkBtn = storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first();
    const forkBtnText = await forkBtn.textContent();
    if (!forkBtnText?.includes('⑂ 2')) {
      throw new Error(`Expected fork badge ⑂ 2 in Story Tree, got: ${forkBtnText}`);
    }
    await forkBtn.click();
    await storyTreeSheet.getByTestId('story-tree-branches').waitFor();
    const siblingB = storyTreeSheet.locator('[data-testid^="story-tree-branch-"][data-active="true"]');
    await siblingB.locator('button:has-text("重命名")').click();
    await siblingB.locator('input[aria-label="分支名称"]').fill('休息支线');
    await siblingB.locator('button:has-text("保存名称")').click();
    await storyTreeSheet.getByRole('tab', { name: '剧情回顾' }).click();
    await storyTreeSheet.getByTestId('story-review').getByText('休息支线', { exact: false }).waitFor();
    await storyTreeSheet.getByRole('tab', { name: '剧情树' }).click();

    // On-demand AI gist on active sibling branch
    delayNextGistMs = 1200;
    await Promise.all([
      page.waitForRequest((request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/chat/completions') &&
        request.postDataJSON()?.messages?.[0]?.content.includes('分支梗概助手'),
      ),
      siblingB.locator('button:has-text("AI 提炼梗概")').click(),
    ]);
    await page.waitForTimeout(50);
    await assertNoSummaryProgress(page, storyTreeSheet, 'Branch gist extraction');
    await siblingB.getByText('AI 梗概：AI提炼：改道休息线稳妥推进', { exact: false }).waitFor();

    // Switch back to Branch A via Story Tree sibling button
    const nonActiveSibling = storyTreeSheet.locator('[data-testid^="story-tree-branch-"][data-active="false"]').first();
    await nonActiveSibling.locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：A. 继续训练声乐")');
    await closeStoryTree(page);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="story-list-item"][data-active="true"]');
    await openSettings(page);
    await page.waitForSelector('[data-testid="connected-key-mask"]');
    await closeSettings(page);
    const sumAfterReload = await readActivePlotSummary(page);
    const reloadedSecondUser = page.getByTestId('turn-user').nth(1);
    await reloadedSecondUser.getByTestId('turn-history-toggle').click();
    const pagerAfterReload = await reloadedSecondUser.getByTestId('branch-pager').textContent();
    if (!sumAfterReload?.includes('【分支A摘要】含黑市线索') || !pagerAfterReload?.includes('1 / 2')) {
      throw new Error('IndexedDB reload did not restore branch tree & summary');
    }
    // Verify renamed Branch B survived reload in Story Tree
    const reloadedTree = await openStoryTree(page);
    await reloadedTree.locator('[data-testid^="story-tree-fork-"]').first().click();
    await reloadedTree.getByTestId('story-tree-branches').getByText('休息支线', { exact: false }).waitFor();
    await closeStoryTree(page);

    // 7. Export JSON backup -> delete story -> re-import JSON backup
    const backupRows = await visibleStoryRows(page);
    const backupRowCount = await backupRows.count();
    const backupRow = backupRows.first();
    await backupRow.getByTestId('story-menu-trigger').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      backupRow.getByRole('menuitem', { name: '导出 .lfh.json' }).click(),
    ]);
    const backupFile = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(backupFile);
    const mainStage = page.getByTestId('main-stage');
    await mainStage.hover({ position: { x: 80, y: 200 } });
    await page.mouse.wheel(0, -1000);
    await page.getByTestId('scroll-to-bottom').waitFor({ state: 'visible' });
    await backupRow.getByTestId('story-menu-trigger').click();
    await backupRow.getByRole('menuitem', { name: '删除故事' }).click();
    await page.waitForFunction((count) =>
      [...document.querySelectorAll('[data-testid="story-list-item"]')]
        .filter((item) => item.getClientRects().length > 0).length < count,
    backupRowCount);
    await page.getByTestId('scroll-to-bottom').waitFor({ state: 'hidden' });
    await openSettings(page);
    await page.setInputFiles('[data-testid="backup-import-input"]', backupFile);
    await page.waitForSelector('[data-testid="story-list-item"][data-active="true"]');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：A. 继续训练声乐")');
    await page.waitForFunction(() => {
      const stage = document.querySelector('[data-testid="main-stage"]');
      return stage && stage.scrollHeight - stage.scrollTop - stage.clientHeight <= 24;
    });
    await page.getByTestId('scroll-to-bottom').waitFor({ state: 'hidden' });

    // 8. Collapsible reasoning panel rendering (.reasoning-content)
    const firstAssistant = page.getByTestId('turn-assistant').first();
    await firstAssistant.getByTestId('turn-history-toggle').click();
    const reasoningDetails = firstAssistant.getByTestId('reasoning-details');
    const reasoningContent = firstAssistant.locator('.reasoning-content');
    if ((await reasoningDetails.evaluate((el) => el.open)) || (await reasoningContent.isVisible())) {
      throw new Error('Expected .reasoning-details to be collapsed by default');
    }
    await reasoningDetails.getByTestId('reasoning-toggle').click();
    if (!(await reasoningDetails.evaluate((el) => el.open)) || !(await reasoningContent.isVisible())) {
      throw new Error('Expected .reasoning-content visible after expanding');
    }
    const reasoningText = await reasoningContent.textContent();
    if (!reasoningText?.includes('推理(')) {
      throw new Error(`Unexpected reasoning content: ${reasoningText}`);
    }
    await reasoningDetails.getByTestId('reasoning-toggle').click();
    if (await reasoningContent.isVisible()) {
      throw new Error('Expected .reasoning-content hidden after collapsing');
    }

    // 9. regenerateNode & rewindToNode UI actions
    const choiceAssistant = page.getByTestId('turn-assistant')
      .filter({ hasText: '回执：A. 继续训练声乐' }).last();
    await choiceAssistant.getByTestId('turn-history-toggle').click();
    await choiceAssistant.getByRole('button', { name: '重新生成分支' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执#2：A. 继续训练声乐")');
    const regenPager = await page.getByTestId('turn-assistant').last().getByTestId('branch-pager').textContent();
    if (!regenPager?.includes('2 / 2')) {
      throw new Error(`Expected regenerated branch pager 2 / 2, got: ${regenPager}`);
    }
    await page.getByTestId('turn-assistant').last().getByRole('button', { name: '上一分支' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("回执：A. 继续训练声乐")');

    await firstAssistant.getByRole('button', { name: '回溯至此' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="turn-assistant"]').length === 1);
    if ((await firstAssistant.getByRole('button', { name: '回溯至此' }).count()) !== 0) {
      throw new Error('Expected active rewound leaf not to show 回溯至此');
    }
    const blueprintAfterRewind = await openStoryBlueprint(page);
    await blueprintAfterRewind.getByTestId('context-overview').locator('summary').click();
    await closeCompanionSheet(page);
    const rewoundSummary = await readActivePlotSummary(page);
    if (!rewoundSummary?.includes('尚未触发压缩')) {
      throw new Error(`Expected rewound summary reset, got: ${rewoundSummary}`);
    }

    // 10. .txt and .md file import + HTTP 401 non-blocking blueprint error banner
    const txtPath = path.join(tmpDir, 'notes.txt');
    const mdPath = path.join(tmpDir, 'camp.md');
    fs.writeFileSync(txtPath, '【纯文本剧本】\n规则：每晚点名。', 'utf8');
    fs.writeFileSync(mdPath, '# 星光练习生 Markdown\n- 不可迟到\n```\n[体力: 100]\n```', 'utf8');

    await startScriptImport(page);
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
    await page.waitForSelector('[data-testid="import-error"]');
    const bpError = await page.getByTestId('import-error').textContent();
    if (!bpError?.includes('401')) {
      throw new Error(`Expected 401 error banner in ImportPanel, got: ${bpError}`);
    }
    // Non-blocking: user can still create a story with the default blueprint.
    await page.getByRole('button', { name: '暂不拆解，直接开始' }).last().click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="story-list-item"]')]
        .filter((item) => item.getClientRects().length > 0).length === 2,
    );
    if ((await (await visibleStoryRows(page)).count()) !== 2) {
      throw new Error('Expected two saved stories after aborted stream recovery.');
    }

    await verifyStoppedSendPreservesNewerDraft(page, () => { delayNextTurnMs = 3000; });

    // 10b. Mid-stream abort via 停止生成 must NOT re-submit the composer form
    delayNextTurnMs = 3000;
    await page.fill('#turn-input', '测试停止生成不重发');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByRole('button', { name: '停止生成' }).waitFor();
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.getByTestId('main-error-banner').waitFor();
    const abortMsg = await page.getByTestId('main-error-banner').textContent();
    if (!abortMsg?.includes('已中止本次生成')) {
      throw new Error(`Expected abort banner, got: ${abortMsg}`);
    }
    if ((await page.inputValue('#turn-input')) !== '测试停止生成不重发') {
      throw new Error('Expected aborted input restored cleanly without re-submitting');
    }
    if ((await page.locator('[data-testid="turn-user"], [data-testid="turn-assistant"]').count()) !== 0) {
      throw new Error('Expected aborted turn not to commit any turn card');
    }

    // 11. Mobile narrow viewport check (390x844, no horizontal overflow) on multi-branch story
    await selectStoryByTitle(page, 'E2E训练营故事');
    await page.getByTestId('open-story-tree').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileRows = await visibleStoryRows(page);
    await page.getByTestId('mobile-library-dialog').waitFor({ state: 'visible' });
    const activeMobileRow = mobileRows.filter({ hasText: 'E2E训练营故事' }).first();
    const storyMenuTrigger = activeMobileRow.getByTestId('story-menu-trigger');
    await expectTouchTarget(storyMenuTrigger, 'mobile story menu trigger');
    await storyMenuTrigger.click();
    const storyMenuItems = activeMobileRow.getByRole('menuitem');
    for (let index = 0; index < await storyMenuItems.count(); index += 1) {
      await expectTouchTarget(storyMenuItems.nth(index), `mobile story menu item ${index + 1}`);
    }
    await page.keyboard.press('Escape');
    const mobileLibraryDialog = page.getByTestId('mobile-library-dialog');
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="mobile-library-dialog"]');
      return dialog?.dataset.closing === 'true' || !dialog?.open;
    });
    if (!(await mobileLibraryDialog.getAttribute('data-closing'))) {
      throw new Error('Escape closed the mobile drawer without its exit state.');
    }
    await mobileLibraryDialog.waitFor({ state: 'hidden' });
    await expectTouchTarget(page.getByTestId('open-story-tree'), 'mobile branch badge');
    const checkNoHorizontalOverflow = async (label) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth) {
        throw new Error(`Horizontal overflow on ${label} (${scrollWidth} > ${clientWidth})`);
      }
    };
    reviewSheet = await openStoryReview(page);
    await reviewSheet.getByTestId('story-review').scrollIntoViewIfNeeded();
    await checkNoHorizontalOverflow('mobile main view');
    await closeCompanionSheet(page);
    const mobileTree = await openStoryTree(page);
    const smallStoryActions = mobileTree.locator('.btn-sm:visible');
    for (let index = 0; index < await smallStoryActions.count(); index += 1) {
      await expectTouchTarget(smallStoryActions.nth(index), `mobile story action ${index + 1}`);
    }
    const treeForkMobile = mobileTree.locator('[data-testid^="story-tree-fork-"]').first();
    if ((await treeForkMobile.getAttribute('aria-expanded')) !== 'true') await treeForkMobile.click();
    await mobileTree.getByTestId('story-tree-branches').waitFor();
    await checkNoHorizontalOverflow('mobile story tree expanded');
    await closeStoryTree(page);
    await startScriptImport(page);
    await page.getByTestId('import-panel').waitFor();
    await checkNoHorizontalOverflow('mobile import view');

    await runComprehensiveSpec18MobileE2E(browser, port, tmpDir);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await runSpec24LongImportE2E(browser, port, viewport);
      await runDiagnosticsE2E(browser, port, tmpDir, viewport);
      console.log(`SPEC24_E2E_PASSED ${viewport.width}x${viewport.height} (long import, catch-up, concurrent rename, diagnostics, crash recovery, privacy)`);
    }

    console.log('ALL_E2E_CHECKS_PASSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await browser.close();
    srv.kill('SIGTERM');
  }
}

function buildComprehensiveSpec18ZipE2E() {
  const docxBytes = buildFixtureDocx();
  const sciSession = {
    id: 'spec18-sci',
    title: '量子退相干数值研究',
    current_message_id: 2,
    inserted_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:02:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-10T08:00:00Z', fragments: [{ type: 'REQUEST', content: 'SELECT * FROM runs;' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-10T08:02:00Z', fragments: [{ type: 'RESPONSE', content: '可以使用主方程估算。' }] },
    ],
  };
  const nullSession = {
    id: 'spec18-null',
    title: null,
    current_message_id: 2,
    inserted_at: '2026-11-11T08:00:00Z',
    updated_at: '2026-11-11T08:01:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-11T08:00:00Z', fragments: [{ type: 'REQUEST', content: '周末高铁时刻查询' }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-11T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '周六早九点有车次。' }] },
    ],
  };
  const fictionSession = {
    id: 'spec18-two-fork',
    title: '庄园双线E2E总验',
    current_message_id: 21,
    inserted_at: '2026-11-12T10:00:00Z',
    updated_at: '2026-11-12T12:00:00Z',
    messages: [
      {
        id: 1,
        parent_id: null,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2026-11-12T10:00:00Z',
        fragments: [
          {
            type: 'FILE',
            files: [
              { id: 'd1', file_name: '庄园规则.docx', file_size: docxBytes.length, export_path: 'chat_sessions/spec18-two-fork/庄园规则.docx', is_image: false },
              { id: 'p1', file_name: '封面.png', file_size: 128, export_path: 'chat_sessions/spec18-two-fork/封面.png', is_image: true },
              { id: 'doc1', file_name: '旧设.doc', file_size: 128, export_path: 'chat_sessions/spec18-two-fork/旧设.doc', is_image: false },
            ],
          },
          { type: 'REQUEST', content: '按附件规则开局。' },
        ],
      },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:01:00Z', fragments: [{ type: 'RESPONSE', content: '第1章 雨夜大宅\n地点：门厅' }] },
      { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:02:00Z', fragments: [{ type: 'REQUEST', content: '查看大宅地图' }] },
      { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:03:00Z', fragments: [{ type: 'RESPONSE', content: '大宅分为东楼与西塔。' }] },
      // Fork 1 at id=4 -> Branch A (12 post-fork nodes -> Event X folded into summary!) & Branch B (12 post-fork nodes -> Event Y folded!)
      { id: 5, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:04:00Z', fragments: [{ type: 'REQUEST', content: '走东楼触发事件X_银钥匙' }] },
      {
        id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        status: 'CONTENT_FILTER',
        inserted_at: '2026-11-12T10:05:00Z',
        fragments: [
          { type: 'CONTENT_RISK', content: '风控噪声' },
          { type: 'RESPONSE', content: '事件X_银钥匙已获取。' },
        ],
      },
      { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:06:00Z', fragments: [{ type: 'REQUEST', content: '检视银钥匙' }] },
      // Fork 2 at id=7
      { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:07:00Z', fragments: [{ type: 'RESPONSE', content: '银钥匙指向东楼密室。' }] },
      { id: 17, parent_id: 7, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:07:30Z', fragments: [{ type: 'RESPONSE', content: '银钥匙备选细节。' }] },
      { id: 9, parent_id: 8, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:08:00Z', fragments: [{ type: 'REQUEST', content: '进入东楼密室' }] },
      { id: 10, parent_id: 9, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:00Z', fragments: [{ type: 'RESPONSE', content: '东楼走廊尽头出现暗门。' }] },
      { id: 18, parent_id: 10, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:09:10Z', fragments: [{ type: 'REQUEST', content: '推开东楼暗门' }] },
      { id: 19, parent_id: 18, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:20Z', fragments: [{ type: 'RESPONSE', content: '暗门后是密室石阶。' }] },
      { id: 20, parent_id: 19, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:09:30Z', fragments: [{ type: 'REQUEST', content: '走下密室石阶' }] },
      { id: 21, parent_id: 20, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:09:40Z', fragments: [{ type: 'RESPONSE', content: '抵达东楼密室终点。' }] },
      // Branch B (mutually exclusive Event Y, 12 post-fork nodes)
      { id: 11, parent_id: 4, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:10:00Z', fragments: [{ type: 'REQUEST', content: '走西塔触发事件Y_西塔毒药' }] },
      { id: 12, parent_id: 11, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:11:00Z', fragments: [{ type: 'RESPONSE', content: '事件Y_西塔毒药已发现。' }] },
      { id: 13, parent_id: 12, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:12:00Z', fragments: [{ type: 'REQUEST', content: '封存毒药样本' }] },
      { id: 14, parent_id: 13, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:13:00Z', fragments: [{ type: 'RESPONSE', content: '发现毒药来源指向温室。' }] },
      { id: 15, parent_id: 14, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:14:00Z', fragments: [{ type: 'REQUEST', content: '清点西塔笔记' }] },
      { id: 16, parent_id: 15, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:15:00Z', fragments: [{ type: 'RESPONSE', content: '笔记记录了温室配比。' }] },
      { id: 22, parent_id: 16, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-12T10:15:10Z', fragments: [{ type: 'REQUEST', content: '收好西塔实验记录' }] },
      { id: 23, parent_id: 22, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-12T10:15:20Z', fragments: [{ type: 'RESPONSE', content: '抵达西塔终点。' }] },
    ],
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/spec18-sci.json': strToU8(JSON.stringify(sciSession)),
    'chat_sessions/spec18-null.json': strToU8(JSON.stringify(nullSession)),
    'chat_sessions/spec18-two-fork.json': strToU8(JSON.stringify(fictionSession)),
    'chat_sessions/spec18-two-fork/庄园规则.docx': docxBytes,
    'chat_sessions/spec18-two-fork/封面.png': strToU8('png'),
    'chat_sessions/spec18-two-fork/旧设.doc': strToU8('doc'),
  });
}

async function runComprehensiveSpec18MobileE2E(browser, port, tmpDir) {
  const mobileCtx = await newOfflineContext(browser, port, { viewport: { width: 390, height: 844 } });
  const page = await mobileCtx.newPage();
  const capturedTurns = [];

  try {
    await page.route('https://cdn.deepseek.example/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body>请登录</body></html>',
      });
    });

    await page.route('https://api.deepseek.com/models', async (route) => {
      const auth = route.request().headers().authorization || '';
      if (auth === 'Bearer sk-e2e-401') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Invalid API key' } }),
        });
        return;
      }
      if (auth === 'Bearer sk-e2e-netfail') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Service Unavailable' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 'deepseek-flash' }] }),
      });
    });

    await page.route('**/chat/completions', async (route) => {
      const reqBody = JSON.parse(route.request().postData() || '{}');
      const sys = reqBody.messages?.[0]?.content || '';
      const allText = (reqBody.messages || []).map((m) => m.content).join('\n');

      if (sys.includes('剧情摘要压缩')) {
        const summary = allText.includes('事件Y_西塔毒药')
          ? '【西塔线摘要】已发现事件Y_西塔毒药。'
          : allText.includes('事件X_银钥匙')
            ? '【东楼线摘要】已取得事件X_银钥匙。'
            : '【开局摘要】查看大宅地图。';
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content: summary }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      if (sys.includes('严格只输出一个 JSON 对象')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      title: '庄园双线E2E总验',
                      worldRules: ['每轮输出状态栏'],
                      protagonist: '调查员',
                      npcs: [],
                      taboos: [],
                      openingHook: '雨夜大宅',
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

      capturedTurns.push(allText);
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content || '';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content: `窄屏续写：${lastMsg}` }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

    const assertNoOverflow = async (label) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth) {
        throw new Error(`390px overflow on ${label} (${scrollWidth} > ${clientWidth})`);
      }
    };

    // 1. Link error fallback -> upload comprehensive zip -> search & preview -> keyless import -> Continue This Story
    await startDeepSeekImport(page);
    await page.getByTestId('deepseek-source-url').click();
    await page.fill('#deepseek-zip-url-input', 'https://cdn.deepseek.example/login.zip');
    await page.getByTestId('deepseek-fetch-zip').click();
    await page.waitForSelector('[data-testid="import-error"]:has-text("HTML")');
    await page.getByRole('button', { name: '改用本地 .zip 文件' }).click();

    const zipPath = path.join(tmpDir, 'spec18-comprehensive.zip');
    fs.writeFileSync(zipPath, buildComprehensiveSpec18ZipE2E());
    await page.setInputFiles('#deepseek-zip-input', zipPath);
    await page.getByTestId('ds-session-list').waitFor();
    await page.fill('input[aria-label="搜索外部会话"]', '庄园');
    const { sheet: comprehensiveSheet, card: comprehensivePreview } = await openSessionPreview(page, '庄园');
    const previewText = await comprehensivePreview.textContent();
    if (
      !previewText?.includes('2 处') ||
      !previewText?.includes('庄园规则.docx') ||
      !previewText?.includes('封面.png') ||
      !previewText?.includes('另存为 .docx') ||
      !previewText?.includes('1 条只读平台诊断')
    ) {
      throw new Error(`Unexpected comprehensive preview: ${previewText}`);
    }
    await assertNoOverflow('spec18 mobile preview');

    await closeSessionPreview(comprehensiveSheet);
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]:has-text("待配置密钥")');
    await page.click('button:has-text("继续这条故事")');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("抵达东楼密室终点")');
    await page.waitForSelector('[data-testid="turn-diagnostics"]:has-text("CONTENT_FILTER")');
    await assertNoOverflow('spec18 mobile main play');

    // 2. Expand Fork 1 -> rename both branches -> switch to Branch B -> inline BYOK -> continue Branch B
    let storyTreeSheet = await openStoryTree(page);
    const fork1Btn = storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first();
    await fork1Btn.click();
    await storyTreeSheet.getByTestId('story-tree-branches').waitFor();

    const branchASibling = storyTreeSheet.locator('[data-testid^="story-tree-branch-"]', { hasText: '东楼' }).first();
    await branchASibling.locator('button:has-text("重命名")').click();
    await branchASibling.locator('input[aria-label="分支名称"]').fill('银钥东楼线');
    await branchASibling.locator('button:has-text("保存名称")').click();

    const branchBSibling = storyTreeSheet.locator('[data-testid^="story-tree-branch-"]', { hasText: '西塔' }).first();
    await branchBSibling.locator('button:has-text("重命名")').click();
    await branchBSibling.locator('input[aria-label="分支名称"]').fill('毒药西塔线');
    await branchBSibling.locator('button:has-text("保存名称")').click();

    await branchBSibling.locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("抵达西塔终点")');
    await closeStoryTree(page);

    await page.fill('#turn-input', '追查西塔温室');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.waitForSelector('[data-testid="deepseek-setup-wizard"]');
    await page.fill('#byok-api-key', 'sk-spec18-mobile');
    await page.click('[data-testid="wizard-verify-save-btn"]');
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("窄屏续写：追查西塔温室")');

    const promptForB = capturedTurns[capturedTurns.length - 1] ?? '';
    if (!promptForB.includes('事件Y_西塔毒药') || promptForB.includes('事件X_银钥匙') || promptForB.includes('CONTENT_FILTER')) {
      throw new Error(`Branch B prompt contaminated: ${promptForB}`);
    }
    const reviewB = await readActivePlotSummary(page);
    if (!reviewB?.includes('事件Y_西塔毒药') || reviewB.includes('事件X_银钥匙')) {
      throw new Error(`StoryReview on Branch B not isolated: ${reviewB}`);
    }

    // 3. Switch back to Branch A -> lazy summary + continue Branch A -> verify StoryReview & prompt zero Event Y leak
    storyTreeSheet = await openStoryTree(page);
    const fork1AfterB = storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first();
    if ((await fork1AfterB.getAttribute('aria-expanded')) !== 'true') {
      await fork1AfterB.click();
    }
    await storyTreeSheet.locator('[data-testid^="story-tree-branch-"]', { hasText: '银钥东楼线' }).locator('button:has-text("切换至此分支")').click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("抵达东楼密室终点")');
    const reviewSheetA = await openStoryReview(page);
    await reviewSheetA.getByTestId('active-plot-summary').getByText('事件X_银钥匙', { exact: false }).waitFor();
    const reviewA = await reviewSheetA.getByTestId('active-plot-summary').textContent();
    await closeCompanionSheet(page);
    if (!reviewA?.includes('事件X_银钥匙') || reviewA.includes('事件Y_西塔毒药')) {
      throw new Error(`StoryReview on Branch A not isolated: ${reviewA}`);
    }

    await page.fill('#turn-input', '打开东楼密室');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("窄屏续写：打开东楼密室")');

    const promptForA = capturedTurns[capturedTurns.length - 1] ?? '';
    if (!promptForA.includes('事件X_银钥匙') || promptForA.includes('事件Y_西塔毒药')) {
      throw new Error(`Branch A prompt contaminated: ${promptForA}`);
    }

    // 4. Reload browser -> verify IndexedDB restores branch names, active branch A, StoryReview, diagnostics, and zero 390px overflow
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="turn-assistant"]:has-text("窄屏续写：打开东楼密室")');
    const reviewSheetAfterReload = await openStoryReview(page);
    await reviewSheetAfterReload.getByTestId('story-review').getByText('银钥东楼线', { exact: false }).waitFor();
    await reviewSheetAfterReload.getByTestId('active-plot-summary').getByText('事件X_银钥匙', { exact: false }).waitFor();
    await closeCompanionSheet(page);
    await page.waitForSelector('[data-testid="turn-diagnostics"]:has-text("CONTENT_FILTER")');
    storyTreeSheet = await openStoryTree(page);
    await storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first().click();
    await storyTreeSheet.getByTestId('story-tree-branches').getByText('毒药西塔线', { exact: false }).waitFor();
    await assertNoOverflow('spec18 mobile post-reload');
  } finally {
    await mobileCtx.close();
  }
}

const DIAGNOSTICS_CANARIES = [
  'sk-e2e-canary-9988776655443322',
  'my-private-relay.example.com',
  '绝密玩家行动_CANARY',
  '规则附件.docx',
  '合成宫斗测试档',
  '原进度抵达东侧练歌房',
  '第1章 初入星光营',
  '星光训练营规则',
  'SYNTHETIC_BEARER_VALUE',
  'SYNTHETIC_QUERY_VALUE',
  'SYNTHETIC_REASONING_TEXT',
  'SYNTHETIC_SUMMARY_TEXT',
  'SYNTHETIC_BRANCH_NAME',
  'SYNTHETIC_INVALID_ARCHIVE.zip',
  'SYNTHETIC_RENDER_BODY',
  'SYNTHETIC_GLOBAL_ERROR_BODY',
  'SYNTHETIC_REJECTION_BODY',
  'SYNTHETIC_BROKEN_DIAGNOSTIC_CONTEXT',
];

function assertZeroLeak(label, text, canaries = DIAGNOSTICS_CANARIES) {
  if (/"(?:rawScript|reasoningContent|branchNames|branchSummaries|apiKey|title|content)"\s*:/.test(text)) {
    throw new Error(`Diagnostic payload contains a private field in ${label}`);
  }
  for (const canary of canaries) {
    if (text.includes(canary)) {
      throw new Error(`Diagnostic privacy leak in ${label}: found canary ${canary}`);
    }
  }
}

const LONG_SCRIPT = '合成长档剧本_CANARY。' + '剧本片段。'.repeat(2200);
const SETUP_REQUEST = '请按附件规则开局，保留蓝色钥匙_CANARY。';
const OVERSIZED_BEGIN = '超长正文起点_CANARY';
const OVERSIZED_END = '超长正文终点_CANARY';
const LONG_STORY_TITLE = '合成长档原始标题_CANARY';
const LONG_ATTACHMENT = '合成长档匿名附件_CANARY.docx';
const LONG_KEY = 'sk-synthetic-long-fixture-canary';
const LONG_REASONING = '合成长档推理_CANARY';
const LONG_BRANCH_NAME = '合成长档重命名_CANARY';
const LONG_BRANCH_GIST = '合成长档分支梗概_CANARY';
const EARLY_BRANCH_A = '主线早期伏笔_CANARY';
const EARLY_BRANCH_B = '备用线早期伏笔_CANARY';
const SUMMARY_A = '合成长档主线摘要_CANARY';
const SUMMARY_B = '合成长档备用线摘要_CANARY';
const LONG_REPLY = '合成长档当前续写正文_CANARY';

function buildLongSpec24Zip() {
  const docx = zipSync({
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${LONG_SCRIPT}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
  const attachmentPath = `chat_sessions/spec24-session/${LONG_ATTACHMENT}`;
  const timestamp = '2026-11-01T08:00:00Z';
  const messages = [];
  const add = (parent_id, role, fragments) => {
    const id = messages.length + 1;
    const inserted_at = new Date(Date.parse(timestamp) + id * 1000).toISOString();
    messages.push({ id, parent_id, role, fragments, status: 'FINISHED', inserted_at });
    return id;
  };
  const setup = add(null, 'USER', [
    { type: 'FILE', files: [{ file_name: LONG_ATTACHMENT, file_size: docx.length, export_path: attachmentPath }] },
    { type: 'REQUEST', content: SETUP_REQUEST },
  ]);
  const fork = add(setup, 'ASSISTANT', [{ type: 'RESPONSE', content: '从合成线索的分叉处开始。' }]);
  const leaves = [];
  for (const [name, clue] of [['主线', EARLY_BRANCH_A], ['备用线', EARLY_BRANCH_B]]) {
    let parent = fork;
    for (let turn = 1; turn <= 35; turn += 1) {
      const action = turn === 1 ? clue : `${name}：调查第 ${turn} 处合成线索`;
      const reply = name === '主线' && turn === 2
        ? OVERSIZED_BEGIN + '长'.repeat(12000) + OVERSIZED_END
        : `${name}第 ${turn} 轮合成回执`;
      const user = add(parent, 'USER', [{ type: 'REQUEST', content: action }]);
      parent = add(user, 'ASSISTANT', [
        { type: 'THINK', content: LONG_REASONING },
        { type: 'RESPONSE', content: reply },
      ]);
    }
    leaves.push(parent);
  }
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/spec24-session.json': strToU8(JSON.stringify({
      id: 'spec24-session', title: LONG_STORY_TITLE, current_message_id: leaves[0],
      inserted_at: timestamp, updated_at: timestamp, messages,
    })),
    [attachmentPath]: docx,
  });
}

async function runSpec24LongImportE2E(browser, port, viewport) {
  const ctx = await newOfflineContext(browser, port, { viewport });
  const page = await ctx.newPage();
  const requests = [];
  let alternateSelected = false;
  let releaseBranch;
  const branchGate = new Promise((resolve) => { releaseBranch = resolve; });
  try {
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      const { messages } = route.request().postDataJSON();
      const summary = messages[0].content.includes('剧情摘要压缩');
      const gist = messages[0].content.includes('分支梗概助手');
      requests.push({ summary, messages });
      const branchB = alternateSelected;
      if (summary && branchB) {
        await branchGate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{
          delta: { content: summary ? (branchB ? SUMMARY_B : SUMMARY_A) : gist ? LONG_BRANCH_GIST : LONG_REPLY },
          finish_reason: 'stop',
        }] }]),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await startDeepSeekImport(page);
    await page.locator('#deepseek-zip-input').setInputFiles({
      name: 'spec24-long-synthetic.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(buildLongSpec24Zip()),
    });
    await page.getByTestId('ds-session-list').waitFor();
    const { sheet: longPreviewSheet } = await openSessionPreview(page, LONG_STORY_TITLE);
    await closeSessionPreview(longPreviewSheet);
    await page.getByTestId('ds-confirm-import-btn').click();
    await page.getByTestId('deepseek-import-receipt').waitFor();
    await page.getByRole('button', { name: '继续这条故事' }).click();
    await page.locator('[data-testid="turn-assistant"]', { hasText: '主线第 35 轮合成回执' }).waitFor();
    if (requests.length !== 0) throw new Error('Keyless long import made model requests');

    await page.fill('#turn-input', '继续当前主线');
    const submit = page.getByRole('button', { name: '发送行动' });
    await submit.click();
    await completePendingSetup(page, LONG_KEY);
    await page.locator('[data-testid="turn-assistant"][data-node-id]', { hasText: LONG_REPLY }).waitFor();
    const generationAt = requests.findIndex(({ summary }) => !summary);
    const batches = requests.slice(0, generationAt).map(({ messages }) => messages.at(-1).content);
    const continuation = requests[generationAt]?.messages ?? [];
    if (generationAt < 2 || !batches.some((text) => text.includes(EARLY_BRANCH_A)) ||
        !continuation.some(({ role, content }) => role === 'system' && content.includes(SUMMARY_A))) {
      throw new Error('Long first continuation did not wait for multiple catch-up batches covering early history');
    }
    if (!batches.some((text) => text.includes(OVERSIZED_BEGIN)) ||
        !batches.some((text) => text.includes(OVERSIZED_END)) ||
        batches.some((text) => text.includes(OVERSIZED_BEGIN) && text.includes(OVERSIZED_END))) {
      throw new Error('Oversized history node did not reach summary in bounded chunks');
    }
    const inAnchor = continuation[0].role === 'system' && continuation[0].content.includes(LONG_SCRIPT);
    const scriptOccurrences = continuation.map(({ content }) => content).join('\n').split(LONG_SCRIPT).length - 1;
    const outsideAnchor = [...batches, ...continuation.slice(1).map(({ content }) => content)].some((text) =>
      text.includes(LONG_SCRIPT.slice(0, 24)) || text.includes('剧本片段。'.repeat(10)),
    );
    if (!inAnchor || scriptOccurrences !== 1 || outsideAnchor) {
      throw new Error(`Setup Node DOCX anchor mismatch (inAnchor=${inAnchor}, occurrences=${scriptOccurrences}, outsideAnchor=${outsideAnchor})`);
    }
    if (!continuation.some(({ content }) => content.includes(SETUP_REQUEST))) {
      throw new Error('The nonduplicate instruction from the attachment setup was lost');
    }

    await submit.waitFor();
    let storyTreeSheet = await openStoryTree(page);
    const spans = storyTreeSheet.getByTestId('story-tree-span');
    if ((await spans.count()) < 2) throw new Error('Expected the long active route to include a linear span after its fork.');
    const longSpan = spans.nth(1);
    const longSpanToggle = longSpan.getByTestId('story-tree-span-toggle');
    await longSpanToggle.waitFor({ state: 'visible' });
    const spanRange = await longSpan.locator('.badge').textContent();
    const spanRangeMatch = /^第 (\d+)–(\d+) 轮$/.exec(spanRange?.trim() ?? '');
    if (!spanRangeMatch || Number(spanRangeMatch[2]) <= Number(spanRangeMatch[1])) {
      throw new Error(`Expected a multi-turn linear span, got: ${spanRange}`);
    }
    if ((await longSpanToggle.getAttribute('aria-label')) !== `展开${spanRange}连续区间`) {
      throw new Error('Linear span does not provide a descriptive disclosure label.');
    }
    if (await longSpan.getByTestId('story-tree-span-preview').count()) {
      throw new Error('Collapsed linear span rendered node previews before expansion.');
    }
    await longSpanToggle.click();
    if ((await longSpanToggle.getAttribute('aria-expanded')) !== 'true') {
      throw new Error('Expanding a multi-turn linear span did not update its disclosure state.');
    }
    const longSpanPreviews = longSpan.getByTestId('story-tree-span-preview');
    await longSpanPreviews.waitFor({ state: 'visible' });
    const activePathPreviews = await longSpanPreviews.getByTestId('story-tree-span-node').allTextContents();
    if (
      activePathPreviews.length <= 2 ||
      !activePathPreviews.join('\n').includes(EARLY_BRANCH_A) ||
      activePathPreviews.join('\n').includes(EARLY_BRANCH_B) ||
      (await longSpanPreviews.locator('button').count()) !== 0
    ) {
      throw new Error('Expanded span must show read-only previews from the active path only.');
    }
    await longSpanToggle.click();
    if ((await longSpanToggle.getAttribute('aria-expanded')) !== 'false' || await longSpanPreviews.count()) {
      throw new Error('Collapsing a linear span did not hide its node previews.');
    }
    let fork = storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first();
    if ((await fork.getAttribute('aria-expanded')) !== 'true') await fork.click();
    const alternateId = await storyTreeSheet.locator('[data-testid^="story-tree-branch-"]', {
      hasText: '备用线第 35 轮合成回执',
    }).getAttribute('data-testid', { timeout: 5000 });
    let alternate = storyTreeSheet.getByTestId(alternateId);
    const alternateRequestStart = requests.length;
    alternateSelected = true;
    await Promise.all([
      page.waitForRequest((req) => {
        return req.method() === 'POST' &&
          req.url().endsWith('/chat/completions') &&
          req.postDataJSON()?.messages?.[0]?.content.includes('剧情摘要压缩');
      }, { timeout: 10000 }),
      alternate.getByRole('button', { name: '切换至此分支' }).click(),
    ]);
    await storyTreeSheet.getByTestId('companion-summary-progress').waitFor();
    await storyTreeSheet.getByRole('tab', { name: '剧情回顾' }).click();
    await storyTreeSheet.getByTestId('companion-summary-progress').waitFor({ state: 'visible' });
    await storyTreeSheet.getByRole('tab', { name: '剧情树' }).click();
    await page.locator('[data-testid="turn-assistant"][data-node-id]', { hasText: '备用线第 35 轮合成回执' }).waitFor();
    await closeStoryTree(page);
    await page.fill('#turn-input', '等待备用线补算');
    if (!(await submit.isDisabled())) throw new Error('Composer was enabled while branch summary was in flight');
    storyTreeSheet = await openStoryTree(page);
    alternate = storyTreeSheet.getByTestId(alternateId);
    await alternate.getByRole('button', { name: '重命名' }).click({ timeout: 5000 });
    await alternate.getByRole('textbox', { name: '分支名称' }).fill(LONG_BRANCH_NAME);
    await alternate.getByRole('button', { name: '保存名称' }).click();
    await page.getByText(LONG_BRANCH_NAME, { exact: true }).first().waitFor();
    releaseBranch();
    await waitForActivePlotSummary(page, SUMMARY_B);
    const alternateRequests = requests.slice(alternateRequestStart).flatMap(({ messages }) => messages);
    if (!alternateRequests.some(({ content }) => content.includes(EARLY_BRANCH_B)) ||
        alternateRequests.some(({ content }) => content.includes(EARLY_BRANCH_A) || content.includes(SUMMARY_A))) {
      throw new Error('Alternate branch catch-up did not use its own early history in isolation');
    }
    await page.locator('button[aria-label="发送行动"]:enabled').waitFor({ timeout: 5000 });
    await closeStoryTree(page);
    await page.reload({ waitUntil: 'networkidle' });
    const reviewSheetAfterReload = await openStoryReview(page);
    await reviewSheetAfterReload.getByTestId('story-review').getByText(LONG_BRANCH_NAME, { exact: false }).waitFor();
    await reviewSheetAfterReload.getByTestId('active-plot-summary').getByText(SUMMARY_B, { exact: false }).waitFor();
    await closeCompanionSheet(page);
    storyTreeSheet = await openStoryTree(page);
    fork = storyTreeSheet.locator('[data-testid^="story-tree-fork-"]').first();
    if ((await fork.getAttribute('aria-expanded')) !== 'true') await fork.click();
    const renamed = storyTreeSheet.locator('[data-testid^="story-tree-branch-"]', { hasText: LONG_BRANCH_NAME });
    await renamed.getByRole('button', { name: 'AI 提炼梗概' }).click();
    await renamed.getByText(LONG_BRANCH_GIST, { exact: false }).waitFor();
    await closeStoryTree(page);

    await openSettings(page);
    await page.getByTestId('open-diagnostics').click();
    const bundleText = await page.getByTestId('diagnostics-json').textContent();
    const slot = await page.evaluate(() => localStorage.getItem('lfh.diagnostics.v1') ?? '');
    const canaries = [
      LONG_SCRIPT.slice(0, 24), SETUP_REQUEST, OVERSIZED_BEGIN, OVERSIZED_END, LONG_STORY_TITLE, LONG_ATTACHMENT,
      LONG_KEY, LONG_REASONING, LONG_BRANCH_NAME, LONG_BRANCH_GIST, SUMMARY_A, SUMMARY_B, LONG_REPLY,
      EARLY_BRANCH_A, EARLY_BRANCH_B,
    ];
    assertZeroLeak('long-story diagnostic preview', bundleText, canaries);
    assertZeroLeak('long-story diagnostic slot', slot, canaries);
    const bundle = JSON.parse(bundleText);
    if (bundle.activeStorySkeleton?.setupNodeCount !== 1 ||
        bundle.activeStorySkeleton?.branchNamesCount !== 1 ||
        bundle.activeStorySkeleton?.branchGistCount !== 1 ||
        bundle.endpointProfile.host !== 'api.deepseek.com') {
      throw new Error('Long story diagnostic bundle lost topology counts or the official endpoint');
    }
  } finally {
    releaseBranch();
    await ctx.close();
  }
}

async function runDiagnosticsE2E(browser, port, tmpDir, viewport) {
  const ctx = await newOfflineContext(browser, port, { acceptDownloads: true, viewport });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://localhost:${port}`,
  });
  const page = await ctx.newPage();
  try {
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: `401 Bearer SYNTHETIC_BEARER_VALUE https://my-private-relay.example.com/v1?token=SYNTHETIC_QUERY_VALUE ${DIAGNOSTICS_CANARIES.join(' ')}`,
          },
        }),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    // DeepSeek import (success radar) with canary title / attachment names
    const zipPath = path.join(tmpDir, 'spec26-deepseek.zip');
    fs.writeFileSync(zipPath, buildSyntheticDeepSeekZipE2E());
    await startDeepSeekImport(page);
    await page.waitForSelector('#deepseek-zip-input');
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'SYNTHETIC_INVALID_ARCHIVE.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({
        'manifest.json': strToU8(JSON.stringify({ export_format_version: 137 })),
      })),
    });
    await page.getByTestId('import-error').waitFor();
    await page.setInputFiles('#deepseek-zip-input', {
      name: 'SYNTHETIC_MALFORMED_SESSIONS.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({
        'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
        'chat_sessions/SYNTHETIC_MALFORMED_SESSION.json': strToU8('malformed session JSON'),
      })),
    });
    await page.getByTestId('ds-session-empty').waitFor();
    await page.getByTestId('deepseek-import-panel').getByRole('button', { name: '返回' }).click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="deepseek-import-panel"] [role="progressbar"]')?.getAttribute('aria-valuenow') === '1',
    );
    await page.setInputFiles('#deepseek-zip-input', zipPath);
    await page.getByTestId('ds-session-list').waitFor();
    const { sheet: diagnosticPreviewSheet } = await openSessionPreview(page, '合成宫斗测试档');
    await closeSessionPreview(diagnosticPreviewSheet);
    await page.click('[data-testid="ds-confirm-import-btn"]');
    await page.waitForSelector('[data-testid="deepseek-import-receipt"]');

    // Model call fails after key setup. The error body includes a private relay URL to exercise redaction.
    await page.getByRole('button', { name: '继续这条故事' }).click();
    await page.fill('#turn-input', '绝密玩家行动_CANARY');
    await page.getByRole('button', { name: '发送行动' }).click();
    await completePendingSetup(page, 'sk-e2e-canary-9988776655443322');
    await page.getByTestId('main-error-banner').waitFor();

    await page.getByRole('button', { name: '打包排障日志' }).click({ timeout: 5000 });
    await page.waitForSelector('[data-testid="diagnostics-preview"]');
    const previewText = await page.locator('[data-testid="diagnostics-json"]').textContent();
    assertZeroLeak('preview', previewText ?? '');
    for (const needle of ['stream_error', '"statusCode": 401', 'importRadars', '"status": "success"']) {
      if (!previewText?.includes(needle)) {
        throw new Error(`Preview missing ${needle}`);
      }
    }
    const { events, importRadars, activeStorySkeleton, trigger, endpointProfile } = JSON.parse(previewText);
    if (endpointProfile.host !== 'api.deepseek.com') {
      throw new Error('Preview missing the official DeepSeek endpoint');
    }
    if (trigger !== 'error_banner' || activeStorySkeleton?.sourceKind !== 'deepseek_import' ||
        !activeStorySkeleton?.nodes?.length ||
        !activeStorySkeleton.nodes.every((node) => /^n[1-9]\d*$/.test(node.id))) {
      throw new Error('The error-banner bundle is missing its trigger or the default anonymous tree');
    }
    const streamError = events.find((event) => event.action === 'stream_error');
    if (!streamError?.sanitizedMessage?.includes('HTTP 401') ||
        !streamError?.stackTop?.some((frame) => /^sse\.ts:\d+:\d+$/.test(frame)) ||
        !Number.isInteger(streamError?.tsOffsetSec) || 'ts' in streamError) {
      throw new Error('Diagnostic error is missing a safe error summary, stack frame or relative timestamp');
    }
    const failedScan = importRadars.find((radar) => radar.status === 'error' && radar.exportFormatVersion === 137);
    const malformedScan = importRadars.find((radar) => radar.status === 'error' && radar.exportFormatVersion === 3);
    const imported = importRadars.find((radar) => radar.status === 'success');
    if (failedScan?.sourceMode !== 'zip_file' || failedScan?.totalSessions !== 0 ||
        malformedScan?.sourceMode !== 'zip_file' || malformedScan?.totalSessions !== 0 ||
        imported?.sourceMode !== 'zip_file' || imported?.exportFormatVersion !== 3 ||
        imported?.totalSessions !== 2 || imported?.selectedSessions !== 1 ||
        imported?.emptyTitleCount !== 1 || imported?.attachmentExtensions?.['.docx'] !== 1 ||
        !Number.isFinite(failedScan?.durationMs) || !Number.isFinite(imported?.durationMs)) {
      throw new Error('Diagnostic import radar did not describe the failed scan and successful import');
    }
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (scrollWidth > clientWidth) {
      throw new Error(`Diagnostics modal overflow on ${viewport.width}px (${scrollWidth} > ${clientWidth})`);
    }

    const skeletonToggle = page.getByRole('checkbox', { name: /附带当前故事匿名树骨架/ });
    await skeletonToggle.uncheck();
    const withoutSkeleton = await page.getByTestId('diagnostics-json').textContent();
    if ('activeStorySkeleton' in JSON.parse(withoutSkeleton)) {
      throw new Error('Unchecking the skeleton retained it in preview');
    }

    await page.click('button:has-text("复制到剪贴板")');
    await page.waitForSelector('[data-testid="diagnostics-preview"] [role="status"]:has-text("已复制")');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assertZeroLeak('clipboard', clip);
    if (clip !== withoutSkeleton) throw new Error('Clipboard differs from diagnostic preview');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("导出 .json")'),
    ]);
    const exportedPath = path.join(tmpDir, 'spec26-export.json');
    await download.saveAs(exportedPath);
    const exported = fs.readFileSync(exportedPath, 'utf8');
    assertZeroLeak('export file', exported);
    if (exported !== withoutSkeleton) throw new Error('Download differs from diagnostic preview');
    const parsed = JSON.parse(exported);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.events) || parsed.events.length === 0) {
      throw new Error('Exported diagnostic bundle malformed');
    }
    await page.keyboard.press('Escape');
    await page.getByTestId('diagnostics-preview').waitFor({ state: 'detached' });

    // Persisted slot survives reload
    await page.reload({ waitUntil: 'networkidle' });
    await openSettings(page);
    await page.getByTestId('open-diagnostics').click();
    await page.waitForSelector('[data-testid="diagnostics-preview"]');
    const afterReload = await page.locator('[data-testid="diagnostics-json"]').textContent();
    assertZeroLeak('post-reload preview', afterReload ?? '');
    if (!afterReload?.includes('stream_error')) {
      throw new Error('Diagnostics did not survive reload');
    }
    const persisted = await page.evaluate(() => localStorage.getItem('lfh.diagnostics.v1') ?? '');
    assertZeroLeak('persisted slot', persisted);

    await page.goto(`http://localhost:${port}/tests/e2e/crash-fixture.html`);
    await page.getByRole('heading', { name: '合成宫斗测试档' }).waitFor();
    await openSettings(page);
    await page.getByTestId('connected-key-mask').filter({ hasText: /^sk-••••3322$/ }).waitFor();
    await closeSettings(page);
    await page.getByRole('button', { name: '触发测试渲染崩溃' }).click();
    const crashText = await page.getByTestId('diagnostics-json').textContent({ timeout: 5000 });
    const crashBundle = JSON.parse(crashText);
    assertZeroLeak('crash preview', crashText);
    if (crashBundle.trigger !== 'crash_boundary' ||
        crashBundle.endpointProfile.host !== parsed.endpointProfile.host ||
        !crashBundle.activeStorySkeleton?.nodes?.length ||
        !crashBundle.events.some((event) => event.category === 'crash') ||
        !crashBundle.events.some((event) => event.action === 'stream_error')) {
      throw new Error('Crash preview lost active story, endpoint or recorded events');
    }
    if (await page.evaluate(() => navigator.clipboard.readText()) !== clip) {
      throw new Error('Crash recovery wrote to the clipboard before preview confirmation');
    }
    await page.getByTestId('diagnostics-preview').getByRole('button', { name: '重新载入界面' }).waitFor();
    await page.getByRole('button', { name: '复制到剪贴板' }).click();
    await page.getByTestId('diagnostics-preview').getByRole('status').waitFor();
    if (await page.evaluate(() => navigator.clipboard.readText()) !== crashText) {
      throw new Error('Copied crash log differs from preview');
    }
    const crashDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 .json' }).click();
    const crashDownload = await crashDownloadPromise;
    const crashExport = fs.readFileSync(await crashDownload.path(), 'utf8');
    assertZeroLeak('crash download', crashExport);
    if (crashExport !== crashText) throw new Error('Crash download differs from preview');
    const crashSlot = await page.evaluate(() => localStorage.getItem('lfh.diagnostics.v1') ?? '');
    assertZeroLeak('crash slot', crashSlot);
    if (!JSON.parse(crashSlot).events.some((event) => event.category === 'crash')) {
      throw new Error('Crash breadcrumb was not written into the persistent slot');
    }

    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      page.getByTestId('diagnostics-preview').getByRole('button', { name: '重新载入界面' }).click(),
    ]);
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '合成宫斗测试档' }).waitFor();
    await openSettings(page);
    await page.getByTestId('open-diagnostics').click();
    const recoveredText = await page.getByTestId('diagnostics-json').textContent();
    assertZeroLeak('recovered crash report', recoveredText);
    const recovered = JSON.parse(recoveredText);
    const initialCrashCount = recovered.events.filter((event) => event.category === 'crash').length;
    if (recovered.trigger !== 'settings_manual' || initialCrashCount === 0) {
      throw new Error('Crash record did not survive reload');
    }
    const [recoveredDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('diagnostics-preview').getByRole('button', { name: '导出 .json' }).click(),
    ]);
    const recoveredExport = fs.readFileSync(await recoveredDownload.path(), 'utf8');
    assertZeroLeak('recovered crash export', recoveredExport);
    if (recoveredExport !== recoveredText) throw new Error('Post-reload export differs from preview');
    await page.keyboard.press('Escape');

    for (const [index, kind] of ['error', 'rejection'].entries()) {
      await page.evaluate((type) => {
        if (type === 'error') {
          setTimeout(() => { throw new Error('SYNTHETIC_GLOBAL_ERROR_BODY'); }, 0);
        } else {
          void Promise.reject(new Error('SYNTHETIC_REJECTION_BODY'));
        }
      }, kind);
      const text = await page.getByTestId('diagnostics-json').textContent({ timeout: 5000 });
      assertZeroLeak(`global ${kind} preview`, text);
      const bundle = JSON.parse(text);
      const crashCount = bundle.events.filter((event) => event.category === 'crash').length;
      if (bundle.trigger !== 'crash_boundary' || crashCount <= initialCrashCount + index) {
        throw new Error(`Global ${kind} did not add a persisted crash record`);
      }
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        page.getByTestId('diagnostics-preview').getByRole('button', { name: '重新载入界面' }).click(),
      ]);
      await page.waitForLoadState('networkidle');
      await openSettings(page);
      await page.getByTestId('open-diagnostics').waitFor();
    }

    await page.goto(`http://localhost:${port}/tests/e2e/crash-fixture.html`);
    await page.getByRole('heading', { name: '合成宫斗测试档' }).waitFor();
    await page.getByRole('button', { name: '触发损坏诊断上下文的崩溃' }).click();
    const fallbackText = await page.getByTestId('diagnostics-json').textContent({ timeout: 5000 });
    assertZeroLeak('crash preview with unavailable story context', fallbackText);
    const fallback = JSON.parse(fallbackText);
    if (fallback.trigger !== 'crash_boundary' ||
        !fallback.events.some((event) => event.category === 'crash')) {
      throw new Error('Recovery cannot export recorded crashes when story context is unavailable');
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
