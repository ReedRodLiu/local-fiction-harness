import type { Story } from '../harness/types.ts';

/**
 * Reconciles a background branch summary result against the latest Story state so concurrent
 * lightweight metadata edits (such as branch renames) are preserved while stale summaries
 * from another story or branch are discarded.
 */
export function mergeBranchSummaryResult(
  latestStory: Story,
  summarizedStory: Story,
  targetLeafId: string,
): Story | null {
  if (latestStory.id !== summarizedStory.id || latestStory.activeLeafNodeId !== targetLeafId) {
    return null;
  }
  const latestLeaf = latestStory.nodes[targetLeafId];
  const summarizedLeaf = summarizedStory.nodes[targetLeafId];
  if (!latestLeaf || !summarizedLeaf) {
    return null;
  }

  return {
    ...latestStory,
    nodes: {
      ...latestStory.nodes,
      [targetLeafId]: {
        ...latestLeaf,
        summarySnapshot: summarizedLeaf.summarySnapshot,
      },
    },
    updatedAt: Math.max(latestStory.updatedAt, summarizedStory.updatedAt),
  };
}
