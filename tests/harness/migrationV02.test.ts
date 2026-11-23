import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  conversationLocalVersion,
  createDefaultBlueprint,
  documentVersion,
  editStoryDocument,
  emptyWorkspace,
  migrateStoryToV02,
  migrateWorkspaceToV02,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  writeDocument,
  type CreativeWorkspaceState,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function makeLegacyStory(overrides: Partial<Story> = {}): Story {
  const blueprint = {
    ...createDefaultBlueprint('雾港列车'),
    protagonist: '林栖（失忆列车员）',
    worldRules: ['午夜十二点后车厢禁止点灯', '票根决定记忆去留'],
    npcs: [{ name: '沈默', role: '检票员', traits: '寡言但守信' }],
    taboos: ['不可说出真实姓名'],
    openingHook: '你醒来时手里攥着半张湿透的车票。',
    extractionStatus: 'complete' as const,
  };
  return {
    id: 'story-v1-1',
    title: '雾港列车',
    sourceKind: 'manual_script',
    rawScript: '【开篇】海雾吞没了七号站台，最后一班绿皮车正在鸣笛。',
    blueprint,
    nodes: {
      n1: {
        id: 'n1',
        parentId: null,
        role: 'user',
        content: '推开车门。',
        createdAt: 1000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      n2: {
        id: 'n2',
        parentId: 'n1',
        role: 'assistant',
        content: '冷风裹着煤烟扑面而来。',
        createdAt: 2000,
        summarySnapshot: {
          content: '主角在七号站台登车。',
          coveredUpToNodeId: 'n1',
          summarizedTurnCount: 1,
        },
      },
    },
    rootNodeIds: ['n1'],
    activeLeafNodeId: 'n2',
    createdAt: 500,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('V0.1 -> V0.2 silent idempotent migration', () => {
  it('merges legacy blueprint and rawScript into canonical Story setting Markdown and is strictly idempotent', () => {
    const legacy = makeLegacyStory();
    const migratedOnce = migrateStoryToV02(legacy);

    expect(migratedOnce.v2Migrated).toBe(true);
    expect(migratedOnce.documents).toBeDefined();

    const containerMarkdown = documentVersion(
      migratedOnce.documents!.container,
      migratedOnce.nodes.n2.documents!.container,
    ).markdown;

    expect(containerMarkdown).toContain('标题：雾港列车');
    expect(containerMarkdown).toContain('主角设定：林栖（失忆列车员）');
    expect(containerMarkdown).toContain('午夜十二点后车厢禁止点灯');
    expect(containerMarkdown).toContain('沈默（检票员）');
    expect(containerMarkdown).toContain('不可说出真实姓名');
    expect(containerMarkdown).toContain('海雾吞没了七号站台');
    expect(containerMarkdown).toContain('你醒来时手里攥着半张湿透的车票。');
    expect(migratedOnce.nodes.n2.summarySnapshot.content).toBe('主角在七号站台登车。');

    const migratedTwice = migrateStoryToV02(migratedOnce);
    expect(migratedTwice).toEqual(migratedOnce);
  });

  it('preserves user edits when container document already diverged or has user versions', () => {
    const base = makeLegacyStory({
      documents: {
        container: newDocument('用户手写的全新故事设定，不要被旧蓝图覆盖。', 'user', 'user-v1'),
        local: newDocument('', 'migration', 'path-original'),
        edits: {},
      },
      nodes: {
        n1: {
          id: 'n1',
          parentId: null,
          role: 'user',
          content: '继续往前走。',
          createdAt: 1000,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          documents: { container: 'user-v1', local: 'path-original' },
        },
      },
      rootNodeIds: ['n1'],
      activeLeafNodeId: 'n1',
    });

    const edited = editStoryDocument(base, 'container', 'user-v1', '用户第二次修订的设定内容。');
    const migrated = migrateStoryToV02(edited);

    expect(migrated.v2Migrated).toBe(true);
    const activeVersionId =
      migrated.documents!.containerEdits?.[migrated.activeLeafNodeId ?? ''] ??
      migrated.documents!.container.head;
    const latestMarkdown = documentVersion(migrated.documents!.container, activeVersionId).markdown;

    expect(latestMarkdown).toBe('用户第二次修订的设定内容。');
    expect(latestMarkdown).not.toContain('海雾吞没了七号站台');
    expect(migrateStoryToV02(migrated)).toEqual(migrated);
  });

  it('migrates DraftWork linear discussion into a TurnNode tree while preserving backward readability', () => {
    const work = newWork('星港短篇', '# 作品设定\n\n太空歌剧');
    const t1: TurnNode = {
      id: 'd1',
      parentId: null,
      role: 'user',
      content: '帮我想一个雨夜开场。',
      createdAt: 100,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    const t2: TurnNode = {
      id: 'd2',
      parentId: null, // legacy linear item may lack parentId
      role: 'assistant',
      content: '玻璃穹顶外下着液态甲烷雨。',
      createdAt: 200,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    const t3: TurnNode = {
      id: 'd3',
      parentId: 'd2',
      role: 'user',
      content: '把节奏放慢一点。',
      createdAt: 300,
      summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    };
    work.discussion = [t1, t2, t3];
    delete work.discussionNodes;
    delete work.activeDiscussionLeafId;

    const workspace: CreativeWorkspaceState = {
      ...emptyWorkspace(),
      works: [work],
      activeWorkId: work.id,
    };

    const migrated = migrateWorkspaceToV02(workspace);
    expect(migrated.v2Migrated).toBe(true);

    const migratedWork = migrated.works[0];
    expect(migratedWork.discussionNodes).toBeDefined();
    expect(Object.keys(migratedWork.discussionNodes!)).toEqual(['d1', 'd2', 'd3']);
    expect(migratedWork.discussionNodes!.d1.parentId).toBeNull();
    expect(migratedWork.discussionNodes!.d2.parentId).toBe('d1');
    expect(migratedWork.discussionNodes!.d3.parentId).toBe('d2');
    expect(migratedWork.activeDiscussionLeafId).toBe('d3');
    // Preserves legacy linear discussion array for backward readability
    expect(migratedWork.discussion.map((n) => n.id)).toEqual(['d1', 'd2', 'd3']);

    // Idempotent on repeat calls
    const twice = migrateWorkspaceToV02(migrated);
    expect(twice).toEqual(migrated);
  });

  it('preserves LocalCharacter conversations intact and supplies sensible fallback titles without requiring kind split', () => {
    const character = newCharacter('谢知微', '# 角色设定\n\n冷静的档案修复师');
    const personalConv = newConversation(character, 'personal', '局内关系记录');
    delete (personalConv as { title?: string }).title;
    personalConv.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'user',
        content: '今晚加班吗？',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      c2: {
        id: 'c2',
        parentId: 'c1',
        role: 'assistant',
        content: '刚整理完第三排旧胶片。',
        createdAt: 200,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    };
    personalConv.activeLeafNodeId = 'c2';

    const roleplayConv = newConversation(character, 'roleplay', '对戏备忘');
    delete (roleplayConv as { title?: string }).title;
    const secondPersonal = newConversation(character, 'personal');
    delete (secondPersonal as { title?: string }).title;
    const titledConv = newConversation(character, 'roleplay');
    titledConv.title = '自定义雨夜线';

    character.conversations = [personalConv, roleplayConv, secondPersonal, titledConv];
    character.activeConversationId = personalConv.id;

    const workspace: CreativeWorkspaceState = {
      ...emptyWorkspace(),
      publicDocument: writeDocument(newDocument('我的偏好', 'user', 'pub-1'), 'pub-1', '偏好细腻对话'),
      characters: [character],
      activeCharacterId: character.id,
    };

    const migrated = migrateWorkspaceToV02(workspace);
    const convs = migrated.characters[0].conversations;
    expect(convs).toHaveLength(4);
    expect(convs[0].nodes.c2.content).toBe('刚整理完第三排旧胶片。');
    expect(convs[0].title).toBe('本人聊天');
    expect(convs[1].title).toBe('扮演对戏');
    expect(convs[2].title).toBe('本人聊天 2');
    expect(convs[3].title).toBe('自定义雨夜线');

    expect(migrateWorkspaceToV02(migrated)).toEqual(migrated);
  });

  it('repairs dangling character branch-note references saved by the story conversion bug', () => {
    const character = newCharacter('谢知微', '# 角色设定\n\n冷静的档案修复师');
    const conversation = newConversation(
      character,
      'personal',
      '## 当前进度\n\n她已经找到了那张缺失的胶片。',
    );
    conversation.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'user',
        content: '再找找第三排。',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: { container: character.document.head, local: conversation.document.head },
      },
      c2: {
        id: 'c2',
        parentId: 'c1',
        role: 'assistant',
        content: '胶片上是一段被剪掉的雨夜。',
        createdAt: 200,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: { container: 'story-original', local: 'story-local-v2' },
      },
    };
    conversation.activeLeafNodeId = 'c2';
    conversation.edits = { c2: 'story-local-v2' };
    character.conversations = [conversation];
    character.activeConversationId = conversation.id;
    const workspace: CreativeWorkspaceState = {
      ...emptyWorkspace(),
      characters: [character],
      activeCharacterId: character.id,
      v2Migrated: true,
    };

    const migrated = migrateWorkspaceToV02(workspace);
    const loaded = migrated.characters[0].conversations[0];
    const localVersion = documentVersion(loaded.document, conversationLocalVersion(loaded));

    expect(localVersion.markdown).toContain('她已经找到了那张缺失的胶片');
    expect(Object.values(loaded.nodes).every((node) => (
      Boolean(node.documents) &&
      Object.hasOwn(loaded.document.versions, node.documents!.local) &&
      Object.hasOwn(migrated.characters[0].document.versions, node.documents!.container)
    ))).toBe(true);
    expect(loaded.nodes.c2.content).toBe('胶片上是一段被剪掉的雨夜。');
    expect(migrateWorkspaceToV02(migrated)).toEqual(migrated);
  });

  it('keeps a valid node branch-note version when a saved edit override is dangling', () => {
    const character = newCharacter('谢知微', '# 角色设定\n\n冷静的档案修复师');
    const initialDocument = newDocument('## 当前进度\n\n仍可读取的有效分支笔记');
    const conversation = newConversation(character, 'personal');
    conversation.document = writeDocument(
      initialDocument,
      initialDocument.head,
      '## 当前进度\n\n后来写下的当前分支笔记',
      'user',
      'local-current',
    );
    conversation.nodes = {
      c1: {
        id: 'c1',
        parentId: null,
        role: 'assistant',
        content: '旧胶片里还有一段没看完。',
        createdAt: 100,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        documents: { container: character.document.head, local: initialDocument.head },
      },
    };
    conversation.activeLeafNodeId = 'c1';
    conversation.edits = { c1: 'story-local-v2' };
    character.conversations = [conversation];
    character.activeConversationId = conversation.id;

    const migrated = migrateWorkspaceToV02({
      ...emptyWorkspace(),
      characters: [character],
      activeCharacterId: character.id,
      v2Migrated: true,
    });
    const loaded = migrated.characters[0].conversations[0];

    expect(documentVersion(loaded.document, conversationLocalVersion(loaded)).markdown).toContain(
      '仍可读取的有效分支笔记',
    );
    expect(loaded.nodes.c1.content).toBe('旧胶片里还有一段没看完。');
  });
});
