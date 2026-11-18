import { DEFAULT_STORY_TITLE } from './scriptParser.ts';
import type { LlmMessage, StoryBlueprint } from './types.ts';

export function createDefaultBlueprint(title: string): StoryBlueprint {
  return {
    title,
    worldRules: [],
    protagonist: '',
    npcs: [],
    taboos: [],
    openingHook: '',
    extractionStatus: 'partial_fallback',
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function toNpcsArray(value: unknown): StoryBlueprint['npcs'] {
  if (!Array.isArray(value)) return [];
  const npcs: StoryBlueprint['npcs'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    npcs.push({
      name,
      role: typeof record.role === 'string' ? record.role.trim() : '',
      traits: typeof record.traits === 'string' ? record.traits.trim() : '',
    });
  }
  return npcs;
}

const BLUEPRINT_KEYS = [
  'title',
  'worldRules',
  'protagonist',
  'npcs',
  'taboos',
  'openingHook',
] as const;

interface JsonCursor {
  text: string;
  pos: number;
}

interface PartialParseResult<T = unknown> {
  value: T;
  complete: boolean;
}

function skipWhitespace(cursor: JsonCursor): void {
  while (cursor.pos < cursor.text.length && /\s/.test(cursor.text[cursor.pos])) {
    cursor.pos += 1;
  }
}

function readJsonString(cursor: JsonCursor): string | null {
  const { text } = cursor;
  if (text[cursor.pos] !== '"') return null;

  const start = cursor.pos;
  let i = start + 1;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      const slice = text.slice(start, i + 1);
      cursor.pos = i + 1;
      try {
        const parsed = JSON.parse(slice);
        return typeof parsed === 'string' ? parsed : null;
      } catch {
        // Retry if an LLM emitted literal newlines/tabs inside a quoted string
        try {
          const sanitized = slice
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t');
          const parsed = JSON.parse(sanitized);
          return typeof parsed === 'string' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
    i += 1;
  }

  cursor.pos = text.length;
  return null;
}

function parseJsonPrimitive(cursor: JsonCursor): PartialParseResult {
  const rest = cursor.text.slice(cursor.pos);
  const match =
    /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=$|[\s,}\]])/.exec(rest);
  if (!match) {
    return { value: undefined, complete: false };
  }
  cursor.pos += match[0].length;
  if (cursor.pos >= cursor.text.length) {
    return { value: undefined, complete: false };
  }
  try {
    return { value: JSON.parse(match[0]), complete: true };
  } catch {
    return { value: undefined, complete: false };
  }
}

function parsePartialValue(cursor: JsonCursor): PartialParseResult {
  skipWhitespace(cursor);
  if (cursor.pos >= cursor.text.length) {
    return { value: undefined, complete: false };
  }

  const ch = cursor.text[cursor.pos];
  if (ch === '"') {
    const str = readJsonString(cursor);
    return str === null ? { value: undefined, complete: false } : { value: str, complete: true };
  }
  if (ch === '{') {
    return parsePartialObject(cursor);
  }
  if (ch === '[') {
    return parsePartialArray(cursor);
  }
  return parseJsonPrimitive(cursor);
}

function consumeClosingOrEof(
  cursor: JsonCursor,
  closingChar: ']' | '}',
): 'eof' | 'closed' | 'open' {
  skipWhitespace(cursor);
  if (cursor.pos >= cursor.text.length) return 'eof';
  if (cursor.text[cursor.pos] === closingChar) {
    cursor.pos += 1;
    return 'closed';
  }
  return 'open';
}

function advanceContainerSeparator(
  cursor: JsonCursor,
  closingChar: ']' | '}',
): 'continue' | 'complete' | 'stop' {
  skipWhitespace(cursor);
  if (cursor.pos >= cursor.text.length) return 'stop';
  const ch = cursor.text[cursor.pos];
  if (ch === ',') {
    cursor.pos += 1;
    return 'continue';
  }
  if (ch === closingChar) {
    cursor.pos += 1;
    return 'complete';
  }
  return 'stop';
}

function parsePartialArray(cursor: JsonCursor): PartialParseResult<unknown[]> {
  cursor.pos += 1; // skip '['
  const items: unknown[] = [];

  while (cursor.pos < cursor.text.length) {
    const startState = consumeClosingOrEof(cursor, ']');
    if (startState === 'eof') return { value: items, complete: false };
    if (startState === 'closed') return { value: items, complete: true };

    const elem = parsePartialValue(cursor);
    if (elem.complete) {
      items.push(elem.value);
    } else {
      if (elem.value && typeof elem.value === 'object' && !Array.isArray(elem.value)) {
        items.push(elem.value);
      }
      return { value: items, complete: false };
    }

    const sep = advanceContainerSeparator(cursor, ']');
    if (sep === 'complete') return { value: items, complete: true };
    if (sep === 'stop') return { value: items, complete: false };
  }

  return { value: items, complete: false };
}

function parsePartialObject(cursor: JsonCursor): PartialParseResult<Record<string, unknown>> {
  cursor.pos += 1; // skip '{'
  const record: Record<string, unknown> = {};

  while (cursor.pos < cursor.text.length) {
    const startState = consumeClosingOrEof(cursor, '}');
    if (startState === 'eof') return { value: record, complete: false };
    if (startState === 'closed') return { value: record, complete: true };
    if (cursor.text[cursor.pos] !== '"') {
      return { value: record, complete: false };
    }

    const key = readJsonString(cursor);
    if (key === null) {
      return { value: record, complete: false };
    }

    skipWhitespace(cursor);
    if (cursor.text[cursor.pos] !== ':') {
      return { value: record, complete: false };
    }
    cursor.pos += 1;

    const val = parsePartialValue(cursor);
    if (
      val.complete ||
      (val.value !== undefined && (Array.isArray(val.value) || typeof val.value === 'object'))
    ) {
      record[key] = val.value;
    }
    if (!val.complete) {
      return { value: record, complete: false };
    }

    const sep = advanceContainerSeparator(cursor, '}');
    if (sep === 'complete') return { value: record, complete: true };
    if (sep === 'stop') return { value: record, complete: false };
  }

  return { value: record, complete: false };
}

interface BlueprintCandidate {
  blueprint: StoryBlueprint;
  score: number;
}

function buildCandidateBlueprint(
  record: Record<string, unknown>,
  safeTitle: string,
  complete: boolean,
): BlueprintCandidate | null {
  const recognizedKeyCount = BLUEPRINT_KEYS.reduce(
    (count, key) => count + (Object.prototype.hasOwnProperty.call(record, key) ? 1 : 0),
    0,
  );
  if (recognizedKeyCount === 0) {
    return null;
  }

  const explicitTitle = typeof record.title === 'string' ? record.title.trim() : '';
  const title = explicitTitle || safeTitle;
  const worldRules = toStringArray(record.worldRules);
  const protagonist = typeof record.protagonist === 'string' ? record.protagonist.trim() : '';
  const npcs = toNpcsArray(record.npcs);
  const taboos = toStringArray(record.taboos);
  const openingHook = typeof record.openingHook === 'string' ? record.openingHook.trim() : '';

  const populatedCount =
    (explicitTitle ? 1 : 0) +
    (worldRules.length > 0 ? 1 : 0) +
    (protagonist.length > 0 ? 1 : 0) +
    (npcs.length > 0 ? 1 : 0) +
    (taboos.length > 0 ? 1 : 0) +
    (openingHook.length > 0 ? 1 : 0);

  const hasCoreDetails =
    worldRules.length > 0 || protagonist.length > 0 || npcs.length > 0 || openingHook.length > 0;

  const score =
    (complete && hasCoreDetails ? 1000 : complete ? 500 : 0) +
    populatedCount * 10 +
    recognizedKeyCount;

  return {
    blueprint: {
      title,
      worldRules,
      protagonist,
      npcs,
      taboos,
      openingHook,
      extractionStatus: complete && hasCoreDetails ? 'complete' : 'partial_fallback',
    },
    score,
  };
}

/**
 * Tolerantly parses LLM blueprint extraction output, stripping reasoning tags/fences,
 * ignoring preamble braces, and salvaging completed fields from truncated JSON as partial_fallback.
 */
export function parseBlueprintResponse(rawText: string, fallbackTitle: string): StoryBlueprint {
  const safeTitle = fallbackTitle.trim() || DEFAULT_STORY_TITLE;
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
    .trim();

  let best: BlueprintCandidate | null = null;
  let searchFrom = 0;

  while (searchFrom < cleaned.length) {
    const start = cleaned.indexOf('{', searchFrom);
    if (start === -1) break;

    const cursor: JsonCursor = { text: cleaned, pos: start };
    const parsed = parsePartialObject(cursor);
    const candidate = buildCandidateBlueprint(parsed.value, safeTitle, parsed.complete);

    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }

    if (parsed.complete && candidate) {
      searchFrom = cursor.pos;
    } else if (!parsed.complete && cursor.pos >= cleaned.length && candidate) {
      // Truncated parse consumed cleanly through EOF; no later outer JSON exists.
      break;
    } else {
      searchFrom = start + 1;
    }
  }

  return best ? best.blueprint : createDefaultBlueprint(safeTitle);
}

export function buildBlueprintExtractionMessages(rawScript: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是互动叙事剧本结构化分析助手。请从用户提供的原始剧本中提取“故事蓝图”，严格只输出一个 JSON 对象，不要包含额外解释或演绎正文。',
        'JSON 字段结构如下：',
        '{',
        '  "title": "故事标题",',
        '  "worldRules": ["核心世界观或数值/面板规则条目"],',
        '  "protagonist": "主角身份、初始状态或自定义要求",',
        '  "npcs": [{"name": "角色名", "role": "身份定位", "traits": "性格或攻略/交互要点"}],',
        '  "taboos": ["禁止事项与铁律"],',
        '  "openingHook": "用于开场的简短情景导入提示"',
        '}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: rawScript,
    },
  ];
}

export function formatConfirmedBlueprintAnchor(blueprint: StoryBlueprint): string {
  const lines: string[] = [`标题：${blueprint.title}`];
  if (blueprint.protagonist) {
    lines.push(`主角设定：${blueprint.protagonist}`);
  }
  if (blueprint.worldRules.length > 0) {
    lines.push(`核心规则：\n${blueprint.worldRules.map((r) => `- ${r}`).join('\n')}`);
  }
  if (blueprint.npcs.length > 0) {
    lines.push(
      `关键角色：\n${blueprint.npcs
        .map((n) => `- ${n.name}${n.role ? `（${n.role}）` : ''}：${n.traits}`)
        .join('\n')}`,
    );
  }
  if (blueprint.taboos.length > 0) {
    lines.push(`禁忌条款：\n${blueprint.taboos.map((t) => `- ${t}`).join('\n')}`);
  }
  return lines.join('\n\n');
}
