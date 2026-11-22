import { inspectStreamingReplyPrefix } from './markdownProposal.ts';

export type AssistantMode = 'story' | 'writing' | 'character';

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'codeblock'; code: string };

export interface ParsedChoice {
  key: string;
  label: string;
  fullText: string;
}

export interface ParsedAssistantMessage {
  segments: MessageSegment[];
  choices: ParsedChoice[];
}

export interface HudField {
  key: string;
  value: string;
  isWide: boolean;
}

export interface ParsedHud {
  heading: string | null;
  fields: HudField[];
}

const EXPLICIT_HUD_LANGS = new Set(['lfh-hud', 'hud', 'status']);
const LEGACY_HUD_LANGS = new Set(['', 'text', 'txt']);

export function parseHudFields(code: string): ParsedHud | null {
  const trimmed = code.trim();
  const hasBracketedHeading = trimmed.startsWith('[') && trimmed.endsWith(']');
  const body = hasBracketedHeading ? trimmed.slice(1, -1) : trimmed;
  let heading: string | null = null;
  const parts = body.split(/\r?\n|[|｜]/).map((part) => part.trim()).filter(Boolean);
  const fields: HudField[] = [];

  for (const [index, part] of parts.entries()) {
    const separator = part.search(/[:：]/);
    if (separator < 1) {
      if (hasBracketedHeading && index === 0) {
        heading = part;
        continue;
      }
      return null;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key || !value) return null;
    const cjkGlyphCount = Array.from(value).filter((glyph) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(glyph),
    ).length;
    fields.push({
      key,
      value,
      isWide: value.length >= 28 || cjkGlyphCount >= 20,
    });
  }

  return fields.length >= 2 ? { heading, fields } : null;
}

export function isHudCodeBlock(
  lang: string | undefined,
  code: string,
  mode: AssistantMode = 'story',
): boolean {
  const normalizedLang = (lang ?? '').trim().toLowerCase();
  if (EXPLICIT_HUD_LANGS.has(normalizedLang)) return true;
  if (mode !== 'story') return false;
  return LEGACY_HUD_LANGS.has(normalizedLang) && parseHudFields(code) !== null;
}

export function stripProposalBlocksForDisplay(rawContent: string): string {
  if (!rawContent.includes('`')) return rawContent;
  return inspectStreamingReplyPrefix(rawContent).visible;
}

interface LineSlice {
  text: string;
  start: number;
}

const CHOICES_FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,})[ \t]*lfh-choices[ \t]*$/;
const CHOICES_BARE_MARKER_RE = /^[ \t]{0,3}lfh-choices[ \t]*$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const EXPLICIT_CHOICE_RE = /^([A-Za-z]|[1-9]\d?)\s*[.、:：)]\s*(.+)$/;
const BULLET_PREFIX_RE = /^[-*•]\s+/;

function splitLinesWithOffsets(input: string): LineSlice[] {
  const lines: LineSlice[] = [];
  const lineRegex = /([^\r\n]*)(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(input)) !== null) {
    if (match[0] === '' && match.index === input.length) break;
    lines.push({ text: match[1], start: match.index });
    if (match.index + match[0].length >= input.length) break;
  }
  return lines;
}

function isFenceOpeningLine(line: string): { char: '`' | '~'; len: number } | null {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return null;
  const fence = match[1];
  const info = match[2];
  if (fence[0] === '`' && info.includes('`')) return null;
  return { char: fence[0] as '`' | '~', len: fence.length };
}

function isFormattedChoiceLine(line: string): boolean {
  const trimmed = line.trim();
  const withoutBullet = trimmed.replace(BULLET_PREFIX_RE, '');
  return BULLET_PREFIX_RE.test(trimmed) || EXPLICIT_CHOICE_RE.test(withoutBullet);
}

function parseChoiceLine(line: string, index: number): ParsedChoice {
  const trimmed = line.trim();
  const withoutBullet = trimmed.replace(BULLET_PREFIX_RE, '');
  const parts = EXPLICIT_CHOICE_RE.exec(withoutBullet);
  return {
    key: parts?.[1]?.toUpperCase() ?? String(index + 1),
    label: parts?.[2] ?? (withoutBullet || trimmed),
    fullText: trimmed,
  };
}

function extractBareChoicesTail(linesAfterMarker: LineSlice[]): string[] | null {
  const tail = linesAfterMarker.map((l) => l.text);
  while (tail.length > 0 && tail[0].trim() === '') tail.shift();
  while (tail.length > 0 && tail[tail.length - 1].trim() === '') tail.pop();
  if (tail.some((line) => isFenceOpeningLine(line) !== null)) return null;

  const nonEmpty = tail.filter((line) => line.trim() !== '');
  if (nonEmpty.length < 2) return null;

  const hasInternalBlankLine = tail.some((line) => line.trim() === '');
  if (hasInternalBlankLine && !nonEmpty.every(isFormattedChoiceLine)) {
    return null;
  }

  return nonEmpty;
}

function findTerminalChoicesBlock(
  lines: LineSlice[],
): { startIndex: number; choiceLines: string[] } | null {
  let activeFence: { char: '`' | '~'; len: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].text;
    if (activeFence) {
      const closeMatch = FENCE_CLOSE_RE.exec(line);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFence.char &&
        closeMatch[1].length >= activeFence.len
      ) {
        activeFence = null;
      }
      continue;
    }

    const choicesFence = CHOICES_FENCE_OPEN_RE.exec(line);
    if (choicesFence) {
      const openLen = choicesFence[1].length;
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const closeMatch = FENCE_CLOSE_RE.exec(lines[j].text);
        if (closeMatch && closeMatch[1][0] === '`' && closeMatch[1].length >= openLen) {
          closeIdx = j;
          break;
        }
      }

      if (closeIdx >= 0) {
        const hasTrailingContent = lines.slice(closeIdx + 1).some((l) => l.text.trim() !== '');
        if (!hasTrailingContent) {
          return {
            startIndex: lines[i].start,
            choiceLines: lines.slice(i + 1, closeIdx).map((l) => l.text),
          };
        }
        i = closeIdx;
        continue;
      }

      const rawChoiceLines = lines.slice(i + 1).map((l) => l.text);
      while (rawChoiceLines.length > 0 && rawChoiceLines[rawChoiceLines.length - 1].trim() === '') {
        rawChoiceLines.pop();
      }
      if (
        rawChoiceLines.length > 0 &&
        /^[ \t]{0,3}`{3,}[ \t]*$/.test(rawChoiceLines[rawChoiceLines.length - 1])
      ) {
        rawChoiceLines.pop();
      }
      return { startIndex: lines[i].start, choiceLines: rawChoiceLines };
    }

    const otherFence = isFenceOpeningLine(line);
    if (otherFence) {
      activeFence = otherFence;
      continue;
    }

    if (CHOICES_BARE_MARKER_RE.test(line)) {
      const bareChoices = extractBareChoicesTail(lines.slice(i + 1));
      if (bareChoices) {
        return { startIndex: lines[i].start, choiceLines: bareChoices };
      }
    }
  }

  return null;
}

export function extractAssistantChoices(rawContent: string): {
  displayContent: string;
  choices: ParsedChoice[];
} {
  const lines = splitLinesWithOffsets(rawContent);
  const block = findTerminalChoicesBlock(lines);
  if (!block) return { displayContent: rawContent, choices: [] };
  const choices = block.choiceLines
    .filter((line) => line.trim())
    .map((line, index) => parseChoiceLine(line, index));
  if (choices.length < 2) return { displayContent: rawContent, choices: [] };
  const displayContent = [
    rawContent.slice(0, block.startIndex).trimEnd(),
    ...choices.map((choice) => choice.fullText),
  ]
    .filter(Boolean)
    .join('\n');
  return { displayContent, choices };
}

function splitCodeSegments(raw: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fenceRegex = /```(?:[a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index).trim();
    if (before) {
      segments.push({ type: 'text', content: before });
    }
    segments.push({
      type: 'codeblock',
      code: match[1].replace(/\r?\n$/, ''),
    });
    lastIndex = fenceRegex.lastIndex;
  }

  const tail = raw.slice(lastIndex).trim();
  if (tail) {
    segments.push({ type: 'text', content: tail });
  }
  return segments;
}

/** Only a terminal lfh-choices fence creates executable choice buttons. */
export function parseAssistantMessage(rawContent: string): ParsedAssistantMessage {
  const { displayContent, choices } = extractAssistantChoices(rawContent);
  return { segments: splitCodeSegments(displayContent), choices };
}
