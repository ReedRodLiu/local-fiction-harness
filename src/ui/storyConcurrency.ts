import type { Story } from '../harness/types.ts';

export function mergeBranchRenameResult(
  latestStory: Story,
  renamedStory: Story,
  branchEntryNodeId: string,
): Story | null {
  if (
    latestStory.id !== renamedStory.id ||
    !latestStory.nodes[branchEntryNodeId] ||
    !renamedStory.nodes[branchEntryNodeId]
  ) {
    return null;
  }

  const branchNames = { ...(latestStory.branchNames ?? {}) };
  const renamedName = renamedStory.branchNames?.[branchEntryNodeId];
  if (renamedName) {
    branchNames[branchEntryNodeId] = renamedName;
  } else {
    delete branchNames[branchEntryNodeId];
  }

  return {
    ...latestStory,
    branchNames: Object.keys(branchNames).length > 0 ? branchNames : undefined,
    updatedAt: Math.max(latestStory.updatedAt, renamedStory.updatedAt),
  };
}

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
