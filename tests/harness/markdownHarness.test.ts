import { describe, expect, it } from 'vitest';
import {
  adoptSuggestion, characterContext, createFictionHarness, createInMemoryStoryStorage, documentVersion, editStoryDocument, exportStoryBackup,
  importStoryBackup, newCharacter, newConversation, newDocument, newWork, splitMarkdownReply, storyDocumentState,
  visibleReplyPrefix, writeDocument,
  type LlmStreamRequest, type Story, type StoryDocuments, type TurnExecutionResult,
} from '../../src/harness/index.ts';

const config = { apiKey: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', memoryOnly: true };
const withDocs = (story: Story) => story as Story & { documents: StoryDocuments };

describe('three-mode Markdown Harness', () => {
  it('syncs a confirmed blueprint edit into story Markdown without replacing user material', async () => {
    const harness = createFictionHarness({ transport: { async *streamChat() { yield { contentDelta: 'ok', finishReason: 'stop' }; } } });
    const originalBlueprint = {
      title: '渡口', worldRules: ['旧规则'], protagonist: '旧主角', npcs: [], taboos: [], openingHook: '',
      extractionStatus: 'complete' as const,
    };
    const saved = withDocs(await harness.saveStory(harness.createStory({
      title: '渡口', rawScript: '原始剧本不可丢失', blueprint: originalBlueprint,
    })));
    const version = documentVersion(saved.documents.container);
    const markdownWithUserMaterial = version.markdown
      .replace('\n\n## 剧本原文', '\n\n玩家补充的确认区资料。\n\n## 剧本原文')
      + '\n\n## 用户补充\n\n这段手工资料要保留。';
    const withUserMaterial = withDocs(editStoryDocument(saved, 'container', version.id,
      markdownWithUserMaterial));
    const updated = withDocs(await harness.updateStoryBlueprint(withUserMaterial, {
      ...originalBlueprint,
      worldRules: ['新规则'],
      protagonist: '新主角',
      taboos: ['第三声钟响前不能离岸'],
    }));
    const currentVersion = storyDocumentState(updated, updated.activeLeafNodeId, true).container;
    const markdown = documentVersion(updated.documents.container, currentVersion).markdown;

    expect(markdown).toContain('主角设定：新主角');
    expect(markdown).toContain('核心规则：\n- 新规则');
    expect(markdown).toContain('第三声钟响前不能离岸');
    expect(markdown).toContain('原始剧本不可丢失');
    expect(markdown).toContain('玩家补充的确认区资料。');
    expect(markdown).toContain('这段手工资料要保留。');
    expect(markdown).not.toContain('旧主角');
  });

  it('rejects a manually changed confirmed anchor without changing the document', async () => {
    const harness = createFictionHarness({ transport: { async *streamChat() { yield { contentDelta: 'ok', finishReason: 'stop' }; } } });
    const saved = withDocs(await harness.saveStory(harness.createStory({ title: '渡口', rawScript: '原文' })));
    const version = documentVersion(saved.documents.container);
    const changed = withDocs(editStoryDocument(saved, 'container', version.id, version.markdown.replace('标题：渡口', '标题：手工修改')));
    const before = documentVersion(changed.documents.container).markdown;
    await expect(harness.updateStoryBlueprint(changed, { ...changed.blueprint, protagonist: '新主角' })).rejects.toThrow(/备份手工内容/);
    expect(documentVersion(changed.documents.container).markdown).toBe(before);
  });

  it.each(['标题：另一个标题\n\n主角设定：另一位主角', '核心规则：\n- 另一条规则'])('rejects blueprint fields appended outside the original anchor: %s', async (extra) => {
    const harness = createFictionHarness({ transport: { async *streamChat() { yield { contentDelta: 'ok', finishReason: 'stop' }; } } });
    const saved = withDocs(await harness.saveStory(harness.createStory({ title: '渡口', rawScript: '原文' })));
    const version = documentVersion(saved.documents.container);
    const changed = withDocs(editStoryDocument(saved, 'container', version.id,
      version.markdown.replace('\n\n## 剧本原文', `\n\n${extra}\n\n## 剧本原文`)));
    const before = documentVersion(changed.documents.container).markdown;
    await expect(harness.updateStoryBlueprint(changed, { ...changed.blueprint, protagonist: '新主角' })).rejects.toThrow(/备份手工内容/);
    expect(documentVersion(changed.documents.container).markdown).toBe(before);
  });

  it('reads the latest public version on a historical fork and keeps local edits on their own path', async () => {
    let publicDocument = newDocument('OLD-PUBLIC');
    const captured: LlmStreamRequest[] = [];
    const harness = createFictionHarness({
      loadPublicDocument: async () => publicDocument,
      transport: { async *streamChat(request) {
        captured.push(request);
        yield { contentDelta: '合成回执', finishReason: 'stop' };
      } },
    });
    const initial = harness.createStory({ title: '渡口', rawScript: 'FULL-SCRIPT-123' });
    const start = await harness.runTurn(initial, '起点', config);
    const originalRead = start.assistantNode.documentReads![0];
    let current = withDocs(start.story);
    current = withDocs(editStoryDocument(current, 'container', current.documents.container.head,
      documentVersion(current.documents.container).markdown + '\nNEW-CONTAINER'));
    current = withDocs(editStoryDocument(current, 'local', start.assistantNode.documents!.local, 'ONLY-FIRST-PATH'));
    const first = await harness.runTurn(current, '兄弟路径私密内容', config);
    expect(JSON.stringify(captured.at(-1)?.messages)).toContain('NEW-CONTAINER');
    expect(JSON.stringify(captured.at(-1)?.messages)).toContain('ONLY-FIRST-PATH');
    publicDocument = writeDocument(publicDocument, publicDocument.head, 'NEW-PUBLIC');
    const historical = await harness.rewindToNode(first.story, start.assistantNode.id);
    const branch = await harness.runTurn(historical, '从旧节点续写', config);
    const text = JSON.stringify(captured.at(-1)?.messages);
    expect(text).toContain('NEW-PUBLIC');
    expect(text).toContain('FULL-SCRIPT-123');
    expect(text).not.toMatch(/OLD-PUBLIC|NEW-CONTAINER|ONLY-FIRST-PATH|兄弟路径私密内容/);
    expect(branch.assistantNode.documentReads![0].versionId).toBe(publicDocument.head);
    expect(branch.story.nodes[start.assistantNode.id].documentReads![0]).toEqual(originalRead);

    const backup = exportStoryBackup(branch.story);
    expect(backup).not.toContain('NEW-PUBLIC');
    expect(importStoryBackup(backup, []).nodes[branch.assistantNode.id].documentReads).toEqual(branch.assistantNode.documentReads);
    const broken = JSON.parse(backup);
    broken.story.nodes[branch.assistantNode.id].summarySnapshot = {
      content: '错误摘要', coveredUpToNodeId: first.assistantNode.id, summarizedTurnCount: 1,
    };
    expect(importStoryBackup(JSON.stringify(broken), []).nodes[branch.assistantNode.id].summarySnapshot.content).toBe('');
    broken.story.nodes[start.assistantNode.id].parentId = branch.assistantNode.id;
    expect(() => importStoryBackup(JSON.stringify(broken), [])).toThrow(/父节点路径/);
  });

  it.each(['length', 'error'])('preserves the last successful coverage when compression returns %s', async (failure) => {
    const requests: LlmStreamRequest[] = [];
    let compressions = 0;
    const harness = createFictionHarness({
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 2000 },
      transport: { async *streamChat(request) {
        requests.push(request);
        if (!request.messages[0].content.includes('剧情摘要压缩')) {
          yield { contentDelta: '完整原文', finishReason: 'stop' };
          return;
        }
        if (++compressions === 1) {
          yield { contentDelta: '上次成功摘要', finishReason: 'stop' };
          return;
        }
        if (failure === 'error') throw new Error('fixture offline');
        yield { contentDelta: '不能作为进度的截断摘要', finishReason: failure };
      } },
    });
    let turn: TurnExecutionResult | undefined;
    const initial = harness.createStory({ title: 'fixture', rawScript: '' });
    for (const input of ['第一轮', '第二轮', '第三轮', '第四轮']) {
      turn = await harness.runTurn(turn?.story ?? initial, input, config);
    }
    expect(turn?.assistantNode.summarySnapshot.content).toBe('上次成功摘要');
    const narration = requests.filter((request) => !request.messages[0].content.includes('剧情摘要压缩')).at(-1);
    expect(JSON.stringify(narration?.messages)).toContain('第二轮');
    expect(JSON.stringify(narration?.messages)).not.toContain('不能作为进度');
  });

  it('asks for a retry if compression fails and the uncovered original cannot fit', async () => {
    let narrationCalls = 0;
    const harness = createFictionHarness({
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 100 },
      transport: { async *streamChat(request) {
        if (request.messages[0].content.includes('剧情摘要压缩')) {
          yield { contentDelta: '不能覆盖旧节点', finishReason: 'length' };
          return;
        }
        narrationCalls += 1;
        yield { contentDelta: '原文'.repeat(29), finishReason: 'stop' };
      } },
    });
    const first = await harness.runTurn(harness.createStory({ title: 'fixture' }), '一', config);
    const second = await harness.runTurn(first.story, '二', config);
    expect(second.assistantNode.summarySnapshot.coveredUpToNodeId).toBeNull();
    await expect(harness.runTurn(second.story, '三', config)).rejects.toThrow(/请重试续写/);
    expect(narrationCalls).toBe(2);
  });

  it('strips incomplete control lines, checks the draft revision and isolates a blank conversation', () => {
    const marker = '\x60\x60\x60lfh-change';
    expect(visibleReplyPrefix('回执\n' + marker.slice(0, -3))).toBe('回执\n');
    expect(splitMarkdownReply('回执\n' + marker + '\n{"target":"unknown","markdown":"bad"}\n\x60\x60\x60').proposal).toBeUndefined();

    const work = { ...newWork('纸月车站'), body: '正文', bodyRevision: 2 };
    const proposal = { id: 's', text: '更改', instruction: '替换', start: 0, end: 2, revision: 1, documentReads: [] };
    expect(() => adoptSuggestion(work, proposal)).toThrow();
    expect(adoptSuggestion(work, { ...proposal, revision: 2 }).body).toBe('更改');

    const role = newCharacter('岑灯', 'ORIGINAL-角色');
    const blank = newConversation(role, 'roleplay', '仅采用一条资料');
    const nextRole = { ...role, document: writeDocument(role.document, role.document.head, 'NEW-角色') };
    const context = characterContext(newDocument('公共最新版'), nextRole, blank, '邮差初访').messages;
    expect(JSON.stringify(context)).toMatch(/公共最新版.*ORIGINAL-角色.*仅采用一条资料.*邮差初访/);
    expect(JSON.stringify(context)).not.toContain('NEW-角色');
  });

  it('syncs confirmed blueprint title in container markdown when renaming a story so later blueprint tweaks succeed', async () => {
    const storage = createInMemoryStoryStorage();
    const harness = createFictionHarness({
      storage,
      transport: { async *streamChat() { yield { contentDelta: 'ok', finishReason: 'stop' }; } },
    });
    const created = await harness.createAndSaveStory({
      title: '旧渡口',
      rawScript: '原始设定不可丢失',
      blueprint: {
        title: '旧渡口',
        worldRules: ['规则甲'],
        protagonist: '旧主角',
        npcs: [],
        taboos: [],
        openingHook: '',
        extractionStatus: 'complete',
      },
    });
    const renamed = withDocs((await harness.renameStory(created.id, '新渡口'))!);
    expect(renamed.title).toBe('新渡口');
    expect(renamed.blueprint.title).toBe('新渡口');
    const containerMarkdown = documentVersion(renamed.documents.container).markdown;
    expect(containerMarkdown).toContain('标题：新渡口');
    expect(containerMarkdown).not.toContain('标题：旧渡口');

    const tweaked = withDocs(await harness.updateStoryBlueprint(renamed, {
      ...renamed.blueprint,
      protagonist: '新主角',
    }));
    expect(tweaked.blueprint.protagonist).toBe('新主角');
    expect(documentVersion(tweaked.documents.container).markdown).toContain('主角设定：新主角');
  });
});
