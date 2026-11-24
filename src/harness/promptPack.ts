import { createDefaultId } from './id.ts';
import type {
  GenerationPreference,
  KeyValueStorage,
  LlmMessage,
  PrefixCompletionMode,
} from './types.ts';

export const PROMPT_PACK_STORAGE_KEY = 'lfh.prompt_packs.v1';

export const PROMPT_PACK_LIMITS = {
  head: 24_000,
  mid: 6_000,
  tail: 2_000,
  total: 32_000,
  warning: 12_000,
} as const;

export interface PromptPackSlots {
  head: string;
  mid: string;
  tail: string;
}

export interface PromptPackSlotChars {
  head: number;
  mid: number;
  tail: number;
}

export interface PromptPack {
  id: string;
  title: string;
  slots: PromptPackSlots;
  enabled?: boolean;
  readOnly?: boolean;
  source?: 'builtin' | 'markdown' | 'sillytavern' | 'user';
  createdAt?: number;
  updatedAt?: number;
}

export interface PromptPackLibrary {
  packs: PromptPack[];
  activePackId: string | null;
  /** Global prefix-completion default used when an item does not override it. */
  defaultPrefixCompletion?: PrefixCompletionMode;
  /** When enabled, the active pack tail is appended to every foreground request. */
  includeTail?: boolean;
}

export interface PromptPackValidationResult {
  valid: boolean;
  errors: string[];
  warning?: string;
  totalChars: number;
  slotChars: PromptPackSlotChars;
}

export interface PromptPackMutationResult extends PromptPackLibrary {
  warning?: string;
}

export interface PromptPackStore {
  load(): PromptPackLibrary;
  save(library: PromptPackLibrary): PromptPackMutationResult;
  add(pack: PromptPack): PromptPackMutationResult;
  update(pack: PromptPack): PromptPackMutationResult;
  remove(id: string): PromptPackMutationResult;
  setActive(id: string | null): PromptPackMutationResult;
  setEnabled(id: string, enabled: boolean): PromptPackMutationResult;
}

export interface EffectivePromptPack {
  enabled: boolean;
  pack: PromptPack | null;
  slots: PromptPackSlots;
  prefixCompletion: PrefixCompletionMode;
}

export interface PromptPackContextOptions {
  promptPackLibrary?: PromptPackLibrary;
  generationPreference?: GenerationPreference;
  /** A resolved pack or one pack can be supplied by callers that already resolved scope. */
  promptPack?: PromptPack | EffectivePromptPack | null;
  /** Tail is deliberately opt-in so normal turns retain a stable prefix. */
  includePromptPackTail?: boolean;
}

export const PROMPT_PACK_SEMANTIC_PRIORITY =
  '「若【我的记忆】或【当前设定】中的文风、人称、角色设定与通用叙事要求冲突，优先级为：当前设定 > 我的记忆 > 提示词包 > 默认叙事要求；但 lfh-summary / lfh-proposal / lfh-choices 元数据围栏格式，以及 lfh-route / entryRouter JSON 分流契约不可省略或覆盖。」';

const BUILTIN_HEAD =
  '当前会话为完全虚构的文学创作与互动叙事沙箱。所有角色、冲突、时代背景与事件均为艺术构想，请严格立足作品内部视角持续推进创作。';
const BUILTIN_MID =
  '用具体感官细节、动作反应与人物对白呈现场景张力；保持文风克制凝练，避免跳出戏外做总结、说教或列举 1/2/3 选择清单。';
const BUILTIN_TAIL =
  '紧接当前场景与人物口吻自然落笔，不要输出多余的免责开场白或创作说明。';

function freezeBuiltin(pack: PromptPack): PromptPack {
  Object.freeze(pack.slots);
  return Object.freeze(pack);
}

export const BUILTIN_NARRATIVE_PROMPT_PACK: PromptPack = freezeBuiltin({
  id: 'builtin-narrative-skeleton',
  title: 'Folio 基础叙事骨架',
  slots: { head: BUILTIN_HEAD, mid: BUILTIN_MID, tail: BUILTIN_TAIL },
  enabled: true,
  readOnly: true,
  source: 'builtin',
});

export function emptyPromptPackSlots(): PromptPackSlots {
  return { head: '', mid: '', tail: '' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSlots(slots: PromptPackSlots): PromptPackSlots {
  return { head: slots.head, mid: slots.mid, tail: slots.tail };
}

export function clonePromptPack(pack: PromptPack): PromptPack {
  return {
    ...pack,
    slots: cloneSlots(pack.slots),
  };
}

function slotChars(slots: PromptPackSlots): PromptPackSlotChars {
  return {
    head: slots.head.length,
    mid: slots.mid.length,
    tail: slots.tail.length,
  };
}

function normalizeSlots(raw: unknown): PromptPackSlots {
  if (!isRecord(raw)) {
    throw new Error('提示词包 slots 必须为对象。');
  }
  const slots = { head: raw.head, mid: raw.mid, tail: raw.tail };
  for (const key of ['head', 'mid', 'tail'] as const) {
    if (typeof slots[key] !== 'string') {
      throw new Error(`提示词包 slots.${key} 必须为字符串。`);
    }
  }
  return slots as PromptPackSlots;
}

export function validatePromptPackSlots(slots: PromptPackSlots): PromptPackValidationResult {
  const slotCharsValue = slotChars(slots);
  const totalChars = slotCharsValue.head + slotCharsValue.mid + slotCharsValue.tail;
  const errors: string[] = [];
  for (const key of ['head', 'mid', 'tail'] as const) {
    const limit = PROMPT_PACK_LIMITS[key];
    if (slotCharsValue[key] > limit) {
      errors.push(`提示词包 ${key} 槽位超出上限 ${limit} 字符（当前 ${slotCharsValue[key]}，超出 ${slotCharsValue[key] - limit}）。`);
    }
  }
  if (totalChars > PROMPT_PACK_LIMITS.total) {
    errors.push(`提示词包总长度超出上限 ${PROMPT_PACK_LIMITS.total} 字符（当前 ${totalChars}，超出 ${totalChars - PROMPT_PACK_LIMITS.total}）。`);
  }
  return {
    valid: errors.length === 0,
    errors,
    ...(totalChars > PROMPT_PACK_LIMITS.warning
      ? {
          warning: `当前提示词包共 ${totalChars} 字，长会话中将命中官方前缀缓存，但首轮请求延迟与 Token 消耗会相应提高。`,
        }
      : {}),
    totalChars,
    slotChars: slotCharsValue,
  };
}

export function validatePromptPack(pack: PromptPack): PromptPackValidationResult {
  if (!pack || typeof pack !== 'object') {
    return {
      valid: false,
      errors: ['提示词包必须为对象。'],
      totalChars: 0,
      slotChars: { head: 0, mid: 0, tail: 0 },
    };
  }
  if (typeof pack.id !== 'string' || !pack.id.trim()) {
    return {
      valid: false,
      errors: ['提示词包 id 不能为空。'],
      totalChars: 0,
      slotChars: { head: 0, mid: 0, tail: 0 },
    };
  }
  if (typeof pack.title !== 'string' || !pack.title.trim()) {
    return {
      valid: false,
      errors: ['提示词包 title 不能为空。'],
      totalChars: 0,
      slotChars: { head: 0, mid: 0, tail: 0 },
    };
  }
  try {
    return validatePromptPackSlots(normalizeSlots(pack.slots));
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : '提示词包 slots 无效。'],
      totalChars: 0,
      slotChars: { head: 0, mid: 0, tail: 0 },
    };
  }
}

export function assertValidPromptPack(pack: PromptPack): PromptPackValidationResult {
  const validation = validatePromptPack(pack);
  if (!validation.valid) {
    throw new Error(validation.errors.join('；'));
  }
  return validation;
}

export function createPromptPack(
  id: string,
  slots: PromptPackSlots,
  options: {
    title?: string;
    enabled?: boolean;
    readOnly?: boolean;
    source?: PromptPack['source'];
    createdAt?: number;
    updatedAt?: number;
  } = {},
): PromptPack {
  const pack: PromptPack = {
    id: id.trim(),
    title: options.title?.trim() || id.trim() || '未命名提示词包',
    slots: cloneSlots(slots),
    enabled: options.enabled ?? true,
    ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    ...(options.source ? { source: options.source } : { source: 'user' }),
    ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
  };
  assertValidPromptPack(pack);
  return pack;
}

function createImportedPack(title: string | undefined, slots: PromptPackSlots, source: PromptPack['source']): PromptPack {
  const now = Date.now();
  return createPromptPack(createDefaultId(), slots, {
    title: title?.trim() || '未命名提示词包',
    source,
    createdAt: now,
    updatedAt: now,
  });
}

function builtinClone(): PromptPack {
  return clonePromptPack(BUILTIN_NARRATIVE_PROMPT_PACK);
}

export function createDefaultPromptPackLibrary(): PromptPackLibrary {
  return {
    packs: [builtinClone()],
    activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
    defaultPrefixCompletion: 'on_retry',
    includeTail: false,
  };
}

function normalizePack(raw: unknown, index: number): PromptPack {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.title !== 'string' || !raw.title.trim()) {
    throw new Error(`提示词包 packs[${index}] 结构无效。`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error(`提示词包 packs[${index}].enabled 必须为布尔值。`);
  }
  if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') {
    throw new Error(`提示词包 packs[${index}].readOnly 必须为布尔值。`);
  }
  if (raw.source !== undefined && raw.source !== 'builtin' && raw.source !== 'markdown' && raw.source !== 'sillytavern' && raw.source !== 'user') {
    throw new Error(`提示词包 packs[${index}].source 无效。`);
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]))) {
      throw new Error(`提示词包 packs[${index}].${field} 必须为有限数字。`);
    }
  }
  const slots = normalizeSlots(raw.slots);
  const pack: PromptPack = {
    id: raw.id.trim(),
    title: raw.title.trim(),
    slots,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    ...(raw.readOnly === true ? { readOnly: true } : {}),
    ...(raw.source === 'builtin' || raw.source === 'markdown' || raw.source === 'sillytavern' || raw.source === 'user'
      ? { source: raw.source }
      : {}),
    ...(typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
  assertValidPromptPack(pack);
  return pack;
}

export function validatePromptPackLibrary(raw: unknown): PromptPackLibrary {
  if (!isRecord(raw) || !Array.isArray(raw.packs)) {
    throw new Error('提示词包库必须包含 packs 数组。');
  }
  const packs: PromptPack[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < raw.packs.length; index += 1) {
    const normalized = normalizePack(raw.packs[index], index);
    if (ids.has(normalized.id)) {
      throw new Error(`提示词包 id 重复：${normalized.id}。`);
    }
    ids.add(normalized.id);
    if (normalized.id === BUILTIN_NARRATIVE_PROMPT_PACK.id) {
      packs.push({ ...builtinClone(), enabled: normalized.enabled });
    } else {
      packs.push(normalized);
    }
  }
  if (!ids.has(BUILTIN_NARRATIVE_PROMPT_PACK.id)) {
    packs.unshift(builtinClone());
  }
  const activePackId = raw.activePackId === null || raw.activePackId === undefined
    ? null
    : typeof raw.activePackId === 'string'
      ? raw.activePackId
      : (() => { throw new Error('提示词包库 activePackId 必须为字符串或 null。'); })();
  const activePack = activePackId ? packs.find((pack) => pack.id === activePackId) : undefined;
  if (
    raw.defaultPrefixCompletion !== undefined &&
    raw.defaultPrefixCompletion !== 'off' &&
    raw.defaultPrefixCompletion !== 'on_retry' &&
    raw.defaultPrefixCompletion !== 'always'
  ) {
    throw new Error('提示词包库 defaultPrefixCompletion 无效。');
  }
  if (raw.includeTail !== undefined && typeof raw.includeTail !== 'boolean') {
    throw new Error('提示词包库 includeTail 必须为布尔值。');
  }
  return {
    packs,
    activePackId: activePack && activePack.enabled !== false ? activePack.id : null,
    defaultPrefixCompletion: raw.defaultPrefixCompletion ?? 'on_retry',
    includeTail: raw.includeTail ?? false,
  };
}

/** Returns whether the library still has the untouched built-in defaults. */
export function isDefaultPromptPackLibrary(library: PromptPackLibrary): boolean {
  const normalized = validatePromptPackLibrary(library);
  const [onlyPack] = normalized.packs;
  return (
    normalized.packs.length === 1 &&
    normalized.activePackId === BUILTIN_NARRATIVE_PROMPT_PACK.id &&
    normalized.defaultPrefixCompletion === 'on_retry' &&
    normalized.includeTail === false &&
    onlyPack?.id === BUILTIN_NARRATIVE_PROMPT_PACK.id &&
    onlyPack.enabled !== false &&
    onlyPack.readOnly === true &&
    onlyPack.source === 'builtin'
  );
}

function mutationResult(library: PromptPackLibrary, warning?: string): PromptPackMutationResult {
  return warning ? { ...library, warning } : { ...library };
}

export function loadPromptPackLibrary(storage: KeyValueStorage): PromptPackLibrary {
  const raw = storage.getItem(PROMPT_PACK_STORAGE_KEY);
  if (!raw) return createDefaultPromptPackLibrary();
  try {
    return validatePromptPackLibrary(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultPromptPackLibrary();
  }
}

export function savePromptPackLibrary(storage: KeyValueStorage, library: PromptPackLibrary): PromptPackMutationResult {
  const normalized = validatePromptPackLibrary(library);
  const warning = normalized.packs
    .map((pack) => validatePromptPack(pack).warning)
    .find((value): value is string => Boolean(value));
  storage.setItem(PROMPT_PACK_STORAGE_KEY, JSON.stringify(normalized));
  return mutationResult(normalized, warning);
}

export function addPromptPack(library: PromptPackLibrary, pack: PromptPack): PromptPackLibrary {
  const normalized = clonePromptPack(pack);
  assertValidPromptPack(normalized);
  if (normalized.id === BUILTIN_NARRATIVE_PROMPT_PACK.id || library.packs.some((item) => item.id === normalized.id)) {
    throw new Error(`提示词包 id 已存在：${normalized.id}。`);
  }
  return validatePromptPackLibrary({
    ...library,
    packs: [...library.packs, normalized],
    activePackId: library.activePackId,
  });
}

export function updatePromptPack(library: PromptPackLibrary, pack: PromptPack): PromptPackLibrary {
  if (pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id) {
    throw new Error('内置提示词包为只读，不能修改。');
  }
  const index = library.packs.findIndex((item) => item.id === pack.id);
  if (index === -1) throw new Error(`提示词包不存在：${pack.id}。`);
  const next = clonePromptPack(pack);
  assertValidPromptPack(next);
  const packs = [...library.packs];
  packs[index] = next;
  return validatePromptPackLibrary({ ...library, packs, activePackId: library.activePackId });
}

export function removePromptPack(library: PromptPackLibrary, id: string): PromptPackLibrary {
  if (id === BUILTIN_NARRATIVE_PROMPT_PACK.id) {
    throw new Error('内置提示词包为只读，不能删除。');
  }
  if (!library.packs.some((pack) => pack.id === id)) throw new Error(`提示词包不存在：${id}。`);
  return validatePromptPackLibrary({
    ...library,
    packs: library.packs.filter((pack) => pack.id !== id),
    activePackId: library.activePackId === id ? null : library.activePackId,
  });
}

export function setActivePromptPack(library: PromptPackLibrary, id: string | null): PromptPackLibrary {
  if (id === null) return validatePromptPackLibrary({ ...library, activePackId: null });
  const pack = library.packs.find((item) => item.id === id);
  if (!pack) throw new Error(`提示词包不存在：${id}。`);
  if (pack.enabled === false) throw new Error(`提示词包已停用：${id}。`);
  return validatePromptPackLibrary({ ...library, activePackId: id });
}

export function setPromptPackEnabled(
  library: PromptPackLibrary,
  id: string,
  enabled: boolean,
): PromptPackLibrary {
  const pack = library.packs.find((item) => item.id === id);
  if (!pack) throw new Error(`提示词包不存在：${id}。`);
  const packs = library.packs.map((item) =>
    item.id === id ? { ...item, enabled } : item,
  );
  return validatePromptPackLibrary({
    ...library,
    packs,
    activePackId: enabled ? library.activePackId : library.activePackId === id ? null : library.activePackId,
  });
}

export function createPromptPackStore(storage: KeyValueStorage): PromptPackStore {
  return {
    load: () => loadPromptPackLibrary(storage),
    save: (library) => savePromptPackLibrary(storage, library),
    add: (pack) => {
      const library = addPromptPack(loadPromptPackLibrary(storage), pack);
      return savePromptPackLibrary(storage, library);
    },
    update: (pack) => {
      const library = updatePromptPack(loadPromptPackLibrary(storage), pack);
      return savePromptPackLibrary(storage, library);
    },
    remove: (id) => {
      const library = removePromptPack(loadPromptPackLibrary(storage), id);
      return savePromptPackLibrary(storage, library);
    },
    setActive: (id) => {
      const library = setActivePromptPack(loadPromptPackLibrary(storage), id);
      return savePromptPackLibrary(storage, library);
    },
    setEnabled: (id, enabled) => {
      const library = setPromptPackEnabled(loadPromptPackLibrary(storage), id, enabled);
      return savePromptPackLibrary(storage, library);
    },
  };
}

export function resolveEffectivePromptPack(
  library: PromptPackLibrary | undefined,
  override?: GenerationPreference,
): EffectivePromptPack {
  const disabled = (): EffectivePromptPack => ({
    enabled: false,
    pack: null,
    slots: emptyPromptPackSlots(),
    prefixCompletion: 'off',
  });
  if (!library) return disabled();

  const requestedMode = override?.promptPackMode?.trim();
  const packId = requestedMode === 'off'
    ? null
    : requestedMode && requestedMode !== 'inherit'
      ? requestedMode
      : library.activePackId;
  if (!packId) return disabled();
  const pack = library.packs.find((item) => item.id === packId);
  if (!pack || pack.enabled === false) return disabled();
  const prefixCompletion = override?.prefixCompletion === 'off' ||
    override?.prefixCompletion === 'on_retry' ||
    override?.prefixCompletion === 'always'
    ? override.prefixCompletion
    : library.defaultPrefixCompletion ?? 'on_retry';
  return {
    enabled: true,
    pack: clonePromptPack(pack),
    slots: cloneSlots(pack.slots),
    prefixCompletion,
  };
}

function resolveExplicitPromptPack(pack: PromptPack | EffectivePromptPack | null | undefined): EffectivePromptPack | null {
  if (pack === undefined) return null;
  if (pack === null) {
    return { enabled: false, pack: null, slots: emptyPromptPackSlots(), prefixCompletion: 'off' };
  }
  if ('slots' in pack && 'id' in pack) {
    if (pack.enabled === false) return { enabled: false, pack: null, slots: emptyPromptPackSlots(), prefixCompletion: 'off' };
    assertValidPromptPack(pack);
    return {
      enabled: true,
      pack: clonePromptPack(pack),
      slots: cloneSlots(pack.slots),
      prefixCompletion: 'on_retry',
    };
  }
  return {
    enabled: pack.enabled,
    pack: pack.pack ? clonePromptPack(pack.pack) : null,
    slots: cloneSlots(pack.slots),
    prefixCompletion: pack.enabled ? pack.prefixCompletion : 'off',
  };
}

export function resolvePromptPackContext(options?: PromptPackContextOptions): EffectivePromptPack {
  const explicit = resolveExplicitPromptPack(options?.promptPack);
  if (explicit) return explicit;
  return resolveEffectivePromptPack(options?.promptPackLibrary, options?.generationPreference);
}

export function buildPromptPackContextOptions(
  library: PromptPackLibrary | undefined,
  generationPreference?: GenerationPreference,
): PromptPackContextOptions {
  return {
    ...(library ? { promptPackLibrary: library } : {}),
    ...(generationPreference ? { generationPreference } : {}),
    ...(library ? { includePromptPackTail: library.includeTail ?? false } : {}),
  };
}

export function buildPromptPackAnchorMessages(
  basePrompt: string,
  effective: EffectivePromptPack,
): LlmMessage[] {
  if (!effective.enabled) return [{ role: 'system', content: basePrompt }];
  const protectedPrompt = basePrompt.includes(PROMPT_PACK_SEMANTIC_PRIORITY)
    ? basePrompt
    : [basePrompt.trim(), PROMPT_PACK_SEMANTIC_PRIORITY].filter(Boolean).join('\n');
  return [
    effective.slots.head.trim() ? { role: 'system', content: effective.slots.head } : null,
    { role: 'system', content: protectedPrompt },
    effective.slots.mid.trim() ? { role: 'system', content: effective.slots.mid } : null,
  ].filter((message): message is LlmMessage => message !== null);
}

export function promptPackTailMessage(effective: EffectivePromptPack, includeTail = false): LlmMessage | null {
  if (!includeTail || !effective.enabled || !effective.slots.tail.trim()) return null;
  return { role: 'system', content: effective.slots.tail };
}

function appendSlot(slots: PromptPackSlots, slot: keyof PromptPackSlots, raw: string): void {
  const content = raw.trim();
  if (!content) return;
  slots[slot] = slots[slot] ? `${slots[slot]}\n\n${content}` : content;
}

const PROMPT_PACK_SLOT_MARKER_SOURCE =
  String.raw`^[ \t]*<!--\s*folio-slot\s*:\s*(head|mid|tail)\s*-->[ \t]*\r?$`;

export function parsePromptPackMarkdown(raw: string, title?: string): PromptPack {
  if (typeof raw !== 'string') throw new Error('提示词包 Markdown 必须为字符串。');
  const text = raw.replace(/^\uFEFF/, '');
  const marker = new RegExp(PROMPT_PACK_SLOT_MARKER_SOURCE, 'gim');
  const matches = Array.from(text.matchAll(marker));
  const slots = emptyPromptPackSlots();
  if (matches.length === 0) {
    appendSlot(slots, 'head', text);
  } else {
    let currentSlot: keyof PromptPackSlots | null = null;
    let cursor = 0;
    for (const match of matches) {
      const before = text.slice(cursor, match.index ?? cursor);
      appendSlot(slots, currentSlot ?? 'head', before);
      currentSlot = match[1].toLowerCase() as keyof PromptPackSlots;
      cursor = (match.index ?? cursor) + match[0].length;
    }
    appendSlot(slots, currentSlot ?? 'head', text.slice(cursor));
  }
  return createImportedPack(title, slots, 'markdown');
}

function containsExcludedSillyTavernPlaceholder(entry: Record<string, unknown>): boolean {
  if (entry.marker === true) return true;
  const identifier = [entry.identifier, entry.name, entry.title].filter((value) => typeof value === 'string').join(' ');
  const content = typeof entry.content === 'string' ? entry.content : '';
  return /\{\{\s*(?:history|chat[_ -]?history|world[_ -]?info(?:[_ -]?(?:before|after))?|worldbook|world[_ -]?book|example[_ -]?messages)\s*\}\}/i.test(content) ||
    /(?:chat[_ -]?history|world[_ -]?info|worldbook|example[_ -]?messages)/i.test(identifier);
}

export function importSillyTavernPresetJson(raw: string, title?: string): PromptPack {
  if (typeof raw !== 'string') throw new Error('SillyTavern 预设必须为 JSON 字符串。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SillyTavern 预设不是有效的 JSON。');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.prompts)) {
    throw new Error('SillyTavern 预设必须包含 prompts 数组。');
  }

  const slots = emptyPromptPackSlots();
  let headAssigned = false;
  for (const item of parsed.prompts) {
    if (!isRecord(item) || item.enabled === false || containsExcludedSillyTavernPlaceholder(item)) continue;
    if (typeof item.content !== 'string' || !item.content.trim()) continue;
    const depth = typeof item.injection_depth === 'number' ? item.injection_depth : undefined;
    const isTailInjection =
      (item.injection_position === 1 && depth !== undefined && depth <= 2) ||
      (item.injection_position === undefined && depth !== undefined && depth > 0 && depth <= 2);
    if (isTailInjection) {
      appendSlot(slots, 'tail', item.content);
    } else if (!headAssigned) {
      appendSlot(slots, 'head', item.content);
      headAssigned = true;
    } else {
      appendSlot(slots, 'mid', item.content);
    }
  }

  const presetTitle = title?.trim() ||
    (typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() :
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined);
  return createImportedPack(presetTitle, slots, 'sillytavern');
}

export function exportPromptPackMarkdown(pack: PromptPack): string {
  assertValidPromptPack(pack);
  for (const slot of ['head', 'mid', 'tail'] as const) {
    const marker = new RegExp(PROMPT_PACK_SLOT_MARKER_SOURCE, 'im');
    if (marker.test(pack.slots[slot])) {
      throw new Error(`提示词包 ${slot} 槽位包含独占一行的 folio-slot 标记，导出后无法无损恢复。`);
    }
  }
  const parts = (['head', 'mid', 'tail'] as const).map((slot) =>
    `<!-- folio-slot: ${slot} -->\n${pack.slots[slot].trim()}`,
  );
  return `${parts.join('\n\n')}\n`;
}
