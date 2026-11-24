import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  CHANGE_PROMPT,
  EMPTY_SUMMARY_SNAPSHOT,
  ENTRY_ROUTE_SYSTEM_PROMPT,
  PROMPT_PACK_SEMANTIC_PRIORITY,
  assembleThreeZoneContext,
  buildSystemAnchorPrompt,
  buildEntryRouteMessages,
  characterContext,
  createDefaultBlueprint,
  createFictionHarness,
  documentVersion,
  getActiveSummarySnapshot,
  invalidateStorySummarySnapshotsFromNode,
  invalidateSummarySnapshotsFromNode,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  writeDocument,
  workContext,
  type PromptPackLibrary,
  type LlmStreamRequest,
  type ModelConfig,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function version(markdown: string) {
  const document = newDocument(markdown);
  return document.versions[document.head];
}

function document(markdown: string) {
  return newDocument(markdown);
}

const library: PromptPackLibrary = {
  packs: [
    {
      ...BUILTIN_NARRATIVE_PROMPT_PACK,
      id: 'test-pack',
      title: '测试包',
      slots: { head: 'PACK_HEAD', mid: 'PACK_MID', tail: 'PACK_TAIL' },
      readOnly: false,
    },
  ],
  activePackId: 'test-pack',
};

function makeStory(): Story {
  return {
    id: 'story-1',
    title: '测试故事',
    rawScript: '当前设定正文',
    blueprint: createDefaultBlueprint('测试故事'),
    nodes: {
      user: {
        id: 'user',
        parentId: null,
        role: 'user',
        content: '近期玩家输入',
        createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      assistant: {
        id: 'assistant',
        parentId: 'user',
        role: 'assistant',
        content: '近期叙事回复',
        createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    },
    rootNodeIds: ['user'],
    activeLeafNodeId: 'assistant',
    createdAt: 1,
    updatedAt: 2,
  };
}

function positions(messages: readonly { content: string }[], markers: string[]): number[] {
  return markers.map((marker) => {
    const index = messages.findIndex((message) => message.content.includes(marker));
    expect(index, `missing marker ${marker}`).toBeGreaterThanOrEqual(0);
    return index;
  });
}

describe('Prompt Pack three-zone physical assembly', () => {
  it('includes the current setting when a prompt pack is enabled unless includeSetting is false', () => {
    const withSetting = buildSystemAnchorPrompt(makeStory(), 'assistant', undefined, {
      promptPackLibrary: library,
    });
    const withoutSetting = buildSystemAnchorPrompt(
      makeStory(),
      'assistant',
      undefined,
      { promptPackLibrary: library },
      false,
    );

    expect(withSetting).toContain('当前设定正文');
    expect(withoutSetting).not.toContain('当前设定正文');
  });

  it('keeps story pack slots, protected prompts, documents, history, tail, and user input ordered', () => {
    const context = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      undefined,
      false,
      {
        publicVersion: version('我的记忆：记忆内容'),
        container: version('当前设定：设定内容'),
        local: version('分支笔记：笔记内容'),
        snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
        promptPackLibrary: library,
        includePromptPackTail: true,
      },
    );
    const [head, base, mid, memory, setting, note, recent, tail, input] = positions(context.messages, [
      'PACK_HEAD',
      'lfh-summary',
      'PACK_MID',
      '我的记忆：记忆内容',
      '当前设定：设定内容',
      '分支笔记：笔记内容',
      '近期玩家输入',
      'PACK_TAIL',
      '本轮 user 输入',
    ]);
    expect(head).toBeLessThan(base);
    expect(base).toBeLessThan(mid);
    expect(mid).toBeLessThan(memory);
    expect(memory).toBeLessThan(setting);
    expect(setting).toBeLessThan(note);
    expect(note).toBeLessThan(recent);
    expect(recent).toBeLessThan(tail);
    expect(tail).toBeLessThan(input);
    expect(context.messages[base].content).toContain(CHANGE_PROMPT);
    expect(context.messages[base].content).toContain(PROMPT_PACK_SEMANTIC_PRIORITY);
    expect(context.metrics.anchorChars).toBeGreaterThan('PACK_HEAD'.length + 'PACK_MID'.length);
    expect(context.messages.map((message) => message.content).join('\n')).toContain('lfh-choices');
  });

  it('keeps memory before setting when the prompt pack is explicitly off', () => {
    const context = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      undefined,
      false,
      {
        publicVersion: version('我的记忆：记忆内容'),
        container: version('当前设定：设定内容'),
        local: version('分支笔记：笔记内容'),
        snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
        promptPackLibrary: library,
        generationPreference: { promptPackMode: 'off' },
      },
    );
    const [base, memory, setting, note, recent, input] = positions(context.messages, [
      'lfh-summary',
      '我的记忆：记忆内容',
      '当前设定：设定内容',
      '分支笔记：笔记内容',
      '近期玩家输入',
      '本轮 user 输入',
    ]);
    expect(context.messages[base].content).toContain(CHANGE_PROMPT);
    expect(context.messages[base].content).not.toContain('当前设定：设定内容');
    expect(base).toBeLessThan(memory);
    expect(memory).toBeLessThan(setting);
    expect(setting).toBeLessThan(note);
    expect(note).toBeLessThan(recent);
    expect(recent).toBeLessThan(input);
  });

  it('does not inject the tail by default and injects it when explicitly enabled', () => {
    const requestDocuments = {
      publicVersion: version('我的记忆：记忆内容'),
      container: version('当前设定：设定内容'),
      local: version('分支笔记：笔记内容'),
      snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      promptPackLibrary: library,
    };
    const withoutTail = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      undefined,
      false,
      requestDocuments,
    );
    const withTail = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      undefined,
      false,
      { ...requestDocuments, includePromptPackTail: true },
    );
    expect(withoutTail.messages.some((message) => message.content === 'PACK_TAIL')).toBe(false);
    expect(withTail.messages.some((message) => message.content === 'PACK_TAIL')).toBe(true);
  });

  it('counts anchor characters exactly without reducing the recent window budget', () => {
    const context = assembleThreeZoneContext(
      makeStory(),
      'assistant',
      '本轮 user 输入',
      { recentMaxChars: 10 },
      false,
      {
        publicVersion: version('我的记忆：记忆内容'),
        container: version('当前设定：设定内容'),
        local: version('分支笔记：笔记内容'),
        snapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
        promptPackLibrary: library,
      },
    );
    const settingIndex = context.messages.findIndex((message) => message.content.includes('当前设定：设定内容'));
    expect(settingIndex).toBeGreaterThanOrEqual(0);
    expect(context.metrics.anchorChars).toBe(
      context.messages.slice(0, settingIndex + 1).reduce((sum, message) => sum + message.content.length, 0),
    );
    expect(context.metrics.recentChars).toBe(
      '近期玩家输入'.length + '近期叙事回复'.length + '本轮 user 输入'.length,
    );
    expect(context.metrics.anchorChars).toBeGreaterThan(10);
  });

  it('uses the same pack seam for writing, character interaction, and welcome routing', () => {
    const work = newWork('作品', '作品当前设定');
    const writingContext = workContext(document('记忆'), work, '写作输入', {
      promptPackLibrary: library,
      includePromptPackTail: true,
    });
    expect(writingContext.messages[0].content).toBe('PACK_HEAD');
    expect(writingContext.messages[1].content).toContain('创作搭档');
    expect(writingContext.messages[2].content).toBe('PACK_MID');
    expect(writingContext.messages.at(-2)?.content).toBe('PACK_TAIL');
    expect(writingContext.messages.at(-1)?.content).toBe('写作输入');
    expect(work.title).toBe('作品');

    const character = newCharacter('角色', '角色设定');
    const conversation = newConversation(character, 'personal');
    const interactionContext = characterContext(
      document('记忆'),
      character,
      conversation,
      '角色输入',
      undefined,
      { promptPackLibrary: library },
    );
    expect(interactionContext.messages.slice(0, 3).map((message) => message.content)).toEqual([
      'PACK_HEAD',
      expect.stringContaining('你是该角色本人'),
      'PACK_MID',
    ]);
    expect(character.name).toBe('角色');

    const entry = buildEntryRouteMessages('欢迎输入', [], '欢迎页记忆', {
      promptPackLibrary: library,
      includePromptPackTail: true,
    });
    expect(entry[0].content).toBe('PACK_HEAD');
    expect(entry[1].content).toContain(ENTRY_ROUTE_SYSTEM_PROMPT);
    expect(entry[1].content).toContain(CHANGE_PROMPT);
    expect(entry[1].content).toContain(PROMPT_PACK_SEMANTIC_PRIORITY);
    expect(entry[1].content).toContain('lfh-route');
    expect(entry[1].content).toContain('entryRouter');
    expect(entry[1].content).toContain('lfh-proposal');
    expect(entry[2].content).toBe('PACK_MID');
    expect(entry.findIndex((message) => message.content.includes(PROMPT_PACK_SEMANTIC_PRIORITY))).toBeLessThan(
      entry.findIndex((message) => message.content === 'PACK_MID'),
    );
    expect(entry.at(-2)?.content).toBe('PACK_TAIL');
    expect(entry.at(-1)).toEqual({ role: 'user', content: '欢迎输入' });
  });

  it('invalidates changed history and descendant summaries for all three creative modes without touching siblings', () => {
    const nodes: Record<string, TurnNode> = {
      root: {
        id: 'root', parentId: null, role: 'user', content: '[root]', createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      target: {
        id: 'target', parentId: 'root', role: 'assistant', content: '[target-old]', createdAt: 2,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      nextUser: {
        id: 'nextUser', parentId: 'target', role: 'user', content: '[next-user]', createdAt: 3,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      activeLeaf: {
        id: 'activeLeaf', parentId: 'nextUser', role: 'assistant', content: '[active-leaf]', createdAt: 4,
        summarySnapshot: {
          content: 'STALE_ACTIVE_SUMMARY',
          coveredUpToNodeId: 'target',
          summarizedTurnCount: 3,
        },
      },
      siblingLeaf: {
        id: 'siblingLeaf', parentId: 'root', role: 'assistant', content: '[sibling-leaf]', createdAt: 5,
        summarySnapshot: {
          content: 'SIBLING_SUMMARY',
          coveredUpToNodeId: 'siblingLeaf',
          summarizedTurnCount: 1,
        },
      },
    };
    const replacedNodes: Record<string, TurnNode> = {
      ...nodes,
      target: { ...nodes.target, content: '[target-new]' },
    };
    const buildContexts = {
      story: (candidate: Record<string, TurnNode>) => assembleThreeZoneContext({
        ...makeStory(),
        nodes: candidate,
        rootNodeIds: ['root'],
        activeLeafNodeId: 'activeLeaf',
      }, 'activeLeaf', '继续'),
      writing: (candidate: Record<string, TurnNode>) => {
        const work = {
          ...newWork('测试作品'),
          discussionNodes: candidate,
          activeDiscussionLeafId: 'activeLeaf',
        };
        return workContext(newDocument(''), work, '继续');
      },
      character: (candidate: Record<string, TurnNode>) => {
        const character = newCharacter('角色', '角色设定');
        const conversation = {
          ...newConversation(character),
          nodes: candidate,
          activeLeafNodeId: 'activeLeaf',
        };
        return characterContext(newDocument(''), character, conversation, '继续');
      },
    };

    for (const buildContext of Object.values(buildContexts)) {
      const staleContext = JSON.stringify(buildContext(replacedNodes).messages);
      expect(staleContext).toContain('STALE_ACTIVE_SUMMARY');
      expect(staleContext).not.toContain('[target-new]');

      const invalidated = invalidateSummarySnapshotsFromNode(replacedNodes, 'target');
      const refreshedContext = JSON.stringify(buildContext(invalidated).messages);
      expect(refreshedContext).toContain('[target-new]');
      expect(refreshedContext).not.toContain('STALE_ACTIVE_SUMMARY');
      expect(invalidated.siblingLeaf.summarySnapshot).toEqual(nodes.siblingLeaf.summarySnapshot);
    }

    expect(replacedNodes.activeLeaf.summarySnapshot.content).toBe('STALE_ACTIVE_SUMMARY');
  });

  it('clears document progress on the changed story subtree so replaced history enters context', async () => {
    const rootLocal = newDocument('', 'user', 'local-original');
    const withTargetProgress = writeDocument(
      rootLocal,
      'local-original',
      '## 当前进度\n\nSTALE_TARGET_PROGRESS\n\n## 目标备忘\n\n保留目标备忘',
      'automatic',
      'local-target',
    );
    const withActiveProgress = writeDocument(
      withTargetProgress,
      'local-target',
      '## 当前进度\n\nSTALE_ACTIVE_PROGRESS\n\n## 关系记录\n\n保留用户关系记录',
      'automatic',
      'local-active',
    );
    const withSiblingProgress = writeDocument(
      withActiveProgress,
      'local-active',
      '## 当前进度\n\nSIBLING_PROGRESS',
      'automatic',
      'local-sibling',
    );
    const local = { ...withSiblingProgress, head: 'local-original' };
    const container = newDocument('当前设定', 'user', 'container-original');

    const nodes: Record<string, TurnNode> = {
      root: {
        id: 'root', parentId: null, role: 'user', content: '[root]', createdAt: 1,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      target: {
        id: 'target', parentId: 'root', role: 'assistant', content: '[target-old]', createdAt: 2,
        summarySnapshot: {
          content: 'STALE_TARGET_SUMMARY', coveredUpToNodeId: 'root', summarizedTurnCount: 1,
        },
        documents: { container: 'container-original', local: 'local-target' },
      },
      nextUser: {
        id: 'nextUser', parentId: 'target', role: 'user', content: '[next-user]', createdAt: 3,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      activeLeaf: {
        id: 'activeLeaf', parentId: 'nextUser', role: 'assistant', content: '[active-leaf]', createdAt: 4,
        summarySnapshot: {
          content: 'STALE_ACTIVE_SUMMARY', coveredUpToNodeId: 'target', summarizedTurnCount: 3,
        },
        documents: { container: 'container-original', local: 'local-target' },
      },
      siblingLeaf: {
        id: 'siblingLeaf', parentId: 'root', role: 'assistant', content: '[sibling-leaf]', createdAt: 5,
        summarySnapshot: {
          content: 'SIBLING_SUMMARY', coveredUpToNodeId: 'siblingLeaf', summarizedTurnCount: 1,
        },
        documents: { container: 'container-original', local: 'local-sibling' },
      },
    };
    const story: Story = {
      ...makeStory(),
      nodes,
      rootNodeIds: ['root'],
      activeLeafNodeId: 'activeLeaf',
      documents: {
        container,
        local,
        edits: { activeLeaf: 'local-active', siblingLeaf: 'local-sibling' },
      },
    };
    const replaced: Story = {
      ...story,
      nodes: { ...story.nodes, target: { ...story.nodes.target, content: '[target-new]' } },
    };

    const staleContext = JSON.stringify(assembleThreeZoneContext(replaced, 'activeLeaf', '继续').messages);
    expect(staleContext).toContain('STALE_ACTIVE_PROGRESS');
    expect(staleContext).not.toContain('[target-new]');

    const refreshed = invalidateStorySummarySnapshotsFromNode(replaced, 'target');
    expect(refreshed.activeLeafNodeId).toBe('activeLeaf');
    expect(refreshed.nodes.nextUser.parentId).toBe('target');
    expect(refreshed.nodes.activeLeaf.parentId).toBe('nextUser');
    expect(refreshed.nodes.activeLeaf.summarySnapshot).toEqual(EMPTY_SUMMARY_SNAPSHOT);
    expect(getActiveSummarySnapshot(refreshed, 'activeLeaf')).toEqual(EMPTY_SUMMARY_SNAPSHOT);
    expect(refreshed.documents?.local.head).toBe('local-original');
    expect(refreshed.nodes.siblingLeaf.summarySnapshot).toEqual(nodes.siblingLeaf.summarySnapshot);
    expect(refreshed.nodes.siblingLeaf.documents).toEqual(nodes.siblingLeaf.documents);
    expect(refreshed.documents?.edits.siblingLeaf).toBe('local-sibling');
    expect(getActiveSummarySnapshot(refreshed, 'siblingLeaf').content).toBe('SIBLING_PROGRESS');

    const activeLocalId = refreshed.documents?.edits.activeLeaf;
    expect(activeLocalId).toBeDefined();
    expect(activeLocalId).not.toBe('local-active');
    expect(refreshed.nodes.activeLeaf.documents?.local).toBe(activeLocalId);
    const activeLocal = documentVersion(refreshed.documents!.local, activeLocalId).markdown;
    expect(activeLocal).toContain('保留用户关系记录');
    expect(activeLocal).not.toContain('STALE_ACTIVE_PROGRESS');
    expect(refreshed.nodes.target.documents?.local).not.toBe('local-target');
    expect(documentVersion(refreshed.documents!.local, refreshed.nodes.target.documents!.local).markdown)
      .toContain('保留目标备忘');

    const refreshedContext = JSON.stringify(assembleThreeZoneContext(refreshed, 'activeLeaf', '继续').messages);
    expect(refreshedContext).toContain('[target-new]');
    expect(refreshedContext).not.toContain('STALE_ACTIVE_PROGRESS');
    expect(refreshedContext).not.toContain('STALE_ACTIVE_SUMMARY');

    const requests: LlmStreamRequest[] = [];
    const config: ModelConfig = {
      apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', memoryOnly: true,
    };
    const harness = createFictionHarness({
      transport: {
        async *streamChat(request) {
          requests.push(request);
          yield { contentDelta: '模型继续叙事。', finishReason: 'stop' };
        },
      },
    });
    await harness.runTurn(refreshed, '继续', config);
    const preparedContext = JSON.stringify(requests[0]?.messages);
    expect(preparedContext).toContain('[target-new]');
    expect(preparedContext).not.toContain('STALE_ACTIVE_PROGRESS');
    expect(preparedContext).not.toContain('STALE_ACTIVE_SUMMARY');
  });
});
