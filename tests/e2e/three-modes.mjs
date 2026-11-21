import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fence = '\x60'.repeat(3);
const proposal = (target, markdown, name) => `${fence}lfh-change\n${JSON.stringify({ target, markdown, name })}\n${fence}`;

export async function verifyThreeModes(browser, port, helpers) {
  const { newOfflineContext, mockSuccessfulKeyVerification, completePendingSetup, sseResponse, startScriptImport, holdNextStoryStorageCommit, releaseHeldStoryStorageCommit } = helpers;
  const context = await newOfflineContext(browser, port, { acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const requests = [];
    let failOpening = true;
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
      await page.evaluate((mode) => localStorage.setItem('lfh.ui.theme', mode), theme);
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        await go();
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

  } finally {
    await context.close();
  }
}
