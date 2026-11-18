import { describe, expect, it } from 'vitest';
import type { Story } from '../../src/harness/types.ts';
import {
  mergeBranchRenameResult,
  mergeBranchSummaryResult,
} from '../../src/ui/storyConcurrency.ts';

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: 's1',
    title: '测试故事',
    rawScript: '规则',
    blueprint: {
      title: '测试故事',
      worldRules: [],
      protagonist: '',
      npcs: [],
      taboos: [],
      openingHook: '',
      extractionStatus: 'complete',
    },
    nodes: {
      n1: {
        id: 'n1',
        parentId: null,
        role: 'user',
        content: '开局',
        createdAt: 1,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
      n2: {
        id: 'n2',
        parentId: 'n1',
        role: 'assistant',
        content: '回复',
        createdAt: 2,
        summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
      },
    },
    rootNodeIds: ['n1'],
    activeLeafNodeId: 'n2',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('Spec #25 Slice 3: Concurrent switchBranch summary & renameBranch reconciliation', () => {
  it('preserves concurrent branchNames while applying computed summarySnapshot to the matching active leaf', () => {
    const latestWithRename = makeStory({
      branchNames: { n1: '高冷师兄线' },
      updatedAt: 50,
    });
    const summarizedStale = makeStory({
      updatedAt: 40,
      nodes: {
        ...makeStory().nodes,
        n2: {
          ...makeStory().nodes.n2,
          summarySnapshot: {
            content: '补算后的支线摘要',
            coveredUpToNodeId: 'n1',
            summarizedTurnCount: 1,
          },
        },
      },
    });

    const merged = mergeBranchSummaryResult(latestWithRename, summarizedStale, 'n2');
    expect(merged).not.toBeNull();
    expect(merged!.branchNames).toEqual({ n1: '高冷师兄线' });
    expect(merged!.nodes.n2.summarySnapshot.content).toBe('补算后的支线摘要');
    expect(merged!.updatedAt).toBe(50);
  });

  it('discards stale summary when user switched to a different story or different active leaf', () => {
    const switchedAway = makeStory({ activeLeafNodeId: 'n1' });
    const summarized = makeStory();
    expect(mergeBranchSummaryResult(switchedAway, summarized, 'n2')).toBeNull();

    const differentStory = makeStory({ id: 's2' });
    expect(mergeBranchSummaryResult(differentStory, summarized, 'n2')).toBeNull();
  });

  it('preserves both branch rename and summary regardless of which result completes first', () => {
    const original = makeStory();
    const renamed = makeStory({
      branchNames: { n1: '新分支名称' },
      updatedAt: 4,
    });
    const summaryResult = makeStory({
      updatedAt: 5,
      nodes: {
        ...makeStory().nodes,
        n2: {
          ...makeStory().nodes.n2,
          summarySnapshot: {
            content: '并发摘要结果',
            coveredUpToNodeId: 'n1',
            summarizedTurnCount: 1,
          },
        },
      },
    });

    const summaryThenRename = mergeBranchRenameResult(
      mergeBranchSummaryResult(original, summaryResult, 'n2')!,
      renamed,
      'n1',
    );
    const renameThenSummary = mergeBranchSummaryResult(
      mergeBranchRenameResult(original, renamed, 'n1')!,
      summaryResult,
      'n2',
    );

    for (const merged of [summaryThenRename, renameThenSummary]) {
      expect(merged?.branchNames).toEqual({ n1: '新分支名称' });
      expect(merged?.nodes.n2.summarySnapshot.content).toBe('并发摘要结果');
    }
  });
});
