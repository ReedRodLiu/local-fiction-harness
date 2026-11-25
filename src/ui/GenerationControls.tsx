import { useState, type ReactNode } from 'react';
import { BookMarked } from 'lucide-react';
import {
  REASONING_EFFORTS,
  normalizeGenerationPreference,
  normalizeOfficialDeepSeekModel,
  normalizeReasoningEffort,
  type GenerationPreference,
  type OfficialDeepSeekModel,
  type PrefixCompletionMode,
  type PromptPackLibrary,
  type ReasoningEffort,
} from '../harness/index.ts';
import { NarrativePresetQuickSheet } from './NarrativePresetQuickSheet.tsx';

export interface GenerationControlsProps {
  model: string;
  reasoningEffort?: ReasoningEffort;
  disabled?: boolean;
  onModelChange: (model: OfficialDeepSeekModel) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  promptPackLibrary?: PromptPackLibrary;
  promptPackMode?: GenerationPreference['promptPackMode'] | 'inherit';
  prefixCompletion?: PrefixCompletionMode | 'inherit';
  onPromptPackModeChange?: (mode: GenerationPreference['promptPackMode'] | 'inherit') => void;
  onPrefixCompletionChange?: (mode: PrefixCompletionMode | 'inherit') => void;
  onManageNarrativePresets?: () => void;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
}

const MODEL_OPTIONS: ReadonlyArray<{
  value: OfficialDeepSeekModel;
  tierLabel: string;
  shortLabel: string;
  ariaLabel: string;
}> = [
  {
    value: 'deepseek-flash',
    tierLabel: '日常轻量',
    shortLabel: 'Flash',
    ariaLabel: '日常轻量 Flash',
  },
  {
    value: 'deepseek-v4-pro',
    tierLabel: '旗舰深度',
    shortLabel: 'Pro',
    ariaLabel: '旗舰深度 Pro',
  },
];

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  high: '高',
  max: '极限',
};

/**
 * Merges a partial generation preference patch into an existing override without
 * mutating global defaults or dropping unrelated fields.
 */
type GenerationPreferencePatch = Omit<Partial<GenerationPreference>, 'promptPackMode' | 'prefixCompletion'> & {
  promptPackMode?: GenerationPreference['promptPackMode'] | null;
  prefixCompletion?: PrefixCompletionMode | null;
};

export function mergeGenerationPreference(
  current: GenerationPreference | undefined,
  patch: GenerationPreferencePatch,
): GenerationPreference | undefined {
  const promptPackMode =
    patch.promptPackMode === null
      ? undefined
      : patch.promptPackMode !== undefined
        ? patch.promptPackMode
        : current?.promptPackMode;
  const prefixCompletion =
    patch.prefixCompletion === null
      ? undefined
      : patch.prefixCompletion !== undefined
        ? patch.prefixCompletion
        : current?.prefixCompletion;
  return normalizeGenerationPreference({
    model: patch.model !== undefined ? patch.model : current?.model,
    reasoningEffort:
      patch.reasoningEffort !== undefined ? patch.reasoningEffort : current?.reasoningEffort,
    promptPackMode,
    prefixCompletion,
  });
}

/**
 * Reusable bottom composer toolbar containing an optional leading action slot,
 * DeepSeek Flash/Pro 2-way selector, 4-stop thinking intensity slider, single
 * narrative-preset trigger + quick sheet, Pro cost hint, and trailing send/stop slot.
 */
export function GenerationControls({
  model,
  reasoningEffort,
  disabled = false,
  onModelChange,
  onReasoningEffortChange,
  promptPackLibrary,
  promptPackMode = 'inherit',
  prefixCompletion = 'inherit',
  onPromptPackModeChange,
  onPrefixCompletionChange,
  onManageNarrativePresets,
  leadingSlot,
  trailingSlot,
}: GenerationControlsProps) {
  const [presetSheetOpen, setPresetSheetOpen] = useState(false);
  const activeModel = normalizeOfficialDeepSeekModel(model);
  const activeEffort = normalizeReasoningEffort(reasoningEffort);
  const sliderIndex = REASONING_EFFORTS.indexOf(activeEffort);
  const hasPresetControls = Boolean(onPromptPackModeChange && onPrefixCompletionChange);
  const normalizedPromptPackMode =
    promptPackMode && promptPackMode !== 'inherit' ? promptPackMode : 'inherit';
  const normalizedPrefixCompletion =
    prefixCompletion && prefixCompletion !== 'inherit' ? prefixCompletion : 'inherit';
  const hasCustomOverride =
    normalizedPromptPackMode !== 'inherit' || normalizedPrefixCompletion !== 'inherit';

  return (
    <div className="composer-toolbar" data-testid="composer-generation-controls">
      <div className="composer-toolbar-row">
        <div className="composer-toolbar-left">
          {leadingSlot}
          <div
            className="composer-model-switch"
            role="group"
            aria-label="模型选择"
          >
            {MODEL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="composer-model-btn"
                data-testid={`composer-model-${option.value}`}
                aria-label={option.ariaLabel}
                aria-pressed={activeModel === option.value}
                disabled={disabled}
                onClick={() => onModelChange(option.value)}
              >
                <span className="composer-model-tier">{option.tierLabel}</span>
                <span className="composer-model-name">{option.shortLabel}</span>
              </button>
            ))}
          </div>

          <div
            className="composer-reasoning-control"
            data-testid="composer-reasoning-control"
          >
            <span className="composer-reasoning-title">思考</span>
            <input
              type="range"
              min={0}
              max={REASONING_EFFORTS.length - 1}
              step={1}
              value={sliderIndex >= 0 ? sliderIndex : 2}
              disabled={disabled}
              aria-label="思考强度"
              aria-valuetext={REASONING_LABELS[activeEffort]}
              data-testid="composer-reasoning-slider"
              className="composer-reasoning-slider"
              onChange={(event) => {
                const index = Number(event.currentTarget.value);
                const next = REASONING_EFFORTS[index] ?? 'high';
                onReasoningEffortChange(next);
              }}
            />
            <div
              className="composer-reasoning-stops"
              role="group"
              aria-label="思考强度档位"
            >
              {REASONING_EFFORTS.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  className="composer-reasoning-stop"
                  data-testid={`composer-reasoning-stop-${effort}`}
                  aria-label={`思考强度：${REASONING_LABELS[effort]}`}
                  aria-pressed={activeEffort === effort}
                  disabled={disabled}
                  onClick={() => onReasoningEffortChange(effort)}
                >
                  {REASONING_LABELS[effort]}
                </button>
              ))}
            </div>
          </div>

          {hasPresetControls && (
            <button
              type="button"
              className={`icon-button composer-preset-trigger${hasCustomOverride ? ' is-overridden' : ''}`}
              data-testid="composer-narrative-preset-trigger"
              aria-label="叙事预设"
              aria-haspopup="dialog"
              aria-expanded={presetSheetOpen}
              data-overridden={hasCustomOverride ? 'true' : 'false'}
              title="叙事预设"
              disabled={disabled}
              onClick={() => setPresetSheetOpen(true)}
            >
              <BookMarked size={18} strokeWidth={1.75} aria-hidden="true" />
              {hasCustomOverride && (
                <span
                  className="composer-preset-dot"
                  data-testid="composer-narrative-preset-dot"
                  aria-hidden="true"
                />
              )}
            </button>
          )}
        </div>
        {trailingSlot}
      </div>

      {activeModel === 'deepseek-v4-pro' && (
        <p className="composer-pro-hint" data-testid="composer-pro-cost-hint">
          旗舰深度响应耗时更长，额度消耗约为 Flash 的 3–4 倍。
        </p>
      )}

      {onPromptPackModeChange && onPrefixCompletionChange && (
        <NarrativePresetQuickSheet
          open={presetSheetOpen}
          library={promptPackLibrary}
          promptPackMode={normalizedPromptPackMode}
          prefixCompletion={normalizedPrefixCompletion}
          disabled={disabled}
          onPromptPackModeChange={onPromptPackModeChange}
          onPrefixCompletionChange={onPrefixCompletionChange}
          onManagePresets={onManageNarrativePresets}
          onClose={() => setPresetSheetOpen(false)}
        />
      )}
    </div>
  );
}
