import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Download,
  FileUp,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import {
  PROMPT_PACK_LIMITS,
  addPromptPack,
  clonePromptPack,
  createDefaultId,
  createPromptPack,
  emptyPromptPackSlots,
  exportPromptPackMarkdown,
  importSillyTavernPresetJson,
  parsePromptPackMarkdown,
  removePromptPack,
  setActivePromptPack,
  setPromptPackEnabled,
  updatePromptPack,
  validatePromptPackSlots,
  type PrefixCompletionMode,
  type PromptPack,
  type PromptPackLibrary,
  type PromptPackSlots,
} from '../harness/index.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { InsetGroup } from './primitives/InsetGroup.tsx';

export const PROMPT_PACK_DISCLAIMER =
  '「提示词包在技术上作为系统提示词（System Prompt）与可选前缀续写发往你所配置的 DeepSeek 官方接口。Folio 仅提供本地槽位编排与拒答重拟机制，不预置、不分发、也不代为获取任何第三方规避提示词；导入内容由你自行维护并对接口调用合规性与双倍重试 Token 消耗负责。」';

export interface PromptPackSheetProps {
  library: PromptPackLibrary;
  onChange: (library: PromptPackLibrary) => void;
  onExport: (pack: PromptPack) => void | Promise<void>;
}

type SlotKey = keyof PromptPackSlots;

const SLOT_META: Record<SlotKey, { label: string; hint: string; testId: string }> = {
  head: {
    label: 'head · 前置叙事框架',
    hint: '放在内置叙事提示词之前，用于虚构沙箱定性与总体创作框架。',
    testId: 'prompt-pack-slot-head',
  },
  mid: {
    label: 'mid · 中段文风规则',
    hint: '放在内置提示词之后，用于文风、感官密度、对白与叙事禁令。',
    testId: 'prompt-pack-slot-mid',
  },
  tail: {
    label: 'tail · 常驻尾槽',
    hint: '仅在拒答重试或显式开启常驻尾槽时追加，适合最后的落笔提醒。',
    testId: 'prompt-pack-slot-tail',
  },
};

const PREFIX_OPTIONS: Array<{ value: PrefixCompletionMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'on_retry', label: '仅重试时开启（推荐）' },
  { value: 'always', label: '每轮开启' },
];

function selectedPack(library: PromptPackLibrary): PromptPack {
  return (
    library.packs.find((pack) => pack.id === library.activePackId) ??
    library.packs[0]
  );
}

function parseImportText(text: string, fileName: string, title?: string): PromptPack {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('导入内容为空。');
  const looksJson =
    fileName.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('{');
  return looksJson
    ? importSillyTavernPresetJson(trimmed, title)
    : parsePromptPackMarkdown(trimmed, title);
}

export function PromptPackSheet({ library, onChange, onExport }: PromptPackSheetProps) {
  const activePack = selectedPack(library);
  const [selectedId, setSelectedId] = useState(activePack.id);
  const selected =
    library.packs.find((pack) => pack.id === selectedId) ??
    library.packs.find((pack) => pack.id === library.activePackId) ??
    library.packs[0];
  const [titleDraft, setTitleDraft] = useState(selected.title);
  const [slotsDraft, setSlotsDraft] = useState<PromptPackSlots>(selected.slots);
  const [pasteDraft, setPasteDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const prevActivePackIdRef = useRef<string | null>(library.activePackId);
  const readOnly = selected.readOnly === true || selected.source === 'builtin';
  const validation = useMemo(() => validatePromptPackSlots(slotsDraft), [slotsDraft]);
  const total = validation.totalChars;

  useEffect(() => {
    if (library.activePackId && library.activePackId !== prevActivePackIdRef.current) {
      if (library.packs.some((pack) => pack.id === library.activePackId)) {
        setSelectedId(library.activePackId);
      }
    } else if (!library.packs.some((pack) => pack.id === selectedId)) {
      setSelectedId(
        (library.activePackId && library.packs.find((pack) => pack.id === library.activePackId)?.id) ??
          library.packs[0]?.id ??
          '',
      );
    }
    prevActivePackIdRef.current = library.activePackId;
  }, [library.activePackId, library.packs, selectedId]);

  useEffect(() => {
    setTitleDraft(selected.title);
    setSlotsDraft(selected.slots);
  }, [
    selected.id,
    selected.updatedAt,
    selected.title,
    selected.slots.head,
    selected.slots.mid,
    selected.slots.tail,
  ]);

  const applyLibrary = (next: PromptPackLibrary, message: string) => {
    setError('');
    onChange(next);
    setStatus(message);
  };

  const selectPack = (packId: string) => {
    const pack = library.packs.find((item) => item.id === packId);
    if (!pack) return;
    setSelectedId(pack.id);
    if (pack.enabled !== false) {
      applyLibrary(setActivePromptPack(library, pack.id), `已切换到「${pack.title}」。`);
    }
  };

  const toggleGlobal = () => {
    if (library.activePackId) {
      applyLibrary(setActivePromptPack(library, null), '已停用默认提示词包。');
      return;
    }
    const nextEnabled =
      library.packs.find((pack) => pack.id === selected.id) ??
      library.packs.find((pack) => pack.enabled !== false) ??
      library.packs.find((pack) => pack.id === 'builtin-narrative-skeleton');
    if (!nextEnabled) return;
    let next = library;
    if (nextEnabled.enabled === false) {
      next = setPromptPackEnabled(next, nextEnabled.id, true);
    }
    applyLibrary(setActivePromptPack(next, nextEnabled.id), `已启用「${nextEnabled.title}」。`);
  };

  const savePack = () => {
    if (readOnly) return;
    if (!validation.valid) {
      setError(validation.errors.join('；'));
      return;
    }
    try {
      const nextPack = createPromptPack(selected.id, slotsDraft, {
        title: titleDraft,
        enabled: selected.enabled,
        source: selected.source,
        createdAt: selected.createdAt,
        updatedAt: Date.now(),
      });
      applyLibrary(updatePromptPack(library, nextPack), '提示词包已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存提示词包失败。');
    }
  };

  const createNew = () => {
    try {
      const now = Date.now();
      const pack = createPromptPack(createDefaultId(), emptyPromptPackSlots(), {
        title: '未命名提示词包',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      });
      const added = addPromptPack(library, pack);
      setSelectedId(pack.id);
      applyLibrary(setActivePromptPack(added, pack.id), '已新建并激活提示词包。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建提示词包失败。');
    }
  };

  const copyPack = () => {
    try {
      const now = Date.now();
      const source = clonePromptPack(selected);
      const pack = createPromptPack(createDefaultId(), source.slots, {
        title: `${source.title} 副本`,
        source: 'user',
        createdAt: now,
        updatedAt: now,
      });
      const added = addPromptPack(library, pack);
      setSelectedId(pack.id);
      applyLibrary(setActivePromptPack(added, pack.id), '已复制为新包并激活。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '复制提示词包失败。');
    }
  };

  const deletePack = () => {
    if (readOnly) return;
    try {
      const next = removePromptPack(library, selected.id);
      setSelectedId(next.packs[0]?.id ?? '');
      applyLibrary(next, '已删除自定义提示词包。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除提示词包失败。');
    }
  };

  const importText = (text: string, fileName: string, title?: string) => {
    try {
      const pack = parseImportText(text, fileName, title);
      const added = addPromptPack(library, pack);
      setSelectedId(pack.id);
      applyLibrary(setActivePromptPack(added, pack.id), `已导入并激活「${pack.title}」。`);
      setPasteDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入提示词包失败。');
    }
  };

  const importFile = async (file: File) => {
    try {
      importText(await file.text(), file.name, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取导入文件失败。');
    }
  };

  const exportSelected = async () => {
    try {
      exportPromptPackMarkdown(selected);
      await onExport(selected);
      setStatus(`已导出「${selected.title}」。`);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出提示词包失败。');
    }
  };

  const changeGlobalPrefix = (value: PrefixCompletionMode) => {
    applyLibrary({ ...library, defaultPrefixCompletion: value }, '已更新全局前缀续写默认档位。');
  };

  const changeTailAlways = (checked: boolean) => {
    applyLibrary({ ...library, includeTail: checked }, checked ? '已开启常驻尾槽。' : '已关闭常驻尾槽。');
  };

  return (
    <InsetGroup
      title="叙事提示词包与拒答治理"
      description="自定义前置叙事框架、前缀续写与拒答自动重拟"
      testId="settings-prompt-pack-section"
    >
      <div className="prompt-pack-global-row">
        <div>
          <strong>{library.activePackId ? `当前激活：${activePack.title}` : '默认提示词包已停用'}</strong>
          <p>同一时间只激活一个包；切换后会用于未单独覆盖的故事、作品与角色。</p>
        </div>
        <button
          type="button"
          className={`btn prompt-pack-switch${library.activePackId ? ' is-on' : ''}`}
          data-testid="prompt-pack-enable-toggle"
          aria-pressed={Boolean(library.activePackId)}
          onClick={toggleGlobal}
        >
          {library.activePackId ? '已启用' : '已停用'}
        </button>
      </div>

      <div className="prompt-pack-picker" role="radiogroup" aria-label="当前全局激活包">
        {library.packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            role="radio"
            aria-checked={library.activePackId === pack.id}
            className={`prompt-pack-option${library.activePackId === pack.id ? ' is-active' : ''}`}
            data-testid={`prompt-pack-option-${pack.id}`}
            onClick={() => selectPack(pack.id)}
          >
            <span>{pack.title}</span>
            <small>{pack.readOnly ? '只读内置' : `${pack.slots.head.length + pack.slots.mid.length + pack.slots.tail.length} 字`}</small>
          </button>
        ))}
      </div>

      <div className="prompt-pack-actions">
        <button type="button" className="btn" data-testid="prompt-pack-new" onClick={createNew}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> 新建
        </button>
        <button type="button" className="btn" data-testid="prompt-pack-copy" onClick={copyPack}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" /> 复制为新包
        </button>
        <button
          type="button"
          className="btn"
          data-testid="prompt-pack-export"
          onClick={() => void exportSelected()}
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" /> 导出 .md
        </button>
        <button
          type="button"
          className="btn prompt-pack-danger"
          data-testid="prompt-pack-delete"
          disabled={readOnly}
          onClick={deletePack}
        >
          <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /> 删除
        </button>
      </div>

      <BannerAlert tone="warning" testId="prompt-pack-disclaimer">
        {PROMPT_PACK_DISCLAIMER}
      </BannerAlert>

      <div className="prompt-pack-import-block">
        <input
          ref={importInputRef}
          type="file"
          accept=".md,.txt,.json,text/markdown,text/plain,application/json"
          data-testid="prompt-pack-import-input"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <button type="button" className="btn" onClick={() => importInputRef.current?.click()}>
          <FileUp size={16} strokeWidth={1.75} aria-hidden="true" /> 导入 .md / .txt / SillyTavern .json
        </button>
        <label className="prompt-pack-paste-label">
          <span>直接粘贴导入</span>
          <textarea
            rows={4}
            value={pasteDraft}
            data-testid="prompt-pack-paste-input"
            placeholder="粘贴无标记 Markdown（默认进入 head），或带 folio-slot 标记的文本 / SillyTavern JSON。"
            onChange={(event) => setPasteDraft(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-testid="prompt-pack-paste-import"
          disabled={!pasteDraft.trim()}
          onClick={() => importText(pasteDraft, 'paste.md', '粘贴导入')}
        >
          导入粘贴内容
        </button>
      </div>

      <div className="prompt-pack-editor-head">
        <label>
          <span>提示词包名称</span>
          <input
            type="text"
            value={titleDraft}
            data-testid="prompt-pack-title"
            readOnly={readOnly}
            onChange={(event) => setTitleDraft(event.currentTarget.value)}
          />
        </label>
        {readOnly && <span className="badge badge-pending">内置只读</span>}
      </div>

      {(['head', 'mid', 'tail'] as const).map((slot) => {
        const meta = SLOT_META[slot];
        const count = slotsDraft[slot].length;
        const limit = PROMPT_PACK_LIMITS[slot];
        const over = count > limit;
        return (
          <label className="prompt-pack-slot" key={slot}>
            <span className="prompt-pack-slot-head">
              <strong>{meta.label}</strong>
              <span className={over ? 'is-over' : undefined}>
                {count} / {limit}
              </span>
            </span>
            <span className="prompt-pack-slot-hint">{meta.hint}</span>
            <textarea
              rows={slot === 'head' ? 8 : 5}
              value={slotsDraft[slot]}
              data-testid={meta.testId}
              readOnly={readOnly}
              aria-invalid={over}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setSlotsDraft((current) => ({ ...current, [slot]: value }));
              }}
            />
          </label>
        );
      })}

      <div className="prompt-pack-budget" data-testid="prompt-pack-budget">
        <strong>总长度 {total} / {PROMPT_PACK_LIMITS.total}</strong>
        {total > PROMPT_PACK_LIMITS.warning && (
          <span className="prompt-pack-soft-warning">
            已超过 12000 字软提示：首轮请求延迟与 Token 消耗会增加，但仍可保存。
          </span>
        )}
        {validation.errors.map((item) => (
          <span className="prompt-pack-hard-error" key={item}>{item}</span>
        ))}
      </div>

      <div className="prompt-pack-save-row">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="prompt-pack-save"
          disabled={readOnly || !validation.valid || !titleDraft.trim()}
          onClick={savePack}
        >
          <Save size={16} strokeWidth={1.75} aria-hidden="true" /> 保存当前包
        </button>
        <span>软提示不阻止保存；任一槽位或总长度超过硬上限时禁止保存。</span>
      </div>

      <div className="prompt-pack-global-settings">
        <label>
          <span>全局默认前缀续写</span>
          <select
            data-testid="prompt-pack-global-prefix"
            value={library.defaultPrefixCompletion ?? 'on_retry'}
            onChange={(event) => changeGlobalPrefix(event.currentTarget.value as PrefixCompletionMode)}
          >
            {PREFIX_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="prompt-pack-checkbox">
          <input
            type="checkbox"
            data-testid="prompt-pack-tail-always"
            checked={library.includeTail === true}
            onChange={(event) => changeTailAlways(event.currentTarget.checked)}
          />
          <span>每轮常驻 tail 槽位</span>
        </label>
      </div>

      {(status || error) && (
        <p
          className={`prompt-pack-status${error ? ' is-error' : ''}`}
          data-testid="prompt-pack-status"
          role="status"
        >
          {error || status}
        </p>
      )}
    </InsetGroup>
  );
}
