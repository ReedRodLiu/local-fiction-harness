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

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Tolerantly parses LLM blueprint extraction output, stripping reasoning tags/fences
 * and falling back to partial_fallback when the response is incomplete or malformed.
 */
export function parseBlueprintResponse(rawText: string, fallbackTitle: string): StoryBlueprint {
  const safeTitle = fallbackTitle.trim() || '未命名剧本';
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
    .trim();

  const jsonCandidate = extractBalancedJsonObject(cleaned);
  if (!jsonCandidate) {
    return createDefaultBlueprint(safeTitle);
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(jsonCandidate);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return createDefaultBlueprint(safeTitle);
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return createDefaultBlueprint(safeTitle);
  }

  const title =
    typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : safeTitle;
  const worldRules = toStringArray(parsed.worldRules);
  const protagonist = typeof parsed.protagonist === 'string' ? parsed.protagonist.trim() : '';
  const npcs = toNpcsArray(parsed.npcs);
  const taboos = toStringArray(parsed.taboos);
  const openingHook = typeof parsed.openingHook === 'string' ? parsed.openingHook.trim() : '';

  const hasCoreDetails =
    worldRules.length > 0 || protagonist.length > 0 || npcs.length > 0 || openingHook.length > 0;

  return {
    title,
    worldRules,
    protagonist,
    npcs,
    taboos,
    openingHook,
    extractionStatus: hasCoreDetails ? 'complete' : 'partial_fallback',
  };
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
