import { describe, expect, it } from 'vitest';
import {
  buildRedactedStorySkeleton,
  createDiagnosticCollector,
  createFictionHarness,
  exportStoryBackup,
  importStoryBackup,
  type LlmTransport,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function makeNode(
  id: string,
  parentId: string | null,
  role: TurnNode['role'],
  createdAt: number,
  content: string,
  options: Partial<TurnNode> = {},
): TurnNode {
  return {
    id,
    parentId,
    role,
    content,
    reasoningContent: `reasoning-${id}-CANARY`,
    createdAt,
    summarySnapshot: {
      content: `summary-${id}-CANARY`,
      coveredUpToNodeId: null,
      summarizedTurnCount: createdAt,
    },
    ...options,
  };
}

function makeStory(): Story {
  const root = makeNode('original-root-CANARY', null, 'user', 1, 'root-dialogue-CANARY');
  const fork = makeNode('original-fork-CANARY', root.id, 'assistant', 2, 'fork-dialogue-CANARY');
  const branchA = makeNode('original-branch-a-CANARY', fork.id, 'user', 3, 'branch-a-CANARY');
  const leafA = makeNode('original-leaf-a-CANARY', branchA.id, 'assistant', 4, 'leaf-a-CANARY', {
    diagnostics: { sourceStatus: 'TIMEOUT', contentRisk: true },
    summarySnapshot: {
      content: 'private-summary-CANARY',
      coveredUpToNodeId: root.id,
      summarizedTurnCount: 7,
    },
  });
  const branchB = makeNode('original-branch-b-CANARY', fork.id, 'user', 5, 'branch-b-CANARY');

  return {
    id: 'private-story-id-CANARY',
    title: 'private-story-title-CANARY',
    rawScript: 'private-raw-script-CANARY',
    blueprint: {
      title: 'blueprint-title-CANARY',
      worldRules: ['rule-one-CANARY', 'rule-two-CANARY'],
      protagonist: 'protagonist-CANARY',
      npcs: [{ name: 'npc-name-CANARY', role: 'npc-role-CANARY', traits: 'npc-traits-CANARY' }],
      taboos: ['taboo-CANARY'],
      openingHook: 'opening-hook-CANARY',
      extractionStatus: 'partial_fallback',
    },
    nodes: {
      [branchB.id]: branchB,
      [leafA.id]: leafA,
      [fork.id]: fork,
      [branchA.id]: branchA,
      [root.id]: root,
    },
    rootNodeIds: [root.id],
    activeLeafNodeId: leafA.id,
    setupNodeIds: [root.id],
    branchNames: { [branchB.id]: 'private-branch-name-CANARY' },
    branchSummaries: { [branchB.id]: 'private-branch-gist-CANARY' },
    createdAt: 1,
    updatedAt: 5,
  };
}

describe('anonymous story skeleton', () => {
  it('preserves topological shape and safe counts while dropping every story text and original id', () => {
    const story = makeStory();
    const skeleton = buildRedactedStorySkeleton(story);

    expect(skeleton).toEqual({
      storyAnonId: 's1',
      sourceKind: 'unknown',
      blueprintStatus: 'partial_fallback',
      activeLeafAnonId: 'n4',
      rawScriptLength: story.rawScript.length,
      setupNodeCount: 1,
      blueprintCounts: { rules: 2, npcs: 1, taboos: 1 },
      forkCount: 1,
      branchNamesCount: 1,
      branchGistCount: 1,
      nodes: [
        { id: 'n1', parentId: null, role: 'user', isSetupNode: true, contentLen: 20, reasoningLen: 37, summaryCoveredCount: 1, summaryContentLen: 35 },
        { id: 'n2', parentId: 'n1', role: 'assistant', isSetupNode: false, contentLen: 20, reasoningLen: 37, summaryCoveredCount: 2, summaryContentLen: 35 },
        { id: 'n3', parentId: 'n2', role: 'user', isSetupNode: false, contentLen: 15, reasoningLen: 41, summaryCoveredCount: 3, summaryContentLen: 39 },
        { id: 'n4', parentId: 'n3', role: 'assistant', isSetupNode: false, contentLen: 13, reasoningLen: 39, diagnostics: { sourceStatus: 'TIMEOUT', contentRisk: true }, summaryCoveredCount: 7, summaryContentLen: 22 },
        { id: 'n5', parentId: 'n2', role: 'user', isSetupNode: false, contentLen: 15, reasoningLen: 41, summaryCoveredCount: 5, summaryContentLen: 39 },
      ],
    });

    const serialized = JSON.stringify(skeleton);
    expect(serialized).not.toContain('CANARY');
    expect(serialized).not.toContain('original-');
    expect(serialized).not.toContain('private-');
    expect(serialized).not.toContain('npc-');
    expect(serialized).not.toContain('protagonist-');
    expect(serialized).not.toContain('opening-hook-');
    expect(serialized).not.toContain('rule-one-');
    expect(serialized).not.toContain('taboo-');
    expect(serialized).not.toContain('fork:');
    expect(serialized).not.toContain('branch-gist');
  });

  it('retains manual provenance from the Story creation input', async () => {
    const transport: LlmTransport = { async *streamChat() {} };
    const harness = createFictionHarness({ transport });
    const input: Parameters<typeof harness.createAndSaveStory>[0] = {
      title: '手动剧本',
      rawScript: '手动剧本文本',
      sourceKind: 'manual_script',
    };

    const story = await harness.createAndSaveStory(input);

    expect(story.sourceKind).toBe('manual_script');
  });

  it('round-trips a known sourceKind in Story v1 backups, accepts legacy backups, and rejects unknown values', () => {
    const story: Story = { ...makeStory(), sourceKind: 'manual_script' };
    const restored = importStoryBackup(exportStoryBackup(story), []);

    expect(restored.sourceKind).toBe('manual_script');

    const importedStory: Story = { ...makeStory(), sourceKind: 'deepseek_import' };
    expect(importStoryBackup(exportStoryBackup(importedStory), []).sourceKind).toBe('deepseek_import');

    const legacyBackup = JSON.parse(exportStoryBackup(makeStory()));
    expect(importStoryBackup(JSON.stringify(legacyBackup), [])).not.toHaveProperty('sourceKind');

    const invalidBackup = JSON.parse(exportStoryBackup(makeStory()));
    invalidBackup.story.sourceKind = 'private-source-CANARY';
    expect(() => importStoryBackup(JSON.stringify(invalidBackup), [])).toThrow();
  });

  it('keeps only known source metadata and maps the active leaf to an anonymous ID', () => {
    const story = Object.assign(makeStory(), { sourceKind: 'deepseek_import' });
    const skeleton = buildRedactedStorySkeleton(story);

    expect(skeleton).toMatchObject({
      storyAnonId: 's1',
      sourceKind: 'deepseek_import',
      activeLeafAnonId: 'n4',
      blueprintStatus: 'partial_fallback',
    });

    Object.assign(story, { sourceKind: 'private-source-CANARY' });
    expect(buildRedactedStorySkeleton(story).sourceKind).toBe('unknown');
  });

  it('adds an anonymous skeleton only when the preview requests it and keeps the trigger allowlisted', () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    const config = { baseUrl: '', model: 'deepseek-chat', memoryOnly: false };
    const story = makeStory();
    const skeleton = buildRedactedStorySkeleton(story);

    const withoutSkeleton = collector.buildBundle(config, { trigger: 'settings_manual' });
    const withSkeleton = collector.buildBundle(config, {
      trigger: 'error_banner',
      activeStory: story,
      appEnv: {
        platform: 'android',
        appVersion: '0.1.0',
        viewport: '400x800',
        activeView: 'story',
        storyCount: 2,
      },
    });

    expect(withoutSkeleton).not.toHaveProperty('activeStorySkeleton');
    expect(withoutSkeleton.trigger).toBe('settings_manual');
    expect(withSkeleton.trigger).toBe('error_banner');
    expect(withSkeleton.activeStorySkeleton).toEqual(skeleton);
    expect(withSkeleton.appEnv).toEqual({
      platform: 'web',
      appVersion: '0.1.0',
      viewport: '400x800',
      activeView: 'story',
      storyCount: 2,
    });
  });

  it('keeps crash action names allowlisted and never persists raw error text', () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    collector.recordError({
      category: 'crash',
      action: 'unhandled_render_crash',
      error: new Error('private-dialogue-CANARY sk-secret-CANARY'),
    });
    collector.recordError({
      category: 'crash',
      action: 'freeform-CANARY',
      error: new Error('private-dialogue-CANARY'),
    });
    collector.recordError({
      category: 'crash',
      action: 'unhandled_window_error',
      error: new Error('private-window-error-CANARY'),
    });
    collector.recordError({
      category: 'crash',
      action: 'unhandled_rejection',
      error: 'private-rejection-CANARY',
    });

    const bundle = collector.buildBundle({ baseUrl: '', model: 'deepseek-chat', memoryOnly: false }, {
      trigger: 'crash_boundary',
    });
    const json = JSON.stringify(bundle);

    expect(bundle.trigger).toBe('crash_boundary');
    expect(bundle.events).toHaveLength(3);
    expect(bundle.events.map((event) => [event.category, event.action])).toEqual([
      ['crash', 'unhandled_render_crash'],
      ['crash', 'unhandled_window_error'],
      ['crash', 'unhandled_rejection'],
    ]);
    expect(json).not.toContain('private-dialogue-CANARY');
    expect(json).not.toContain('sk-secret-CANARY');
    expect(json).not.toContain('freeform-CANARY');
    expect(json).not.toContain('private-window-error-CANARY');
    expect(json).not.toContain('private-rejection-CANARY');
  });
});
