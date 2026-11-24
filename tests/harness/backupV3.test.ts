import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  EMPTY_SUMMARY_SNAPSHOT,
  characterContext,
  conversationLocalVersion,
  createDefaultBlueprint,
  detectBackupSchemaVersion,
  documentVersion,
  emptyWorkspace,
  exportFolioBackupV3,
  exportStoryBackup,
  mergeRestoredBackup,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  parseAndValidateFolioBackup,
  writeDocument,
  type CreativeWorkspaceState,
  type Story,
  type StoryBackupEnvelope,
  type TurnProposalRecord,
} from '../../src/harness/index.ts';

function makeSampleStory(id = 'story-1', title = '渡口夜话'): Story {
  const proposal: TurnProposalRecord = {
    id: 'prop-1',
    target: 'setting',
    op: 'patch',
    summary: '主角获得铜哨',
    status: 'pending',
    body: '<<<<<<< SEARCH\n- 物品：空\n=======\n- 物品：铜哨\n>>>>>>> REPLACE',
    baseVersionId: 'story-original',
  };
  return {
    id,
    title,
    sourceKind: 'manual_script',
    rawScript: '夜渡口规则：三更后不渡生人。',
    blueprint: createDefaultBlueprint(title),
    nodes: {
      n1: {
        id: 'n1',
        parentId: null,
        role: 'user',
        content: '走向渡口。',
        createdAt: 1000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      n2: {
        id: 'n2',
        parentId: 'n1',
        role: 'assistant',
        content: '船夫递来一枚铜哨。',
        createdAt: 2000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        proposals: [proposal],
      },
    },
    rootNodeIds: ['n1'],
    activeLeafNodeId: 'n2',
    createdAt: 500,
    updatedAt: 2000,
  };
}

describe('.folio.json v3 full backup, legacy .lfh.json compat & non-destructive merge', () => {
  it('exports valid v3 bundle covering all 3 modes, My Memory, display preferences, and strictly excludes API keys', () => {
    const story = makeSampleStory();
    const work = newWork('同人短篇', '# 作品设定\n\n雨夜站台');
    work.body = '正文第一段。';
    const character = newCharacter('江澄', '# 角色设定\n\n安静的书店老板');
    const conv = newConversation(character, 'personal', '日常记录');
    character.conversations = [conv];
    character.activeConversationId = conv.id;

    const workspace: CreativeWorkspaceState = {
      revision: 3,
      publicDocument: newDocument('偏好：不要剧透。', 'user', 'public-original'),
      works: [work],
      characters: [character],
      activeWorkId: work.id,
      activeCharacterId: character.id,
    };

    // Even if an unknown runtime object accidentally carried an apiKey property, export must strip it
    const poisonedWorkspace = { ...workspace, apiKey: 'sk-SECRET-LEAK-12345' } as unknown as CreativeWorkspaceState;

    const json = exportFolioBackupV3({
      stories: [story],
      workspace: poisonedWorkspace,
      appVersion: '0.2.0',
      displayPreferences: { themePreference: 'warm', fontSize: 18 },
      now: () => 1700000000000,
    });

    expect(json).not.toContain('sk-SECRET-LEAK-12345');
    expect(json).not.toContain('"apiKey"');

    const parsed = parseAndValidateFolioBackup(json);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.exportedAt).toBe(1700000000000);
    expect(parsed.appVersion).toBe('0.2.0');
    expect(parsed.displayPreferences).toEqual({ themePreference: 'warm', fontSize: 18 });
    expect(parsed.stories).toHaveLength(1);
    expect(parsed.stories[0].v2Migrated).toBe(true);
    expect(parsed.stories[0].nodes.n2.proposals?.[0].id).toBe('prop-1');
    expect(parsed.workspace.v2Migrated).toBe(true);
    expect(parsed.workspace.works[0].body).toBe('正文第一段。');
    expect(parsed.workspace.characters[0].name).toBe('江澄');
    expect(documentVersion(parsed.workspace.publicDocument).markdown).toBe('偏好：不要剧透。');
  });

  it('imports legacy .lfh.json v1 and v2 single-story backups into normalized v3 envelopes', () => {
    const legacyV1: StoryBackupEnvelope = {
      schemaVersion: 1,
      exportedAt: 12345,
      story: makeSampleStory('legacy-v1', '旧版v1故事'),
    };
    const parsedV1 = parseAndValidateFolioBackup(JSON.stringify(legacyV1));
    expect(parsedV1.schemaVersion).toBe(3);
    expect(parsedV1.stories).toHaveLength(1);
    expect(parsedV1.stories[0].id).toBe('legacy-v1');
    expect(parsedV1.stories[0].v2Migrated).toBe(true);
    expect(parsedV1.workspace.works).toEqual([]);
    expect(parsedV1.workspace.characters).toEqual([]);

    const v2Json = exportStoryBackup(makeSampleStory('legacy-v2', '旧版v2故事'));
    const parsedV2 = parseAndValidateFolioBackup(v2Json);
    expect(parsedV2.schemaVersion).toBe(3);
    expect(parsedV2.stories[0].id).toBe('legacy-v2');
    expect(parsedV2.stories[0].v2Migrated).toBe(true);
  });

  it('rejects malformed or invalid backup payloads with clear errors', () => {
    expect(() => parseAndValidateFolioBackup('not-json')).toThrow(/JSON/);
    expect(() => parseAndValidateFolioBackup(JSON.stringify({ schemaVersion: 99 }))).toThrow(/不支持/);
    expect(() =>
      parseAndValidateFolioBackup(
        JSON.stringify({
          schemaVersion: 3,
          exportedAt: 100,
          appVersion: '0.2.0',
          stories: 'bad',
          workspace: emptyWorkspace(),
        }),
      ),
    ).toThrow(/stories/);
    expect(() =>
      parseAndValidateFolioBackup(
        JSON.stringify({
          schemaVersion: 3,
          exportedAt: 100,
          appVersion: '0.2.0',
          stories: [],
          workspace: { ...emptyWorkspace(), works: 'bad' },
        }),
      ),
    ).toThrow(/works/);
  });

  it('performs non-destructive conflict merge by cloning colliding IDs and preserving existing user edits', () => {
    let seq = 0;
    const createId = () => `fresh-${++seq}`;

    const existingStory = makeSampleStory('story-shared', '本地修改版故事');
    const existingWork = { ...newWork('本地作品'), id: 'work-shared', body: '本地已编辑正文' };
    const existingChar = { ...newCharacter('本地角色', '本地人设'), id: 'char-shared' };
    const existingWorkspace: CreativeWorkspaceState = {
      revision: 4,
      publicDocument: newDocument('本地我的记忆内容', 'user', 'public-original'),
      works: [existingWork],
      characters: [existingChar],
      activeWorkId: existingWork.id,
      activeCharacterId: existingChar.id,
    };

    const incomingStory = makeSampleStory('story-shared', '备份里的故事');
    const incomingNewStory = makeSampleStory('story-new', '全新故事');
    const incomingWork = {
      ...newWork('备份作品'),
      id: 'work-shared',
      body: '备份正文',
      source: { storyId: 'story-shared', nodeId: 'n2' },
    };
    const incomingChar = {
      ...newCharacter('备份角色', '备份人设'),
      id: 'char-shared',
    };
    const conv = newConversation(incomingChar, 'personal');
    incomingChar.conversations = [conv];
    incomingChar.activeConversationId = conv.id;

    const incomingBackup = parseAndValidateFolioBackup(
      exportFolioBackupV3({
        stories: [incomingStory, incomingNewStory],
        workspace: {
          revision: 1,
          publicDocument: newDocument('备份里的我的记忆', 'user', 'public-original'),
          works: [incomingWork],
          characters: [incomingChar],
        },
      }),
    );

    const merged = mergeRestoredBackup(
      {
        stories: [existingStory],
        workspace: existingWorkspace,
        displayPreferences: { themePreference: 'dark', fontSize: 16 },
      },
      incomingBackup,
      { createId, now: () => 99999 },
    );

    // Existing records untouched
    expect(merged.stories.find((s) => s.id === 'story-shared')?.title).toBe('本地修改版故事');
    expect(merged.workspace.works.find((w) => w.id === 'work-shared')?.body).toBe('本地已编辑正文');
    expect(merged.workspace.characters.find((c) => c.id === 'char-shared')?.name).toBe('本地角色');

    // Colliding incoming items cloned with fresh IDs and (备份导入) marker
    expect(merged.stories).toHaveLength(3);
    const clonedStory = merged.stories.find((s) => s.title.includes('(备份导入)'));
    expect(clonedStory).toBeDefined();
    expect(clonedStory!.id).not.toBe('story-shared');
    expect(merged.stories.find((s) => s.id === 'story-new')).toBeDefined();

    expect(merged.workspace.works).toHaveLength(2);
    const clonedWork = merged.workspace.works.find((w) => w.id !== 'work-shared');
    expect(clonedWork).toBeDefined();
    expect(clonedWork!.title).toContain('(备份导入)');
    expect(clonedWork!.body).toBe('备份正文');
    // Source story reference follows the remapped story ID!
    expect(clonedWork!.source?.storyId).toBe(clonedStory!.id);

    expect(merged.workspace.characters).toHaveLength(2);
    const clonedChar = merged.workspace.characters.find((c) => c.id !== 'char-shared');
    expect(clonedChar).toBeDefined();
    expect(clonedChar!.name).toContain('(备份导入)');
    expect(clonedChar!.conversations[0].id).not.toBe(conv.id);
    expect(clonedChar!.activeConversationId).toBe(clonedChar!.conversations[0].id);

    // Public memory preserves both local edits and imported memory non-destructively
    const mergedPublic = documentVersion(merged.workspace.publicDocument).markdown;
    expect(mergedPublic).toContain('本地我的记忆内容');
    expect(mergedPublic).toContain('备份里的我的记忆');

    // Existing display preferences are not clobbered
    expect(merged.displayPreferences).toEqual({ themePreference: 'dark', fontSize: 16 });

    // Re-merging identical public memory does not duplicate the section
    const mergedAgain = mergeRestoredBackup(
      { stories: merged.stories, workspace: merged.workspace, displayPreferences: merged.displayPreferences },
      incomingBackup,
      { createId, now: () => 100000 },
    );
    expect(mergedAgain.report.mergedPublicMemory).toBe(false);
  });

  it('preserves an explicit null prompt-pack activation and remaps imported preference references', () => {
    let seq = 0;
    const createId = () => `fresh-${++seq}`;
    const localPack = {
      id: 'same-pack',
      title: '本地包',
      slots: { head: '本地规则', mid: '', tail: '' },
    };
    const incomingPack = {
      id: 'same-pack',
      title: '备份包',
      slots: { head: '备份规则', mid: '', tail: '' },
    };
    const incomingStory = makeSampleStory('story-with-pack', '带提示词包的故事');
    incomingStory.generationPreference = { promptPackMode: 'same-pack' };
    const incomingWork = { ...newWork('带提示词包的作品'), id: 'work-with-pack' };
    incomingWork.generationPreference = { promptPackMode: 'same-pack' };
    const incomingCharacter = { ...newCharacter('带提示词包的角色', '角色设定'), id: 'character-with-pack' };
    incomingCharacter.generationPreference = { promptPackMode: 'same-pack' };

    const merged = mergeRestoredBackup(
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK, localPack],
          activePackId: null,
        },
      },
      {
        stories: [incomingStory],
        workspace: {
          ...emptyWorkspace(),
          works: [incomingWork],
          characters: [incomingCharacter],
        },
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK, incomingPack],
          activePackId: 'same-pack',
        },
      },
      { createId },
    );

    const importedPack = merged.promptPacks?.packs.find((pack) => pack.title.includes('(备份导入)'));
    expect(importedPack).toBeDefined();
    expect(importedPack!.id).not.toBe('same-pack');
    expect(merged.promptPacks?.activePackId).toBeNull();
    expect(merged.stories[0].generationPreference?.promptPackMode).toBe(importedPack!.id);
    expect(merged.workspace.works[0].generationPreference?.promptPackMode).toBe(importedPack!.id);
    expect(merged.workspace.characters[0].generationPreference?.promptPackMode).toBe(importedPack!.id);
  });

  it('restores incoming prompt-pack global state when the local library is untouched defaults', () => {
    const incomingPack = {
      id: 'incoming-pack',
      title: '备份叙事包',
      slots: { head: '备份头部', mid: '备份中段', tail: '备份尾部' },
    };
    const merged = mergeRestoredBackup(
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
          activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
          defaultPrefixCompletion: 'on_retry',
          includeTail: false,
        },
      },
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK, incomingPack],
          activePackId: incomingPack.id,
          defaultPrefixCompletion: 'always',
          includeTail: true,
        },
      },
    );

    expect(merged.promptPacks?.activePackId).toBe(incomingPack.id);
    expect(merged.promptPacks?.defaultPrefixCompletion).toBe('always');
    expect(merged.promptPacks?.includeTail).toBe(true);
  });

  it('keeps modified local prompt-pack global state ahead of incoming defaults', () => {
    const local = {
      packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
      activePackId: null,
      defaultPrefixCompletion: 'off' as const,
      includeTail: true,
    };
    const merged = mergeRestoredBackup(
      { stories: [], workspace: emptyWorkspace(), promptPacks: local },
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
          activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
          defaultPrefixCompletion: 'always',
          includeTail: false,
        },
      },
    );

    expect(merged.promptPacks).toMatchObject({
      activePackId: null,
      defaultPrefixCompletion: 'off',
      includeTail: true,
    });
  });

  it('detects schema versions and rejects invalid TurnProposalRecord entries in backups', () => {
    const v3Json = exportFolioBackupV3({
      stories: [makeSampleStory()],
      workspace: emptyWorkspace(),
    });
    expect(detectBackupSchemaVersion(v3Json)).toBe(3);

    const v2Json = exportStoryBackup(makeSampleStory());
    expect(detectBackupSchemaVersion(v2Json)).toBe(2);

    const corrupted = JSON.parse(v3Json);
    corrupted.stories[0].nodes.n2.proposals[0].status = 'invalid_status';
    expect(() => parseAndValidateFolioBackup(JSON.stringify(corrupted))).toThrow(/proposals/);
  });

  it('round-trips complete REFUSAL diagnostics through .folio.json v3 and rejects invalid values', () => {
    const story = makeSampleStory('story-refusal');
    const diagnostics = {
      sourceStatus: 'REFUSAL' as const,
      refusalRoute: 'refused_exhausted' as const,
      recoveredFromText: '抱歉，我不能帮你写这段内容。',
      retriedWithPrefix: true,
      matchedRuleId: 'L1-02',
    };
    story.nodes.n2!.diagnostics = diagnostics;
    const json = exportFolioBackupV3({
      stories: [story],
      workspace: emptyWorkspace(),
    });

    const parsed = parseAndValidateFolioBackup(json);
    expect(parsed.stories[0]?.nodes.n2?.diagnostics).toEqual(diagnostics);

    const invalidValues = [
      ['sourceStatus', 'UNKNOWN'],
      ['refusalRoute', 'not-a-route'],
      ['recoveredFromText', 42],
      ['retriedWithPrefix', 'true'],
      ['matchedRuleId', 42],
    ] as const;
    for (const [field, value] of invalidValues) {
      const corrupted = JSON.parse(json) as {
        stories: Array<{ nodes: Record<string, { diagnostics?: Record<string, unknown> }> }>;
      };
      corrupted.stories[0]!.nodes.n2!.diagnostics![field] = value;
      expect(() => parseAndValidateFolioBackup(JSON.stringify(corrupted))).toThrow(new RegExp(field));
    }
  });

  it('round-trips TurnNode.prefillContent through .folio.json v3 and rejects non-string values', () => {
    const story = makeSampleStory('story-prefill');
    story.nodes.n2!.prefillContent = '船夫递来';
    const json = exportFolioBackupV3({
      stories: [story],
      workspace: emptyWorkspace(),
    });

    const parsed = parseAndValidateFolioBackup(json);
    expect(parsed.stories[0]?.nodes.n2?.prefillContent).toBe('船夫递来');

    const corrupted = JSON.parse(json) as {
      stories: Array<{ nodes: Record<string, Record<string, unknown>> }>;
    };
    corrupted.stories[0]!.nodes.n2!.prefillContent = 42;
    expect(() => parseAndValidateFolioBackup(JSON.stringify(corrupted))).toThrow(/prefillContent/);
  });

  it('preserves incoming built-in enabled: false state when the local prompt-pack library is untouched defaults', () => {
    const merged = mergeRestoredBackup(
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
          activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
          defaultPrefixCompletion: 'on_retry',
          includeTail: false,
        },
      },
      {
        stories: [],
        workspace: emptyWorkspace(),
        promptPacks: {
          packs: [{ ...BUILTIN_NARRATIVE_PROMPT_PACK, enabled: false }],
          activePackId: null,
          defaultPrefixCompletion: 'on_retry',
          includeTail: false,
        },
      },
    );

    const builtin = merged.promptPacks?.packs.find(
      (pack) => pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id,
    );
    expect(builtin?.enabled).toBe(false);
    expect(merged.promptPacks?.activePackId).toBeNull();
  });

  it('imports a recoverable dangling conversation characterVersion and keeps continuation readable', () => {
    const character = newCharacter('谢知微', 'PROFILE-HEAD');
    const conversation = newConversation(character, 'personal', '## 当前进度\n\n仍可继续。');
    conversation.characterVersion = 'missing-profile-version';
    conversation.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'assistant',
        content: '档案仍在。',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: { container: character.document.head, local: conversation.document.head },
      },
    };
    conversation.activeLeafNodeId = 'c1';
    character.conversations = [conversation];
    character.activeConversationId = conversation.id;

    const backup = JSON.parse(exportFolioBackupV3({
      stories: [],
      workspace: {
        revision: 1,
        publicDocument: newDocument('', 'user', 'public-original'),
        works: [],
        characters: [character],
        activeCharacterId: character.id,
      },
    }));
    backup.workspace.characters[0].conversations[0].characterVersion = 'missing-profile-version';

    const parsed = parseAndValidateFolioBackup(JSON.stringify(backup));
    const loadedCharacter = parsed.workspace.characters[0];
    const loaded = loadedCharacter.conversations[0];
    const context = characterContext(newDocument(''), loadedCharacter, loaded, '继续');

    expect(loaded.characterVersion).toBe(character.document.head);
    expect(context.messages.map((message) => message.content).join('\n')).toContain('PROFILE-HEAD');

    const invalidType = structuredClone(backup);
    invalidType.workspace.characters[0].conversations[0].characterVersion = 42;
    expect(() => parseAndValidateFolioBackup(JSON.stringify(invalidType))).toThrow(/characterVersion/);

    const emptyVersion = structuredClone(backup);
    emptyVersion.workspace.characters[0].conversations[0].characterVersion = '   ';
    expect(() => parseAndValidateFolioBackup(JSON.stringify(emptyVersion))).toThrow(/characterVersion/);
  });

  it('repairs a saved character edit override that points to a missing note version', () => {
    const character = newCharacter('谢知微', '# 角色设定\n\n冷静的档案修复师');
    const conversation = newConversation(character, 'personal', '## 当前进度\n\n仍可读取的有效分支笔记');
    conversation.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'assistant',
        content: '旧胶片里还有一段没看完。',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: {
          container: character.document.head,
          local: conversation.document.head,
        },
      },
    };
    conversation.activeLeafNodeId = 'c1';
    conversation.edits = { c1: 'missing-local-version' };
    character.conversations = [conversation];
    character.activeConversationId = conversation.id;

    const backup = JSON.parse(exportFolioBackupV3({
      stories: [],
      workspace: {
        revision: 1,
        publicDocument: newDocument('', 'user', 'public-original'),
        works: [],
        characters: [character],
        activeCharacterId: character.id,
      },
    }));
    backup.workspace.characters[0].conversations[0].edits.c1 = 'missing-local-version';

    const parsed = parseAndValidateFolioBackup(JSON.stringify(backup));
    const loaded = parsed.workspace.characters[0].conversations[0];
    expect(loaded.edits).toEqual({});
    expect(loaded.nodes.c1.documents?.local).toBe(conversation.document.head);
    expect(documentVersion(loaded.document, conversationLocalVersion(loaded)).markdown).toContain(
      '仍可读取的有效分支笔记',
    );

    const invalidAnchor = structuredClone(backup);
    invalidAnchor.workspace.characters[0].conversations[0].edits = {
      'missing-node': 'missing-local-version',
    };
    expect(() => parseAndValidateFolioBackup(JSON.stringify(invalidAnchor))).toThrow(/版本引用无效/);

    const invalidRevisionType = structuredClone(backup);
    invalidRevisionType.workspace.characters[0].conversations[0].edits.c1 = 42;
    expect(() => parseAndValidateFolioBackup(JSON.stringify(invalidRevisionType))).toThrow(/版本引用无效/);
  });
});
