import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  assembleThreeZoneContext,
  createDefaultPromptPackLibrary,
  createPromptPack,
  createDefaultBlueprint,
  excludeRefusedTurns,
  isDefaultPromptPackLibrary,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { GenerationControls } from '../../src/ui/GenerationControls.tsx';
import { PromptPackSheet } from '../../src/ui/PromptPackSheet.tsx';
import {
  finalizePrefixContinuation,
  streamPrefixContinuation,
} from '../../src/ui/refusalContinuation.ts';
import { StoryTree } from '../../src/ui/StoryTree.tsx';
import { TurnCard } from '../../src/ui/TurnCard.tsx';

function makeNode(overrides: Partial<TurnNode> = {}): TurnNode {
  return {
    id: 'assistant-refusal',
    parentId: 'user-1',
    role: 'assistant',
    content: '已经写出的正文。',
    createdAt: 2,
    summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
    ...overrides,
  };
}

function makeStory(node: TurnNode): Story {
  return {
    id: 'story-refusal',
    title: '拒答测试',
    rawScript: '',
    blueprint: createDefaultBlueprint('拒答测试'),
    nodes: {
      'user-1': {
        id: 'user-1',
        parentId: null,
        role: 'user',
        content: '继续。',
        createdAt: 1,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      [node.id]: node,
    },
    rootNodeIds: ['user-1'],
    activeLeafNodeId: node.id,
    createdAt: 1,
    updatedAt: 2,
  };
}

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('Issue #133 prompt pack and refusal UI contracts', () => {
  it('renders the prompt pack first-class settings sheet with exact copy and all controls', () => {
    const library = createDefaultPromptPackLibrary();
    const custom = createPromptPack('custom-pack', {
      head: '开头规则',
      mid: '中段规则',
      tail: '尾段规则',
    }, { title: '自定义叙事包' });
    library.packs.push(custom);
    library.activePackId = custom.id;

    const markup = renderToStaticMarkup(createElement(PromptPackSheet, {
      library,
      onChange: vi.fn(),
      onExport: vi.fn(),
    }));

    expect(markup).toContain('data-testid="settings-prompt-pack-section"');
    expect(markup).toContain('叙事提示词包与拒答治理');
    expect(markup).toContain('自定义前置叙事框架、前缀续写与拒答自动重拟');
    expect(markup).toContain('data-testid="prompt-pack-enable-toggle"');
    expect(markup).toContain('data-testid="prompt-pack-import-input"');
    expect(markup).toContain('data-testid="prompt-pack-slot-head"');
    expect(markup).toContain('data-testid="prompt-pack-slot-mid"');
    expect(markup).toContain('data-testid="prompt-pack-slot-tail"');
    expect(markup).toContain('data-testid="prompt-pack-tail-always"');
    expect(markup).toContain('data-testid="prompt-pack-global-prefix"');
    expect(markup).toContain('data-testid="prompt-pack-disclaimer"');
    expect(markup).toContain('24000');
    expect(markup).toContain('6000');
    expect(markup).toContain('2000');
    expect(markup).toContain('Folio 基础叙事骨架');
    expect(markup).toContain('提示词包在技术上作为系统提示词（System Prompt）');
    expect(markup.indexOf('data-testid="prompt-pack-disclaimer"')).toBeLessThan(
      markup.indexOf('class="prompt-pack-import-block"'),
    );
  });

  it('renders story-level prompt-pack and prefix selectors next to the existing generation controls', () => {
    const markup = renderToStaticMarkup(createElement(GenerationControls, {
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      onModelChange: vi.fn(),
      onReasoningEffortChange: vi.fn(),
      promptPackLibrary: createDefaultPromptPackLibrary(),
      promptPackMode: 'inherit',
      prefixCompletion: 'inherit',
      onPromptPackModeChange: vi.fn(),
      onPrefixCompletionChange: vi.fn(),
    }));

    expect(markup).toContain('data-testid="generation-pref-prompt-pack"');
    expect(markup).toContain('data-testid="generation-pref-prefix-mode"');
    expect(markup).toContain('跟随全局');
    expect(markup).toContain('在此条目停用');
    expect(markup).toContain(BUILTIN_NARRATIVE_PROMPT_PACK.title);
    expect(markup).toContain('仅重试时开启');
    expect(markup).toContain('每轮开启');
  });

  it('renders recovered restore and partial-refusal continue actions on assistant turns', () => {
    const recovered = makeNode({
      diagnostics: {
        refusalRoute: 'retry',
        recoveredFromText: '抱歉，我不能帮你写这段内容。',
        retriedWithPrefix: true,
      },
    });
    const recoveredMarkup = renderToStaticMarkup(createElement(TurnCard, {
      node: recovered,
      isActiveLeaf: true,
      isLatestTurn: true,
      isSetupNode: false,
      turnNumber: 1,
      isBusy: false,
      isStreaming: false,
      siblings: { siblings: [recovered], prevSiblingId: null, nextSiblingId: null, currentIndex: 0, total: 1 },
      onSwitchBranch: vi.fn(),
      onRewindToNode: vi.fn(),
      onRestoreRefusalOriginal: vi.fn(),
      onContinuePartialRefusal: vi.fn(),
    }));
    expect(recoveredMarkup).toContain('data-testid="turn-refusal-recovered-badge"');
    expect(recoveredMarkup).toContain('data-testid="turn-refusal-restore-original"');
    expect(recoveredMarkup).toContain('已自动重拟（消耗双倍 Token）');

    const partial = makeNode({
      content: '雨声落下。抱歉，我不能继续写更具体的内容。',
      diagnostics: {
        refusalRoute: 'partial_refused',
        recoveredFromText: '抱歉，我不能继续写更具体的内容。',
      },
    });
    const partialMarkup = renderToStaticMarkup(createElement(TurnCard, {
      node: partial,
      isActiveLeaf: true,
      isLatestTurn: true,
      isSetupNode: false,
      turnNumber: 1,
      isBusy: false,
      isStreaming: false,
      siblings: { siblings: [partial], prevSiblingId: null, nextSiblingId: null, currentIndex: 0, total: 1 },
      onSwitchBranch: vi.fn(),
      onRewindToNode: vi.fn(),
      onRestoreRefusalOriginal: vi.fn(),
      onContinuePartialRefusal: vi.fn(),
    }));
    expect(partialMarkup).toContain('data-testid="turn-partial-refusal-banner"');
    expect(partialMarkup).toContain('data-testid="turn-partial-refusal-continue"');
    expect(partialMarkup).toContain('模型似乎略过了部分具体描写');
    expect(partialMarkup).toContain('将消耗一次新请求');
  });

  it('streams a manual prefix continuation while exposing only newly appended text', async () => {
    const requests: Array<{ prefixCompletion?: { content: string } }> = [];
    const visible: string[] = [];
    const result = await streamPrefixContinuation({
      transport: {
        async *streamChat(request) {
          requests.push(request);
          yield { contentDelta: '原有正文' };
          yield { contentDelta: '，新增段落。', finishReason: 'stop' };
        },
      },
      config: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        memoryOnly: false,
      },
      messages: [{ role: 'user', content: '继续。' }],
      prefixContent: '原有正文',
      onContentDelta: (delta) => visible.push(delta),
    });

    expect(requests[0]?.prefixCompletion?.content).toBe('原有正文');
    expect(visible.join('')).toBe('，新增段落。');
    expect(result.content).toBe('原有正文，新增段落。');
    expect(result.finishReason).toBe('stop');
  });

  it.each([
    {
      name: 'echoed prefix with only an lfh-summary block',
      content: '已经写出的正文。\n\n```lfh-summary\n没有新增正文。\n```',
    },
    {
      name: 'empty body',
      content: '',
    },
  ])('rejects $name and keeps the partial-refusal retry entry available', ({ content }) => {
    const node = makeNode({ diagnostics: { refusalRoute: 'partial_refused' } });
    const before = structuredClone(node);

    expect(() => finalizePrefixContinuation(node, {
      content,
      reasoningContent: '',
      finishReason: 'stop',
    }, { mode: 'story' })).toThrow('模型没有返回可追加的正文。');

    expect(node).toEqual(before);
    const markup = renderToStaticMarkup(createElement(TurnCard, {
      node,
      isActiveLeaf: true,
      isLatestTurn: true,
      isSetupNode: false,
      turnNumber: 1,
      isBusy: false,
      isStreaming: false,
      siblings: { siblings: [node], prevSiblingId: null, nextSiblingId: null, currentIndex: 0, total: 1 },
      onSwitchBranch: vi.fn(),
      onRewindToNode: vi.fn(),
      onContinuePartialRefusal: vi.fn(),
    }));
    expect(markup).toContain('data-testid="turn-partial-refusal-continue"');
  });

  it('accepts a proposal-only continuation while preserving the original body', () => {
    const node = makeNode({ diagnostics: { refusalRoute: 'partial_refused' } });
    const finalized = finalizePrefixContinuation(node, {
      content: [
        '```lfh-proposal',
        'target: note',
        'op: append',
        'summary: 记录追加线索',
        '---',
        '- 新线索',
        '```',
      ].join('\n'),
      reasoningContent: '',
      finishReason: 'stop',
    }, { mode: 'story' });

    expect(finalized.content).toBe(node.content);
    expect(finalized.proposals).toHaveLength(1);
  });

  it('parses prefix continuation protocols, strips fences, and merges new proposal records', () => {
    const node = makeNode({
      turnSummary: '此前摘要。',
      proposals: [{
        id: 'existing-proposal',
        target: 'setting',
        op: 'append',
        summary: '既有提案',
        status: 'pending',
        body: '- 既有内容',
      }],
    });
    const finalized = finalizePrefixContinuation(
      node,
      {
        content: [
          node.content,
          '',
          '新增正文。',
          '',
          '```lfh-summary',
          '新增剧情摘要。',
          '```',
          '',
          '```lfh-proposal',
          'target: setting',
          'op: append',
          'summary: 记录新增线索',
          '---',
          '- 新线索',
          '```',
          '',
          '```lfh-proposal',
          'target: note',
          'op: append',
          'summary: 半截局部笔记',
          '---',
          '- 未闭合内容',
        ].join('\n'),
        reasoningContent: '继续推理。',
        finishReason: 'stop',
      },
      { mode: 'story', baseVersions: { setting: 'setting-v2' }, now: 123 },
    );

    expect(finalized.content).toBe(`${node.content}\n\n新增正文。`);
    expect(finalized.content).not.toContain('lfh-summary');
    expect(finalized.turnSummary).toBe('新增剧情摘要。');
    expect(finalized.reasoningContent).toBe('继续推理。');
    expect(finalized.proposals).toHaveLength(3);
    expect(finalized.proposals?.[0]).toMatchObject({ id: 'existing-proposal' });
    expect(finalized.proposals?.[1]).toMatchObject({
      target: 'setting',
      status: 'pending',
      baseVersionId: 'setting-v2',
    });
    expect(finalized.proposals?.[2]).toMatchObject({
      target: 'note',
      status: 'needs_review',
      reason: 'unclosed_fence',
    });
  });

  it('preserves a thin second refusal as REFUSAL instead of marking the continuation pass', () => {
    const node = makeNode({ diagnostics: { refusalRoute: 'partial_refused' } });
    const finalized = finalizePrefixContinuation(
      node,
      {
        content: `${node.content}\n\n抱歉，我不能继续写这段内容。`,
        reasoningContent: '',
        finishReason: 'stop',
      },
      { mode: 'story' },
    );

    expect(finalized.content).toContain('抱歉，我不能继续写这段内容。');
    expect(finalized.diagnostics).toMatchObject({
      sourceStatus: 'REFUSAL',
      refusalRoute: 'retry',
    });
    expect(finalized.diagnostics?.refusalRoute).not.toBe('pass');
  });

  it('keeps partial refusal content and the recoverable continue route after prefix continuation', () => {
    const node = makeNode({
      diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'partial_refused' },
    });
    const finalized = finalizePrefixContinuation(
      node,
      {
        content: `${node.content}\n\n她按住门把手，低声说：“抱歉，我不能继续写这段内容。”`,
        reasoningContent: '',
        finishReason: 'stop',
      },
      { mode: 'story' },
    );

    expect(finalized.content).toContain('她按住门把手');
    expect(finalized.diagnostics).toMatchObject({
      refusalRoute: 'partial_refused',
    });
    expect(finalized.diagnostics?.sourceStatus).toBeUndefined();
  });

  it('clears a legacy REFUSAL status when a continuation passes and keeps the node in context', () => {
    const node = makeNode({
      diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'partial_refused' },
    });
    const finalized = finalizePrefixContinuation(node, {
      content: `${node.content}\n\n她握紧门把手，走进雨里。`,
      reasoningContent: '',
      finishReason: 'stop',
    }, { mode: 'story' });

    expect(finalized.diagnostics).toMatchObject({ refusalRoute: 'pass' });
    expect(finalized.diagnostics?.sourceStatus).toBeUndefined();
    const story = makeStory(finalized);
    expect(excludeRefusedTurns([story.nodes['user-1'], finalized])).toEqual([
      story.nodes['user-1'],
      finalized,
    ]);

    const context = assembleThreeZoneContext(story, finalized.id, '继续');
    expect(context.messages.map((message) => message.content).join('\n')).toContain('她握紧门把手');
  });

  it('keeps partial-refused nodes in context while excluding thin refusal nodes', () => {
    const partialNode = finalizePrefixContinuation(
      makeNode({ id: 'partial-assistant', parentId: 'partial-user', diagnostics: { refusalRoute: 'partial_refused' } }),
      {
        content: '已经写出的正文。\n\n她按住门把手，低声说：“抱歉，我不能继续写这段内容。”',
        reasoningContent: '',
        finishReason: 'stop',
      },
      { mode: 'story' },
    );
    const thinNode = finalizePrefixContinuation(
      makeNode({ id: 'thin-assistant', parentId: 'thin-user', diagnostics: { refusalRoute: 'partial_refused' } }),
      {
        content: '已经写出的正文。\n\n抱歉，我不能继续写这段内容。',
        reasoningContent: '',
        finishReason: 'stop',
      },
      { mode: 'story' },
    );
    const nodes = [
      {
        id: 'partial-user',
        parentId: null,
        role: 'user' as const,
        content: '半拒绝追问',
        createdAt: 1,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      partialNode,
      {
        id: 'thin-user',
        parentId: null,
        role: 'user' as const,
        content: '薄拒答追问',
        createdAt: 3,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      thinNode,
    ];

    expect(excludeRefusedTurns(nodes)).toEqual([nodes[0], partialNode]);
    expect(thinNode.diagnostics).toMatchObject({
      sourceStatus: 'REFUSAL',
      refusalRoute: 'retry',
    });
  });

  it('keeps all three manual continuation callers on the shared finalization path', () => {
    for (const file of ['App.tsx', 'DraftPane.tsx', 'CharacterPane.tsx']) {
      const source = readFileSync(join(repoRoot, 'src/ui', file), 'utf8');
      expect(source).toContain('finalizePrefixContinuation');
      expect(source).toContain('invalidateSummarySnapshotsFromNode');
      expect(source).not.toContain('continued.content.trim() === node.content.trim()');
    }
  });

  it('does not reset unsaved prompt-pack drafts when global settings change', () => {
    const source = readFileSync(join(repoRoot, 'src/ui/PromptPackSheet.tsx'), 'utf8');
    expect(source).toContain('}, [selected.id]);');
    expect(source).not.toContain('}, [selected.id, selected.title, selected.slots]);');
  });

  it('wires prompt-pack backup export, restore persistence, and summary text through App', () => {
    const appSource = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8');
    expect(appSource).toContain('promptPacks: promptPackLibrary');
    expect(appSource).toContain('setPromptPackLibrary(merged.promptPacks)');
    expect(appSource).toContain('个提示词包与我的记忆');
    expect(appSource).toContain('onPromptPackLibraryChange={setPromptPackLibrary}');
    expect(appSource).toContain('!isDefaultPromptPackLibrary(promptPackLibrary)');
    const draftSource = readFileSync(join(repoRoot, 'src/ui/DraftPane.tsx'), 'utf8');
    const characterSource = readFileSync(join(repoRoot, 'src/ui/CharacterPane.tsx'), 'utf8');
    for (const source of [draftSource, characterSource]) {
      expect(source).toContain('promptPackLibrary={props.promptPackLibrary}');
      expect(source).toContain('buildPromptPackContextOptions');
      expect(source).toContain('streamPrefixContinuation');
      expect(source).toContain('onRestoreRefusalOriginal');
      expect(source).toContain('onContinuePartialRefusal');
    }
    expect(draftSource.match(/diagnostics: result\.diagnostics/g)?.length).toBe(5);
    expect(draftSource.match(/prefillContent: result\.prefillContent/g)?.length).toBe(5);
    expect(characterSource.match(/diagnostics: result\.diagnostics/g)?.length).toBe(2);
    expect(characterSource.match(/prefillContent: result\.prefillContent/g)?.length).toBe(2);
    expect(draftSource).toContain('const activeWritingWaitingPhrase = reply.refusalRetrying');
    expect(draftSource).toContain('{activeWritingWaitingPhrase}</div>');
    expect(draftSource).toContain('onRefusalRetry: () =>');
    expect(draftSource).toContain('onRefusalRetry();');
  });

  it('marks built-in-only global prompt-pack changes as exportable state', () => {
    const defaults = createDefaultPromptPackLibrary();
    expect(isDefaultPromptPackLibrary(defaults)).toBe(true);
    expect(isDefaultPromptPackLibrary({ ...defaults, defaultPrefixCompletion: 'always' })).toBe(false);
    expect(isDefaultPromptPackLibrary({ ...defaults, includeTail: true })).toBe(false);
    expect(isDefaultPromptPackLibrary({ ...defaults, activePackId: null })).toBe(false);
  });

  it('keeps CONTENT_FILTER copy separate and exposes a stable REFUSAL tree diagnostic', () => {
    const refusal = makeNode({ diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'refused_exhausted' } });
    const story = makeStory(refusal);
    const markup = renderToStaticMarkup(createElement(StoryTree, { story }));

    expect(markup).toContain('本轮触发拒答，已从上下文隔离');
    expect(markup).toContain('data-testid="story-tree-diag-refusal"');
    expect(markup).not.toContain('这条历史消息在原平台未完整生成');
  });
});
