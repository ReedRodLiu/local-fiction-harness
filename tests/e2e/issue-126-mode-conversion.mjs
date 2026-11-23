import assert from 'node:assert/strict';

const fence = '\x60'.repeat(3);
const TITLE = '灯塔转换 E2E';
const STORY_TURN = '继续走到塔顶';
const CHARACTER_TURN = '再敲一次钟';
const STORY_REPLY = '故事续写：钟声在渡口回荡。';
const CHARACTER_REPLY = '角色续写：雾里传来你的脚步声。';
const NOTE_FIRST = '## 当前进度\n\n第一版分支笔记，渡口仍然有雾。';
const NOTE_SECOND = '## 当前进度\n\n第二版分支笔记，灯塔重新亮起。';

const routeReply = ({ mode, title, characterName, settingMarkdown = '', body }) => [
  `${fence}lfh-route`,
  `mode: ${mode}`,
  `title: ${title}`,
  ...(characterName ? [`character_name: ${characterName}`] : []),
  '---',
  settingMarkdown,
  fence,
  body,
].join('\n');

const markdownDocument = (id, markdown, source = 'user') => ({
  head: id,
  versions: {
    [id]: {
      id,
      previous: null,
      markdown,
      savedAt: 1,
      source,
    },
  },
});

async function readStoredState(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('local-fiction-harness');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readStore = (name, key) => new Promise((resolve, reject) => {
      const request = key === undefined
        ? db.transaction(name).objectStore(name).getAll()
        : db.transaction(name).objectStore(name).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [stories, workspace, activeStory, activeCharacter] = await Promise.all([
      readStore('stories'),
      readStore('meta', 'creativeWorkspace'),
      readStore('meta', 'activeStoryId'),
      readStore('meta', 'activeCharacterId'),
    ]);
    db.close();
    const workspaceValue = workspace?.value;
    return {
      stories,
      workspace: workspaceValue,
      activeStoryId: activeStory?.value ?? null,
      activeCharacterId: workspaceValue?.activeCharacterId ?? activeCharacter?.value ?? null,
    };
  });
}

function assertDocumentReferences(container, conversation, label) {
  assert.equal(typeof conversation.activeLeafNodeId, 'string', `${label} has no active leaf`);
  const activeAnchor = conversation.activeLeafNodeId;
  const editVersion = conversation.edits?.[activeAnchor];
  const activeNodeVersion = conversation.nodes?.[activeAnchor]?.documents?.local;
  const effectiveVersion = editVersion ?? activeNodeVersion ?? conversation.document.head;
  assert.ok(conversation.document.versions?.[effectiveVersion], `${label} effective note version is missing`);
  for (const [id, node] of Object.entries(conversation.nodes)) {
    assert.ok(container.versions?.[node.documents?.container], `${label} node ${id} container reference is missing`);
    assert.ok(conversation.document.versions?.[node.documents?.local], `${label} node ${id} local reference is missing`);
  }
  return effectiveVersion;
}

function assertStoryDocumentReferences(story, label) {
  assert.ok(story.activeLeafNodeId, `${label} has no active leaf`);
  for (const [id, node] of Object.entries(story.nodes)) {
    assert.ok(story.documents?.container?.versions?.[node.documents?.container], `${label} node ${id} container reference is missing`);
    assert.ok(story.documents?.local?.versions?.[node.documents?.local], `${label} node ${id} local reference is missing`);
  }
  const editVersion = story.documents?.edits?.[story.activeLeafNodeId];
  const nodeVersion = story.nodes[story.activeLeafNodeId]?.documents?.local;
  const effectiveVersion = editVersion ?? nodeVersion ?? story.documents?.local?.head;
  assert.ok(story.documents?.local?.versions?.[effectiveVersion], `${label} effective note version is missing`);
  return effectiveVersion;
}

async function switchTopbarMode(page, target) {
  const switcher = page.getByTestId('topbar-mode-switcher');
  await switcher.waitFor({ state: 'visible' });
  await switcher.click();
  await page.getByTestId('topbar-mode-menu').waitFor();
  await page.getByTestId(`topbar-mode-option-${target}`).click();
}

async function closeStoryCompanion(page) {
  const sheet = page.getByTestId('story-tree-sheet');
  await sheet.getByRole('button', { name: '关闭剧情面板' }).click();
  await sheet.waitFor({ state: 'hidden' });
}

async function closeCharacterCompanion(page) {
  const sheet = page.getByTestId('creative-companion');
  await sheet.getByRole('button', { name: '关闭历史对话与设定面板' }).click();
  await sheet.waitFor({ state: 'hidden' });
}

async function openStoredCharacter(page, title) {
  const library = page.getByTestId('desktop-library');
  await library.getByRole('button', { name: '角色', exact: true }).click();
  const row = library.getByTestId('story-select-button').filter({ hasText: title }).first();
  await row.waitFor();
  await row.click();
  await page.getByTestId('character-page').waitFor();
}

async function verifyRecoverableBackupImport(browser, port, helpers) {
  const {
    newOfflineContext,
    mockSuccessfulKeyVerification,
    completePendingSetup,
  } = helpers;
  const context = await newOfflineContext(browser, port, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await mockSuccessfulKeyVerification(page);
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-key-hint').click();
    await completePendingSetup(page, 'sk-issue-126-backup');

    const characterDocument = markdownDocument('character-v1', '## 设定\n\n档案修复师。');
    const noteDocument = markdownDocument('note-v1', '## 当前进度\n\n仍可读取的有效分支笔记。');
    const backup = {
      schemaVersion: 3,
      exportedAt: 1,
      appVersion: '0.3.0',
      stories: [],
      workspace: {
        revision: 1,
        publicDocument: markdownDocument('public-v1', ''),
        works: [],
        characters: [{
          id: 'recoverable-character',
          name: '恢复角色',
          document: characterDocument,
          conversations: [{
            id: 'recoverable-conversation',
            title: '恢复对话',
            kind: 'personal',
            characterVersion: 'character-v1',
            document: noteDocument,
            edits: { c1: 'missing-note-version' },
            nodes: {
              c1: {
                id: 'c1',
                parentId: null,
                role: 'assistant',
                content: '旧胶片仍能打开。',
                createdAt: 1,
                summarySnapshot: { coveredUpToNodeId: null, content: '', summarizedTurnCount: 0 },
                documents: { container: 'character-v1', local: 'note-v1' },
              },
            },
            activeLeafNodeId: 'c1',
          }],
          activeConversationId: 'recoverable-conversation',
        }],
        activeCharacterId: 'recoverable-character',
        v2Migrated: true,
      },
    };

    await page.getByTestId('desktop-settings-open').click();
    await page.getByTestId('settings-page').waitFor();
    await page.setInputFiles('[data-testid="backup-import-input"]', {
      name: 'issue-126-recoverable.folio.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 3000 }).catch(async () => {
      const message = await page.getByTestId('main-error-banner').textContent().catch(() => '');
      throw new Error(`Recoverable backup import stayed on Settings: ${message}`);
    });
    await page.getByTestId('status-notice-banner').getByText('备份已安全合入', { exact: false }).waitFor();

    await openStoredCharacter(page, '恢复角色');
    await page.getByTestId('character-timeline').getByText('旧胶片仍能打开。', { exact: true }).waitFor();
    const state = await readStoredState(page);
    const imported = state.workspace.characters.find((item) => item.id === 'recoverable-character');
    const conversation = imported.conversations[0];
    assert.equal(conversation.edits.c1, undefined);
    assert.equal(assertDocumentReferences(imported.document, conversation, 'imported character'), 'note-v1');
    assert.equal(await page.getByTestId('main-error-banner').count(), 0);
  } finally {
    await context.close();
  }
}

export async function verifyIssue126ModeConversion(browser, port, helpers) {
  const {
    newOfflineContext,
    mockSuccessfulKeyVerification,
    completePendingSetup,
    sseResponse,
  } = helpers;
  const context = await newOfflineContext(browser, port, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await mockSuccessfulKeyVerification(page);
    await page.route('**/chat/completions', async (route) => {
      const messages = route.request().postDataJSON().messages;
      const system = messages[0]?.content ?? '';
      const input = messages.at(-1)?.content ?? '';
      let content = '一句十五字左右的合成背景更新摘要。';
      if (system.includes('自然语言第一入口助手')) {
        content = routeReply({
          mode: 'story',
          title: TITLE,
          settingMarkdown: '## 故事设定\n\n雾港只有一座灯塔。',
          body: '故事开场：雾里传来第一声钟响。',
        });
      } else if (system.includes('你是该角色本人')) {
        content = CHARACTER_REPLY;
      } else if (system.includes('你是文游的叙事者')) {
        content = STORY_REPLY;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]),
      });
    });

    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-key-hint').click();
    await completePendingSetup(page, 'sk-issue-126-mode');
    await page.fill('#turn-input', `开启文游：${TITLE}`);
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByTestId('story-timeline').getByText('故事开场：雾里传来第一声钟响。', { exact: true }).waitFor();
    await page.getByTestId('app-topbar').getByRole('heading', { name: TITLE, exact: true }).waitFor();

    await page.fill('#turn-input', STORY_TURN);
    await page.getByRole('button', { name: '发送行动' }).click();
    await page.getByTestId('story-timeline').getByText(STORY_REPLY, { exact: true }).waitFor();

    await page.getByTestId('open-companion-sheet').click();
    const storySheet = page.getByTestId('story-tree-sheet');
    await storySheet.waitFor();
    await storySheet.getByTestId('companion-tab-settings').click();
    await storySheet.getByTestId('branch-note-details').getByText('分支笔记', { exact: true }).click();
    await storySheet.getByTestId('edit-branch-note-btn').click();
    const documentDialog = page.getByTestId('markdown-document');
    await documentDialog.getByRole('textbox').fill(NOTE_FIRST);
    await documentDialog.getByRole('button', { name: '确认保存' }).click();
    await documentDialog.waitFor({ state: 'hidden' });
    await storySheet.getByTestId('edit-branch-note-btn').click();
    await documentDialog.getByRole('textbox').fill(NOTE_SECOND);
    await documentDialog.getByRole('button', { name: '确认保存' }).click();
    await documentDialog.waitFor({ state: 'hidden' });
    await closeStoryCompanion(page);

    const beforeConversion = await readStoredState(page);
    const originalStoryId = beforeConversion.activeStoryId;
    assert.equal(typeof originalStoryId, 'string');

    await switchTopbarMode(page, 'character');
    await page.getByTestId('character-page').waitFor();
    await page.getByTestId('status-notice-banner').getByText('已切换为「角色互动」', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('main-error-banner').count(), 0);
    await page.getByTestId('character-timeline').getByText('故事开场：雾里传来第一声钟响。', { exact: true }).waitFor();
    await page.getByTestId('character-timeline').getByText(STORY_REPLY, { exact: true }).waitFor();

    const afterStoryConversion = await readStoredState(page);
    assert.ok(afterStoryConversion.stories.some((story) => story.id === originalStoryId), 'source story disappeared');
    const character = afterStoryConversion.workspace.characters.find(
      (item) => item.id === afterStoryConversion.activeCharacterId,
    );
    assert.ok(character, 'converted character was not persisted');
    const conversation = character.conversations.find((item) => item.id === character.activeConversationId);
    assert.ok(conversation, 'converted conversation was not persisted');
    const effectiveNoteVersion = assertDocumentReferences(character.document, conversation, 'converted character');
    const noteLineage = [];
    let cursor = effectiveNoteVersion;
    while (cursor) {
      const version = conversation.document.versions[cursor];
      noteLineage.push(version.markdown);
      cursor = version.previous;
    }
    assert.ok(noteLineage.some((markdown) => markdown.includes('第一版分支笔记')));
    assert.ok(noteLineage.some((markdown) => markdown.includes('第二版分支笔记')));

    await page.getByTestId('open-companion-sheet').click();
    const characterSheet = page.getByTestId('creative-companion');
    await characterSheet.waitFor();
    await characterSheet.getByTestId('character-tab-profile').click();
    await characterSheet.getByTestId('branch-note-details').getByText('分支笔记', { exact: true }).click();
    await characterSheet.getByText('第二版分支笔记', { exact: false }).waitFor();
    await characterSheet.getByRole('button', { name: '编辑分支笔记' }).click();
    await documentDialog.getByRole('textbox').waitFor();
    assert.match(await documentDialog.getByRole('textbox').inputValue(), /第二版分支笔记/);
    await documentDialog.getByText('历史版本', { exact: true }).click();
    assert.ok(await documentDialog.getByRole('button', { name: '查看并恢复此版' }).count() > 0);
    await documentDialog.getByRole('button', { name: '取消' }).click();
    await documentDialog.waitFor({ state: 'hidden' });
    await closeCharacterCompanion(page);

    await page.getByLabel('发消息').fill(CHARACTER_TURN);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByTestId('character-timeline').getByText(CHARACTER_REPLY, { exact: true }).waitFor();

    await page.reload({ waitUntil: 'networkidle' });
    await openStoredCharacter(page, TITLE);
    await page.getByTestId('character-timeline').getByText(CHARACTER_REPLY, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('main-error-banner').count(), 0);

    await switchTopbarMode(page, 'story');
    await page.getByTestId('story-timeline').waitFor();
    await page.getByTestId('status-notice-banner').getByText('已切换为「文游」', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('main-error-banner').count(), 0);
    await page.getByTestId('story-timeline').getByText(CHARACTER_REPLY, { exact: true }).waitFor();

    const afterCharacterConversion = await readStoredState(page);
    assert.notEqual(afterCharacterConversion.activeStoryId, originalStoryId);
    assert.ok(afterCharacterConversion.workspace.characters.some((item) => item.id === character.id));
    assert.equal(afterCharacterConversion.stories.length >= 2, true);
    const convertedStory = afterCharacterConversion.stories.find(
      (story) => story.id === afterCharacterConversion.activeStoryId,
    );
    assertStoryDocumentReferences(convertedStory, 'converted story');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('app-topbar').getByRole('heading', { name: TITLE, exact: true }).waitFor();
    assert.equal(await page.getByTestId('main-error-banner').count(), 0);

    const library = page.getByTestId('desktop-library');
    const activeConvertedRow = library.locator('[data-testid="story-list-item"][data-active="true"]');
    await activeConvertedRow.getByTestId('story-menu-trigger').click();
    await activeConvertedRow.getByRole('menuitem', { name: '重命名' }).click();
    await library.getByRole('textbox', { name: '重命名故事标题' }).fill(`${TITLE} 转换目标`);
    await library.getByRole('button', { name: '保存', exact: true }).click();
    await library.getByText(`${TITLE} 转换目标`, { exact: true }).waitFor();
    await library.getByRole('button', { name: '文游', exact: true }).click();
    const originalStoryRow = library.getByTestId('story-select-button')
      .filter({ hasText: TITLE })
      .filter({ hasNotText: '转换目标' });
    await originalStoryRow.click();
    await page.waitForFunction(async (expectedId) => {
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
      return entry?.value === expectedId;
    }, originalStoryId);
    await page.getByTestId('story-timeline').getByText(STORY_REPLY, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('story-timeline').getByText(CHARACTER_REPLY, { exact: true }).count(), 0);

    await openStoredCharacter(page, TITLE);
    await page.getByTestId('character-timeline').getByText(CHARACTER_REPLY, { exact: true }).waitFor();

    await context.close();
    await verifyRecoverableBackupImport(browser, port, helpers);
  } catch (error) {
    await context.close();
    throw error;
  }
}
