import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fence = '\x60'.repeat(3);
const proposal = (target, markdown, name) => `${fence}lfh-change\n${JSON.stringify({ target, markdown, name })}\n${fence}`;

export async function verifyInactiveStoryReload(browser, port, helpers) {
  const {
    newOfflineContext,
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
      await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
      await page.getByTestId('welcome-view').waitFor();
      assert.deepEqual(await readActiveSelection(page), { present: false, id: null });

      const title = `显式无激活${overlayLabel}`;
      await page.fill('#turn-input', `${title}。创建后激活期间打开${overlayLabel}`);
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
  const { newOfflineContext, mockSuccessfulKeyVerification, completePendingSetup, sseResponse, startScriptImport, holdNextStoryStorageCommit, releaseHeldStoryStorageCommit } = helpers;
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
      const input = messages.at(-1)?.content ?? '';
      if (input.includes('讨论纸月') && failOpening) {
        failOpening = false;
        await route.fulfill({ status: 500, body: 'synthetic failure' });
        return;
      }
      if (input.includes('敲钟')) {
        storyResponseStarted();
        await storyResponseRelease;
      }
      let content = `接续：${input}`;
      if (input.includes('保存公共记忆')) content = `请核对公共记忆。\n${proposal('public', '仅用短句。PUBLIC-LATEST')}`;
      else if (input.includes('带入文游人设')) content = `请核对渡口人物。\n${proposal('character', '渡口的收灯人。SOURCE-COPY', '收灯人')}`;
      else if (input.includes('讨论纸月')) content = '废弃车站收到一件无人承认的行李。';
      else if (input.includes('总结存入')) content = `请核对作品资料。\n${proposal('container', '## 开书讨论\n失物招领员认出了自己的旧行李。')}`;
      else if (input.includes('接着写一小段')) content = '第三声钟响，船离岸了。';
      else if (input.includes('私密文本')) content = '我记住你刚刚说的话了。';
      else if (input.includes('空白后第一句')) content = '初次见面。';
      else if (input.includes('邮差重访')) content = '岑灯接过信，问起你的名字。';
      else if (input.includes('自然开场')) content = '岑灯推开码头边的窗。';
      else if (input.includes('敲钟')) content = '渡口灯亮，第二声钟响。';
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseResponse([
        { choices: [{ delta: { content: content.slice(0, 12) } }] },
        { choices: [{ delta: { content: content.slice(12) }, finish_reason: 'stop' }] },
      ]) });
    });

    const go = () => page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const dialog = page.getByTestId('markdown-document');
    const writing = page.getByTestId('writing-page');
    const character = page.getByTestId('character-page');
    const lastRequest = () => JSON.stringify(requests.at(-1));

    await go();
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').getByRole('button', { name: '公共记忆', exact: true }).click();
    await dialog.getByRole('textbox').fill('设置中的公共记忆');
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByTestId('settings-page').getByRole('button', { name: '公共记忆', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value === '设置中的公共记忆');
    assert.equal(await dialog.getByRole('textbox').inputValue(), '设置中的公共记忆');
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await page.getByTestId('welcome-view').getByRole('button', { name: /产粮/ }).click();
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, 'Writing shares the main top bar');
    await page.fill('#turn-input', '纸月车站。讨论纸月车站的开场');
    await button('发送行动').click();
    await page.getByTestId('deepseek-setup-wizard').getByRole('button', { name: '关闭引导' }).click();
    await go();
    await page.getByTestId('desktop-library').getByRole('button', { name: '产粮', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '纸月车站' }).click();
    await writing.getByText('你 · 纸月车站。讨论纸月车站的开场', { exact: true }).waitFor();
    await writing.getByRole('button', { name: '发送', exact: true }).click();
    await completePendingSetup(page, 'sk-synthetic-fixture');
    await writing.getByRole('alert').waitFor();
    await go();
    await page.getByTestId('desktop-library').getByRole('button', { name: '产粮', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '纸月车站' }).click();
    await writing.getByRole('button', { name: '发送', exact: true }).click();
    await writing.getByText('AI · 废弃车站收到一件无人承认的行李。', { exact: true }).waitFor();
    assert.equal(await writing.getByText('你 · 纸月车站。讨论纸月车站的开场', { exact: true }).count(), 1);
    assert.equal(requests.at(-1).filter((message) => message.content === '纸月车站。讨论纸月车站的开场').length, 1);
    await page.getByTestId('app-topbar').getByRole('heading', { name: '纸月车站', exact: true }).waitFor();
    assert.doesNotMatch(await writing.innerText(), /资料审计/);
    assert.equal(await page.getByTestId('creative-document-reads').count(), 1);
    assert.equal(await page.getByTestId('creative-document-reads').isVisible(), false);
    await page.getByTestId('app-topbar').getByRole('button', { name: '创作资料' }).click();
    const writingSheet = page.getByRole('dialog', { name: '创作资料' });
    const writingReads = writingSheet.getByTestId('creative-document-reads');
    await writingReads.waitFor();
    if (await writingReads.evaluate((element) => element.open)) {
      throw new Error('Writing document reads should be collapsed by default.');
    }
    await writingReads.locator('summary').click();
    assert.match(await writingReads.innerText(), /纸月车站/);
    assert.match(await writingReads.innerText(), /公共记忆/);
    await writingReads.locator('summary').click();
    await page.goBack();
    await writingSheet.waitFor({ state: 'hidden' });
    await page.getByLabel('讨论内容').fill('把选定背景总结存入作品资料');
    await button('发送').click();
    await dialog.getByTestId('document-proposal-preview').waitFor();
    assert.match(await dialog.innerText(), /作用范围：当前作品资料。来源：本轮 AI 回复。/);
    if (await dialog.getByRole('textbox').count()) {
      throw new Error('Markdown proposals should be read-only until the user selects edit.');
    }
    assert.match(await dialog.innerText(), /失物招领员认出了自己的旧行李/);
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await button('作品资料').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value.includes('失物招领员'));
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '正文' }).click();
    await writing.locator('textarea.creative-manuscript').fill('纸月照进车站。');
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').getByRole('button', { name: '人机恋' }).click();
    await page.fill('#turn-input', '名称：岑灯\n退役夜航员，寡言。PERSONA-UNIQUE');
    await button('发送行动').click();
    await character.getByText('岑灯推开码头边的窗。', { exact: true }).waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '岑灯', exact: true }).waitFor();
    assert.doesNotMatch(await character.innerText(), /资料审计/);
    assert.equal(await page.getByTestId('creative-document-reads').isVisible(), false);
    await page.getByTestId('app-topbar').getByRole('button', { name: '创作资料' }).click();
    const characterSheet = page.getByRole('dialog', { name: '创作资料' });
    const characterReads = characterSheet.getByTestId('creative-document-reads');
    await characterReads.waitFor();
    if (await characterReads.evaluate((element) => element.open)) {
      throw new Error('Character document reads should be collapsed by default.');
    }
    await characterReads.locator('summary').click();
    assert.match(await characterReads.innerText(), /岑灯/);
    assert.match(await characterReads.innerText(), /公共记忆/);
    await characterReads.locator('summary').click();
    await characterSheet.getByRole('button', { name: '关闭创作资料面板' }).click();
    await characterSheet.waitFor({ state: 'hidden' });
    const requestPublicEdit = async () => {
      await page.getByLabel('发消息').fill('请保存公共记忆，今后只用短句');
      await button('发送').click();
      await dialog.getByRole('button', { name: '确认保存' }).waitFor();
      await dialog.getByTestId('document-proposal-preview').waitFor();
      assert.match(await dialog.innerText(), /作用范围：公共记忆。来源：本轮 AI 回复。/);
      await dialog.getByRole('button', { name: '编辑微调' }).click();
      await dialog.getByRole('textbox').waitFor();
    };
    await requestPublicEdit();
    const other = await context.newPage();
    await other.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await other.getByTestId('desktop-settings-open').click();
    await other.getByTestId('settings-page').getByRole('button', { name: '公共记忆', exact: true }).click();
    const otherDoc = other.getByTestId('markdown-document');
    await otherDoc.getByRole('textbox').fill('另一处已确认 ALT-PUBLIC');
    await otherDoc.getByRole('button', { name: '确认保存' }).click();
    await otherDoc.waitFor({ state: 'hidden' });
    await other.close();
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.getByRole('button', { name: '重新核对' }).click();
    await dialog.getByText('历史版本', { exact: true }).click();
    await dialog.getByText('重新核对前的拟保存草稿').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value.includes('ALT-PUBLIC'));
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await requestPublicEdit();
    assert.match(lastRequest(), /ALT-PUBLIC/);
    assert.doesNotMatch(lastRequest(), /PUBLIC-LATEST/);
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByLabel('发消息').fill('需要隔离的私密文本 PRIVATE-HISTORY');
    await button('发送').click();
    await character.getByText('我记住你刚刚说的话了。', { exact: true }).waitFor();
    assert.match(lastRequest(), /PUBLIC-LATEST/);
    assert.match(lastRequest(), /PERSONA-UNIQUE/);
    await character.getByText('对话管理', { exact: true }).click();
    await button('空白开聊').click();
    await button('生成开场').waitFor();
    await page.getByLabel('发消息').fill('空白后第一句');
    await button('发送').click();
    await character.getByText('初次见面。', { exact: true }).waitFor();
    assert.doesNotMatch(lastRequest(), /PRIVATE-HISTORY/);
    await button('预览导出').click();
    const exportPreview = page.getByRole('dialog', { name: '对话导出预览' });
    assert.doesNotMatch(await exportPreview.innerText(), /PRIVATE-HISTORY/);
    const [conversationDownload] = await Promise.all([page.waitForEvent('download'), button('导出 Markdown').click()]);
    assert.match(fs.readFileSync(await conversationDownload.path(), 'utf8'), /初次见面/);
    await button('删除对话').click();
    await button('确认删除').click();
    await character.getByText('初次见面。', { exact: true }).waitFor({ state: 'detached' });
    await button('扮演对戏').click();
    await character.getByText('岑灯推开码头边的窗。', { exact: true }).waitFor();
    await page.getByLabel('发消息').fill('邮差重访：我是第一次遇见你的邮差。');
    await button('发送').click();
    await character.getByText('岑灯接过信，问起你的名字。', { exact: true }).waitFor();
    assert.doesNotMatch(lastRequest(), /PRIVATE-HISTORY/);
    await character.getByText('历史对话', { exact: true }).click();
    await button('本人聊天 1').click();
    await character.getByText('需要隔离的私密文本 PRIVATE-HISTORY', { exact: true }).waitFor();
    await button('扮演对戏 2').click();
    await page.getByTestId('desktop-library-new-creation').click();

    await startScriptImport(page);
    await page.fill('#import-raw-script', '收灯人用三声钟响通知船主。钟响第三次之前，赤灯不可离岸。SCRIPT-END');
    await page.getByText('填写故事标题（可选）').click();
    await page.fill('#import-title', '浮灯渡口');
    await button('暂不拆解，直接开始').click();
    await page.getByTestId('turn-assistant').last().waitFor();
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
    const library = page.getByTestId('desktop-library');
    const selectStory = () => library.getByTestId('story-select-button').filter({ hasText: '浮灯渡口' }).click();
    const selectWork = () => library.getByTestId('story-select-button').filter({ hasText: '纸月车站' }).click();
    await library.getByRole('button', { name: '文游', exact: true }).click();
    await holdNextStoryStorageCommit(page, 'meta');
    await selectStory();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await page.getByTestId('desktop-library-new-creation').click();
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('welcome-view').waitFor();
    await holdNextStoryStorageCommit(page, 'meta');
    await selectStory();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await library.getByRole('button', { name: '产粮', exact: true }).click();
    await selectWork();
    await writing.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await writing.waitFor();
    await holdNextStoryStorageCommit(page, 'meta');
    await selectWork();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await library.getByRole('button', { name: '文游', exact: true }).click();
    await selectStory();
    await page.getByTestId('story-timeline').waitFor();
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('story-timeline').waitFor();
    await library.getByRole('button', { name: '产粮', exact: true }).click();
    await holdNextStoryStorageCommit(page, 'meta');
    await selectWork();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').waitFor();
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('settings-page').waitFor();
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await page.getByTestId('story-timeline').waitFor();
    assert.match(lastRequest(), /SCRIPT-END/);
    assert.match(lastRequest(), /PUBLIC-LATEST/);
    await page.getByRole('button', { name: '从这里开稿' }).last().click();
    const manuscript = writing.locator('textarea.creative-manuscript');
    const half = '第二声钟刚停。阿霁把赤灯按在窗沿。';
    await manuscript.fill(half);
    await manuscript.evaluate((element) => {
      element.setSelectionRange(element.value.length, element.value.length);
      element.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.getByLabel('写作要求').fill('接着写一小段');
    await button('获取建议').click();
    await button('采纳建议').click();
    await page.waitForFunction(() => document.querySelector('.creative-manuscript')?.value.includes('第三声钟响'));
    assert.match(lastRequest(), /SCRIPT-END/);
    assert.match(lastRequest(), /第二声钟刚停/);
    const [draftDownload] = await Promise.all([page.waitForEvent('download'), button('导出正文').click()]);
    const downloaded = fs.readFileSync(await draftDownload.path(), 'utf8');
    assert.equal(downloaded, await manuscript.inputValue());
    assert.doesNotMatch(downloaded, /SCRIPT-END/);
    await go();
    await page.getByTestId('desktop-library').getByRole('button', { name: '产粮', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '浮灯渡口' }).click();
    assert.equal(await manuscript.inputValue(), downloaded);
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '纸月车站' }).click();
    await page.waitForFunction(() => document.querySelector('.creative-manuscript')?.value === '纸月照进车站。');

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
        for (const [name, category, title, target] of [['产粮', '产粮', '纸月车站', writing], ['人机恋', '角色', '岑灯', character]]) {
          if (viewport.width < 960) await page.getByTestId('library-drawer-trigger').click();
          const library = page.getByTestId(viewport.width < 960 ? 'mobile-library-dialog' : 'desktop-library');
          await library.getByRole('button', { name: category, exact: true }).click();
          await library.getByTestId('story-select-button').filter({ hasText: title }).click();
          await target.waitFor();
          const bounds = await page.getByTestId('app-topbar').getByRole('button', { name: '创作资料' }).boundingBox();
          assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
          assert.ok(await page.getByTestId('main-stage').evaluate((element) =>
            element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
          ), `Unexpected horizontal overflow in ${name}, ${theme}, ${viewport.width}`);
          if (targetScreens) await page.screenshot({ path: path.join(targetScreens, `${theme}-${viewport.width}-${name}.png`) });
          if (viewport.width < 960) await page.getByTestId('library-drawer-trigger').click();
          await page.getByTestId(viewport.width < 960 ? 'mobile-library-new-creation' : 'desktop-library-new-creation').click();
          await target.waitFor({ state: 'detached' });
        }
        if (targetScreens) await page.screenshot({ path: path.join(targetScreens, `${theme}-${viewport.width}-文游.png`) });
      }
    }
    await page.getByTestId('desktop-library').getByRole('button', { name: '文游', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '浮灯渡口' }).click();
    await page.fill('#turn-input', '请把当前文游资料带入文游人设，建立新角色');
    await page.getByRole('button', { name: '发送行动' }).click();
    await dialog.getByText(/来源节点.*第二声钟响/).waitFor();
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await character.getByRole('heading', { name: '收灯人' }).waitFor();
    await character.getByRole('button', { name: '角色人设' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value.includes('SOURCE-COPY'));

    await dialog.getByRole('button', { name: '取消' }).click();
    // A story backup restored while a creative page is active must replace that page.
    await page.getByTestId('desktop-library').getByRole('button', { name: '文游', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '浮灯渡口' }).click();
    await page.getByTestId('desktop-settings-open').click();
    const [backup] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-current-story').click()]);
    const backupPath = await backup.path();
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await page.getByTestId('desktop-library').getByRole('button', { name: '角色', exact: true }).click();
    await page.getByTestId('desktop-library').getByTestId('story-select-button').filter({ hasText: '岑灯' }).click();
    await character.waitFor();
    await page.getByTestId('desktop-settings-open').click();
    await page.setInputFiles('[data-testid="backup-import-input"]', backupPath);
    await character.waitFor({ state: 'detached' });
    await page.getByTestId('story-timeline').waitFor();

    // Settings opened during deletion must remain open when the save finishes.
    const desktopLibrary = page.getByTestId('desktop-library');
    await desktopLibrary.getByRole('button', { name: '产粮', exact: true }).click();
    const secondWork = desktopLibrary.getByTestId('story-list-item').filter({ hasText: '浮灯渡口' });
    await secondWork.getByTestId('story-select-button').click();
    await writing.waitFor();
    await secondWork.getByTestId('story-menu-trigger').click();
    await secondWork.getByRole('menuitem', { name: /删除/ }).click();
    await holdNextStoryStorageCommit(page, 'meta');
    await page.getByRole('dialog', { name: '确认删除' }).getByRole('button', { name: '确认删除' }).click();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').waitFor();
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('settings-page').waitFor();
    await page.getByTestId('settings-page').getByRole('button', { name: '返回' }).click();
    await secondWork.waitFor({ state: 'detached' });

    // Import navigation also takes precedence over a pending deletion redirect.
    await desktopLibrary.getByRole('button', { name: '角色', exact: true }).click();
    const secondCharacter = desktopLibrary.getByTestId('story-list-item').filter({ hasText: '收灯人' });
    await secondCharacter.getByTestId('story-select-button').click();
    await character.waitFor();
    await secondCharacter.getByTestId('story-menu-trigger').click();
    await secondCharacter.getByRole('menuitem', { name: /删除/ }).click();
    await holdNextStoryStorageCommit(page, 'meta');
    await page.getByRole('dialog', { name: '确认删除' }).getByRole('button', { name: '确认删除' }).click();
    await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
    await startScriptImport(page);
    await page.getByTestId('import-panel').waitFor();
    await releaseHeldStoryStorageCommit(page);
    await page.getByTestId('import-panel').waitFor();
    await page.getByTestId('import-panel').getByRole('button', { name: '返回' }).click();
    await secondCharacter.waitFor({ state: 'detached' });

    // New creation is reachable from the library on both screen sizes.
    for (const mobile of [false, true]) {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      if (mobile) await page.getByTestId('library-drawer-trigger').click();
      await page.getByTestId(`${mobile ? 'mobile' : 'desktop'}-library-new-creation`).click();
      await page.getByTestId('welcome-view').waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'turn-input');
    }
    // Exercise both categories, including a confirmation nested in the mobile drawer.
    for (const [mobile, category, title] of [[false, '产粮', '纸月车站'], [true, '角色', '岑灯']]) {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      if (mobile) await page.getByTestId('library-drawer-trigger').click();
      const library = page.getByTestId(mobile ? 'mobile-library-dialog' : 'desktop-library');
      await library.getByRole('button', { name: category, exact: true }).click();
      const row = library.getByTestId('story-list-item').filter({ hasText: title });
      if (!mobile) {
        await row.getByTestId('story-select-button').click();
        await writing.waitFor();
      }
      await row.getByTestId('story-menu-trigger').click();
      await row.getByRole('menuitem', { name: /删除/ }).click();
      const confirmation = page.getByRole('dialog', { name: '确认删除' });
      await confirmation.getByRole('button', { name: '取消' }).click();
      await confirmation.waitFor({ state: 'hidden' });
      await row.waitFor();
      await row.getByTestId('story-menu-trigger').click();
      await row.getByRole('menuitem', { name: /删除/ }).click();
      if (mobile) {
        await page.goBack();
        await confirmation.waitFor({ state: 'hidden' });
        await row.waitFor();
        await row.getByTestId('story-menu-trigger').click();
        await row.getByRole('menuitem', { name: /删除/ }).click();
      }
      if (!mobile) await holdNextStoryStorageCommit(page, 'meta');
      await confirmation.getByRole('button', { name: '确认删除' }).click();
      if (!mobile) {
        await page.waitForFunction(() => typeof window.__lfhStoryCommitControl?.release === 'function');
        await library.getByRole('button', { name: '文游', exact: true }).click();
        await library.getByTestId('story-select-button').filter({ hasText: '浮灯渡口' }).first().click();
        await page.getByTestId('story-timeline').waitFor();
        await releaseHeldStoryStorageCommit(page);
        await page.getByTestId('story-timeline').waitFor();
        assert.equal(await page.getByTestId('welcome-view').count(), 0);
        await library.getByRole('button', { name: '产粮', exact: true }).click();
      }
      await row.waitFor({ state: 'detached' });
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    const mobileLibrary = page.getByTestId('mobile-library-dialog');
    if (await mobileLibrary.isVisible().catch(() => false)) {
      await mobileLibrary.getByRole('button', { name: '关闭书架' }).click();
      await mobileLibrary.waitFor({ state: 'hidden' });
    }
    const welcome = page.getByTestId('welcome-view');
    const settingsPage = page.getByTestId('settings-page');
    const importPanel = page.getByTestId('import-panel');
    const polishLibrary = page.getByTestId('desktop-library');
    const openCreationMode = async (label) => {
      if (await settingsPage.isVisible().catch(() => false)) {
        await settingsPage.getByRole('button', { name: '返回' }).click();
      }
      if (await importPanel.isVisible().catch(() => false)) {
        await importPanel.getByRole('button', { name: '返回' }).click();
      }
      if (!await welcome.isVisible().catch(() => false)) {
        await page.getByTestId('desktop-library-new-creation').click();
      }
      await welcome.waitFor();
      await welcome.getByRole('button', { name: label, exact: true }).click();
    };
    const waitForHeldCommit = () => page.waitForFunction(
      () => typeof window.__lfhStoryCommitControl?.release === 'function',
    );
    const readActiveStoryId = () => page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('local-fiction-harness');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const active = await new Promise((resolve, reject) => {
        const request = db.transaction('meta').objectStore('meta').get('activeStoryId');
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return active;
    });
    const waitForActiveStoryId = (expected) => page.waitForFunction(async (expected) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('local-fiction-harness');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const active = await new Promise((resolve, reject) => {
        const request = db.transaction('meta').objectStore('meta').get('activeStoryId');
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return active === expected;
    }, expected);
    const waitForStoredCreativeItemMissing = (title, collection) => page.waitForFunction(async ({ title, collection }) => {
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
      const items = entry?.value?.[collection] ?? [];
      return !items.some((item) => (collection === 'characters' ? item.name : item.title) === title);
    }, { title, collection });
    const waitForCreativeWorkBody = (title, body) => page.waitForFunction(async ({ title, body }) => {
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
      return entry?.value?.works?.some((work) => work.title === title && work.body === body) === true;
    }, { title, body });
    const assertWelcomeStage = async (deletedTitle) => {
      await welcome.waitFor();
      assert.equal(await page.locator('#turn-input').count(), 1, 'The welcome stage should expose exactly one story composer');
      assert.equal(await page.locator('#turn-input').isVisible(), true);
      if (deletedTitle) assert.equal((await page.getByTestId('main-stage').innerText()).includes(deletedTitle), false);
    };
    const newerStoryRow = polishLibrary.getByTestId('story-list-item').filter({
      has: page.locator('.story-list-title', { hasText: /^浮灯渡口$/ }),
    });

    // A slow story save stays on the welcome stage when settings opens after creation starts.
    await polishLibrary.getByRole('button', { name: '文游', exact: true }).click();
    await openCreationMode('文游');
    await page.fill('#turn-input', '慢速文游。创建期间的设置不能被关闭');
    const requestsBeforeSlowStory = requests.length;
    const activeBeforeSlowStory = await readActiveStoryId();
    await holdNextStoryStorageCommit(page, 'stories');
    await button('发送行动').click();
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    const slowStoryRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速文游' });
    await slowStoryRow.waitFor({ state: 'attached' });
    assert.equal(await settingsPage.isVisible(), true, 'A completed story creation must not close settings');
    assert.equal(await readActiveStoryId(), activeBeforeSlowStory, 'A creation hidden by settings must not activate its story');
    assert.equal(requests.length, requestsBeforeSlowStory, 'A stale story creation must not trigger its opening turn');
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();
    await polishLibrary.getByRole('button', { name: '文游', exact: true }).click();
    await slowStoryRow.waitFor();

    // A navigation change during the activation transaction rolls back to the previous active story.
    await openCreationMode('文游');
    await page.fill('#turn-input', '慢速激活。激活写入期间的设置不能被关闭');
    const requestsBeforeDelayedActivation = requests.length;
    await holdNextStoryStorageCommit(page, 'meta');
    await button('发送行动').click();
    const delayedActivationRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速激活' });
    await Promise.all([delayedActivationRow.waitFor({ state: 'attached' }), waitForHeldCommit()]);
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await waitForActiveStoryId(activeBeforeSlowStory);
    assert.equal(await settingsPage.isVisible(), true, 'A stale activation must not close newer settings navigation');
    assert.equal(requests.length, requestsBeforeDelayedActivation, 'A stale activation must not start an opening turn');
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();
    await go();
    assert.equal(
      await page.getByTestId('app-topbar').getByRole('heading', { name: '慢速激活', exact: true }).count(),
      0,
      'Reload must not open the story whose activation was rolled back',
    );

    // A later user selection wins even when the stale activation rollback finishes after it.
    await openCreationMode('文游');
    await page.fill('#turn-input', '慢速激活选择。用户选择不能被迟到回滚覆盖');
    const requestsBeforeSelectionDuringActivation = requests.length;
    await holdNextStoryStorageCommit(page, 'meta');
    await button('发送行动').click();
    const selectionDuringActivationRow = polishLibrary.getByTestId('story-list-item').filter({
      hasText: '慢速激活选择',
    });
    await Promise.all([selectionDuringActivationRow.waitFor({ state: 'attached' }), waitForHeldCommit()]);
    await newerStoryRow.getByTestId('story-select-button').click();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口', exact: true }).waitFor();
    const selectedActiveStoryId = await readActiveStoryId();
    await releaseHeldStoryStorageCommit(page);
    await selectionDuringActivationRow.waitFor();
    assert.equal(
      await page.getByTestId('app-topbar').getByRole('heading').innerText(),
      '浮灯渡口',
      'A stale activation rollback must not replace the newer story selection',
    );
    assert.equal(await readActiveStoryId(), selectedActiveStoryId);
    assert.equal(requests.length, requestsBeforeSelectionDuringActivation);
    await go();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口', exact: true }).waitFor();
    assert.equal(await readActiveStoryId(), selectedActiveStoryId);

    // A delayed story save cannot replace a newer story selection, in memory or after reload.
    await openCreationMode('文游');
    await page.fill('#turn-input', '慢速导航。迟到创建不能抢走用户选择');
    await holdNextStoryStorageCommit(page, 'stories');
    await button('发送行动').click();
    await waitForHeldCommit();
    await newerStoryRow.getByTestId('story-select-button').click();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口', exact: true }).waitFor();
    const newerActiveStoryId = await readActiveStoryId();
    await releaseHeldStoryStorageCommit(page);
    const lateNavigationStoryRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速导航' });
    await lateNavigationStoryRow.waitFor();
    assert.equal(await page.getByTestId('app-topbar').getByRole('heading').innerText(), '浮灯渡口');
    assert.equal(await readActiveStoryId(), newerActiveStoryId, 'The late story save must not change the active story');
    await go();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口', exact: true }).waitFor();
    assert.equal(await readActiveStoryId(), newerActiveStoryId, 'Reload must keep the user selection rather than the late creation');

    // Backup restore is newer navigation even while a story save is pending.
    await openCreationMode('文游');
    await page.fill('#turn-input', '慢速恢复。恢复备份应该取代这次创建');
    const requestsBeforeRestore = requests.length;
    await holdNextStoryStorageCommit(page, 'stories');
    await button('发送行动').click();
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await page.setInputFiles('[data-testid="backup-import-input"]', backupPath);
    await settingsPage.waitFor({ state: 'hidden' });
    await page.getByTestId('story-timeline').waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口（导入副本）', exact: true }).waitFor();
    const restoredActiveStoryId = await readActiveStoryId();
    await releaseHeldStoryStorageCommit(page);
    const lateRestoreStoryRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速恢复' });
    await lateRestoreStoryRow.waitFor();
    assert.equal(await page.getByTestId('app-topbar').getByRole('heading').innerText(), '浮灯渡口（导入副本）');
    assert.equal(await readActiveStoryId(), restoredActiveStoryId, 'The pending creation must not replace the restored active story');
    assert.equal(requests.length, requestsBeforeRestore, 'The pending creation must not start an opening turn after restore');
    await go();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '浮灯渡口（导入副本）', exact: true }).waitFor();

    // Deleting the active story under settings keeps settings open, then closes to a usable welcome stage.
    await polishLibrary.getByRole('button', { name: '文游', exact: true }).click();
    await slowStoryRow.getByTestId('story-select-button').click();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '慢速文游', exact: true }).waitFor();
    await slowStoryRow.getByTestId('story-menu-trigger').click();
    await slowStoryRow.getByRole('menuitem', { name: /删除/ }).click();
    const deleteConfirmation = page.getByRole('dialog', { name: '确认删除' });
    await deleteConfirmation.waitFor();
    await holdNextStoryStorageCommit(page, 'stories');
    await deleteConfirmation.getByRole('button', { name: '确认删除' }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await slowStoryRow.waitFor({ state: 'detached' });
    assert.equal(await settingsPage.isVisible(), true, 'Delete completion must not close newer settings navigation');
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage('慢速文游');
    assert.equal(await page.getByTestId('story-timeline').count(), 0);

    // Deleting the active story under import does the same, then leaves the deleted story off the shelf.
    await polishLibrary.getByRole('button', { name: '文游', exact: true }).click();
    await openCreationMode('文游');
    await page.fill('#turn-input', '删除导入文游。删除期间打开导入');
    await button('发送行动').click();
    await page.getByTestId('story-timeline').waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: '删除导入文游', exact: true }).waitFor();
    const importDeleteStoryRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '删除导入文游' });
    await importDeleteStoryRow.getByTestId('story-menu-trigger').click();
    await importDeleteStoryRow.getByRole('menuitem', { name: /删除/ }).click();
    await deleteConfirmation.waitFor();
    await holdNextStoryStorageCommit(page, 'stories');
    await deleteConfirmation.getByRole('button', { name: '确认删除' }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await waitForHeldCommit();
    await startScriptImport(page);
    await importPanel.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await importDeleteStoryRow.waitFor({ state: 'detached' });
    assert.equal(await importPanel.isVisible(), true, 'Delete completion must not close newer import navigation');
    await importPanel.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage('删除导入文游');
    assert.equal(await page.getByTestId('story-timeline').count(), 0);

    // Work creation finishing behind settings only adds a shelf entry.
    await polishLibrary.getByRole('button', { name: '产粮', exact: true }).click();
    await openCreationMode('产粮');
    await page.fill('#turn-input', '慢速产粮。创建期间的设置不能被关闭');
    await holdNextStoryStorageCommit(page, 'meta');
    await button('发送行动').click();
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    const workRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速产粮' });
    await workRow.waitFor({ state: 'attached' });
    assert.equal(await settingsPage.isVisible(), true);
    assert.equal(await writing.count(), 0, 'A stale work creation must not open the writing page');
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();

    // Character creation finishing behind import only adds a shelf entry.
    await polishLibrary.getByRole('button', { name: '角色', exact: true }).click();
    await openCreationMode('人机恋');
    await page.getByTestId('welcome-character-name').fill('明灯');
    await page.fill('#turn-input', '从人设推断名\n守夜的引路人。');
    await holdNextStoryStorageCommit(page, 'meta');
    await button('发送行动').click();
    await waitForHeldCommit();
    await startScriptImport(page);
    await importPanel.waitFor();
    await releaseHeldStoryStorageCommit(page);
    const namedCharacterRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '明灯' });
    await namedCharacterRow.waitFor({ state: 'attached' });
    assert.equal(await importPanel.isVisible(), true);
    assert.equal(await character.count(), 0, 'A stale character creation must not open the character page');
    await importPanel.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();

    // Direct manuscript creation also cannot open its page after settings takes navigation.
    await polishLibrary.getByRole('button', { name: '产粮', exact: true }).click();
    await openCreationMode('产粮');
    await holdNextStoryStorageCommit(page, 'meta');
    await welcome.getByRole('button', { name: '直接写正文', exact: true }).click();
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    const manuscriptRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '未命名作品' }).last();
    await manuscriptRow.waitFor({ state: 'attached' });
    assert.equal(await settingsPage.isVisible(), true);
    assert.equal(await writing.count(), 0, 'A stale direct-writing creation must not open its page');
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();
    await manuscriptRow.getByTestId('story-select-button').click();
    await writing.waitFor();
    await writing.locator('textarea.creative-manuscript').waitFor();

    // Rename and export remain available from the shelf overflow menu for works and characters.
    await polishLibrary.getByRole('button', { name: '产粮', exact: true }).click();
    await workRow.getByTestId('story-select-button').click();
    await writing.waitFor();
    await page.getByRole('group', { name: '作品视图' }).getByRole('button', { name: '正文' }).click();
    const exportedWorkBody = '慢速产粮导出内容 WORK-EXPORT-CONTENT';
    await writing.locator('textarea.creative-manuscript').fill(exportedWorkBody);
    await waitForCreativeWorkBody('慢速产粮', exportedWorkBody);
    await workRow.getByTestId('story-menu-trigger').click();
    await workRow.getByRole('menuitem', { name: '重命名' }).click();
    await polishLibrary.getByRole('textbox', { name: '重命名作品标题' }).fill('慢速产粮改名');
    await polishLibrary.getByRole('button', { name: '保存', exact: true }).click();
    const renamedWorkRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '慢速产粮改名' });
    await renamedWorkRow.waitFor();
    await renamedWorkRow.getByTestId('story-menu-trigger').click();
    const [workExport] = await Promise.all([
      page.waitForEvent('download'),
      renamedWorkRow.getByRole('menuitem', { name: '导出 .md' }).click(),
    ]);
    assert.match(workExport.suggestedFilename(), /慢速产粮改名\.md$/);
    assert.equal(fs.readFileSync(await workExport.path(), 'utf8'), exportedWorkBody);

    await polishLibrary.getByRole('button', { name: '角色', exact: true }).click();
    await namedCharacterRow.getByTestId('story-menu-trigger').click();
    await namedCharacterRow.getByRole('menuitem', { name: '重命名' }).click();
    await polishLibrary.getByRole('textbox', { name: '重命名角色标题' }).fill('明灯改名');
    await polishLibrary.getByRole('button', { name: '保存', exact: true }).click();
    const renamedCharacterRow = polishLibrary.getByTestId('story-list-item').filter({ hasText: '明灯改名' });
    await renamedCharacterRow.waitFor();
    await renamedCharacterRow.getByTestId('story-menu-trigger').click();
    const [characterExport] = await Promise.all([
      page.waitForEvent('download'),
      renamedCharacterRow.getByRole('menuitem', { name: '导出 .md' }).click(),
    ]);
    assert.match(characterExport.suggestedFilename(), /明灯改名\.md$/);
    assert.match(fs.readFileSync(await characterExport.path(), 'utf8'), /^# 明灯改名 · 本人聊天/m);

    // Deleting the active work under settings leaves settings open, then returns to the welcome stage.
    await polishLibrary.getByRole('button', { name: '产粮', exact: true }).click();
    await renamedWorkRow.getByTestId('story-select-button').click();
    await writing.waitFor();
    await renamedWorkRow.getByTestId('story-menu-trigger').click();
    await renamedWorkRow.getByRole('menuitem', { name: /删除作品/ }).click();
    await deleteConfirmation.waitFor();
    await holdNextStoryStorageCommit(page, 'meta');
    await deleteConfirmation.getByRole('button', { name: '确认删除' }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await waitForHeldCommit();
    await page.getByTestId('desktop-settings-open').click();
    await settingsPage.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await waitForStoredCreativeItemMissing('慢速产粮改名', 'works');
    await renamedWorkRow.waitFor({ state: 'detached' });
    assert.equal(await settingsPage.isVisible(), true);
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();
    assert.equal(await writing.count(), 0);

    // Deleting the active character under import leaves import open, then returns to the welcome stage.
    await polishLibrary.getByRole('button', { name: '角色', exact: true }).click();
    await renamedCharacterRow.getByTestId('story-select-button').click();
    await character.waitFor();
    await renamedCharacterRow.getByTestId('story-menu-trigger').click();
    await renamedCharacterRow.getByRole('menuitem', { name: /删除角色/ }).click();
    await deleteConfirmation.waitFor();
    await holdNextStoryStorageCommit(page, 'meta');
    await deleteConfirmation.getByRole('button', { name: '确认删除' }).click();
    await deleteConfirmation.waitFor({ state: 'hidden' });
    await waitForHeldCommit();
    await startScriptImport(page);
    await importPanel.waitFor();
    await releaseHeldStoryStorageCommit(page);
    await waitForStoredCreativeItemMissing('明灯改名', 'characters');
    await renamedCharacterRow.waitFor({ state: 'detached' });
    assert.equal(await importPanel.isVisible(), true);
    await importPanel.getByRole('button', { name: '返回' }).click();
    await assertWelcomeStage();
    assert.equal(await character.count(), 0);

  } finally {
    await context.close();
  }
}
