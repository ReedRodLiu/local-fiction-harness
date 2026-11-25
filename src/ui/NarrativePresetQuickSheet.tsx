import { Check, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type {
  GenerationPreference,
  PrefixCompletionMode,
  PromptPackLibrary,
} from '../harness/index.ts';
import { SheetDialog } from './primitives/SheetDialog.tsx';
import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

export interface NarrativePresetQuickSheetProps {
  open: boolean;
  library?: PromptPackLibrary;
  promptPackMode?: GenerationPreference['promptPackMode'] | 'inherit';
  prefixCompletion?: PrefixCompletionMode | 'inherit';
  disabled?: boolean;
  onPromptPackModeChange: (mode: GenerationPreference['promptPackMode'] | 'inherit') => void;
  onPrefixCompletionChange: (mode: PrefixCompletionMode | 'inherit') => void;
  onManagePresets?: () => void;
  onClose: () => void;
}

/**
 * Resolves the underlying `PrefixCompletionMode` when the player chooses
 * 「开启」 in the simplified 「叙事连贯保护」 switcher, preserving `'always'`
 * if already configured and otherwise enabling automatic continuity retry.
 */
export function resolveContinuityEnableMode(
  current: PrefixCompletionMode | 'inherit' | undefined,
  globalDefault: PrefixCompletionMode | undefined,
): PrefixCompletionMode {
  if (current === 'always') return 'always';
  if (globalDefault === 'always') return 'always';
  return 'on_retry';
}

export function NarrativePresetQuickSheet({
  open,
  library,
  promptPackMode = 'inherit',
  prefixCompletion = 'inherit',
  disabled = false,
  onPromptPackModeChange,
  onPrefixCompletionChange,
  onManagePresets,
  onClose,
}: NarrativePresetQuickSheetProps) {
  useWebHistoryLayer('narrative-preset-quick-sheet', 45, open, onClose);

  const packs = library?.packs ?? [];
  const normalizedPackMode = promptPackMode && promptPackMode !== 'inherit' ? promptPackMode : 'inherit';
  const normalizedPrefix = prefixCompletion && prefixCompletion !== 'inherit' ? prefixCompletion : 'inherit';
  const globalActivePack = library?.activePackId
    ? packs.find((pack) => pack.id === library.activePackId) ?? null
    : null;
  const globalPrefix = library?.defaultPrefixCompletion ?? 'on_retry';
  const hasMissingPack =
    normalizedPackMode !== 'inherit' &&
    normalizedPackMode !== 'off' &&
    !packs.some((pack) => pack.id === normalizedPackMode);
  const continuityOn = normalizedPrefix === 'on_retry' || normalizedPrefix === 'always';

  const handleManageClick = () => {
    onClose();
    onManagePresets?.();
  };

  return (
    <SheetDialog
      open={open}
      title="叙事预设"
      label="叙事预设快捷设置"
      panelName="叙事预设"
      testId="narrative-preset-quick-sheet"
      onClose={onClose}
    >
      <div className="narrative-quick-sheet">
        <section className="narrative-quick-section">
          <h3 className="narrative-quick-heading">当前预设选择</h3>
          <div
            className="narrative-quick-list"
            role="radiogroup"
            aria-label="当前预设选择"
            data-testid="quick-sheet-preset-list"
          >
            <button
              type="button"
              role="radio"
              aria-checked={normalizedPackMode === 'inherit'}
              className={`narrative-quick-option${normalizedPackMode === 'inherit' ? ' is-selected' : ''}`}
              data-testid="quick-preset-option-inherit"
              disabled={disabled}
              onClick={() => onPromptPackModeChange('inherit')}
            >
              <span className="narrative-quick-option-copy">
                <strong>跟随全局</strong>
                <small>{globalActivePack ? `当前全局：${globalActivePack.title}` : '当前全局：已停用'}</small>
              </span>
              {normalizedPackMode === 'inherit' && (
                <Check size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={normalizedPackMode === 'off'}
              className={`narrative-quick-option${normalizedPackMode === 'off' ? ' is-selected' : ''}`}
              data-testid="quick-preset-option-off"
              disabled={disabled}
              onClick={() => onPromptPackModeChange('off')}
            >
              <span className="narrative-quick-option-copy">
                <strong>停用预设</strong>
                <small>仅在当前条目停用叙事预设</small>
              </span>
              {normalizedPackMode === 'off' && (
                <Check size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>

            {packs.map((pack) => {
              const selected = normalizedPackMode === pack.id;
              const totalChars = pack.slots.head.length + pack.slots.mid.length + pack.slots.tail.length;
              return (
                <button
                  key={pack.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`narrative-quick-option${selected ? ' is-selected' : ''}`}
                  data-testid={`quick-preset-option-${pack.id}`}
                  disabled={disabled}
                  onClick={() => onPromptPackModeChange(pack.id)}
                >
                  <span className="narrative-quick-option-copy">
                    <strong>{pack.title}</strong>
                    <small>{pack.readOnly ? '只读内置' : `${totalChars} 字`}</small>
                  </span>
                  {selected && <Check size={16} strokeWidth={1.75} aria-hidden="true" />}
                </button>
              );
            })}

            {hasMissingPack && (
              <button
                type="button"
                role="radio"
                aria-checked={true}
                className="narrative-quick-option is-selected"
                data-testid="quick-preset-option-missing"
                disabled={disabled}
                onClick={() => onPromptPackModeChange(normalizedPackMode)}
              >
                <span className="narrative-quick-option-copy">
                  <strong>已移除的叙事预设</strong>
                  <small>原预设已删除，可切换为其他预设或跟随全局</small>
                </span>
                <Check size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>

        <section className="narrative-quick-section">
          <div className="narrative-quick-heading-group">
            <h3 className="narrative-quick-heading">叙事连贯保护</h3>
            <p className="narrative-quick-hint">
              输出意外中断或半途收束时，自动尝试衔接续写当前场景。
            </p>
          </div>
          <div
            className="narrative-quick-segmented"
            role="radiogroup"
            aria-label="叙事连贯保护"
            data-testid="quick-sheet-continuity-group"
          >
            <button
              type="button"
              role="radio"
              aria-checked={normalizedPrefix === 'inherit'}
              className={`narrative-quick-segment${normalizedPrefix === 'inherit' ? ' is-selected' : ''}`}
              data-testid="quick-continuity-option-inherit"
              disabled={disabled}
              onClick={() => onPrefixCompletionChange('inherit')}
            >
              <strong>跟随全局</strong>
              <small>{globalPrefix === 'off' ? '当前全局：关闭' : '当前全局：开启'}</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={continuityOn}
              className={`narrative-quick-segment${continuityOn ? ' is-selected' : ''}`}
              data-testid="quick-continuity-option-on"
              disabled={disabled}
              onClick={() =>
                onPrefixCompletionChange(
                  resolveContinuityEnableMode(normalizedPrefix, library?.defaultPrefixCompletion),
                )
              }
            >
              <strong>开启</strong>
              <small>{normalizedPrefix === 'always' ? '每轮前缀续写' : '中断时自动衔接'}</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={normalizedPrefix === 'off'}
              className={`narrative-quick-segment${normalizedPrefix === 'off' ? ' is-selected' : ''}`}
              data-testid="quick-continuity-option-off"
              disabled={disabled}
              onClick={() => onPrefixCompletionChange('off')}
            >
              <strong>关闭</strong>
              <small>仅单轮标准请求</small>
            </button>
          </div>
        </section>

        <section className="narrative-quick-footer">
          <button
            type="button"
            className="btn narrative-quick-manage-btn"
            data-testid="quick-sheet-manage-presets"
            onClick={handleManageClick}
          >
            <span className="narrative-quick-manage-label">
              <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>管理叙事预设…</span>
            </span>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </section>
      </div>
    </SheetDialog>
  );
}
