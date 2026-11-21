import { getActiveBranchNodes } from './context.ts';
import {
  getWorkDiscussionTree,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type DraftWork,
  type InteractionMode,
  type LocalCharacter,
} from './creative.ts';
import {
  documentVersion,
  legacyStoryMarkdown,
  migrateStoryDocuments,
  writeDocument,
  type StoryDocuments,
} from './markdownDocuments.ts';
import type { Story, TurnNode } from './types.ts';

function buildCanonicalV02SettingMarkdown(story: Story, existingMarkdown: string): string {
  const sections: string[] = [];
  const base = existingMarkdown.trim() ? existingMarkdown.trimEnd() : legacyStoryMarkdown(story).trimEnd();
  if (base) {
    sections.push(base);
  }
  const rawScript = story.rawScript.trim();
  if (rawScript && !base.includes(rawScript)) {
    sections.push(`## 剧本原文\n\n${rawScript}`);
  }
  const openingHook = story.blueprint.openingHook.trim();
  if (openingHook && !base.includes(openingHook)) {
    sections.push(`## 开场导入\n\n${openingHook}`);
  }
  return sections.join('\n\n');
}

/**
 * Idempotently migrates a V0.1 Story (with legacy blueprint/rawScript) to V0.2 single-Markdown setting.
 * Preserves existing user edits if the container document has diverged or contains user versions.
 */
export function migrateStoryToV02(story: Story): Story {
  const allNodesHaveDocs = Object.values(story.nodes).every((node) => Boolean(node.documents));
  if (story.v2Migrated && story.documents && allNodesHaveDocs) {
    return story;
  }

  const scoped = migrateStoryDocuments(story) as Story & { documents: StoryDocuments };
  let container = scoped.documents.container;
  let nodes = scoped.nodes;

  if (!allNodesHaveDocs) {
    const updatedNodes: Record<string, TurnNode> = {};
    for (const [id, node] of Object.entries(nodes)) {
      updatedNodes[id] = node.documents
        ? node
        : {
            ...node,
            documents: {
              container: container.head,
              local: scoped.documents.local.head,
            },
          };
    }
    nodes = updatedNodes;
  }

  const versions = Object.values(container.versions);
  const hasUserEdit = versions.some((version) => version.source === 'user');
  const hasContainerEdits = Boolean(
    scoped.documents.containerEdits && Object.keys(scoped.documents.containerEdits).length > 0,
  );
  const isUntouchedMigration = !hasUserEdit && !hasContainerEdits && container.head === 'story-original';

  if (isUntouchedMigration) {
    const baseVersion = documentVersion(container, 'story-original');
    const canonical = buildCanonicalV02SettingMarkdown(scoped, baseVersion.markdown);
    if (canonical !== baseVersion.markdown && !Object.hasOwn(container.versions, 'v2-story-setting')) {
      container = writeDocument(
        container,
        'story-original',
        canonical,
        'migration',
        'v2-story-setting',
      );
      const updatedNodes: Record<string, TurnNode> = {};
      for (const [id, node] of Object.entries(nodes)) {
        updatedNodes[id] =
          node.documents?.container === 'story-original'
            ? { ...node, documents: { ...node.documents, container: container.head } }
            : node;
      }
      nodes = updatedNodes;
    }
  }

  return {
    ...scoped,
    nodes,
    documents: {
      ...scoped.documents,
      container,
    },
    v2Migrated: true,
  };
}

function migrateDraftWorkToV02(work: DraftWork): DraftWork {
  const hasTree = work.discussionNodes !== undefined;
  const hasLeaf = work.activeDiscussionLeafId !== undefined;
  if (hasTree && hasLeaf) {
    if (work.discussion.length === 0 && Object.keys(work.discussionNodes!).length > 0 && work.activeDiscussionLeafId) {
      return {
        ...work,
        discussion: getActiveBranchNodes(
          { nodes: work.discussionNodes!, activeLeafNodeId: work.activeDiscussionLeafId },
          work.activeDiscussionLeafId,
        ),
      };
    }
    return work;
  }

  const tree = getWorkDiscussionTree(work);
  const activeLeaf =
    work.activeDiscussionLeafId !== undefined
      ? work.activeDiscussionLeafId
      : tree.activeLeafNodeId;
  const discussion =
    work.discussion.length > 0
      ? work.discussion
      : activeLeaf
        ? getActiveBranchNodes(tree, activeLeaf)
        : [];

  return {
    ...work,
    discussion,
    discussionNodes: tree.nodes,
    activeDiscussionLeafId: activeLeaf,
  };
}

function migrateCharacterToV02(character: LocalCharacter): LocalCharacter {
  const usedTitles = new Set(
    character.conversations
      .map((conv) => conv.title?.trim())
      .filter((title): title is string => Boolean(title)),
  );

  let changed = false;
  const conversations: CharacterConversation[] = character.conversations.map((conv) => {
    const kind: InteractionMode = conv.kind === 'roleplay' ? 'roleplay' : 'personal';
    let title = conv.title?.trim();
    if (!title) {
      const base = kind === 'roleplay' ? '扮演对戏' : '本人聊天';
      let candidate = base;
      let suffix = 2;
      while (usedTitles.has(candidate)) {
        candidate = `${base} ${suffix}`;
        suffix += 1;
      }
      title = candidate;
      usedTitles.add(title);
      changed = true;
    }
    if (conv.kind !== kind || conv.title !== title) {
      changed = true;
      return { ...conv, kind, title };
    }
    return conv;
  });

  if (!changed) return character;
  return { ...character, conversations };
}

/**
 * Idempotently migrates V0.1 creative workspace state (写故事 linear discussion + 角色互动 legacy kinds)
 * to V0.2 TurnNode trees and titled conversations without losing any existing content.
 */
export function migrateWorkspaceToV02(workspace: CreativeWorkspaceState): CreativeWorkspaceState {
  let worksChanged = false;
  const works = workspace.works.map((work) => {
    const migrated = migrateDraftWorkToV02(work);
    if (migrated !== work) worksChanged = true;
    return migrated;
  });

  let charactersChanged = false;
  const characters = workspace.characters.map((character) => {
    const migrated = migrateCharacterToV02(character);
    if (migrated !== character) charactersChanged = true;
    return migrated;
  });

  if (!worksChanged && !charactersChanged && workspace.v2Migrated) {
    return workspace;
  }

  return {
    ...workspace,
    works: worksChanged ? works : workspace.works,
    characters: charactersChanged ? characters : workspace.characters,
    v2Migrated: true,
  };
}
