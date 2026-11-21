import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TurnProposalRecord } from '../../src/harness/index.ts';
import { ProposalCard, computeProposalCardState } from '../../src/ui/ProposalCard.tsx';

function makeProposal(overrides: Partial<TurnProposalRecord> = {}): TurnProposalRecord {
  return {
    id: 'prop-1',
    target: 'setting',
    op: 'patch',
    summary: '补充主角随身物品银匕首',
    status: 'pending',
    body: [
      '<<<<<<< SEARCH',
      '## 随身物品',
      '- 旧怀表',
      '=======',
      '## 随身物品',
      '- 旧怀表',
      '- 银匕首',
      '>>>>>>> REPLACE',
    ].join('\n'),
    baseVersionId: 'v1',
    ...overrides,
  };
}

const sampleDoc = [
  '# 角色档案',
  '',
  '背景故事第一行。',
  '背景故事第二行。',
  '背景故事第三行。',
  '背景故事第四行。',
  '背景故事第五行。',
  '背景故事第六行。',
  '',
  '## 随身物品',
  '- 旧怀表',
].join('\n');

describe('ProposalCard', () => {
  it('renders a collapsed inline header with plain-Chinese target badges, summary, and +N -M stats', () => {
    const cases: Array<{
      target: TurnProposalRecord['target'];
      mode?: 'story' | 'writing' | 'character';
      expectedBadge: string;
    }> = [
      { target: 'setting', mode: 'story', expectedBadge: '故事设定' },
      { target: 'setting', mode: 'writing', expectedBadge: '作品设定' },
      { target: 'setting', mode: 'character', expectedBadge: '角色设定' },
      { target: 'memory', expectedBadge: '我的记忆' },
      { target: 'note', expectedBadge: '分支笔记' },
      { target: 'draft', expectedBadge: '新开写故事' },
      { target: 'character', expectedBadge: '新建角色' },
    ];

    for (const item of cases) {
      const proposal = makeProposal({
        target: item.target,
        op: 'full',
        body: '第一行\n第二行',
      });
      const markup = renderToStaticMarkup(
        createElement(ProposalCard, {
          proposal,
          currentMarkdown: '第一行',
          mode: item.mode,
        }),
      );
      expect(markup).toContain(item.expectedBadge);
      expect(markup).toContain('补充主角随身物品银匕首');
      expect(markup).toMatch(/\+\d+\s*-\d+\s*行/);
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).not.toContain('data-testid="proposal-drawer"');
    }
  });

  it('expands to show two-level Myers diff with collapsed hunks, CJK inline highlights, and MarkdownView preview', () => {
    const proposal = makeProposal({
      op: 'patch',
      body: [
        '<<<<<<< SEARCH',
        '## 随身物品',
        '- 旧怀表',
        '=======',
        '## 随身物品',
        '- 精钢怀表',
        '- 银匕首',
        '>>>>>>> REPLACE',
      ].join('\n'),
    });

    const diffMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal,
        currentMarkdown: sampleDoc,
        currentVersionId: 'v1',
        defaultExpanded: true,
        defaultDetailTab: 'diff',
        onApply: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(diffMarkup).toContain('data-testid="proposal-drawer"');
    expect(diffMarkup).toContain('改动对比');
    expect(diffMarkup).toContain('完整预览');
    expect(diffMarkup).toContain('diff-collapsed');
    expect(diffMarkup).toContain('diff-inline-del');
    expect(diffMarkup).toContain('diff-inline-ins');
    expect(diffMarkup).toContain('保存改动');
    expect(diffMarkup).toContain('暂不采用');

    const previewMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal,
        currentMarkdown: sampleDoc,
        currentVersionId: 'v1',
        defaultExpanded: true,
        defaultDetailTab: 'preview',
      }),
    );

    expect(previewMarkup).toContain('class="md-view');
    expect(previewMarkup).toContain('<h1>角色档案</h1>');
    expect(previewMarkup).toContain('银匕首');
  });

  it('auto-rebases safe incremental patches when base version advanced without anchor conflict', () => {
    const driftedDoc = sampleDoc.replace('背景故事第一行。', '用户手写的全新开篇。') + '\n';
    const state = computeProposalCardState(
      makeProposal({ baseVersionId: 'v1' }),
      driftedDoc,
      'v2',
    );

    expect(state.hasVersionDrift).toBe(true);
    expect(state.hasConflict).toBe(false);
    expect(state.rebasedAutomatically).toBe(true);
    expect(state.resolvedMarkdown).toContain('用户手写的全新开篇。');
    expect(state.resolvedMarkdown).toContain('- 银匕首');
  });

  it('renders non-destructive side-by-side conflict recovery when base drifted and patch or full cannot safely apply', () => {
    const conflictedDoc = '# 角色档案\n\n用户手动改写了随身物品与背景。';
    const proposal = makeProposal({
      baseVersionId: 'v1',
      op: 'patch',
    });

    const state = computeProposalCardState(proposal, conflictedDoc, 'v2');
    expect(state.hasConflict).toBe(true);

    const markup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal,
        currentMarkdown: conflictedDoc,
        currentVersionId: 'v2',
        defaultExpanded: true,
        onOpenEditor: vi.fn(),
        onAskAiReorganize: vi.fn(),
      }),
    );

    expect(markup).toContain('内容已更新，你可以对照保留自己的修改或由 AI 重新整理');
    expect(markup).toContain('用户手动改写了随身物品与背景。');
    expect(markup).toContain('data-testid="proposal-conflict-view"');
    expect(markup).toContain('打开设定编辑');
    expect(markup).toContain('由 AI 重新整理');
    expect(markup).not.toContain('data-testid="proposal-apply-btn"');

    // Full replacement on drifted version also triggers non-destructive conflict
    const fullDrift = computeProposalCardState(
      makeProposal({ op: 'full', baseVersionId: 'v1', body: '# 全新覆写稿' }),
      conflictedDoc,
      'v2',
    );
    expect(fullDrift.hasConflict).toBe(true);
  });

  it('supports applied (with immediate 撤销此改动), reverted, dismissed, and needs_review states', () => {
    const appliedMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: makeProposal({ status: 'applied', appliedVersionId: 'v2', previousVersionId: 'v1' }),
        currentMarkdown: sampleDoc,
        onRevert: vi.fn(),
      }),
    );
    expect(appliedMarkup).toContain('已保存');
    expect(appliedMarkup).toContain('撤销此改动');
    expect(appliedMarkup).toContain('data-testid="proposal-revert-btn"');

    const revertedMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: makeProposal({ status: 'reverted' }),
        currentMarkdown: sampleDoc,
      }),
    );
    expect(revertedMarkup).toContain('已撤销');

    const dismissedMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: makeProposal({ status: 'dismissed' }),
        currentMarkdown: sampleDoc,
      }),
    );
    expect(dismissedMarkup).toContain('已忽略');

    const needsReviewMarkup = renderToStaticMarkup(
      createElement(ProposalCard, {
        proposal: makeProposal({
          status: 'needs_review',
          raw: '```lfh-proposal\ntarget: setting\n---\n未闭合提案正文',
          body: '未闭合提案正文',
          reason: 'truncated_stream',
        }),
        defaultExpanded: true,
        onOpenEditor: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(needsReviewMarkup).toContain('需手动核对');
    expect(needsReviewMarkup).toContain('未闭合提案正文');
    expect(needsReviewMarkup).toContain('复制内容');
    expect(needsReviewMarkup).toContain('打开设定编辑');
    expect(needsReviewMarkup).toContain('暂不采用');
  });
});
