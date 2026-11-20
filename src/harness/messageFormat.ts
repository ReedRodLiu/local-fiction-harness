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

/** Only a terminal lfh-choices fence creates executable choice buttons. */
export function parseAssistantMessage(rawContent: string): ParsedAssistantMessage {
  const match = /(?:^|\r?\n)`{3}lfh-choices\r?\n([\s\S]*?)\r?\n`{3}\s*$/.exec(rawContent);
  if (!match) return { segments: splitCodeSegments(rawContent), choices: [] };
  const choices = match[1].split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    const parts = /^([A-Za-z]|[1-9]\d?)\s*[.、:：)]\s*(.+)$/.exec(line.trim());
    return {
      key: parts?.[1]?.toUpperCase() ?? String(index + 1),
      label: parts?.[2] ?? line.trim(),
      fullText: line.trim(),
    };
  });
  if (choices.length < 2) return { segments: splitCodeSegments(rawContent), choices: [] };
  const display = [rawContent.slice(0, match.index).trimEnd(), ...choices.map((choice) => choice.fullText)].join('\n');
  return { segments: splitCodeSegments(display), choices };
}
