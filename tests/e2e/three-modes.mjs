import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fence = '\x60'.repeat(3);
const proposal = (target, markdown, name) => `${fence}lfh-change\n${JSON.stringify({ target, markdown, name })}\n${fence}`;

export async function verifyThreeModes(browser, port, helpers) {
  const { newOfflineContext, mockSuccessfulKeyVerification, completePendingSetup, sseResponse, startScriptImport } = helpers;
  const context = await newOfflineContext(browser, port, { acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const requests = [];
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      const messages = route.request().postDataJSON().messages;
      requests.push(messages);
      const input = messages.at(-1)?.content ?? '';
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
    await page.getByTestId('welcome-view').getByRole('button', { name: /产粮/ }).click();
    await button('开新书').click();
    await page.getByLabel('作品标题').fill('纸月车站');
    await button('开始讨论').click();
    await page.getByLabel('讨论内容').fill('讨论纸月车站的开场');
    await button('发送').click();
    await completePendingSetup(page, 'sk-synthetic-fixture');
    await writing.getByText('AI · 废弃车站收到一件无人承认的行李。', { exact: true }).waitFor();
    await page.getByLabel('讨论内容').fill('把选定背景总结存入作品资料');
    await button('发送').click();
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await button('作品资料').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value.includes('失物招领员'));
    await dialog.getByRole('button', { name: '取消' }).click();
    await button('开始写').click();
    await writing.locator('textarea.creative-manuscript').fill('纸月照进车站。');
    await button('返回').click();
    await page.getByTestId('welcome-view').getByRole('button', { name: /人机恋/ }).click();
    await button('添加角色').click();
    await page.getByLabel('角色名称').fill('岑灯');
    await page.getByLabel('自由文本人设').fill('退役夜航员，寡言。PERSONA-UNIQUE');
    await button('保存角色').click();
    await button('本人聊天').click();
    await character.getByText('岑灯推开码头边的窗。', { exact: true }).waitFor();
    const requestPublicEdit = async () => {
      await page.getByLabel('发消息').fill('请保存公共记忆，今后只用短句');
      await button('发送').click();
      await dialog.getByRole('button', { name: '确认保存' }).waitFor();
    };
    await requestPublicEdit();
    const other = await context.newPage();
    await other.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await other.getByTestId('welcome-view').getByRole('button', { name: /产粮/ }).click();
    await other.getByRole('button', { name: '公共记忆', exact: true }).click();
    const otherDoc = other.getByTestId('markdown-document');
    await otherDoc.getByRole('textbox').fill('另一处已确认 ALT-PUBLIC');
    await otherDoc.getByRole('button', { name: '核对修改' }).click();
    await otherDoc.getByRole('button', { name: '确认保存' }).click();
    await otherDoc.waitFor({ state: 'hidden' });
    await other.close();
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await dialog.getByRole('button', { name: '重新核对' }).click();
    await dialog.getByText('查看之前拟保存的草稿').waitFor();
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
    await button('返回').click();

    await startScriptImport(page);
    await page.fill('#import-raw-script', '收灯人用三声钟响通知船主。钟响第三次之前，赤灯不可离岸。SCRIPT-END');
    await page.getByText('填写故事标题（可选）').click();
    await page.fill('#import-title', '浮灯渡口');
    await button('暂不拆解，直接开始').click();
    await page.getByTestId('turn-assistant').last().waitFor();
    await page.fill('#turn-input', '敲钟');
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByTestId('story-timeline').getByText('渡口灯亮，第二声钟响。', { exact: true }).waitFor();
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
    await button('产粮').click();
    assert.equal(await manuscript.inputValue(), downloaded);
    await button('纸月车站').click();
    await page.waitForFunction(() => document.querySelector('.creative-manuscript')?.value === '纸月照进车站。');

    await button('返回').click();
    const targetScreens = process.env.LFH_MODE_SCREENSHOTS;
    for (const theme of ['light', 'dark', 'warm']) {
      await page.evaluate((mode) => localStorage.setItem('lfh.ui.theme', mode), theme);
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        await go();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        for (const [name, target] of [['产粮', writing], ['人机恋', character]]) {
          if (viewport.width < 960) await page.getByTestId('library-drawer-trigger').click();
          await button(name).click();
          const bounds = await target.getByRole('button', { name: '返回' }).boundingBox();
          assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
          assert.ok(await target.locator('.overlay-page-content').evaluate((element) =>
            element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
          ), `Unexpected horizontal overflow in ${name}, ${theme}, ${viewport.width}`);
          if (targetScreens) await page.screenshot({ path: path.join(targetScreens, `${theme}-${viewport.width}-${name}.png`) });
          if (viewport.width < 960) await page.goBack();
          else await button('返回').click();
          await target.waitFor({ state: 'detached' });
        }
        if (targetScreens) await page.screenshot({ path: path.join(targetScreens, `${theme}-${viewport.width}-文游.png`) });
      }
    }
    await page.fill('#turn-input', '请把当前文游资料带入文游人设，建立新角色');
    await page.getByRole('button', { name: '发送行动' }).click();
    await dialog.getByText(/来源节点.*第二声钟响/).waitFor();
    await dialog.getByRole('button', { name: '确认保存' }).click();
    await character.getByRole('heading', { name: '收灯人' }).waitFor();
    await character.getByRole('button', { name: '角色人设' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=markdown-document] textarea')?.value.includes('SOURCE-COPY'));
  } finally {
    await context.close();
  }
}
