import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  DEFAULT_CONTEXT_BUDGET,
  assembleThreeZoneContext,
  createDefaultPromptPackLibrary,
  createFictionHarness,
  createPromptPack,
  createDefaultBlueprint,
  excludeRefusedTurns,
  isDefaultPromptPackLibrary,
  type LlmStreamRequest,
  type ModelConfig,
  type RefusalDiagnosticEvent,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { GenerationControls } from '../../src/ui/GenerationControls.tsx';
import { PromptPackSheet } from '../../src/ui/PromptPackSheet.tsx';
import {
  finalizePrefixContinuation,
  prepareStoryContinuationContext,
  restoreStoryRefusalOriginal,
  restoreTurnNodeRefusalOriginal,
  streamPrefixContinuation,
} from '../../src/ui/refusalContinuation.ts';
import { StoryTree } from '../../src/ui/StoryTree.tsx';
import { TurnCard } from '../../src/ui/TurnCard.tsx';
import { createCreativeReplyRequest } from '../../src/ui/useCreativeReply.ts';
import { WelcomeView } from '../../src/ui/WelcomeView.tsx';

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
    expect(markup).toContain('banner-alert-warning');
    expect(markup).toContain('24000');
    expect(markup).toContain('6000');
    expect(markup).toContain('2000');
    expect(markup).toContain('Folio 基础叙事骨架');
    expect(markup).toContain('提示词包在技术上作为系统提示词（System Prompt）');
    expect(markup.indexOf('data-testid="prompt-pack-disclaimer"')).toBeLessThan(
      markup.indexOf('class="prompt-pack-import-block"'),
    );

    const disabledMarkup = renderToStaticMarkup(createElement(PromptPackSheet, {
      library: { ...library, activePackId: null },
      onChange: vi.fn(),
      onExport: vi.fn(),
    }));
    expect(disabledMarkup).toContain('默认提示词包已停用');
    expect(disabledMarkup).not.toContain('全局提示词');

    const sheetSource = readFileSync(join(repoRoot, 'src/ui/PromptPackSheet.tsx'), 'utf8');
    const cssSource = readFileSync(join(repoRoot, 'src/ui/styles/prompt-pack.css'), 'utf8');
    expect(sheetSource).not.toContain('全局提示词');
    expect(sheetSource).toContain('<BannerAlert tone="warning" testId="prompt-pack-disclaimer">');
    expect(cssSource).not.toContain('.prompt-pack-disclaimer');
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
    expect(partialMarkup).toContain('banner-alert-warning');
    expect(partialMarkup).toContain('data-testid="turn-partial-refusal-continue"');
    expect(partialMarkup).toContain('模型似乎略过了部分具体描写');
    expect(partialMarkup).toContain('将消耗一次新请求');

    const refusedRetryNode = makeNode({
      diagnostics: {
        sourceStatus: 'REFUSAL',
        refusalRoute: 'retry',
        recoveredFromText: '旧拒答文本',
      },
    });
    const refusedRetryMarkup = renderToStaticMarkup(createElement(TurnCard, {
      node: refusedRetryNode,
      isActiveLeaf: true,
      isLatestTurn: true,
      isSetupNode: false,
      turnNumber: 1,
      isBusy: false,
      isStreaming: false,
      siblings: { siblings: [refusedRetryNode], prevSiblingId: null, nextSiblingId: null, currentIndex: 0, total: 1 },
      onSwitchBranch: vi.fn(),
      onRewindToNode: vi.fn(),
      onRestoreRefusalOriginal: vi.fn(),
    }));
    expect(refusedRetryMarkup).not.toContain('data-testid="turn-refusal-recovered-badge"');
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

  it('rejects a thin second refusal non-destructively and preserves partial_refused without recovered badge', () => {
    const node = makeNode({
      diagnostics: {
        refusalRoute: 'partial_refused',
        recoveredFromText: '首次薄拒答。',
        matchedRuleId: 'L1-01',
      },
    });
    const before = structuredClone(node);

    expect(() =>
      finalizePrefixContinuation(
        node,
        {
          content: `${node.content}\n\n抱歉，我不能继续写这段内容。`,
          reasoningContent: '',
          finishReason: 'stop',
        },
        { mode: 'story' },
      ),
    ).toThrow('追要未获得新的有效正文，已保留原有内容，请稍后再试。');

    expect(node).toEqual(before);
    expect(node.diagnostics?.sourceStatus).toBeUndefined();
    expect(node.diagnostics?.refusalRoute).toBe('partial_refused');
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
    expect(markup).not.toContain('data-testid="turn-refusal-recovered-badge"');
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

  it('clears legacy REFUSAL status and stale matchedRuleId when a continuation passes', () => {
    const node = makeNode({
      diagnostics: {
        sourceStatus: 'REFUSAL',
        refusalRoute: 'partial_refused',
        matchedRuleId: 'L1-01',
      },
    });
    const finalized = finalizePrefixContinuation(node, {
      content: `${node.content}\n\n她握紧门把手，走进雨里。`,
      reasoningContent: '',
      finishReason: 'stop',
    }, { mode: 'story' });

    expect(finalized.diagnostics).toMatchObject({ refusalRoute: 'pass' });
    expect(finalized.diagnostics?.sourceStatus).toBeUndefined();
    expect(finalized.diagnostics?.matchedRuleId).toBeUndefined();
    const story = makeStory(finalized);
    expect(excludeRefusedTurns([story.nodes['user-1'], finalized])).toEqual([
      story.nodes['user-1'],
      finalized,
    ]);

    const context = assembleThreeZoneContext(story, finalized.id, '继续');
    expect(context.messages.map((message) => message.content).join('\n')).toContain('她握紧门把手');
  });

  it('combines prefix and suffix safely when continuation reply does not echo the prefix', () => {
    const node = makeNode({
      content: '雨夜里她停在楼梯口。',
      diagnostics: { refusalRoute: 'partial_refused', matchedRuleId: 'L1-01' },
    });
    const finalized = finalizePrefixContinuation(
      node,
      {
        content: '指尖摸到门锁上的铜锈，她推门走进屋内。\n\n```lfh-summary\n推门入屋。\n```',
        reasoningContent: '',
        finishReason: 'stop',
      },
      { mode: 'story' },
    );

    expect(finalized.content).toBe('雨夜里她停在楼梯口。指尖摸到门锁上的铜锈，她推门走进屋内。');
    expect(finalized.content).not.toContain('lfh-summary');
    expect(finalized.turnSummary).toBe('推门入屋。');
    expect(finalized.diagnostics?.matchedRuleId).toBeUndefined();
  });

  it('strips lfh fences live during streamPrefixContinuation without flashing raw markers', async () => {
    const chunks: string[] = [];
    const result = await streamPrefixContinuation({
      transport: {
        async *streamChat() {
          yield { contentDelta: '原有正文' };
          yield { contentDelta: '，她推开门。\n\n```lfh-s' };
          yield { contentDelta: 'ummary\n门后景象。\n```', finishReason: 'stop' };
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
      onContentDelta: (delta) => chunks.push(delta),
    });

    const streamed = chunks.join('');
    expect(streamed).toContain('，她推开门。');
    expect(streamed).not.toContain('lfh-s');
    expect(streamed).not.toContain('```');
    expect(result.content).toContain('```lfh-summary');
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
    const thinNode = makeNode({
      id: 'thin-assistant',
      parentId: 'thin-user',
      content: '抱歉，我不能继续写这段内容。',
      diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'retry' },
    });
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
  });

  it('keeps all three manual continuation callers on the shared finalization path', () => {
    for (const file of ['DraftPane.tsx', 'CharacterPane.tsx']) {
      const source = readFileSync(join(repoRoot, 'src/ui', file), 'utf8');
      expect(source).toContain('finalizePrefixContinuation');
      expect(source).toContain('invalidateSummarySnapshotsFromNode');
      expect(source).toContain('summaryTargetBranchFingerprint');
      expect(source).toContain(file === 'DraftPane.tsx'
        ? 'mergeWorkSummaryResult'
        : 'mergeCharacterSummaryResult');
      expect(source).not.toContain('continued.content.trim() === node.content.trim()');
    }
    const appSource = readFileSync(join(repoRoot, 'src/ui', 'App.tsx'), 'utf8');
    expect(appSource).toContain('finalizePrefixContinuation');
    expect(appSource).toContain('invalidateStorySummarySnapshotsFromNode');
    expect(appSource).not.toContain('invalidateSummarySnapshotsFromNode');
    expect(appSource).not.toContain('continued.content.trim() === node.content.trim()');
  });

  it('preserves selected pack and unsaved drafts on disable/enable while syncing external persisted updates', () => {
    const source = readFileSync(join(repoRoot, 'src/ui/PromptPackSheet.tsx'), 'utf8');
    expect(source).toContain('selected.updatedAt');
    expect(source).toContain('selected.slots.head');
    expect(source).not.toContain('setSelectedId(activePack.id)');
    expect(source).toContain('library.packs.find((pack) => pack.id === selected.id)');
  });

  it('wires prompt-pack backup export, restore persistence, and summary text through App', () => {
    const appSource = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8');
    expect(appSource).toContain('loadPromptPackLibrary(runtime.promptPackStorage)');
    expect(appSource).toContain('savePromptPackLibrary(runtime.promptPackStorage, next)');
    expect(appSource).not.toContain('window.localStorage');
    expect(appSource).toContain('diagnostics: runtime.diagnostics');
    expect(appSource).toContain('onDiagnostic: (event) => recordRefusalDiagnostic(runtime.diagnostics, event)');
    expect(appSource.match(/recordRefusalOriginalRestoredDiagnostic\(runtime\.diagnostics, node\.diagnostics\)/g)?.length).toBe(1);
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
      expect(source).toContain('restoreTurnNodeRefusalOriginal');
      expect(source.match(/recordRefusalOriginalRestoredDiagnostic\(runtime\.diagnostics, refusalDiagnostics\)/g)?.length).toBe(1);
    }
    expect(draftSource.match(/onDiagnostic: \(event\) => recordRefusalDiagnostic\(runtime\.diagnostics, event\)/g)?.length).toBe(3);
    expect(characterSource.match(/onDiagnostic: \(event\) => recordRefusalDiagnostic\(runtime\.diagnostics, event\)/g)?.length).toBe(2);
    expect(draftSource).toContain('TurnRefusalNotices');
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

  it('keeps CONTENT_FILTER copy separate and exposes a stable REFUSAL tree diagnostic without duplicate span testIds', () => {
    const refusal = makeNode({ diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'refused_exhausted' } });
    const story = makeStory(refusal);
    const markup = renderToStaticMarkup(createElement(StoryTree, { story }));

    expect(markup).toContain('本轮触发拒答，已从上下文隔离');
    expect(markup).toContain('data-testid="story-tree-diag-refusal"');
    expect(markup.match(/data-testid="story-tree-diag-refusal"/g)?.length).toBe(1);
    expect(markup).not.toContain('这条历史消息在原平台未完整生成');

    const treeSource = readFileSync(join(repoRoot, 'src/ui/StoryTree.tsx'), 'utf8');
    expect(treeSource.match(/getActiveBranchNodes\(/g)?.length).toBe(1);
    const expandedStart = treeSource.indexOf('expandedNodes.map(');
    const expandedEnd = treeSource.indexOf('</ol>', expandedStart);
    expect(treeSource.slice(expandedStart, expandedEnd)).not.toContain('story-tree-diag-refusal');
  });

  it('forwards refusalOptions as the 5th argument in useCreativeReply for character and writing modes', async () => {
    const baseConfig: ModelConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      memoryOnly: false,
    };

    for (const mode of ['character', 'writing'] as const) {
      const requests: LlmStreamRequest[] = [];
      const diagnostics: RefusalDiagnosticEvent[] = [];
      let retryNotified = 0;
      let attempt = 0;

      const request = createCreativeReplyRequest(
        {
          async *streamChat(req) {
            requests.push(req);
            attempt += 1;
            if (attempt === 1) {
              yield { contentDelta: '抱歉，我不能帮你写这段内容。', finishReason: 'stop' };
              return;
            }
            yield { contentDelta: '她停在门边，指节抵着门框。\n\n```lfh-summary\n门边停顿。\n```', finishReason: 'stop' };
          },
        },
        baseConfig,
        {
          onRefusalRetry: () => {
            retryNotified += 1;
          },
        },
      );

      const result = await request(
        [{ role: 'user', content: '继续这一幕。' }],
        {
          refusalOptions: {
            mode,
            characterName: mode === 'character' ? '沈砚' : undefined,
            promptPackOptions: {
              promptPackLibrary: createDefaultPromptPackLibrary(),
            },
            onDiagnostic: (event) => diagnostics.push(event),
          },
        },
      );

      expect(retryNotified).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.prefixCompletion?.content).toBeDefined();
      if (mode === 'character') {
        expect(requests[1]?.prefixCompletion?.content).toContain('沈砚');
      }
      expect(diagnostics.map((item) => item.action)).toEqual([
        'refusal_detected',
        'refusal_retry_recovered',
      ]);
      expect(result.diagnostics).toMatchObject({
        refusalRoute: 'retry',
        retriedWithPrefix: true,
        recoveredFromText: '抱歉，我不能帮你写这段内容。',
      });
    }

    const hookSource = readFileSync(join(repoRoot, 'src/ui/useCreativeReply.ts'), 'utf8');
    expect(hookSource).not.toContain('...options?.refusalOptions');
  });

  it('reads prompt-pack updates dynamically via getPromptPackLibrary without recreating harness or reloading story', () => {
    let activeLibrary = createDefaultPromptPackLibrary();
    const harness = createFictionHarness({
      transport: {
        async *streamChat() {
          yield { contentDelta: 'ok', finishReason: 'stop' };
        },
      },
      getPromptPackLibrary: () => activeLibrary,
    });
    const story = harness.createStory({ title: '动态提示词包测试' });

    const beforeMessages = harness.assembleContext(story, null, '继续').messages;
    expect(beforeMessages.map((m) => m.content).join('\n')).not.toContain('动态更新的新头段规则');

    const customPack = createPromptPack('dynamic-pack', {
      head: '动态更新的新头段规则',
      mid: '中段规则',
      tail: '尾段规则',
    }, { title: '动态包' });
    activeLibrary = {
      ...activeLibrary,
      packs: [...activeLibrary.packs, customPack],
      activePackId: customPack.id,
    };

    const afterMessages = harness.assembleContext(story, null, '继续').messages;
    expect(afterMessages.map((m) => m.content).join('\n')).toContain('动态更新的新头段规则');

    const appSource = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8');
    expect(appSource).toContain('getPromptPackLibrary:');
    expect(appSource).not.toContain('[promptPackLibrary, runtime]');
  });

  it('catches up branch summary and assembles continuation context for long stories exceeding recentMaxChars without throwing', async () => {
    const chunk = '长剧情段落内容。'.repeat(700); // ~5600 chars per node -> 6 nodes > 24000 recentMaxChars
    const nodes: Record<string, TurnNode> = {
      u1: {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: chunk,
        createdAt: 1,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      a1: {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content: chunk,
        createdAt: 2,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      u2: {
        id: 'u2',
        parentId: 'a1',
        role: 'user',
        content: chunk,
        createdAt: 3,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      a2: {
        id: 'a2',
        parentId: 'u2',
        role: 'assistant',
        content: chunk,
        createdAt: 4,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      u3: {
        id: 'u3',
        parentId: 'a2',
        role: 'user',
        content: chunk,
        createdAt: 5,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      a3: {
        id: 'a3',
        parentId: 'u3',
        role: 'assistant',
        content: '雨声落下。抱歉，我不能继续写这段内容。',
        createdAt: 6,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
        diagnostics: { refusalRoute: 'partial_refused' },
      },
    };
    const longStory: Story = {
      id: 'long-story',
      title: '超长故事续写',
      rawScript: '',
      blueprint: createDefaultBlueprint('超长故事续写'),
      nodes,
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a3',
      createdAt: 1,
      updatedAt: 6,
    };

    const totalBeforeU3 = Object.values(nodes)
      .filter((n) => n.id !== 'a3')
      .reduce((acc, n) => acc + n.content.length, 0);
    expect(totalBeforeU3).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET.recentMaxChars);

    const harness = createFictionHarness({
      transport: {
        async *streamChat() {
          yield { contentDelta: '压缩后的剧情摘要。', finishReason: 'stop' };
        },
      },
    });
    const config: ModelConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      memoryOnly: false,
    };

    const ctx = await prepareStoryContinuationContext({
      story: longStory,
      nodeId: 'a3',
      config,
      promptPackLibrary: createDefaultPromptPackLibrary(),
      calculateBranchSummary: harness.calculateActiveBranchSummary,
    });

    expect(ctx.workingStory.activeLeafNodeId).toBe('a3');
    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(ctx.messages.map((m) => m.content).join('\n')).toContain('压缩后的剧情摘要。');
  });

  it('invalidates downstream summary snapshots when restoring original refusal content in stories and creative trees', () => {
    const story = makeStory(
      makeNode({
        id: 'a1',
        parentId: 'user-1',
        content: '重拟后的正文。',
        summarySnapshot: { content: '重拟摘要', coveredUpToNodeId: 'a1', summarizedTurnCount: 2 },
        diagnostics: {
          refusalRoute: 'retry',
          recoveredFromText: '抱歉，我不能帮你写这段内容。',
          retriedWithPrefix: true,
        },
      }),
    );
    story.nodes['u2'] = {
      id: 'u2',
      parentId: 'a1',
      role: 'user',
      content: '下一步',
      createdAt: 3,
      summarySnapshot: { content: '下游摘要', coveredUpToNodeId: 'u2', summarizedTurnCount: 3 },
    };
    story.nodes['sibling'] = {
      id: 'sibling',
      parentId: 'user-1',
      role: 'assistant',
      content: '兄弟分支。',
      createdAt: 4,
      summarySnapshot: { content: '兄弟摘要', coveredUpToNodeId: 'sibling', summarizedTurnCount: 2 },
    };

    const storyRestored = restoreStoryRefusalOriginal(story, 'a1');
    expect(storyRestored).not.toBeNull();
    expect(storyRestored?.restored.content).toBe('抱歉，我不能帮你写这段内容。');
    expect(storyRestored?.story.nodes['a1'].summarySnapshot.coveredUpToNodeId).toBeNull();
    expect(storyRestored?.story.nodes['u2'].summarySnapshot.coveredUpToNodeId).toBeNull();
    expect(storyRestored?.story.nodes['sibling'].summarySnapshot.coveredUpToNodeId).toBe('sibling');

    const treeRestored = restoreTurnNodeRefusalOriginal(story.nodes, 'a1');
    expect(treeRestored).not.toBeNull();
    expect(treeRestored?.nodes['a1'].summarySnapshot.coveredUpToNodeId).toBeNull();
    expect(treeRestored?.nodes['u2'].summarySnapshot.coveredUpToNodeId).toBeNull();
    expect(treeRestored?.nodes['sibling'].summarySnapshot.coveredUpToNodeId).toBe('sibling');
  });

  it('renders WelcomeView refusalRetrying copy and restore/continue controls on neutral assistant turns', () => {
    const neutralRecovered: TurnNode = makeNode({
      id: 'neutral-recovered',
      content: '重拟后的中性回复。',
      diagnostics: {
        refusalRoute: 'retry',
        recoveredFromText: '抱歉，我不能写这个。',
        retriedWithPrefix: true,
      },
    });
    const neutralPartial: TurnNode = makeNode({
      id: 'neutral-partial',
      content: '半拒绝中性回复。',
      diagnostics: {
        refusalRoute: 'partial_refused',
      },
    });

    const markup = renderToStaticMarkup(createElement(WelcomeView, {
      stories: [],
      recentCreative: [],
      neutralTurns: [neutralRecovered, neutralPartial],
      isStreaming: true,
      streamContent: '',
      streamReasoning: '',
      refusalRetrying: true,
      onSelectStory: vi.fn(),
      onRestoreRefusalOriginal: vi.fn(),
      onContinuePartialRefusal: vi.fn(),
    }));

    expect(markup).toContain('正在重新构思落笔…');
    expect(markup).toContain('data-testid="turn-refusal-restore-original"');
    expect(markup).toContain('data-testid="turn-partial-refusal-continue"');
    expect(markup).toContain('banner-alert-warning');
  });
});
