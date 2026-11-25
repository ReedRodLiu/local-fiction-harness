import { describe, expect, it } from 'vitest';
import {
  createDiagnosticCollector,
  documentVersion,
  emptyWorkspace,
  newCharacter,
  newWork,
  type TurnProposalRecord,
} from '../../src/harness/index.ts';
import {
  createDerivedAssetInWorkspace,
  recordDerivedAssetDiagnostic,
  recordProposalDiagnostic,
} from '../../src/ui/proposalActions.ts';

function makeProposal(overrides: Partial<TurnProposalRecord>): TurnProposalRecord {
  return {
    id: 'p-1',
    target: 'character',
    op: 'full',
    summary: '衍生新条目',
    status: 'pending',
    body: '# 设定\n内容',
    ...overrides,
  };
}

describe('proposalActions cross-mode derivation', () => {
  it('derives character, draft (work), and story assets independently without modifying source items', () => {
    const existingWork = newWork('已有作品', '作品设定');
    const existingChar = newCharacter('已有角色', '角色设定');
    const state = {
      ...emptyWorkspace(),
      works: [existingWork],
      activeWorkId: existingWork.id,
      characters: [existingChar],
      activeCharacterId: existingChar.id,
    };

    const charResult = createDerivedAssetInWorkspace(
      state,
      makeProposal({ target: 'character', name: '沈默' }),
      '# 沈默\n港务档案员',
    );
    expect(charResult.createdKind).toBe('character');
    expect(charResult.label).toBe('已创建角色「沈默」');
    expect(charResult.nextState.characters).toHaveLength(2);
    expect(charResult.nextState.activeCharacterId).toBe(existingChar.id);
    expect(documentVersion(charResult.nextState.characters[1]!.document).markdown).toBe('# 沈默\n港务档案员');

    const draftResult = createDerivedAssetInWorkspace(
      charResult.nextState,
      makeProposal({ target: 'draft', name: '雾港手记' }),
      '# 雾港手记\n故事大纲',
    );
    expect(draftResult.createdKind).toBe('work');
    expect(draftResult.label).toBe('已创建作品「雾港手记」');
    expect(draftResult.nextState.works).toHaveLength(2);
    expect(draftResult.nextState.activeWorkId).toBe(existingWork.id);
    expect(documentVersion(draftResult.nextState.works[1]!.document).markdown).toBe('# 雾港手记\n故事大纲');

    const storyResult = createDerivedAssetInWorkspace(
      draftResult.nextState,
      makeProposal({ target: 'story', name: '雾港夜航' }),
      '# 雾港夜航\n开局设定',
    );
    expect(storyResult.createdKind).toBe('story');
    expect(storyResult.label).toBe('已创建文游「雾港夜航」');
    expect(storyResult.nextState).toBe(draftResult.nextState);
    expect(storyResult.createdStory).toBeDefined();
    expect(storyResult.createdStory?.id).toBe(storyResult.createdId);
    expect(storyResult.createdStory?.title).toBe('雾港夜航');
    expect(storyResult.createdStory?.v2Migrated).toBe(true);
    expect(storyResult.createdStory?.nodes).toEqual({});
    expect(documentVersion(storyResult.createdStory!.documents!.container).markdown).toBe('# 雾港夜航\n开局设定');
  });

  it('records zero-content asset_derived_from_proposal breadcrumbs for character, draft, and story', () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    const proposals = [
      makeProposal({ target: 'character', name: '绝密角色名_CANARY', body: '绝密设定_CANARY' }),
      makeProposal({ target: 'draft', name: '绝密作品名_CANARY', body: '绝密大纲_CANARY' }),
      makeProposal({ target: 'story', name: '绝密文游名_CANARY', body: '绝密规则_CANARY' }),
    ];

    for (const proposal of proposals) {
      recordProposalDiagnostic(collector, 'proposal_applied', proposal);
      recordDerivedAssetDiagnostic(collector, proposal);
    }

    const bundle = collector.buildBundle({ baseUrl: '', model: 'deepseek-flash', memoryOnly: true });
    expect(JSON.stringify(bundle)).not.toContain('CANARY');

    const derivedEvents = bundle.events.filter((e) => e.action === 'asset_derived_from_proposal');
    expect(derivedEvents).toHaveLength(3);
    expect(derivedEvents.map((e) => e.meta)).toEqual([
      { routeMode: 'character', target: 'character' },
      { routeMode: 'writing', target: 'draft' },
      { routeMode: 'story', target: 'story' },
    ]);

    const appliedEvents = bundle.events.filter((e) => e.action === 'proposal_applied');
    expect(appliedEvents.map((e) => e.meta?.target)).toEqual(['character', 'draft', 'story']);
  });
});
