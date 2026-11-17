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

function extractTrailingChoices(raw: string): ParsedChoice[] {
  const lines = raw.split(/\r?\n/);
  const choiceRegex = /^\s*([A-Za-z]|[1-9]\d?)\s*[\.、:：\)]\s*(.+?)\s*$/;
  const collected: ParsedChoice[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      if (collected.length > 0) break;
      continue;
    }
    const m = choiceRegex.exec(line);
    if (!m) {
      break;
    }
    collected.unshift({
      key: m[1].toUpperCase(),
      label: m[2].trim(),
      fullText: line,
    });
  }

  return collected.length >= 2 ? collected : [];
}

/**
 * Splits assistant narrative content into prose and fenced pseudo-code HUD panels,
 * and extracts trailing A/B/C/D or numbered interactive choices.
 */
export function parseAssistantMessage(rawContent: string): ParsedAssistantMessage {
  return {
    segments: splitCodeSegments(rawContent),
    choices: extractTrailingChoices(rawContent),
  };
}
