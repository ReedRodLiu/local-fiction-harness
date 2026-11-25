import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fence = '\x60'.repeat(3);
const routeReply = ({ mode, title, characterName, settingMarkdown = '', body }) => [
  `${fence}lfh-route`,
  `mode: ${mode}`,
  ...(title ? [`title: ${title}`] : []),
  ...(characterName ? [`character_name: ${characterName}`] : []),
  '---',
  settingMarkdown,
  fence,
  body,
].join('\n');

const proposalV2 = ({ target, op = 'full', summary, name, body }) => [
  `${fence}lfh-proposal`,
  `target: ${target}`,
  `op: ${op}`,
  `summary: ${summary}`,
  ...(name ? [`name: ${name}`] : []),
  '---',
  body,
  fence,
].join('\n');

const sevenColumnTable = [
  '| 姓名 | 外貌 | 性格 | 身份 | 能力 | 主要事件 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| 沈砚秋 | 眉骨有一道旧伤，左眼在阴天会轻微发红 | 寡言但判断很快，遇到陌生人的承诺总会先记下来 | 南巡营旧档管理员，如今负责遗失行李的登记与归还 | 能凭脚步声分辨来客是否走过月台尽头的碎石路 | 曾在雪夜打开停运多年的候车室，并独自守到天亮 | 随身带着一枚没有编号的铜钥匙 |',
].join('\n');

const sevenColumnSettingMarkdown = [
  '## 作品设定',
  '',
  '废弃的纸月车站收到一件无人承认的行李。',
  '',
  sevenColumnTable,
].join('\n');

const sevenColumnMessageMarkdown = [
  '废弃的纸月车站收到一件无人承认的行李。',
  '',
  '### 人物表速览',
  '',
  sevenColumnTable,
  '',
  '### 常规表',
  '',
  '| 项目 | 内容 |',
  '| --- | --- |',
  '| 状态 | 可读 |',
].join('\n');

async function assertReadableSevenColumnTable(scope, label, { checkEditEntry = false } = {}) {
  const wrap = scope.locator('.md-table-wrap').first();
  await wrap.waitFor();
  const metrics = await wrap.evaluate((element) => {
    const sheet = element.closest('dialog');
    const headers = [...element.querySelectorAll('th')].map((cell) => cell.getBoundingClientRect());
    const cells = [...element.querySelectorAll('td')].map((cell) => cell.getBoundingClientRect());
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      wrapperWidth: element.clientWidth,
      wrapperScrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      headerWidths: headers.map((rect) => rect.width),
      cellWidths: cells.map((rect) => rect.width),
      sheetLeft: sheet?.getBoundingClientRect().left ?? 0,
      sheetRight: sheet?.getBoundingClientRect().right ?? 0,
    };
  });

  assert.equal(metrics.documentWidth, metrics.viewportWidth, `${label}: page overflowed at ${metrics.viewportWidth}px`);
  assert.ok(metrics.sheetLeft >= -1, `${label}: dialog started outside the viewport`);
  assert.ok(metrics.sheetRight <= metrics.viewportWidth + 1, `${label}: dialog exceeded the viewport`);
  assert.match(metrics.overflowX, /auto|scroll/, `${label}: table wrapper must own horizontal scrolling`);
  assert.ok(metrics.wrapperScrollWidth > metrics.wrapperWidth,
    `${label}: seven-column table did not overflow inside its wrapper (${JSON.stringify(metrics)})`);
  assert.ok(Math.min(...metrics.headerWidths) >= 70, `${label}: a header column became unreadably narrow`);
  assert.ok(Math.min(...metrics.cellWidths) >= 70, `${label}: a data column became unreadably narrow`);

  await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const lastHeader = await wrap.locator('th').last().boundingBox();
  const wrapperBox = await wrap.boundingBox();
  assert.ok(lastHeader && wrapperBox, `${label}: missing table geometry`);
  assert.ok(lastHeader.x >= wrapperBox.x - 1, `${label}: last column could not be scrolled into view`);
  assert.ok(lastHeader.x + lastHeader.width <= wrapperBox.x + wrapperBox.width + 1,
    `${label}: last column remained clipped after scrolling`);

  if (checkEditEntry) {
    const editEntry = scope.getByTestId('edit-writing-setting-btn');
    await editEntry.scrollIntoViewIfNeeded();
    assert.equal(await editEntry.isVisible(), true, `${label}: edit entry became inaccessible`);
  }
}

async function assertNormalWidthTable(scope, label) {
  const wrap = scope.locator('.md-table-wrap').last();
  const layout = await wrap.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1,
    `${label}: normal-width table unexpectedly scrolled horizontally (${JSON.stringify(layout)})`);
}

export async function verifyInactiveStoryReload(browser, port, helpers) {
  const {
    newOfflineContext,
    mockSuccessfulKeyVerification,
    completePendingSetup,
    sseResponse,
    startScriptImport,
    holdNextStoryStorageCommit,
    releaseHeldStoryStorageCommit,
  } = helpers;

  const readActiveSelection = (page) => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('local-fiction-harness');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const entry = await new Promise((resolve, reject) => {
      const request = db.transaction('meta').objectStore('meta').get('activeStoryId');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { present: Boolean(entry), id: entry?.value ?? null };
  });

  const waitForExplicitInactiveStory = (page) => page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('local-fiction-harness');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const entry = await new Promise((resolve, reject) => {
      const request = db.transaction('meta').objectStore('meta').get('activeStoryId');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Boolean(entry) && entry.value === null;
  });

  const assertWelcome = async (page, title) => {
    const welcome = page.getByTestId('welcome-view');
    await welcome.waitFor();
    assert.equal(await page.getByTestId('app-topbar').getByRole('heading', { name: title, exact: true }).count(), 0);
  };

  for (const [overlay, overlayLabel, openOverlay, overlayTestId] of [
    ['settings', '设置', (page) => page.getByTestId('desktop-settings-open').click(), 'settings-page'],
    ['import', '导入', (page) => startScriptImport(page), 'import-panel'],
  ]) {
    const context = await newOfflineContext(browser, port, { viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await mockSuccessfulKeyVerification(page);
      await page.route('**/chat/completions', async (route) => {
        const messages = route.request().postDataJSON().messages;
        const input = messages.at(-1)?.content ?? '';
        const titleMatch = /^(显式无激活[^\s。]+)/.exec(input);
        const title = titleMatch?.[1] ?? '新故事';
        const content = routeReply({
          mode: 'story',
          title,
          settingMarkdown: `## 故事设定\n${input}`,
          body: '第一幕：门铃轻响。',
        });
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]),
        });
      });

      await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
      await page.getByTestId('welcome-view').waitFor();
      assert.deepEqual(await readActiveSelection(page), { present: false, id: null });

      await page.getByTestId('welcome-key-hint').click();
      await completePendingSetup(page, 'sk-inactive-fixture');

      const title = `显式无激活${overlayLabel}`;
      await page.fill('#turn-input', `${title}。开启互动文游`);
      await holdNextStoryStorageCommit(page, 'meta');
      await page.getByRole('button', { name: '发送行动', exact: true }).click();
      const row = page.getByTestId('desktop-library').getByTestId('story-list-item').filter({ hasText: title });
      await Promise.all([
        row.waitFor({ state: 'attached' }),
        page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function'),
      ]);

      await openOverlay(page);
      const overlayView = page.getByTestId(overlayTestId);
      await overlayView.waitFor();
      await releaseHeldStoryStorageCommit(page);
      await waitForExplicitInactiveStory(page);
      assert.deepEqual(await readActiveSelection(page), { present: true, id: null });
      assert.equal(await overlayView.isVisible(), true, `${overlay} should remain open after the stale activation`);

      await overlayView.getByRole('button', { name: '返回', exact: true }).click();
      await assertWelcome(page, title);
      await page.reload({ waitUntil: 'networkidle' });
      await assertWelcome(page, title);
      assert.deepEqual(await readActiveSelection(page), { present: true, id: null });
    } finally {
      await context.close();
    }
  }
}

export async function verifyThreeModes(browser, port, helpers) {
  const {
    newOfflineContext,
    mockSuccessfulKeyVerification,
    completePendingSetup,
    sseResponse,
    startScriptImport,
    holdNextStoryStorageCommit,
    releaseHeldStoryStorageCommit,
  } = helpers;
  const context = await newOfflineContext(browser, port, { acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const requests = [];
    let failOpening = true;
    let releaseStoryResponse;
    let storyResponseStarted;
    const storyResponsePending = new Promise((resolve) => { storyResponseStarted = resolve; });
    const storyResponseRelease = new Promise((resolve) => { releaseStoryResponse = resolve; });
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      const messages = route.request().postDataJSON().messages;
      requests.push(messages);
      const sys = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const input = messages.at(-1)?.content ?? '';

      if (sys.includes('自然语言第一入口助手')) {
        let content = '';
        if (input.includes('有点犹豫')) {
          content = routeReply({
            mode: 'ambiguous',
            body: '随时都可以！你想玩文字冒险、一起写小说，还是找个角色聊聊？',
          });
        } else if (input.includes('纸月车站')) {
          if (failOpening) {
            failOpening = false;
            await route.fulfill({ status: 500, body: 'synthetic routing failure' });
            return;
          }
          content = routeReply({
            mode: 'writing',
            title: '纸月车站',
            settingMarkdown: sevenColumnSettingMarkdown,
            body: sevenColumnMessageMarkdown,
          });
        } else if (input.includes('岑灯')) {
          content = routeReply({
            mode: 'character',
            title: '岑灯',
            characterName: '岑灯',
            settingMarkdown: '## 角色设定\n名称：岑灯\n退役夜航员，寡言。PERSONA-UNIQUE',
            body: '岑灯推开码头边的窗。',
          });
        } else {
          const titleMatch = /^([^\s。]+)/.exec(input);
          content = routeReply({
            mode: 'story',
            title: titleMatch?.[1] ?? '新文游',
            settingMarkdown: `## 故事设定\n${input}`,
            body: '故事开场：风声穿过廊桥。',
          });
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            { choices: [{ delta: { content: content.slice(0, 16) } }] },
            { choices: [{ delta: { content: content.slice(16) }, finish_reason: 'stop' }] },
          ]),
        });
        return;
      }

      if (sys.includes('正文稿纸界面')) {
        let content = `接着写：${input}`;
        if (input.includes('节奏是不是太快')) {
          content = `${fence}lfh-manuscript-intent\nintent: chat\n${fence}\n节奏刚好，可以在钟响后补写一句环境细节。`;
        } else if (input.includes('接着写一小段')) {
          content = `已为你续写下一段：\n${proposalV2({
            target: 'manuscript',
            op: 'append',
            summary: '续写第三声钟响段落',
            body: '第三声钟响，船离岸了。',
          })}`;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]),
        });
        return;
      }

      if (input.includes('敲钟')) {
        storyResponseStarted();
        await storyResponseRelease;
      }

      let content = `接续：${input}`;
      if (input.includes('保存我的记忆')) {
        content = `请确认这条记忆更新。\n${proposalV2({
          target: 'memory',
          op: 'append',
          summary: '记住今后偏好短句风格',
          body: '仅用短句。PUBLIC-LATEST',
        })}`;
      } else if (input.includes('带入文游人设')) {
        content = `已为你草拟新角色。\n${proposalV2({
          target: 'character',
          op: 'full',
          summary: '根据渡口故事建立角色「收灯人」',
          name: '收灯人',
          body: '渡口的收灯人。SOURCE-COPY',
        })}`;
      } else if (input.includes('总结存入')) {
        content = `我整理了一段开书设定。\n${proposalV2({
          target: 'setting',
          op: 'append',
          summary: '补充失物招领员背景',
          body: '## 开书讨论\n失物招领员认出了自己的旧行李。',
        })}`;
      } else if (input.includes('试写一段车站开头')) {
        content = `月台灯柱下只剩一只褪色皮箱，风吹过铁轨发出轻响。\n\n${proposalV2({
          target: 'manuscript',
          op: 'append',
          summary: '将车站开头段落写入作品正文',
          body: '月台灯柱下只剩一只褪色皮箱，风吹过铁轨发出轻响。',
        })}`;
      } else if (input.includes('断尾提案')) {
        content = `我刚整理到一半：\n${fence}lfh-proposal\ntarget: setting\nop: append\nsummary: 未闭合提案\n---\n这条设定提案被网络中断了`;
      } else if (input.includes('开始第一幕')) {
        content = [
          '第一幕开启。',
          `${fence}lfh-hud`,
          '地点: 浮灯渡口\n状态: 雾起',
          fence,
          `${fence}js`,
          'const plainCode = "not-a-hud";',
          fence,
        ].join('\n');
      } else if (input.includes('私密文本')) {
        content = '我记住你刚刚说的话了。';
      } else if (input.includes('空白后第一句')) {
        content = '初次见面。';
      } else if (input.includes('邮差重访')) {
        content = '岑灯接过信，问起你的名字。';
      } else if (input.includes('敲钟')) {
        content = '渡口灯亮，第二声钟响。';
      }

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([
          { choices: [{ delta: { content: content.slice(0, 12) } }] },
          { choices: [{ delta: { content: content.slice(12) }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const go = () => page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const dialog = page.getByTestId('markdown-document');
    const writing = page.getByTestId('writing-page');
    const character = page.getByTestId('character-page');
    const lastRequest = () => JSON.stringify(requests.at(-1));

    // 1. Settings -> 我的记忆
    await go();
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').getByTestId('open-my-memory').click();
    await dialog.getByRole('textbox').fill('设置中的我的记忆');
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByTestId('settings-page').getByTestId('open-my-memory').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value === '设置中的我的记忆');
    assert.equal(await dialog.getByRole('textbox').inputValue(), '设置中的我的记忆');
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();

    // 2. Welcome single natural-language input: no mode pills, weak key hint, ambiguous neutral chat -> auto-materialization
    const welcome = page.getByTestId('welcome-view');
    await welcome.waitFor();
    assert.equal(await page.locator('[data-testid^="welcome-mode-pill"]').count(), 0);
    await page.getByTestId('welcome-key-hint').waitFor();
    await page.getByTestId('welcome-plus-menu-trigger').waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);

    await page.fill('#turn-input', '你好，我有点犹豫写什么好');
    await button('发送行动').click();
    await completePendingSetup(page, 'sk-synthetic-fixture');
    await page.getByTestId('neutral-timeline').waitFor();
    await page.getByTestId('neutral-stage-hint').getByText('尚未建档', { exact: false }).waitFor();
    await page.getByTestId('neutral-timeline').getByText('随时都可以！', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('desktop-library').getByTestId('story-list-item').count(), 0);

    // Follow-up in neutral chat hits synthetic error first (preserves draft), then retries and materializes into 写故事!
    await page.fill('#turn-input', '还是帮我写一个叫纸月车站的小说大纲吧');
    await button('发送行动').click();
    await page.getByTestId('main-error-banner').waitFor();
    assert.equal(await page.inputValue('#turn-input'), '还是帮我写一个叫纸月车站的小说大纲吧');
    await button('发送行动').click();
    await writing.waitFor();
    await writing.getByTestId('writing-discussion-timeline').getByText('废弃的纸月车站收到一件无人承认的行李。', { exact: true }).waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '纸月车站', exact: true }).waitFor();
    // Neutral turns carried into materialized work without duplicating messages
    assert.equal(await writing.getByTestId('user-bubble').filter({ hasText: '你好，我有点犹豫写什么好' }).count(), 1);
    // StoryLibrary auto-synced to 写故事 category
    const writingCategoryBtn = page.getByTestId('desktop-library').getByRole('button', { name: '写故事', exact: true });
    assert.equal(await writingCategoryBtn.getAttribute('aria-pressed'), 'true');

    // 3. Dual-channel mode correction: TopBar mode switcher + natural-language chat command
    await page.getByTestId('topbar-mode-switcher').click();
    await page.getByTestId('topbar-mode-option-story').click();
    await page.getByTestId('story-timeline').waitFor();
    await page.getByTestId('status-notice-banner').getByText('已切换为「文游」', { exact: false }).waitFor();
    assert.equal(
      await page.getByTestId('desktop-library').getByRole('button', { name: '文游', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    await page.fill('#turn-input', '切换成写故事');
    await button('发送行动').click();
    await writing.waitFor();
    assert.equal(await writingCategoryBtn.getAttribute('aria-pressed'), 'true');

    // 4. 写故事: zero V0.1 citation/jargon, inline ProposalCard + Diff/Preview + Save + Undo, Chat-to-Manuscript push, Manuscript intent routing
    const writingText = await writing.innerText();
    for (const retired of ['引用讨论', '挑选原话', '资料审计', '公共记忆']) {
      assert.doesNotMatch(writingText, new RegExp(retired));
    }

    await page.getByLabel('聊天内容').fill('把选定背景总结存入作品设定');
    await button('发送').click();
    const settingProposal = writing.locator('section[data-testid^="proposal-card-"]').first();
    await settingProposal.waitFor();
    assert.equal(await dialog.isVisible(), false, 'ProposalCard must not block reading with a modal dialog');
    await settingProposal.getByTestId('proposal-card-toggle').click();
    await settingProposal.getByTestId('proposal-diff-view').waitFor();
    await settingProposal.getByTestId('proposal-tab-preview').click();
    await settingProposal.getByTestId('proposal-markdown-preview').getByText('失物招领员认出了自己的旧行李', { exact: false }).waitFor();
    await settingProposal.getByTestId('proposal-apply-btn').click();
    await settingProposal.getByTestId('proposal-revert-btn').waitFor();

    // One-click revert & re-apply verification
    await settingProposal.getByTestId('proposal-revert-btn').click();
    await settingProposal.getByText('已撤销').waitFor();

    // Open 2-tab companion sheet & edit setting via DocumentDialog
    await page.setViewportSize({ width: 390, height: 844 });
    const messageTable = writing.getByTestId('turn-body').filter({ hasText: '人物表速览' }).first();
    await assertReadableSevenColumnTable(messageTable, 'ordinary message table');
    await assertNormalWidthTable(messageTable, 'normal message table at 390px');
    await page.setViewportSize({ width: 1280, height: 800 });
    await assertNormalWidthTable(messageTable, 'normal message table on desktop');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('open-companion-sheet').click();
    const writingSheet = page.getByTestId('writing-companion-sheet');
    await writingSheet.waitFor();
    assert.equal(await writingSheet.getByRole('tab').count(), 2);
    await writingSheet.getByTestId('writing-tab-documents').click();
    await writingSheet.getByTestId('branch-note-details').waitFor();

    for (const width of [360, 376, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await assertReadableSevenColumnTable(writingSheet, `companion setting at ${width}px`, { checkEditEntry: true });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await assertReadableSevenColumnTable(writingSheet, 'companion setting on desktop', { checkEditEntry: true });

    await writingSheet.getByTestId('edit-writing-setting-btn').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('tab', { name: '预览' }).click();
    await assertReadableSevenColumnTable(dialog, 'editing preview');
    await dialog.getByRole('tab', { name: '编辑' }).click();
    await dialog.getByRole('textbox').fill('## 作品设定\n失物招领员认出了自己的旧行李。');
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });

    await page.setViewportSize({ width: 1280, height: 800 });
    await writingSheet.getByTestId('edit-writing-setting-btn').click();
    await dialog.getByText('历史版本', { exact: true }).click();
    await dialog.locator('.local-document-history').last().getByRole('button', { name: '查看并恢复此版' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertReadableSevenColumnTable(dialog, 'historical setting preview');
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goBack();
    await writingSheet.waitFor({ state: 'hidden' });

    // Chat-to-manuscript trial writing via target: manuscript ProposalCard
    await page.getByLabel('聊天内容').fill('试写一段车站开头');
    await button('发送').click();
    await writing.getByTestId('writing-discussion-timeline').getByText('月台灯柱下只剩一只褪色皮箱', { exact: false }).waitFor();
    const chatManuscriptProposal = writing.locator('section[data-testid^="proposal-card-"]').filter({ hasText: '作品正文' }).last();
    await chatManuscriptProposal.waitFor();
    await chatManuscriptProposal.getByTestId('proposal-card-toggle').click();
    await chatManuscriptProposal.getByTestId('proposal-apply-btn').click();
    await writing.getByTestId('manuscript-undo-banner').waitFor();
    await writing.getByTestId('jump-to-manuscript-btn').click();
    await writing.getByTestId('creative-manuscript').waitFor();
    assert.match(await writing.getByTestId('creative-manuscript').inputValue(), /月台灯柱下只剩一只褪色皮箱/);

    // Debounced autosave + quiet manuscript status + pre-transition flushes + manuscript intent split
    await page.evaluate(() => {
      const status = document.querySelector('[data-testid="manuscript-status"]');
      window.__lfhObservedManuscriptStatuses = status ? [status.textContent ?? ''] : [];
      if (status) {
        const observer = new MutationObserver(() => {
          window.__lfhObservedManuscriptStatuses.push(status.textContent ?? '');
        });
        observer.observe(status, { childList: true, characterData: true, subtree: true });
        window.__lfhManuscriptStatusObserver = observer;
      }
    });
    await writing.getByTestId('creative-manuscript').fill('纸月照进车站。');
    await writing.getByTestId('manuscript-status').getByText('7 字 · 已本地保存', { exact: true }).waitFor();

    // Pre-debounce flush on TopBar 聊天/正文 switch
    await writing.getByTestId('creative-manuscript').fill('纸月照进车站。未落盘补充。');
    assert.equal(await page.evaluate(() => window.__lfhHasPendingManuscriptFlush?.()), true);
    await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '聊天' }).click();
    await writing.getByTestId('writing-discussion-timeline').waitFor();
    await page.waitForFunction(async (expectedBody) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('local-fiction-harness');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entry = await new Promise((resolve, reject) => {
        const request = db.transaction('meta').objectStore('meta').get('creativeWorkspace');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return entry?.value?.works?.some((work) => work.body === expectedBody) === true;
    }, '纸月照进车站。未落盘补充。');

    // Pre-debounce flush on active work export from library menu
    await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '正文' }).click();
    await writing.getByTestId('creative-manuscript').waitFor();
    await writing.getByTestId('creative-manuscript').fill('纸月照进车站。导出瞬时正文。');
    const activeWorkRow = page.getByTestId('desktop-library').locator('[data-testid="story-list-item"][data-active="true"]');
    await activeWorkRow.getByTestId('story-menu-trigger').click();
    const [workExportDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('story-overflow-menu').getByRole('menuitem', { name: '导出 Markdown (.md)' }).click(),
    ]);
    assert.match(fs.readFileSync(await workExportDownload.path(), 'utf8'), /导出瞬时正文/);

    // Android hardware Back flush hook flushes pending edits immediately
    await writing.getByTestId('creative-manuscript').fill('纸月照进车站。');
    assert.equal(await page.evaluate(() => window.__lfhHasPendingManuscriptFlush?.()), true);
    await page.evaluate(() => window.__lfhFlushManuscript?.());
    assert.equal(await page.evaluate(() => window.__lfhHasPendingManuscriptFlush?.()), false);

    await writing.getByTestId('manuscript-status').getByText('7 字 · 已本地保存', { exact: true }).waitFor();
    const observedStatuses = await page.evaluate(() => {
      window.__lfhManuscriptStatusObserver?.disconnect();
      return window.__lfhObservedManuscriptStatuses ?? [];
    });
    for (const statusText of observedStatuses) {
      assert.doesNotMatch(statusText, /待保存|保存中/);
    }

    await page.getByLabel('写作要求').fill('这一段节奏是不是太快？');
    await button('发送请求').click();
    await writing.getByTestId('manuscript-chat-answer').getByText('可以在钟响后补写一句环境细节', { exact: false }).waitFor();

    // 5. 角色互动: zero binary sub-toggles, unified conversation, inline ProposalCard conflict/rebase, 2-tab companion sheet
    await page.getByTestId('desktop-library-new-creation').click();
    await welcome.waitFor();
    await page.fill('#turn-input', '名称：岑灯\n退役夜航员，寡言。PERSONA-UNIQUE');
    await button('发送行动').click();
    await character.waitFor();
    await character.getByText('岑灯推开码头边的窗。', { exact: true }).waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '岑灯', exact: true }).waitFor();
    const charText = await character.innerText();
    for (const retired of ['本人聊天', '扮演对戏', '空白开聊', '带资料开新对话', '资料审计', '公共记忆']) {
      assert.doesNotMatch(charText, new RegExp(retired));
    }

    // Inline memory proposal + concurrent edit in second page -> conflict view -> AI reorganize / open editor
    await page.getByLabel('发消息').fill('请保存我的记忆，今后只用短句');
    await button('发送').click();
    const memProposal = character.locator('section[data-testid^="proposal-card-"]').first();
    await memProposal.waitFor();

    const other = await context.newPage();
    await other.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await other.getByTestId('desktop-settings-open').click();
    await other.getByTestId('settings-page').getByTestId('open-my-memory').click();
    const otherDoc = other.getByTestId('markdown-document');
    await otherDoc.getByRole('textbox').fill('另一处已确认 ALT-PUBLIC');
    await otherDoc.getByRole('button', { name: '确认保存' }).click();
    await otherDoc.waitFor({ state: 'hidden' });
    await other.close();

    // First apply detects concurrent drift, syncs ALT-PUBLIC & auto-rebases; second apply saves rebased append
    await memProposal.getByTestId('proposal-card-toggle').click();
    await memProposal.getByTestId('proposal-apply-btn').click();
    await memProposal.getByText('已自动对齐你刚才的修改，保存前可确认下方变动。', { exact: false }).waitFor();
    await memProposal.getByTestId('proposal-apply-btn').click();
    await memProposal.getByTestId('proposal-revert-btn').waitFor();

    // Private history & branching & 2-tab companion sheet
    await page.getByLabel('发消息').fill('需要隔离的私密文本 PRIVATE-HISTORY');
    await button('发送').click();
    await character.getByText('我记住你刚刚说的话了。', { exact: true }).waitFor();
    assert.match(lastRequest(), /PUBLIC-LATEST/);
    assert.match(lastRequest(), /PERSONA-UNIQUE/);
    await character.getByTestId('turn-history-toggle').first().click();
    await character.getByRole('button', { name: '回溯至此' }).first().waitFor();

    await page.getByTestId('open-companion-sheet').click();
    const characterSheet = page.getByTestId('character-companion-sheet');
    await characterSheet.waitFor();
    assert.equal(await characterSheet.getByRole('tab').count(), 2);
    await characterSheet.getByTestId('character-new-conversation-btn').click();
    await characterSheet.waitFor({ state: 'hidden' });
    await page.getByLabel('发消息').fill('空白后第一句');
    await button('发送').click();
    await character.getByText('初次见面。', { exact: true }).waitFor();
    assert.doesNotMatch(lastRequest(), /PRIVATE-HISTORY/);

    await page.getByTestId('open-companion-sheet').click();
    await characterSheet.getByRole('button', { name: '导出对话 Markdown (.md)' }).click();
    const exportPreview = page.getByRole('dialog', { name: '导出对话 Markdown' });
    assert.doesNotMatch(await exportPreview.innerText(), /PRIVATE-HISTORY/);
    const [conversationDownload] = await Promise.all([page.waitForEvent('download'), button('导出 Markdown').click()]);
    assert.match(fs.readFileSync(await conversationDownload.path(), 'utf8'), /初次见面/);
    await exportPreview.waitFor({ state: 'hidden' });
    await characterSheet.getByRole('button', { name: '删除此段对话' }).click();
    const deleteConvDialog = page.getByRole('dialog', { name: '删除这段对话' });
    await button('确认删除').click();
    await deleteConvDialog.waitFor({ state: 'hidden' });
    await character.getByText('初次见面。', { exact: true }).waitFor({ state: 'detached' });
    await characterSheet.getByRole('button').filter({ hasText: /岑灯|请保存我的记忆/ }).first().click();
    await characterSheet.waitFor({ state: 'hidden' });
    await character.getByText('岑灯推开码头边的窗。', { exact: true }).waitFor();

    // 6. 文游: Script import -> lfh-hud isolation (plain code block stays <code>) -> ProposalCard needs_review & character creation -> concurrency
    await page.getByTestId('desktop-library-new-creation').click();
    await startScriptImport(page);
    await page.fill('#import-raw-script', '收灯人用三声钟响通知船主。钟响第三次之前，赤灯不可离岸。SCRIPT-END');
    await page.getByText('填写故事标题（可选）').click();
    await page.fill('#import-title', '浮灯渡口');
    await button('导入并开始').click();
    await page.getByTestId('story-timeline').waitFor();
    await button('开启第一幕').click();
    await page.getByTestId('turn-assistant').last().getByTestId('hud-panel').waitFor();
    // Explicit lfh-hud isolation: normal js code block must NOT become a HUD panel
    assert.equal(await page.getByTestId('turn-assistant').last().getByTestId('hud-panel').count(), 1);
    assert.equal(await page.getByTestId('turn-assistant').last().locator('pre code').filter({ hasText: 'not-a-hud' }).count(), 1);

    // Truncated lfh-proposal triggers needs_review recovery card instead of silent drop
    await page.fill('#turn-input', '触发断尾提案');
    await page.getByRole('button', { name: '发送行动' }).click();
    const needsReviewCard = page.locator('section[data-testid^="proposal-card-"]').last();
    await needsReviewCard.waitFor();
    await needsReviewCard.getByTestId('proposal-card-toggle').click();
    await needsReviewCard.getByTestId('proposal-needs-review-body').waitFor();

    // Delayed response while opening Settings preserves background save & reload
    await page.fill('#turn-input', '敲钟');
    await page.getByRole('button', { name: '发送行动' }).click();
    await storyResponsePending;
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').waitFor();
    releaseStoryResponse();
    await page.waitForFunction(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('local-fiction-harness');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stories = await new Promise((resolve, reject) => {
        const request = db.transaction('stories').objectStore('stories').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return JSON.stringify(stories).includes('渡口灯亮，第二声钟响。');
    });
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await page.getByTestId('story-timeline').getByText('渡口灯亮，第二声钟响。', { exact: true }).waitFor();
    await go();
    await page.getByTestId('story-timeline').getByText('渡口灯亮，第二声钟响。', { exact: true }).waitFor();
    assert.match(lastRequest(), /SCRIPT-END/);
    assert.match(lastRequest(), /PUBLIC-LATEST/);

    // Story -> Character proposal card creates new character asset
    await page.fill('#turn-input', '请把当前文游资料带入文游人设，建立新角色');
    await page.getByRole('button', { name: '发送行动' }).click();
    const charProposal = page.locator('section[data-testid^="proposal-card-"]').filter({ hasText: '收灯人' }).last();
    await charProposal.waitFor();
    await charProposal.getByTestId('proposal-card-toggle').click();
    await charProposal.getByTestId('proposal-apply-btn').click();
    await page.getByRole('button', { name: '去看看' }).click();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '收灯人', exact: true }).waitFor();

    // 7. Manuscript suggestion adoption + autosave + reload persistence
    const library = page.getByTestId('desktop-library');
    await library.getByRole('button', { name: '写故事', exact: true }).click();
    await library.getByTestId('story-select-button').filter({ hasText: '纸月车站' }).filter({ hasText: '正文' }).click();
    await writing.waitFor();
    await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '正文' }).click();
    const manuscript = writing.getByTestId('creative-manuscript');
    const half = '第二声钟刚停。阿霁把赤灯按在窗沿。';
    await manuscript.fill(half);
    await manuscript.evaluate((element) => {
      element.setSelectionRange(element.value.length, element.value.length);
      element.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.getByLabel('写作要求').fill('接着写一小段');
    await button('发送请求').click();
    const inlineManuscriptProposal = writing.getByTestId('manuscript-inline-proposal');
    await inlineManuscriptProposal.getByTestId('proposal-apply-btn').waitFor();
    await manuscript.fill(`${half}（补充）`);
    await page.waitForFunction(async (expectedBody) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('local-fiction-harness');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entry = await new Promise((resolve, reject) => {
        const request = db.transaction('meta').objectStore('meta').get('creativeWorkspace');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return entry?.value?.works?.some((work) => work.body === expectedBody) === true;
    }, `${half}（补充）`);
    await inlineManuscriptProposal.getByTestId('proposal-apply-btn').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=creative-manuscript]')?.value.includes('第三声钟响'));
    await writing.getByTestId('manuscript-undo-btn').waitFor();

    // 8. 3 themes × 2 viewports × 3 modes zero horizontal overflow
    await page.getByTestId('desktop-library-new-creation').click();
    const targetScreens = process.env.LFH_MODE_SCREENSHOTS;
    for (const theme of ['light', 'dark', 'warm']) {
      await page.getByTestId('desktop-settings-open').click();
      const appearanceSettings = page.getByTestId('settings-page');
      await appearanceSettings.getByTestId(`theme-option-${theme}`).click();
      await page.waitForFunction(
        (selectedTheme) => document.documentElement.dataset.theme === selectedTheme,
        theme,
      );
      await appearanceSettings.getByRole('button', { name: '返回' }).click();
      await page.getByTestId('welcome-view').waitFor();
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        for (const [name, category, title, target, actionLabel] of [
          ['文游', '文游', '浮灯渡口', page.getByTestId('story-timeline'), '打开分支与设定'],
          ['写故事', '写故事', '纸月车站', writing, '打开灵感与设定'],
          ['角色互动', '角色', '岑灯', character, '打开历史对话与设定'],
        ]) {
          if (viewport.width < 960) await page.getByTestId('library-drawer-trigger').click();
          const activeLib = page.getByTestId(viewport.width < 960 ? 'mobile-library-dialog' : 'desktop-library');
          await activeLib.getByRole('button', { name: category, exact: true }).click();
          await activeLib.getByTestId('story-select-button').filter({ hasText: title }).first().click();
          await target.waitFor();
          const companionBtn = page.getByTestId('open-companion-sheet');
          assert.equal(await companionBtn.getAttribute('aria-label'), actionLabel);
          const bounds = await companionBtn.boundingBox();
          assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
          assert.ok(await page.getByTestId('main-stage').evaluate((element) =>
            element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
          ), `Unexpected horizontal overflow in ${name}, ${theme}, ${viewport.width}`);
          if (targetScreens) await page.screenshot({ path: path.join(targetScreens, `${theme}-${viewport.width}-${name}.png`) });
          if (viewport.width < 960) await page.getByTestId('library-drawer-trigger').click();
          await page.getByTestId(viewport.width < 960 ? 'mobile-library-new-creation' : 'desktop-library-new-creation').click();
          await target.waitFor({ state: 'detached' });
        }
      }
    }

    // 9. Unified .folio.json v3 full backup export/restore + V0.1 .lfh.json silent migration
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('desktop-settings-open').click();
    const [v3Backup] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-current-story').click(),
    ]);
    assert.match(v3Backup.suggestedFilename(), /^folio-backup-.*\.folio\.json$/);
    const v3Path = await v3Backup.path();
    const v3Json = JSON.parse(fs.readFileSync(v3Path, 'utf8'));
    assert.equal(v3Json.schemaVersion, 3);
    assert.equal(v3Json.appVersion, '0.4.1');
    assert.ok(v3Json.stories.some((s) => s.title === '浮灯渡口'));
    assert.ok(v3Json.workspace.works.some((w) => w.title === '纸月车站'));
    assert.ok(v3Json.workspace.characters.some((c) => c.name === '岑灯'));
    assert.ok(!JSON.stringify(v3Json).includes('sk-synthetic-fixture'), 'Backup must never serialize API key');

    // Import v3 backup -> safe copy merge
    await page.setInputFiles('[data-testid="backup-import-input"]', v3Path);
    await page.getByTestId('settings-page').waitFor({ state: 'detached' });
    await page.getByTestId('status-notice-banner').getByText('备份已安全合入', { exact: false }).waitFor();

    // Import V0.1 legacy .lfh.json backup -> silent V0.2 migration
    const legacyBackupPath = path.join(path.dirname(v3Path), 'legacy-v01.lfh.json');
    fs.writeFileSync(legacyBackupPath, JSON.stringify({
      schemaVersion: 1,
      exportedAt: Date.now(),
      story: {
        id: 'legacy-v01-story',
        title: '旧版迁移故事',
        rawScript: '旧版原始剧本正文 LEGACY-SCRIPT',
        blueprint: {
          title: '旧版迁移故事',
          worldRules: ['规则一'],
          protagonist: '旧主角',
          npcs: [],
          taboos: [],
          openingHook: '旧开局',
          extractionStatus: 'complete',
        },
        nodes: {},
        rootNodeIds: [],
        activeLeafNodeId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    await page.getByTestId('desktop-settings-open').click();
    await page.setInputFiles('[data-testid="backup-import-input"]', legacyBackupPath);
    await page.getByTestId('settings-page').waitFor({ state: 'detached' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: '旧版迁移故事', exact: true }).waitFor();
    await page.getByTestId('story-timeline').getByText('旧版原始剧本正文 LEGACY-SCRIPT', { exact: false }).waitFor();

    // 10. StoryLibrary rename & .md export for works & characters
    await library.getByRole('button', { name: '写故事', exact: true }).click();
    const workRow = library.getByTestId('story-list-item').filter({ hasText: '纸月车站' }).filter({ hasText: '正文' }).first();
    await workRow.getByTestId('story-menu-trigger').click();
    await workRow.getByRole('menuitem', { name: '重命名' }).click();
    await library.getByRole('textbox', { name: '重命名作品标题' }).fill('纸月车站改名');
    await library.getByRole('button', { name: '保存', exact: true }).click();
    const renamedWorkRow = library.getByTestId('story-list-item').filter({ hasText: '纸月车站改名' }).first();
    await renamedWorkRow.waitFor();
    await renamedWorkRow.getByTestId('story-menu-trigger').click();
    const [workExport] = await Promise.all([
      page.waitForEvent('download'),
      renamedWorkRow.getByRole('menuitem', { name: '导出 Markdown (.md)' }).click(),
    ]);
    assert.match(workExport.suggestedFilename(), /纸月车站改名\.md$/);
    assert.match(fs.readFileSync(await workExport.path(), 'utf8'), /第三声钟响/);

    await library.getByRole('button', { name: '角色', exact: true }).click();
    const charRow = library.getByTestId('story-list-item').filter({ hasText: '岑灯' }).first();
    await charRow.getByTestId('story-menu-trigger').click();
    const [charExport] = await Promise.all([
      page.waitForEvent('download'),
      charRow.getByRole('menuitem', { name: '导出 Markdown (.md)' }).click(),
    ]);
    assert.match(charExport.suggestedFilename(), /岑灯\.md$/);
    assert.match(fs.readFileSync(await charExport.path(), 'utf8'), /岑灯推开码头边的窗/);

    // 11. Concurrency guard during deletion under Settings
    await library.getByRole('button', { name: '文游', exact: true }).click();
    const activeStoryRow = library.getByTestId('story-list-item').filter({ hasText: '旧版迁移故事' }).first();
    await activeStoryRow.getByTestId('story-menu-trigger').click();
    await activeStoryRow.getByRole('menuitem', { name: '删除故事' }).click();
    const deleteConfirmation = page.getByRole('dialog', { name: '确认删除' });
    await deleteConfirmation.waitFor();
    await holdNextStoryStorageCommit(page, 'stories');
    await deleteConfirmation.getByRole('button', { name: '确认删除' }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').waitFor();
    await releaseHeldStoryStorageCommit(page);
    await activeStoryRow.waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('settings-page').isVisible(), true);
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await welcome.waitFor();
  } finally {
    await context.close();
  }
}
