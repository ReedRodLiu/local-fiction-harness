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

export function extractAssistantChoices(rawContent: string): {
  displayContent: string;
  choices: ParsedChoice[];
} {
  const match = /(?:^|\r?\n)`{3}lfh-choices\r?\n([\s\S]*?)\r?\n`{3}\s*$/.exec(rawContent);
  if (!match) return { displayContent: rawContent, choices: [] };
  const choices = match[1].split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    const parts = /^([A-Za-z]|[1-9]\d?)\s*[.、:：)]\s*(.+)$/.exec(line.trim());
    return {
      key: parts?.[1]?.toUpperCase() ?? String(index + 1),
      label: parts?.[2] ?? line.trim(),
      fullText: line.trim(),
    };
  });
  if (choices.length < 2) return { displayContent: rawContent, choices: [] };
  const displayContent = [
    rawContent.slice(0, match.index).trimEnd(),
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
