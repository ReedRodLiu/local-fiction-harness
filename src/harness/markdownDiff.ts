export interface InlineDiffPart {
  text: string;
  highlight: boolean;
}

export interface DiffLine {
  type: 'equal' | 'delete' | 'insert';
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  inlineParts?: InlineDiffPart[];
}

export interface DiffHunk {
  type: 'hunk';
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface CollapsedDiffHunk {
  type: 'collapsed';
  hiddenCount: number;
  lines: DiffLine[];
}

export type DiffBlock = DiffHunk | CollapsedDiffHunk;

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface DiffOverview {
  oldLineCount: number;
  newLineCount: number;
  reason: 'doc_too_large' | 'edit_distance_exceeded';
}

export interface MarkdownDiffOptions {
  contextLines?: number;
  maxCombinedLines?: number;
  maxEditDistance?: number;
  maxInlinePairLines?: number;
  disableSegmenter?: boolean;
}

export interface MarkdownDiffResult {
  hasChanges: boolean;
  fuseTriggered: boolean;
  stats: DiffStats;
  hunks: DiffBlock[];
  overview?: DiffOverview;
}

type EditOp =
  | { type: 'equal'; oldIdx: number; newIdx: number }
  | { type: 'delete'; oldIdx: number }
  | { type: 'insert'; newIdx: number };

let cachedZhSegmenter: Intl.Segmenter | null | undefined;

function getZhWordSegmenter(): Intl.Segmenter | null {
  if (cachedZhSegmenter !== undefined) return cachedZhSegmenter;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      cachedZhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    } catch {
      cachedZhSegmenter = null;
    }
  } else {
    cachedZhSegmenter = null;
  }
  return cachedZhSegmenter;
}

export function tokenizeForInlineDiff(
  text: string,
  options: { disableSegmenter?: boolean } = {},
): string[] {
  if (!text) return [];
  if (!options.disableSegmenter) {
    const segmenter = getZhWordSegmenter();
    if (segmenter) {
      return Array.from(segmenter.segment(text), (segment) => segment.segment);
    }
  }
  return Array.from(text);
}

function myersBacktrack(
  trace: Int32Array[],
  a: readonly string[],
  b: readonly string[],
  offset: number,
): EditOp[] {
  const ops: EditOp[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 1; d -= 1) {
    const vPrev = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])
        ? k + 1
        : k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', oldIdx: x - 1, newIdx: y - 1 });
      x -= 1;
      y -= 1;
    }

    if (x === prevX) {
      ops.push({ type: 'insert', newIdx: y - 1 });
      y -= 1;
    } else {
      ops.push({ type: 'delete', oldIdx: x - 1 });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', oldIdx: x - 1, newIdx: y - 1 });
    x -= 1;
    y -= 1;
  }

  ops.reverse();
  return ops;
}

function runMyers(
  a: readonly string[],
  b: readonly string[],
  maxEditDistance: number,
): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(maxEditDistance, n + m);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return myersBacktrack(trace, a, b, offset);
      }
    }
  }

  return null;
}

function mergeInlineParts(parts: InlineDiffPart[]): InlineDiffPart[] {
  const merged: InlineDiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.highlight === part.highlight) {
      prev.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

function computeLinePairInlineDiff(
  oldLine: string,
  newLine: string,
  disableSegmenter: boolean,
): { oldParts: InlineDiffPart[]; newParts: InlineDiffPart[] } | null {
  const oldTokens = tokenizeForInlineDiff(oldLine, { disableSegmenter });
  const newTokens = tokenizeForInlineDiff(newLine, { disableSegmenter });
  if (oldTokens.length + newTokens.length > 400) return null;

  const ops = runMyers(oldTokens, newTokens, 240);
  if (!ops) return null;

  const oldParts: InlineDiffPart[] = [];
  const newParts: InlineDiffPart[] = [];

  for (const op of ops) {
    if (op.type === 'equal') {
      const token = oldTokens[op.oldIdx];
      oldParts.push({ text: token, highlight: false });
      newParts.push({ text: token, highlight: false });
    } else if (op.type === 'delete') {
      oldParts.push({ text: oldTokens[op.oldIdx], highlight: true });
    } else {
      newParts.push({ text: newTokens[op.newIdx], highlight: true });
    }
  }

  return {
    oldParts: mergeInlineParts(oldParts),
    newParts: mergeInlineParts(newParts),
  };
}

function splitPartsByNewline(parts: InlineDiffPart[]): InlineDiffPart[][] {
  const lines: InlineDiffPart[][] = [[]];
  for (const part of parts) {
    const segments = part.text.split('\n');
    for (let i = 0; i < segments.length; i += 1) {
      if (i > 0) lines.push([]);
      if (segments[i]) {
        lines[lines.length - 1].push({ text: segments[i], highlight: part.highlight });
      }
    }
  }
  return lines.map(mergeInlineParts);
}

function annotateInlineDiffs(
  lines: DiffLine[],
  maxInlinePairLines: number,
  disableSegmenter: boolean,
): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'delete') {
      i += 1;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].type === 'delete') i += 1;
    const delEnd = i;

    const insStart = i;
    while (i < lines.length && lines[i].type === 'insert') i += 1;
    const insEnd = i;

    const delCount = delEnd - delStart;
    const insCount = insEnd - insStart;
    if (delCount === 0 || insCount === 0 || Math.max(delCount, insCount) > maxInlinePairLines) {
      continue;
    }

    if (delCount === insCount) {
      for (let k = 0; k < delCount; k += 1) {
        const pair = computeLinePairInlineDiff(
          lines[delStart + k].text,
          lines[insStart + k].text,
          disableSegmenter,
        );
        if (pair) {
          lines[delStart + k].inlineParts = pair.oldParts;
          lines[insStart + k].inlineParts = pair.newParts;
        }
      }
    } else {
      const joinedOld = lines
        .slice(delStart, delEnd)
        .map((line) => line.text)
        .join('\n');
      const joinedNew = lines
        .slice(insStart, insEnd)
        .map((line) => line.text)
        .join('\n');
      const pair = computeLinePairInlineDiff(joinedOld, joinedNew, disableSegmenter);
      if (pair) {
        const oldByLine = splitPartsByNewline(pair.oldParts);
        const newByLine = splitPartsByNewline(pair.newParts);
        if (oldByLine.length === delCount && newByLine.length === insCount) {
          for (let k = 0; k < delCount; k += 1) {
            lines[delStart + k].inlineParts = oldByLine[k];
          }
          for (let k = 0; k < insCount; k += 1) {
            lines[insStart + k].inlineParts = newByLine[k];
          }
        }
      }
    }
  }
}

function buildHunk(lines: DiffLine[]): DiffHunk {
  const oldNums = lines.map((l) => l.oldLineNumber).filter((n): n is number => n !== null);
  const newNums = lines.map((l) => l.newLineNumber).filter((n): n is number => n !== null);
  return {
    type: 'hunk',
    oldStart: oldNums[0] ?? 0,
    oldCount: oldNums.length,
    newStart: newNums[0] ?? 0,
    newCount: newNums.length,
    lines,
  };
}

function groupIntoHunks(diffLines: DiffLine[], contextLines: number): DiffBlock[] {
  const changeRanges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < diffLines.length) {
    if (diffLines[i].type === 'equal') {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - contextLines);
    while (i < diffLines.length && diffLines[i].type !== 'equal') i += 1;
    const end = Math.min(diffLines.length, i + contextLines);
    const prev = changeRanges[changeRanges.length - 1];
    if (prev && start <= prev.end) {
      prev.end = Math.max(prev.end, end);
    } else {
      changeRanges.push({ start, end });
    }
  }

  if (changeRanges.length === 0) return [];

  const blocks: DiffBlock[] = [];
  let cursor = 0;
  for (const range of changeRanges) {
    if (range.start > cursor) {
      const collapsedLines = diffLines.slice(cursor, range.start);
      blocks.push({
        type: 'collapsed',
        hiddenCount: collapsedLines.length,
        lines: collapsedLines,
      });
    }
    blocks.push(buildHunk(diffLines.slice(range.start, range.end)));
    cursor = range.end;
  }

  if (cursor < diffLines.length) {
    const trailing = diffLines.slice(cursor);
    blocks.push({
      type: 'collapsed',
      hiddenCount: trailing.length,
      lines: trailing,
    });
  }

  return blocks;
}

function splitNormalizedLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized === '' ? [] : normalized.split('\n');
}

export function computeMarkdownDiff(
  oldText: string,
  newText: string,
  options: MarkdownDiffOptions = {},
): MarkdownDiffResult {
  const contextLines = options.contextLines ?? 2;
  const maxCombinedLines = options.maxCombinedLines ?? 800;
  const maxEditDistance = options.maxEditDistance ?? 400;
  const maxInlinePairLines = options.maxInlinePairLines ?? 4;
  const disableSegmenter = options.disableSegmenter ?? false;

  const oldLines = splitNormalizedLines(oldText);
  const newLines = splitNormalizedLines(newText);

  if (oldLines.length + newLines.length > maxCombinedLines) {
    return {
      hasChanges: oldLines.join('\n') !== newLines.join('\n'),
      fuseTriggered: true,
      stats: {
        added: newLines.length,
        removed: oldLines.length,
        unchanged: 0,
      },
      hunks: [],
      overview: {
        oldLineCount: oldLines.length,
        newLineCount: newLines.length,
        reason: 'doc_too_large',
      },
    };
  }

  const ops = runMyers(oldLines, newLines, maxEditDistance);
  if (!ops) {
    return {
      hasChanges: true,
      fuseTriggered: true,
      stats: {
        added: newLines.length,
        removed: oldLines.length,
        unchanged: 0,
      },
      hunks: [],
      overview: {
        oldLineCount: oldLines.length,
        newLineCount: newLines.length,
        reason: 'edit_distance_exceeded',
      },
    };
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;

  const diffLines: DiffLine[] = ops.map((op) => {
    if (op.type === 'equal') {
      unchanged += 1;
      return {
        type: 'equal',
        text: oldLines[op.oldIdx],
        oldLineNumber: op.oldIdx + 1,
        newLineNumber: op.newIdx + 1,
      };
    }
    if (op.type === 'delete') {
      removed += 1;
      return {
        type: 'delete',
        text: oldLines[op.oldIdx],
        oldLineNumber: op.oldIdx + 1,
        newLineNumber: null,
      };
    }
    added += 1;
    return {
      type: 'insert',
      text: newLines[op.newIdx],
      oldLineNumber: null,
      newLineNumber: op.newIdx + 1,
    };
  });

  const hasChanges = added > 0 || removed > 0;
  if (hasChanges) {
    annotateInlineDiffs(diffLines, maxInlinePairLines, disableSegmenter);
  }

  return {
    hasChanges,
    fuseTriggered: false,
    stats: { added, removed, unchanged },
    hunks: hasChanges ? groupIntoHunks(diffLines, contextLines) : [],
  };
}
