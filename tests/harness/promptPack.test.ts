import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  PROMPT_PACK_LIMITS,
  createDefaultPromptPackLibrary,
  createPromptPack,
  createPromptPackStore,
  emptyPromptPackSlots,
  exportFolioBackupV3,
  exportPromptPackMarkdown,
  importSillyTavernPresetJson,
  newDocument,
  parseAndValidateFolioBackup,
  parsePromptPackMarkdown,
  resolveEffectivePromptPack,
  type KeyValueStorage,
  type PromptPackLibrary,
} from '../../src/harness/index.ts';

function createMemoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe('Prompt Pack storage and exchange formats', () => {
  it('keeps the built-in narrative skeleton and protects it from mutation/deletion', () => {
    const store = createPromptPackStore(createMemoryStorage());
    expect(store.load().packs.some((pack) => pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id)).toBe(true);
    expect(() => store.remove(BUILTIN_NARRATIVE_PROMPT_PACK.id)).toThrow(/内置|只读/);
    expect(() => store.update({ ...BUILTIN_NARRATIVE_PROMPT_PACK, title: '被改写' })).toThrow(/内置|只读/);

    const disabled = store.load();
    disabled.packs = disabled.packs.map((pack) =>
      pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id ? { ...pack, enabled: false } : pack,
    );
    disabled.activePackId = BUILTIN_NARRATIVE_PROMPT_PACK.id;
    expect(store.save(disabled).activePackId).toBeNull();
    expect(store.load().packs.find((pack) => pack.id === BUILTIN_NARRATIVE_PROMPT_PACK.id)?.enabled).toBe(false);
    expect(store.setEnabled(BUILTIN_NARRATIVE_PROMPT_PACK.id, true).packs[0]?.enabled).toBe(true);
  });

  it('accepts exact slot boundaries and rejects each slot and total hard-limit overflow', () => {
    const store = createPromptPackStore(createMemoryStorage());
    const boundary = createPromptPack('boundary-pack', {
      head: '甲'.repeat(PROMPT_PACK_LIMITS.head),
      mid: '乙'.repeat(PROMPT_PACK_LIMITS.mid),
      tail: '丙'.repeat(PROMPT_PACK_LIMITS.tail),
    });
    expect(store.add(boundary).packs.find((pack) => pack.id === boundary.id)?.slots).toEqual(boundary.slots);

    for (const slot of ['head', 'mid', 'tail'] as const) {
      const tooLong = {
        ...createPromptPack(`${slot}-too-long`, emptyPromptPackSlots()),
        slots: { ...emptyPromptPackSlots(), [slot]: '甲'.repeat(PROMPT_PACK_LIMITS[slot] + 1) },
      };
      expect(() => store.add(tooLong)).toThrow(new RegExp(`${slot}.*${PROMPT_PACK_LIMITS[slot]}`));
    }

    const totalTooLong = {
      ...createPromptPack('total-too-long', emptyPromptPackSlots()),
      slots: {
        head: '甲'.repeat(PROMPT_PACK_LIMITS.head),
        mid: '乙'.repeat(PROMPT_PACK_LIMITS.mid),
        tail: '丙'.repeat(PROMPT_PACK_LIMITS.tail + 1),
      },
    };
    expect(() => store.add(totalTooLong)).toThrow(/总长度.*32000/);
  });

  it('reports a long-pack warning above 12000 characters', () => {
    const store = createPromptPackStore(createMemoryStorage());

    const longPack = createPromptPack('long-pack', {
      head: '甲'.repeat(12001),
      mid: '',
      tail: '',
    });
    expect(store.add(longPack).warning).toMatch(/12001/);
  });

  it('persists global prefix and tail defaults and applies the prefix default at request resolution', () => {
    const storage = createMemoryStorage();
    const store = createPromptPackStore(storage);
    const saved = store.save({
      ...createDefaultPromptPackLibrary(),
      defaultPrefixCompletion: 'always',
      includeTail: true,
    });
    expect(saved.defaultPrefixCompletion).toBe('always');
    expect(saved.includeTail).toBe(true);

    const reloaded = store.load();
    expect(reloaded.defaultPrefixCompletion).toBe('always');
    expect(reloaded.includeTail).toBe(true);
    expect(resolveEffectivePromptPack(reloaded, { promptPackMode: 'inherit' }).prefixCompletion).toBe('always');
    expect(resolveEffectivePromptPack(reloaded, { promptPackMode: 'inherit', prefixCompletion: 'off' }).prefixCompletion).toBe('off');
  });

  it('imports unmarked Markdown into head and round-trips marked slots', () => {
    const unmarked = parsePromptPackMarkdown('纯 Markdown 提示词', '纯文本');
    expect(unmarked.slots).toEqual({ head: '纯 Markdown 提示词', mid: '', tail: '' });

    const marked = parsePromptPackMarkdown(
      '<!-- folio-slot: head -->\n头\n\n<!-- folio-slot: mid -->\n中\n\n<!-- folio-slot: tail -->\n尾',
      '三段',
    );
    const exported = exportPromptPackMarkdown(marked);
    expect(parsePromptPackMarkdown(exported).slots).toEqual(marked.slots);
  });

  it('round-trips inline folio-slot marker literals without splitting slots', () => {
    const pack = createPromptPack('inline-marker', {
      head: '开头\n正文 <!-- folio-slot: mid --> 字面量\n结尾',
      mid: '中段\n正文 <!-- folio-slot: tail --> 字面量',
      tail: '尾段',
    });

    expect(parsePromptPackMarkdown(exportPromptPackMarkdown(pack)).slots).toEqual(pack.slots);
  });

  it('rejects exporting a slot containing a standalone folio-slot marker', () => {
    const pack = createPromptPack('ambiguous-marker', {
      head: '前文\n<!-- folio-slot: mid -->\n后文',
      mid: '',
      tail: '',
    });

    expect(() => exportPromptPackMarkdown(pack)).toThrow(/head.*folio-slot/);
  });

  it('extracts static SillyTavern prompts into head, mid, and tail', () => {
    const pack = importSillyTavernPresetJson(
      JSON.stringify({
        name: 'ST 预设',
        prompts: [
          { identifier: 'main', content: '顶部系统规则' },
          { identifier: 'style', content: '中部文风规则' },
          { identifier: 'history', marker: true, content: '{{history}}' },
          { identifier: 'world', content: '{{world_info}}' },
          { identifier: 'tail', content: '尾部推进', injection_depth: 2 },
          { identifier: 'disabled', enabled: false, content: '不应导入' },
        ],
      }),
    );

    expect(pack.title).toBe('ST 预设');
    expect(pack.slots.head).toContain('顶部系统规则');
    expect(pack.slots.mid).toContain('中部文风规则');
    expect(pack.slots.tail).toContain('尾部推进');
    expect(JSON.stringify(pack.slots)).not.toContain('history');
    expect(JSON.stringify(pack.slots)).not.toContain('world_info');
    expect(JSON.stringify(pack.slots)).not.toContain('不应导入');
  });

  it('resolves global activation, per-entry off, and prefix defaults', () => {
    const custom = createPromptPack('custom', { head: '自定义', mid: '', tail: '' });
    const library: PromptPackLibrary = {
      packs: [BUILTIN_NARRATIVE_PROMPT_PACK, custom],
      activePackId: custom.id,
    };

    expect(resolveEffectivePromptPack(library).pack?.id).toBe('custom');
    expect(resolveEffectivePromptPack(library).prefixCompletion).toBe('on_retry');
    expect(resolveEffectivePromptPack(library, { promptPackMode: 'off' }).enabled).toBe(false);
    expect(resolveEffectivePromptPack(library, { promptPackMode: 'custom', prefixCompletion: 'always' })).toMatchObject({
      enabled: true,
      prefixCompletion: 'always',
    });
  });

  it('keeps prompt packs in the optional v3 backup field', () => {
    const library = {
      packs: [BUILTIN_NARRATIVE_PROMPT_PACK],
      activePackId: BUILTIN_NARRATIVE_PROMPT_PACK.id,
      defaultPrefixCompletion: 'always',
      includeTail: true,
    } satisfies PromptPackLibrary;
    const json = exportFolioBackupV3({
      stories: [],
      workspace: {
        revision: 0,
        publicDocument: newDocument(''),
        works: [],
        characters: [],
      },
      promptPacks: library,
    });
    const parsed = parseAndValidateFolioBackup(json);
    expect(parsed.promptPacks?.activePackId).toBe(BUILTIN_NARRATIVE_PROMPT_PACK.id);
    expect(parsed.promptPacks?.defaultPrefixCompletion).toBe('always');
    expect(parsed.promptPacks?.includeTail).toBe(true);
    expect(parsed.promptPacks?.packs[0].slots.head).toContain('虚构');
  });
});
