import { describe, expect, it } from 'vitest';
import { computeMarkdownDiff, tokenizeForInlineDiff } from '../../src/harness/markdownDiff.ts';

describe('Two-level Myers Hunk Diff', () => {
  it('normalizes CRLF and treats identical content as no changes', () => {
    const diff = computeMarkdownDiff('第一行\r\n第二行', '第一行\n第二行');
    expect(diff.hasChanges).toBe(false);
    expect(diff.stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(diff.hunks).toEqual([]);
  });

  it('collapses unchanged regions outside 2 context lines and keeps expandable lines', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行内容`);
    const newLines = [...oldLines];
    newLines[9] = '第 10 行已修改';

    const diff = computeMarkdownDiff(oldLines.join('\n'), newLines.join('\n'));
    expect(diff.hasChanges).toBe(true);
    expect(diff.fuseTriggered).toBe(false);
    expect(diff.stats).toEqual({ added: 1, removed: 1, unchanged: 19 });

    expect(diff.hunks).toHaveLength(3);
    expect(diff.hunks[0]).toMatchObject({ type: 'collapsed', hiddenCount: 7 });
    expect(diff.hunks[1].type).toBe('hunk');
    if (diff.hunks[1].type === 'hunk') {
      expect(diff.hunks[1].lines.map((line) => line.type)).toEqual([
        'equal',
        'equal',
        'delete',
        'insert',
        'equal',
        'equal',
      ]);
      expect(diff.hunks[1].lines[0].oldLineNumber).toBe(8);
      expect(diff.hunks[1].lines[5].newLineNumber).toBe(12);
    }
    expect(diff.hunks[2]).toMatchObject({ type: 'collapsed', hiddenCount: 8 });
  });

  it('merges nearby edits into one hunk without empty collapsed blocks', () => {
    const oldText = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const newText = ['1', '2-改', '3', '4', '5', '6-改', '7', '8'].join('\n');

    const diff = computeMarkdownDiff(oldText, newText);
    expect(diff.hunks.filter((block) => block.type === 'hunk')).toHaveLength(1);
    expect(diff.hunks.some((block) => block.type === 'collapsed' && block.hiddenCount === 0)).toBe(false);
  });

  it('highlights Chinese inline word changes and falls back safely to code points without Intl.Segmenter', () => {
    const oldText = '主角携带制式铁剑走进雨夜车站。';
    const newText = '主角携带雕花银匕首走进雨夜车站。';

    const diffWithSegmenter = computeMarkdownDiff(oldText, newText);
    const hunk = diffWithSegmenter.hunks.find((b) => b.type === 'hunk');
    expect(hunk).toBeDefined();
    if (hunk && hunk.type === 'hunk') {
      const delLine = hunk.lines.find((line) => line.type === 'delete');
      const insLine = hunk.lines.find((line) => line.type === 'insert');
      expect(delLine?.inlineParts?.some((part) => part.highlight && part.text.includes('铁剑'))).toBe(true);
      expect(insLine?.inlineParts?.some((part) => part.highlight && part.text.includes('银匕首'))).toBe(true);
      expect(insLine?.inlineParts?.some((part) => !part.highlight && part.text.includes('主角'))).toBe(true);
    }

    const fallbackTokens = tokenizeForInlineDiff('🏮灯笼与🗡️匕首', { disableSegmenter: true });
    expect(fallbackTokens).toEqual(['🏮', '灯', '笼', '与', '🗡', '️', '匕', '首']);

    const diffFallback = computeMarkdownDiff('携带🏮灯笼', '携带🗡️匕首', { disableSegmenter: true });
    const fbHunk = diffFallback.hunks.find((b) => b.type === 'hunk');
    if (fbHunk && fbHunk.type === 'hunk') {
      const ins = fbHunk.lines.find((line) => line.type === 'insert');
      expect(ins?.inlineParts?.some((part) => part.highlight && part.text.includes('🗡'))).toBe(true);
    }
  });

  it('skips inline diff for replacements larger than 4 lines and trips fuse guard on huge rewrites', () => {
    const oldFive = ['a1', 'a2', 'a3', 'a4', 'a5'].join('\n');
    const newFive = ['b1', 'b2', 'b3', 'b4', 'b5'].join('\n');
    const fiveDiff = computeMarkdownDiff(oldFive, newFive);
    const fiveHunk = fiveDiff.hunks.find((b) => b.type === 'hunk');
    if (fiveHunk && fiveHunk.type === 'hunk') {
      expect(fiveHunk.lines.every((line) => line.inlineParts === undefined)).toBe(true);
    }

    const hugeOld = Array.from({ length: 450 }, (_, i) => `旧行 ${i}`).join('\n');
    const hugeNew = Array.from({ length: 450 }, (_, i) => `新行 ${i}`).join('\n');
    const hugeDiff = computeMarkdownDiff(hugeOld, hugeNew);
    expect(hugeDiff.fuseTriggered).toBe(true);
    expect(hugeDiff.overview).toEqual({
      oldLineCount: 450,
      newLineCount: 450,
      reason: 'doc_too_large',
    });

    const highEditOld = Array.from({ length: 250 }, (_, i) => `A-${i}`).join('\n');
    const highEditNew = Array.from({ length: 250 }, (_, i) => `B-${i}`).join('\n');
    const editFuseDiff = computeMarkdownDiff(highEditOld, highEditNew);
    expect(editFuseDiff.fuseTriggered).toBe(true);
    expect(editFuseDiff.overview?.reason).toBe('edit_distance_exceeded');
  });
});
