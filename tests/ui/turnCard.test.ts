import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SiblingBranchInfo, TurnNode } from '../../src/harness/index.ts';
import { TurnCard } from '../../src/ui/TurnCard.tsx';

const node: TurnNode = {
  id: 'assistant-1',
  parentId: 'user-1',
  role: 'assistant',
  content: '灯光亮起。',
  reasoningContent: '先确认所在位置。',
  createdAt: 10,
  summarySnapshot: { content: '', coveredUpToNodeId: null, summarizedTurnCount: 0 },
};

const oneSibling: SiblingBranchInfo = {
  siblings: [node],
  currentIndex: 0,
  total: 1,
  prevSiblingId: null,
  nextSiblingId: null,
};

function renderCard(overrides: Partial<Parameters<typeof TurnCard>[0]> = {}) {
  const props: Parameters<typeof TurnCard>[0] = {
    node,
    isActiveLeaf: false,
    isLatestTurn: false,
    isSetupNode: false,
    turnNumber: 2,
    reasoningDurationSeconds: 4,
    isBusy: false,
    isStreaming: false,
    siblings: oneSibling,
    onSelectChoice: () => undefined,
    onSwitchBranch: () => undefined,
    onEditAndBranch: () => undefined,
    onRegenerate: () => undefined,
    onRewindToNode: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(TurnCard, props));
}

describe('TurnCard', () => {
  it('keeps historical story content visible while folding its operation row', () => {
    const markup = renderCard();

    expect(markup).toContain('data-testid="turn-history-toggle"');
    expect(markup).toContain('第 2 轮');
    expect(markup).toContain('灯光亮起。');
    expect(markup).toContain('先确认所在位置。');
    expect(markup).not.toContain('class="turn-actions"');
    expect(markup).not.toContain('hidden=""');
  });

  it('keeps setup node identity and exposes its own collapsed summary directly', () => {
    const setupNode: TurnNode = { ...node, id: 'setup-1', role: 'user', content: '完整设定全文' };
    const markup = renderCard({
      node: setupNode,
      isSetupNode: true,
    });

    expect(markup).toContain('data-testid="turn-user"');
    expect(markup).toContain('data-testid="setup-node"');
    expect(markup).toContain('data-node-id="setup-1"');
    expect(markup).toContain('已提交设定');
    expect(markup).not.toContain('data-testid="turn-history-toggle"');
  });

  it('shows a collapsed reasoning disclosure with its measured duration', () => {
    const markup = renderCard({ isLatestTurn: true });

    expect(markup).toContain('data-testid="reasoning-toggle"');
    expect(markup).toContain('已思考 4 秒');
    expect(markup).not.toMatch(/<details[^>]* open=/);
  });

  it('keeps completed reasoning collapsed when another operation is busy', () => {
    const markup = renderCard({
      isLatestTurn: true,
      isBusy: true,
      isStreaming: false,
    });

    expect(markup).not.toMatch(/<details[^>]* open=/);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('data-testid="reasoning-toggle"');
  });

  it('uses the stable branch pager contract for sibling nodes', () => {
    const markup = renderCard({
      isLatestTurn: true,
      siblings: {
        ...oneSibling,
        siblings: [node, { ...node, id: 'assistant-2', content: '另一个结局。' }],
        total: 2,
        nextSiblingId: 'assistant-2',
      },
    });

    expect(markup).toContain('data-testid="branch-pager"');
    expect(markup).toContain('aria-label="下一分支"');
    expect(markup).toContain('1 / 2');
  });

  it('places quick choices after the narrative action toolbar', () => {
    const markup = renderCard({
      node: { ...node, content: '正文\n\n```lfh-choices\n继续前进\n暂时离开\n```' },
      isLatestTurn: true,
      isActiveLeaf: true,
    });

    expect(markup.indexOf('class="turn-actions"')).toBeLessThan(markup.indexOf('class="choices-row"'));
  });

  it('shows the active branch index in a collapsed historical turn', () => {
    const markup = renderCard({
      siblings: {
        ...oneSibling,
        siblings: [node, { ...node, id: 'assistant-2', content: '另一个结局。' }],
        currentIndex: 1,
        total: 2,
      },
    });

    expect(markup).toContain('第 2 轮 · AI 叙事 · 分支 2/2');
    expect(markup).toContain('先确认所在位置。');
  });

  it('identifies a collapsed setup turn without a generic history label', () => {
    const setupNode: TurnNode = { ...node, id: 'setup-2', role: 'user', content: '设定正文' };
    const markup = renderCard({
      node: setupNode,
      isSetupNode: true,
      siblings: {
        ...oneSibling,
        siblings: [setupNode, { ...setupNode, id: 'setup-3' }],
        currentIndex: 1,
        total: 2,
      },
    });

    expect(markup).toContain('第 2 轮 · 故事设定 · 分支 2/2');
    expect(markup).not.toContain('第 2 轮 · 玩家行动');
  });
});
