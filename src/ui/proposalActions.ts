import {
  documentVersion,
  materializeAssetFromNodes,
  newCharacter,
  newConversation,
  newWork,
  normalizeProposalTarget,
  writeDocument,
  type CreativeWorkspaceState,
  type DiagnosticCollector,
  type MarkdownDocument,
  type StageAssetMode,
  type Story,
  type TurnNode,
  type TurnProposalRecord,
} from '../harness/index.ts';

export function updateTurnNodeProposal(
  nodes: Record<string, TurnNode>,
  nodeId: string,
  proposalId: string,
  updater: (proposal: TurnProposalRecord) => TurnProposalRecord,
  now = Date.now(),
): Record<string, TurnNode> {
  const node = nodes[nodeId];
  if (!node || !node.proposals) return nodes;
  let changed = false;
  const nextProposals = node.proposals.map((item) => {
    if (item.id !== proposalId) return item;
    changed = true;
    return { ...updater(item), updatedAt: now };
  });
  if (!changed) return nodes;
  return {
    ...nodes,
    [nodeId]: {
      ...node,
      proposals: nextProposals,
    },
  };
}

export function recordProposalDiagnostic(
  diagnostics: DiagnosticCollector | undefined,
  action:
    | 'proposal_parsed'
    | 'proposal_needs_review'
    | 'proposal_applied'
    | 'proposal_dismissed'
    | 'proposal_reverted'
    | 'patch_reapplied'
    | 'patch_conflict',
  proposal: Pick<TurnProposalRecord, 'target' | 'op'>,
): void {
  if (!diagnostics) return;
  const normalizedTarget = normalizeProposalTarget(proposal.target) ?? 'setting';
  const targetMeta =
    normalizedTarget === 'note'
      ? 'branch_note'
      : normalizedTarget === 'memory' ||
          normalizedTarget === 'character' ||
          normalizedTarget === 'draft' ||
          normalizedTarget === 'story' ||
          normalizedTarget === 'manuscript'
        ? normalizedTarget
        : 'setting';
  try {
    diagnostics.recordEvent({
      level: action === 'patch_conflict' || action === 'proposal_needs_review' ? 'warn' : 'info',
      category: 'ui',
      action,
      meta: {
        target: targetMeta,
        op: proposal.op,
      },
    });
  } catch {
    // Diagnostics breadcrumbs must never disrupt user edits.
  }
}

export function recordProposalCreationBreadcrumbs(
  diagnostics: DiagnosticCollector | undefined,
  proposals: readonly TurnProposalRecord[],
): void {
  for (const proposal of proposals) {
    recordProposalDiagnostic(
      diagnostics,
      proposal.status === 'needs_review' ? 'proposal_needs_review' : 'proposal_parsed',
      proposal,
    );
  }
}

export function revertDocumentToVersion(
  document: MarkdownDocument,
  proposal: TurnProposalRecord,
): { nextDocument: MarkdownDocument; revertedMarkdown: string } {
  const previousId = proposal.previousVersionId;
  if (!previousId || !Object.hasOwn(document.versions, previousId)) {
    throw new Error('找不到可用于撤销的历史版本。');
  }
  const previousMarkdown = documentVersion(document, previousId).markdown;
  const nextDocument = writeDocument(document, document.head, previousMarkdown, 'user');
  return { nextDocument, revertedMarkdown: previousMarkdown };
}

export function recordDerivedAssetDiagnostic(
  diagnostics: DiagnosticCollector | undefined,
  proposal: Pick<TurnProposalRecord, 'target'>,
): void {
  if (!diagnostics) return;
  const normalizedTarget = normalizeProposalTarget(proposal.target);
  if (normalizedTarget !== 'character' && normalizedTarget !== 'draft' && normalizedTarget !== 'story') {
    return;
  }
  const routeMode =
    normalizedTarget === 'character'
      ? 'character'
      : normalizedTarget === 'draft'
        ? 'writing'
        : 'story';
  try {
    diagnostics.recordEvent({
      level: 'info',
      category: 'ui',
      action: 'asset_derived_from_proposal',
      meta: {
        routeMode,
        target: normalizedTarget,
      },
    });
  } catch {
    // Diagnostics breadcrumbs must never disrupt user edits.
  }
}

export interface CreatedAssetNotice {
  kind: 'character' | 'work' | 'story';
  id: string;
  label: string;
}

export type DerivedAssetTarget = 'character' | 'draft' | 'story';

export interface CrossModeProposalConfirmPayload {
  sourceMode: StageAssetMode;
  targetMode: StageAssetMode;
  targetTitle: string;
  executeConfirm: () => Promise<void>;
}

export function isDerivedAssetTarget(
  target: string | undefined,
): target is DerivedAssetTarget {
  return target === 'character' || target === 'draft' || target === 'story';
}

export function derivedTargetToStageMode(target: DerivedAssetTarget): StageAssetMode {
  if (target === 'character') return 'character';
  return target === 'draft' ? 'writing' : 'story';
}

export function derivedAssetTargetLabel(target: DerivedAssetTarget): string {
  if (target === 'character') return '新建角色';
  return target === 'draft' ? '新开写故事' : '新开文游';
}

export function toCreatedAssetNotice(derived: DerivedAssetResult): CreatedAssetNotice {
  return { kind: derived.createdKind, id: derived.createdId, label: derived.label };
}

export async function createAndSaveDerivedStory(options: {
  workspace: CreativeWorkspaceState;
  proposal: TurnProposalRecord;
  resolvedMarkdown: string;
  saveStory: (story: Story) => Promise<void>;
}): Promise<CreatedAssetNotice> {
  const derived = createDerivedAssetInWorkspace(
    options.workspace,
    options.proposal,
    options.resolvedMarkdown,
  );
  if (derived.createdStory) {
    await options.saveStory(derived.createdStory);
  }
  return toCreatedAssetNotice(derived);
}

export interface DerivedAssetResult {
  nextState: CreativeWorkspaceState;
  createdKind: 'character' | 'work' | 'story';
  createdId: string;
  label: string;
  createdStory?: Story;
}

export function createDerivedAssetInWorkspace(
  state: CreativeWorkspaceState,
  proposal: TurnProposalRecord,
  resolvedMarkdown: string,
): DerivedAssetResult {
  const normalized = normalizeProposalTarget(proposal.target);
  if (normalized === 'character') {
    const name = proposal.name?.trim() || '新角色';
    const baseChar = newCharacter(name, resolvedMarkdown);
    const conv = newConversation(baseChar, 'personal');
    const createdChar = {
      ...baseChar,
      conversations: [conv],
      activeConversationId: conv.id,
    };
    return {
      createdKind: 'character',
      createdId: createdChar.id,
      label: `已创建角色「${createdChar.name}」`,
      nextState: {
        ...state,
        characters: [...state.characters, createdChar],
      },
    };
  }
  if (normalized === 'story') {
    const title = proposal.name?.trim() || '新开文游';
    const createdStory = materializeAssetFromNodes({
      targetMode: 'story',
      title,
      settingMarkdown: resolvedMarkdown,
      turns: [],
    }).story!;
    return {
      createdKind: 'story',
      createdId: createdStory.id,
      label: `已创建文游「${createdStory.title}」`,
      nextState: state,
      createdStory,
    };
  }
  const title = proposal.name?.trim() || '新故事稿';
  const createdWork = newWork(title, resolvedMarkdown);
  return {
    createdKind: 'work',
    createdId: createdWork.id,
    label: `已创建作品「${createdWork.title}」`,
    nextState: {
      ...state,
      works: [...state.works, createdWork],
    },
  };
}
