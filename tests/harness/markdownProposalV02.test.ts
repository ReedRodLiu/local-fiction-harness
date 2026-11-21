import { describe, expect, it } from 'vitest';
import {
  applyProposalPatch,
  inspectStreamingReplyPrefix,
  parseProposalReply,
  resolveProposalMarkdown,
  splitMarkdownReply,
  visibleReplyPrefix,
} from '../../src/harness/markdownProposal.ts';

describe('V0.2 lfh-proposal protocol', () => {
  it('parses head+body lfh-proposal with raw multiline markdown, quotes, and backslashes', () => {
    const reply = [
      '我已经帮你更新设定。',
      '```lfh-proposal',
      'target: setting',
      'op: full',
      'summary: 补充主角武器与台词引号',
      '---',
      '# 角色档案',
      '',
      '- 武器："银匕首" \\ 旧式',
      '- 口头禅："别回头。"',
      '```',
    ].join('\n');

    const parsed = parseProposalReply(reply);
    expect(parsed.content).toBe('我已经帮你更新设定。');
    expect(parsed.proposalStatus).toBe('recognized');
    expect(parsed.unparsedBlocks).toEqual([]);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]).toMatchObject({
      target: 'setting',
      legacyTarget: 'container',
      op: 'full',
      summary: '补充主角武器与台词引号',
      format: 'lfh-proposal',
    });
    expect(parsed.proposals[0].body).toContain('- 武器："银匕首" \\ 旧式');
    expect(parsed.proposals[0].body).toContain('- 口头禅："别回头。"');
  });

  it('supports nested fenced code blocks inside four-backtick and labeled three-backtick proposals', () => {
    const fourTick = [
      '````lfh-proposal',
      'target: note',
      'op: full',
      'summary: 记录状态脚本示例',
      '---',
      '## 笔记',
      '```ts',
      'const hp = 100;',
      '```',
      '````',
    ].join('\n');

    const parsedFour = parseProposalReply(fourTick);
    expect(parsedFour.proposalStatus).toBe('recognized');
    expect(parsedFour.proposals[0].body).toContain('```ts\nconst hp = 100;\n```');

    const threeTick = [
      '```lfh-proposal',
      'target: memory',
      'op: append',
      'summary: 追加代码格式偏好',
      '---',
      '示例格式：',
      '```markdown',
      '## 偏好',
      '```',
      '```',
    ].join('\n');

    const parsedThree = parseProposalReply(threeTick);
    expect(parsedThree.proposalStatus).toBe('recognized');
    expect(parsedThree.proposals[0].target).toBe('memory');
    expect(parsedThree.proposals[0].body).toContain('```markdown\n## 偏好\n```');
  });

  it('parses multiple ordered proposals in a single reply and preserves trailing conversational text', () => {
    const reply = [
      '好的，我同时调整当前设定和你的通用偏好。',
      '',
      '```lfh-proposal',
      'target: setting',
      'op: patch',
      'summary: 将主角武器改为银匕首',
      '---',
      '<<<<<<< SEARCH',
      '- 武器：铁剑',
      '=======',
      '- 武器：银匕首',
      '>>>>>>> REPLACE',
      '```',
      '',
      '```lfh-proposal',
      'target: memory',
      'op: append',
      'summary: 记录偏爱慢热调查节奏',
      '---',
      '- 喜欢慢热调查与冷兵器设定',
      '```',
      '',
      '已为你整理好以上两项改动，确认后才会保存。',
    ].join('\n');

    const parsed = parseProposalReply(reply);
    expect(parsed.proposalStatus).toBe('recognized');
    expect(parsed.unparsedBlocks).toEqual([]);
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0].target).toBe('setting');
    expect(parsed.proposals[0].op).toBe('patch');
    expect(parsed.proposals[1].target).toBe('memory');
    expect(parsed.proposals[1].op).toBe('append');
    expect(parsed.content).toBe(
      '好的，我同时调整当前设定和你的通用偏好。\n\n已为你整理好以上两项改动，确认后才会保存。',
    );
  });

  it('maps legacy target aliases and generates fallback Chinese summaries when summary is omitted', () => {
    const reply = [
      '```lfh-proposal',
      'target: container',
      'op: patch',
      '---',
      '<<<<<<< SEARCH',
      '- 旧规则',
      '=======',
      '- 新规则',
      '- 补充条款',
      '>>>>>>> REPLACE',
      '```',
      '```lfh-proposal',
      'target: draft',
      'op: full',
      'name: 番外篇',
      '---',
      '# 番外篇',
      '夜雾漫过月台。',
      '```',
    ].join('\n');

    const parsed = parseProposalReply(reply);
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0].target).toBe('setting');
    expect(parsed.proposals[0].summary).toContain('当前设定');
    expect(parsed.proposals[0].summary).toMatch(/新增|修改|删除/);
    expect(parsed.proposals[1].target).toBe('draft');
    expect(parsed.proposals[1].name).toBe('番外篇');
    expect(parsed.proposals[1].summary).toContain('番外篇');
  });

  it('keeps legacy lfh-change compatibility via both parseProposalReply and splitMarkdownReply', () => {
    const reply = [
      '请看修改。',
      '```lfh-change',
      '{"target":"public","markdown":"# 我的记忆\\n- 偏爱悬疑"}',
      '```',
      '供参考。',
    ].join('\n');

    const parsed = parseProposalReply(reply);
    expect(parsed.proposalStatus).toBe('recognized');
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0].target).toBe('memory');
    expect(parsed.proposals[0].legacyTarget).toBe('public');
    expect(parsed.proposals[0].markdown).toBe('# 我的记忆\n- 偏爱悬疑');
    expect(parsed.content).toBe('请看修改。\n\n供参考。');

    const legacy = splitMarkdownReply(reply);
    expect(legacy.proposalStatus).toBe('recognized');
    expect(legacy.proposal).toEqual({
      target: 'public',
      markdown: '# 我的记忆\n- 偏爱悬疑',
      name: undefined,
    });
  });

  it('never silently drops truncated, unclosed, or malformed blocks (emits needs_review)', () => {
    const truncated = [
      '剧情继续推进。',
      '```lfh-proposal',
      'target: setting',
      'op: patch',
      'summary: 修改人物背景',
      '---',
      '<<<<<<< SEARCH',
      '- 旧背景',
    ].join('\n');

    const parsedTruncated = parseProposalReply(truncated, { finishReason: 'length' });
    expect(parsedTruncated.content).toBe('剧情继续推进。');
    expect(parsedTruncated.proposalStatus).toBe('needs_review');
    expect(parsedTruncated.proposals).toHaveLength(0);
    expect(parsedTruncated.unparsedBlocks).toHaveLength(1);
    expect(parsedTruncated.unparsedBlocks[0]).toMatchObject({
      reason: 'truncated_stream',
      format: 'lfh-proposal',
      partialTarget: 'setting',
      partialOp: 'patch',
      partialSummary: '修改人物背景',
    });

    const missingSeparator = [
      '```lfh-proposal',
      'target: character',
      'name: 岑灯',
      '没有分隔线的正文',
      '```',
    ].join('\n');
    const parsedMissingSep = parseProposalReply(missingSeparator);
    expect(parsedMissingSep.proposalStatus).toBe('needs_review');
    expect(parsedMissingSep.unparsedBlocks[0]).toMatchObject({
      reason: 'missing_separator',
      partialTarget: 'character',
      partialName: '岑灯',
    });
  });

  it('hides lfh-proposal and partial markers during streaming and signals proposalInProgress', () => {
    expect(visibleReplyPrefix('回执。\n```lfh-pro')).toBe('回执。\n');
    expect(inspectStreamingReplyPrefix('回执。\n```lfh-pro')).toEqual({
      visible: '回执。\n',
      proposalInProgress: true,
    });
    expect(inspectStreamingReplyPrefix('回执。\n```lfh-proposal\ntarget: setting\n---\n秘密')).toEqual({
      visible: '回执。\n',
      proposalInProgress: true,
    });
    expect(inspectStreamingReplyPrefix('回执。\n```lfh-change\n{"target":"local"')).toEqual({
      visible: '回执。\n',
      proposalInProgress: true,
    });
    expect(inspectStreamingReplyPrefix('普通文本。')).toEqual({
      visible: '普通文本。',
      proposalInProgress: false,
    });
    const normalCodeBlock = '代码：\n```python\nprint(1)\n```';
    expect(inspectStreamingReplyPrefix(normalCodeBlock)).toEqual({
      visible: normalCodeBlock,
      proposalInProgress: false,
    });
    expect(inspectStreamingReplyPrefix(`${normalCodeBlock}\n\`\`\`lfh-pro`)).toEqual({
      visible: `${normalCodeBlock}\n`,
      proposalInProgress: true,
    });
  });
});

describe('3-tier tolerant patch / section / append applier', () => {
  it('applies multiple SEARCH/REPLACE blocks across exact, trimEnd, and normalized tiers', () => {
    const doc = [
      '# 人物设定',
      '  ',
      '*   武器：制式铁剑   ',
      '- 性格：冷静果断',
      '',
      '## 随身物品',
      '- 旧车票',
    ].join('\r\n');

    const patchBody = [
      '<<<<<<< SEARCH',
      '- 武器：制式铁剑',
      '=======',
      '- 武器：雕花银匕首',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      '## 随身物品',
      '- 旧车票',
      '=======',
      '## 随身物品',
      '- 旧车票',
      '- 银质怀表',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyProposalPatch(doc, patchBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain('- 武器：雕花银匕首');
      expect(result.markdown).toContain('- 银质怀表');
      expect(result.markdown).not.toContain('制式铁剑');
    }
  });

  it('returns structured anchor_not_found or ambiguous_anchor failures without corrupting markdown', () => {
    const missing = applyProposalPatch('第一行\n第二行', '<<<<<<< SEARCH\n不存在的行\n=======\n替换\n>>>>>>> REPLACE');
    expect(missing).toEqual({ ok: false, reason: 'anchor_not_found', failedHunkIndex: 0 });

    const ambiguous = applyProposalPatch('- 重复项\n- 重复项', '<<<<<<< SEARCH\n- 重复项\n=======\n- 改写\n>>>>>>> REPLACE');
    expect(ambiguous).toEqual({ ok: false, reason: 'ambiguous_anchor', failedHunkIndex: 0 });
  });

  it('resolves append and section proposals accurately while ignoring fake headings in code fences', () => {
    const doc = [
      '# 故事设定',
      '',
      '## 规则',
      '```markdown',
      '## 重要物品',
      '```',
      '- 不可在夜里熄灯',
      '',
      '## 重要物品',
      '- 铜钥匙',
      '',
      '## 关系网',
      '- 林：同伴',
    ].join('\n');

    const appended = resolveProposalMarkdown(doc, {
      op: 'append',
      heading: '## 重要物品',
      body: '- 怀表',
    });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.markdown).toContain('- 铜钥匙\n- 怀表\n\n## 关系网');
    }

    const replacedSection = resolveProposalMarkdown(doc, {
      op: 'section',
      heading: '重要物品',
      body: '- 银匕首\n- 旧车票',
    });
    expect(replacedSection.ok).toBe(true);
    if (replacedSection.ok) {
      expect(replacedSection.markdown).toContain('## 重要物品\n\n- 银匕首\n- 旧车票\n\n## 关系网');
      expect(replacedSection.markdown).toContain('```markdown\n## 重要物品\n```');
    }

    const missingHeading = resolveProposalMarkdown(doc, {
      op: 'section',
      heading: '## 不存在的章节',
      body: '内容',
    });
    expect(missingHeading).toEqual({ ok: false, reason: 'heading_not_found' });
  });
});
