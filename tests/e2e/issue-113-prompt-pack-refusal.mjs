const ROUTE_REPLY = `\`\`\`lfh-route
mode: story
title: 雨夜提示词包测试
---
# 雨夜提示词包测试

这是一座被雨声包围的旧城。
\`\`\`

雨声落在青石板上，你站在尚未熄灯的巷口。

\`\`\`lfh-summary
雨夜故事开场，主角停在巷口。
\`\`\``;

const PACK_HEAD = 'ISSUE133_PACK_HEAD_CANARY：保持克制、具体、连续的虚构叙事。';
const PACK_MID = 'ISSUE133_PACK_MID_CANARY：多写动作、对白与感官细节。';
const PACK_TAIL = 'ISSUE133_PACK_TAIL_CANARY：紧接当前场景继续写。';
const RECOVERED_REPLY = '雨停之后，巷口的灯一盏盏亮起来，她把伞递到你手里，示意你继续往里走。\n\n```lfh-summary\n雨势渐停，两人沿巷继续前行。\n```';
const PARTIAL_REPLY = '雨声压低了屋檐，她把杯子推到你面前，目光停了一瞬。抱歉，我不能继续写更具体的内容。\n\n```lfh-summary\n雨夜对话继续推进，气氛变得紧张。\n```';
const CONTINUATION = '\n\n门轴轻响，她先一步走进里屋，桌上的灯把两个人的影子拉得很长。';
const WRITING_RECOVERED_REPLY = '她把雨衣挂在门后，指尖沿着旧稿纸的折痕慢慢抚平，重新落下一行字。\n\n```lfh-summary\n写故事模式重试后继续构思。\n```';

function jsonDelta(content, finishReason = null) {
  return {
    choices: [{
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  };
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function createGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(`Issue #133 horizontal overflow on ${label}: ${metrics.scrollWidth} > ${metrics.clientWidth}`);
  }
}

export async function runIssue113PromptPackRefusalE2E(browser, port, helpers) {
  const {
    newOfflineContext,
    mockSuccessfulKeyVerification,
    sseResponse,
    openSettings,
    closeSettings,
  } = helpers;
  const context = await newOfflineContext(browser, port, { acceptDownloads: true });
  const page = await context.newPage();
  const refusalAttempts = new Map();
  const recoverTrace = [];
  const creativeRecoverTrace = [];
  let partialContinueAttempt = 0;
  let stableRequests = 0;
  let betaRequests = 0;
  let lastStableBody = null;
  let lastBetaBody = null;

  const recoverRetryArrived = createGate();
  const recoverRetryRelease = createGate();
  const creativeRetryArrived = createGate();
  const creativeRetryRelease = createGate();

  try {
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isBeta = url.pathname.includes('/beta/chat/completions');
      const body = JSON.parse(request.postData() || '{}');
      const last = body.messages?.at(-1);
      const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
      const lastAssistant = last?.role === 'assistant' ? last.content || '' : '';
      if (isBeta) betaRequests += 1;
      else {
        stableRequests += 1;
        lastStableBody = body;
      }
      if (isBeta) lastBetaBody = body;

      if (lastAssistant.includes('雨声压低了屋檐')) {
        partialContinueAttempt += 1;
        const nextText = partialContinueAttempt === 1
          ? `${lastAssistant}\n\n抱歉，我不能继续写这段内容。`
          : `${lastAssistant}${CONTINUATION}`;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([jsonDelta(nextText, 'stop')]),
        });
        return;
      }

      if (lastUser.includes('短拒答恢复测试')) {
        const attempt = (refusalAttempts.get('recover') || 0) + 1;
        refusalAttempts.set('recover', attempt);
        recoverTrace.push({
          attempt,
          isBeta,
          hasPrefix: Boolean(last?.prefix),
        });
        if (attempt === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: sseResponse([jsonDelta('抱歉，我不能帮你写这段内容。', 'stop')]),
          });
          return;
        }
        recoverRetryArrived.release();
        await recoverRetryRelease.promise;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([jsonDelta(RECOVERED_REPLY, 'stop')]),
        });
        return;
      }

      if (lastUser.includes('写故事模式拒答恢复测试')) {
        const attempt = (refusalAttempts.get('writing_recover') || 0) + 1;
        refusalAttempts.set('writing_recover', attempt);
        creativeRecoverTrace.push({
          attempt,
          isBeta,
          hasPrefix: Boolean(last?.prefix),
        });
        if (attempt === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: sseResponse([jsonDelta('抱歉，我不能帮你写这段内容。', 'stop')]),
          });
          return;
        }
        creativeRetryArrived.release();
        await creativeRetryRelease.promise;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([jsonDelta(WRITING_RECOVERED_REPLY, 'stop')]),
        });
        return;
      }

      if (lastUser.includes('耗尽测试')) {
        const attempt = (refusalAttempts.get('exhaust') || 0) + 1;
        refusalAttempts.set('exhaust', attempt);
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([jsonDelta('抱歉，我不能帮你写这段内容。', 'stop')]),
        });
        return;
      }

      if (lastUser.includes('半拒绝追要测试')) {
        const attempt = (refusalAttempts.get('partial') || 0) + 1;
        refusalAttempts.set('partial', attempt);
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([jsonDelta(PARTIAL_REPLY, 'stop')]),
        });
        return;
      }

      if (lastUser.includes('覆盖测试')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            jsonDelta('她把门推开一条缝，示意你先听屋里的动静。\n\n```lfh-summary\n覆盖测试正常推进。\n```', 'stop'),
          ]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([jsonDelta(ROUTE_REPLY, 'stop')]),
      });
    });

    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
    await openSettings(page);
    let settings = page.getByTestId('settings-page');
    const connect = settings.getByTestId('open-setup-wizard-btn');
    if (await connect.isVisible().catch(() => false)) {
      await connect.click();
      const wizard = page.getByTestId('deepseek-setup-wizard');
      await wizard.locator('#byok-api-key').fill('sk-e2e-issue133');
      await wizard.getByTestId('wizard-verify-save-btn').click();
      await wizard.waitFor({ state: 'detached' });
    }
    await closeSettings(page);
    await page.fill('#turn-input', '我想玩一个雨夜侦探故事');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByRole('heading', { name: '雨夜提示词包测试' }).waitFor();
    await openSettings(page);
    settings = page.getByTestId('settings-page');

    const promptSection = settings.getByTestId('settings-prompt-pack-section');
    await promptSection.waitFor({ state: 'visible' });
    if (!(await promptSection.textContent()).includes('叙事提示词包与拒答治理')) {
      throw new Error('Prompt pack settings section title missing.');
    }
    const disclaimerClass = await promptSection.getByTestId('prompt-pack-disclaimer').getAttribute('class');
    if (!disclaimerClass?.includes('banner-alert-warning')) {
      throw new Error(`Expected BannerAlert warning on prompt-pack-disclaimer, got: ${disclaimerClass}`);
    }

    await promptSection.getByTestId('prompt-pack-import-input').setInputFiles({
      name: 'issue133-unmarked.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(PACK_HEAD, 'utf8'),
    });
    const headSlot = promptSection.getByTestId('prompt-pack-slot-head');
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="prompt-pack-slot-head"]')?.value === expected,
      PACK_HEAD,
    );
    await promptSection.getByTestId('prompt-pack-slot-mid').fill(PACK_MID);
    await promptSection.getByTestId('prompt-pack-slot-tail').fill(PACK_TAIL);
    await promptSection.getByTestId('prompt-pack-save').click();
    await promptSection.getByTestId('prompt-pack-tail-always').check();

    const defaultPrefix = await promptSection.getByTestId('prompt-pack-global-prefix').inputValue();
    if (defaultPrefix !== 'on_retry') {
      throw new Error(`Expected default global prefix mode on_retry, got: ${defaultPrefix}`);
    }

    // Verify disabling preserves selected pack + unsaved drafts, uses compliant wording,
    // and re-enabling restores the previously selected pack rather than forcing builtin.
    const unsavedDraft = `${PACK_HEAD}\n未保存草稿验证`;
    await headSlot.fill(unsavedDraft);
    await promptSection.getByTestId('prompt-pack-enable-toggle').click();
    const disabledSectionText = await promptSection.textContent();
    if (
      !disabledSectionText?.includes('默认提示词包已停用') ||
      !disabledSectionText?.includes('已停用默认提示词包。') ||
      disabledSectionText.includes('全局提示词')
    ) {
      throw new Error(`Prompt pack disabled copy failed glossary check: ${disabledSectionText}`);
    }
    if ((await headSlot.inputValue()) !== unsavedDraft) {
      throw new Error('Disabling prompt pack reset unsaved head draft.');
    }
    await promptSection.getByTestId('prompt-pack-enable-toggle').click();
    const reenabledStatus = await promptSection.getByTestId('prompt-pack-status').textContent();
    if (!reenabledStatus?.includes('已启用「issue133-unmarked」')) {
      throw new Error(`Re-enabling prompt pack did not restore previously selected pack: ${reenabledStatus}`);
    }
    if ((await headSlot.inputValue()) !== unsavedDraft) {
      throw new Error('Re-enabling prompt pack reset unsaved head draft.');
    }

    // > 12000 char soft warning keeps save enabled
    await headSlot.fill('甲'.repeat(12001));
    if (!(await promptSection.getByTestId('prompt-pack-budget').textContent()).includes('已超过 12000 字软提示')) {
      throw new Error('Prompt pack > 12000 char soft warning did not render.');
    }
    if (await promptSection.getByTestId('prompt-pack-save').isDisabled()) {
      throw new Error('Prompt pack save was unexpectedly disabled on > 12000 char soft warning.');
    }

    // > 24000 char hard limit blocks save
    await headSlot.fill('甲'.repeat(24001));
    if (!(await promptSection.getByTestId('prompt-pack-save').isDisabled())) {
      throw new Error('Prompt pack save stayed enabled after the head hard limit was exceeded.');
    }
    if (!(await promptSection.getByTestId('prompt-pack-budget').textContent()).includes('24000')) {
      throw new Error('Prompt pack hard-limit feedback did not name the 24000-character head limit.');
    }
    await headSlot.fill(PACK_HEAD);
    await promptSection.getByTestId('prompt-pack-save').click();
    await closeSettings(page);

    const stableBeforeOverride = stableRequests;
    const betaBeforeOverride = betaRequests;
    const promptPackSelect = page.getByTestId('generation-pref-prompt-pack');
    const prefixSelect = page.getByTestId('generation-pref-prefix-mode');
    await promptPackSelect.selectOption('off');
    await prefixSelect.selectOption('off');
    await page.fill('#turn-input', '覆盖测试：先关闭故事级提示词包');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByTestId('turn-assistant').last().getByText('她把门推开一条缝').waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="停止生成"]'));
    if (stableRequests !== stableBeforeOverride + 1 || betaRequests !== betaBeforeOverride) {
      throw new Error(`Story-level off override did not use the stable endpoint (stable ${stableBeforeOverride}->${stableRequests}, beta ${betaBeforeOverride}->${betaRequests}).`);
    }
    if (!lastStableBody || JSON.stringify(lastStableBody).includes('ISSUE133_PACK_HEAD_CANARY')) {
      throw new Error('Story-level prompt-pack off override still sent the imported pack head.');
    }

    // Keep default on_retry mode for 短拒答恢复测试
    await promptPackSelect.selectOption({ label: 'issue133-unmarked' });
    await prefixSelect.selectOption('inherit');
    await page.evaluate(() => {
      window.__lfhRefusalFlashed = false;
      const root = document.querySelector('[data-testid="story-timeline"]') || document.body;
      const observer = new MutationObserver(() => {
        if (root.textContent?.includes('抱歉，我不能帮你写这段内容。')) {
          window.__lfhRefusalFlashed = true;
        }
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      window.__lfhRefusalObserver = observer;
    });

    await page.fill('#turn-input', '短拒答恢复测试');
    await page.getByRole('button', { name: '发送行动' }).click();

    await recoverRetryArrived.promise;
    if (recoverTrace.length < 2) {
      throw new Error(`Expected 2 attempts for 短拒答恢复测试, got ${recoverTrace.length}`);
    }
    if (recoverTrace[0].isBeta || recoverTrace[0].hasPrefix) {
      throw new Error(`First attempt should hit stable /chat/completions without prefix, got: ${JSON.stringify(recoverTrace[0])}`);
    }
    if (!recoverTrace[1].isBeta || !recoverTrace[1].hasPrefix) {
      throw new Error(`Retry attempt should hit /beta/chat/completions with prefix: true, got: ${JSON.stringify(recoverTrace[1])}`);
    }

    await page.getByTestId('story-timeline').getByText('正在重新构思落笔…').waitFor();
    const flashedDuringWindow = await page.evaluate(() => {
      window.__lfhRefusalObserver?.disconnect();
      return window.__lfhRefusalFlashed;
    });
    if (flashedDuringWindow || (await page.getByTestId('story-timeline').getByText('抱歉，我不能帮你写这段内容。').count()) > 0) {
      throw new Error('First-pass refusal text flashed during the 120-char observation window.');
    }

    recoverRetryRelease.release();
    await page.getByTestId('turn-refusal-recovered-badge').waitFor();
    await page.getByTestId('turn-assistant').last().getByText('雨停之后，巷口的灯一盏盏亮起来').waitFor();
    await page.getByTestId('turn-refusal-restore-original').click();
    await page.getByTestId('turn-assistant').last().getByText('抱歉，我不能帮你写这段内容。').waitFor();

    // Verify restored original refusal text persists across page reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '雨夜提示词包测试' }).waitFor();
    await page.getByTestId('story-timeline').getByText('抱歉，我不能帮你写这段内容。').waitFor();

    await page.fill('#turn-input', '耗尽测试');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByTestId('turn-assistant').last().getByText('本轮生成未通过模型的安全策略').waitFor();
    await page.getByTestId('open-story-tree').click();
    const refusalDiag = page.getByTestId('story-tree-diag-refusal');
    await refusalDiag.waitFor();
    if ((await refusalDiag.count()) !== 1) {
      throw new Error(`Expected 1 story-tree-diag-refusal before expanding span, got ${await refusalDiag.count()}`);
    }
    const refusalSpan = page.getByTestId('story-tree-span').filter({ has: refusalDiag }).first();
    await refusalSpan.getByTestId('story-tree-span-toggle').click();
    await refusalSpan.getByTestId('story-tree-span-preview').waitFor();
    if ((await page.getByTestId('story-tree-diag-refusal').count()) !== 1) {
      throw new Error(`Expanded span emitted duplicate story-tree-diag-refusal (${await page.getByTestId('story-tree-diag-refusal').count()})`);
    }
    await page.keyboard.press('Escape');

    await page.fill('#turn-input', '半拒绝追要测试');
    await page.getByRole('button', { name: '发送行动' }).click();
    const partialTurn = page.getByTestId('turn-assistant').last();
    await partialTurn.getByTestId('turn-partial-refusal-banner').waitFor();
    if (!(await partialTurn.textContent()).includes('雨声压低了屋檐')) {
      throw new Error('Partial refusal did not preserve delivered prose.');
    }

    // Failed partial_refused continuation must preserve original prose without false recovered badge
    await partialTurn.getByTestId('turn-partial-refusal-continue').click();
    await page.getByText('追要未获得新的有效正文，已保留原有内容，请稍后再试。').waitFor();
    if (!(await partialTurn.textContent()).includes('雨声压低了屋檐')) {
      throw new Error('Failed partial-refusal continuation lost original prose.');
    }
    if ((await partialTurn.getByTestId('turn-refusal-recovered-badge').count()) !== 0) {
      throw new Error('Failed partial-refusal continuation emitted a false recovered badge.');
    }
    await partialTurn.getByTestId('turn-partial-refusal-continue').waitFor();

    // Second continuation succeeds
    await partialTurn.getByTestId('turn-partial-refusal-continue').click();
    await page.getByText('门轴轻响，她先一步走进里屋').waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="停止生成"]'));
    if (await partialTurn.getByTestId('turn-partial-refusal-banner').isVisible().catch(() => false)) {
      throw new Error('Partial-refusal banner remained after a successful continuation.');
    }

    // Validate Writing mode refusal retry end-to-end (useCreativeReply 5th-arg refusalOptions fix)
    await page.getByTestId('topbar-mode-switcher').click();
    await page.getByTestId('topbar-mode-option-writing').click();
    const writingPage = page.getByTestId('writing-page');
    await writingPage.waitFor();
    await writingPage.locator('#writing-discussion-input').fill('写故事模式拒答恢复测试');
    await writingPage.getByRole('button', { name: '发送', exact: true }).click();
    await creativeRetryArrived.promise;
    if (creativeRecoverTrace.length < 2 || creativeRecoverTrace[0].isBeta || !creativeRecoverTrace[1].isBeta || !creativeRecoverTrace[1].hasPrefix) {
      throw new Error(`Writing mode refusal retry trace invalid: ${JSON.stringify(creativeRecoverTrace)}`);
    }
    await writingPage.getByText('正在重新构思落笔…').waitFor();
    if ((await writingPage.locator('.turn-streaming').getByText('抱歉，我不能帮你写这段内容。').count()) > 0) {
      throw new Error('Writing mode flashed first-pass refusal text during the observation window.');
    }
    creativeRetryRelease.release();
    await writingPage.getByTestId('turn-assistant').last().getByTestId('turn-refusal-recovered-badge').waitFor();
    await writingPage.getByTestId('turn-assistant').last().getByText('她把雨衣挂在门后').waitFor();

    if (stableRequests < 3 || betaRequests < 5) {
      throw new Error(`Expected stable and /beta requests, got stable=${stableRequests}, beta=${betaRequests}`);
    }
    if (!lastBetaBody?.messages?.at(-1)?.prefix) {
      throw new Error('The last /beta request did not end with an assistant prefix message.');
    }

    await openSettings(page);
    await page.getByTestId('settings-page').getByTestId('prompt-pack-global-prefix').selectOption('always');
    await closeSettings(page);

    const themeIds = ['light', 'dark', 'warm'];
    for (const theme of themeIds) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        await openSettings(page);
        const currentSettings = page.getByTestId('settings-page');
        await currentSettings.getByTestId(`theme-option-${theme}`).click();
        await currentSettings.getByTestId('settings-prompt-pack-section').scrollIntoViewIfNeeded();
        await assertNoHorizontalOverflow(page, `prompt-pack ${theme} ${viewport.width}x${viewport.height}`);
        await closeSettings(page);
        await assertNoHorizontalOverflow(page, `story ${theme} ${viewport.width}x${viewport.height}`);
      }
    }

    const persistent = await page.evaluate(() => localStorage.getItem('lfh.prompt_packs.v1') || '');
    if (
      countOccurrences(persistent, 'issue133-unmarked') !== 1 ||
      !persistent.includes('"defaultPrefixCompletion":"always"') ||
      !persistent.includes('"includeTail":true')
    ) {
      throw new Error('Prompt-pack library or global defaults did not persist to localStorage.');
    }

    console.log('ISSUE_113_PROMPT_PACK_REFUSAL_E2E_PASSED');
  } finally {
    await context.close();
  }
}
