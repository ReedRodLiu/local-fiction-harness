import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookMarked, Check, ChevronDown } from 'lucide-react';
import {
  DEFAULT_MODEL_CONFIG,
  PROVIDER_PRESETS,
  isOfficialDeepSeekModel,
  isOfficialDeepSeekUrl,
  normalizeGenerationPreference,
  normalizeOfficialDeepSeekModel,
  normalizeReasoningEffort,
  projectActiveModelConfig,
  resolveEffectiveModelConfig,
  type GenerationPreference,
  type ModelConfig,
  type OfficialDeepSeekModel,
  type PrefixCompletionMode,
  type PromptPackLibrary,
  type ProviderCapabilities,
  type ProviderLibrary,
  type ProviderModelEntry,
  type ProviderProfile,
  type ProviderThinkingProtocol,
  type ReasoningEffort,
} from '../harness/index.ts';
import { NarrativePresetQuickSheet } from './NarrativePresetQuickSheet.tsx';

export interface GenerationControlsProps {
  model: string;
  reasoningEffort?: ReasoningEffort;
  providerLibrary?: ProviderLibrary;
  providerId?: string;
  capabilities?: ProviderCapabilities;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onProviderModelChange?: (patch: { providerId?: string; model: string }) => void;
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

const DEEPSEEK_THINKING_STOPS: readonly ReasoningEffort[] = ['low', 'high', 'max'];
const OPENAI_THINKING_STOPS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '极限',
};

/**
 * Computes the next ReasoningEffort when toggling the composer's unified
 * thinking switch on/off for the active provider's thinking protocol.
 */
export function resolveComposerThinkingToggleEffort(
  currentEffort: ReasoningEffort,
  thinkingProtocol: ProviderThinkingProtocol,
): ReasoningEffort {
  if (currentEffort !== 'none') return 'none';
  return thinkingProtocol === 'deepseek' ? 'high' : 'medium';
}

function normalizeStopForProtocol(
  effort: ReasoningEffort,
  thinkingProtocol: ProviderThinkingProtocol,
): ReasoningEffort {
  if (effort === 'none') return 'none';
  if (thinkingProtocol === 'deepseek') {
    return effort === 'medium' ? 'high' : effort;
  }
  return effort === 'max' ? 'high' : effort;
}

export interface ProviderModelMenuGroup {
  profileId: string;
  profileName: string;
  models: ProviderModelEntry[];
}

/**
 * Builds profile-grouped model choices for the composer provider/model menu,
 * ensuring the currently active model remains selectable even if unlisted.
 */
export function buildProviderModelMenuGroups(
  providerLibrary: ProviderLibrary,
  activeProfileId: string | undefined,
  activeModel: string,
): ProviderModelMenuGroup[] {
  const trimmedActiveModel = activeModel.trim();
  return providerLibrary.profiles.map((profile) => {
    const models = [...profile.models];
    if (models.length === 0 && profile.defaultModel.trim()) {
      models.push({ id: profile.defaultModel.trim() });
    }
    if (
      profile.id === activeProfileId &&
      trimmedActiveModel &&
      !models.some((entry) => entry.id === trimmedActiveModel)
    ) {
      models.unshift({ id: trimmedActiveModel });
    }
    return {
      profileId: profile.id,
      profileName: profile.name,
      models,
    };
  });
}

function isSimpleOfficialDeepSeekMode(
  providerLibrary: ProviderLibrary | undefined,
  activeProfile: ProviderProfile | undefined,
): boolean {
  if (!providerLibrary || providerLibrary.profiles.length === 0) {
    return true;
  }
  if (providerLibrary.profiles.length > 1) {
    return false;
  }
  const sole = activeProfile ?? providerLibrary.profiles[0];
  if (!sole) return true;
  const isDeepSeek = sole.presetId === 'deepseek' || isOfficialDeepSeekUrl(sole.baseUrl);
  const hasCustomModels = sole.models.some((entry) => !isOfficialDeepSeekModel(entry.id));
  return isDeepSeek && !hasCustomModels;
}

/**
 * Merges a partial generation preference patch into an existing override without
 * mutating global defaults or dropping unrelated fields.
 */
type GenerationPreferencePatch = Omit<
  Partial<GenerationPreference>,
  'providerId' | 'model' | 'promptPackMode' | 'prefixCompletion'
> & {
  providerId?: string | null;
  model?: string | null;
  promptPackMode?: GenerationPreference['promptPackMode'] | null;
  prefixCompletion?: PrefixCompletionMode | null;
};

export function mergeGenerationPreference(
  current: GenerationPreference | undefined,
  patch: GenerationPreferencePatch,
): GenerationPreference | undefined {
  const providerId =
    patch.providerId === null
      ? undefined
      : patch.providerId !== undefined
        ? patch.providerId
        : current?.providerId;
  const model =
    patch.model === null
      ? undefined
      : patch.model !== undefined
        ? patch.model
        : current?.model;
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
    providerId,
    model,
    reasoningEffort:
      patch.reasoningEffort !== undefined ? patch.reasoningEffort : current?.reasoningEffort,
    promptPackMode,
    prefixCompletion,
  });
}

/**
 * Hydrates `publicResearch.apiKey` in memory from a saved DeepSeek profile when
 * a third-party profile borrows a DeepSeek account for public research.
 */
export function hydratePublicResearchKeyInMemory(
  library: ProviderLibrary,
  config: ModelConfig,
): ModelConfig {
  const research = config.publicResearch;
  if (!research || research.provider !== 'deepseek_account' || research.apiKey?.trim()) {
    return config;
  }
  const preferredId = research.deepseekProfileId?.trim();
  const deepSeekProfile =
    (preferredId
      ? library.profiles.find(
          (p) =>
            p.id === preferredId &&
            (p.presetId === 'deepseek' || isOfficialDeepSeekUrl(p.baseUrl)) &&
            p.apiKey.trim(),
        )
      : undefined) ??
    library.profiles.find(
      (p) => (p.presetId === 'deepseek' || isOfficialDeepSeekUrl(p.baseUrl)) && p.apiKey.trim(),
    );
  if (!deepSeekProfile) {
    return config;
  }
  return {
    ...config,
    publicResearch: {
      ...research,
      apiKey: deepSeekProfile.apiKey.trim(),
    },
  };
}

/**
 * Resolves the effective ModelConfig for a Welcome/Story/Work/Character item
 * from a ProviderLibrary (with optional dev proxy overlay and in-memory DeepSeek
 * research key hydration), falling back to `resolveEffectiveModelConfig`.
 */
export function resolveEffectiveLibraryModelConfig(options: {
  providerLibrary?: ProviderLibrary;
  defaultConfig?: ModelConfig;
  preference?: GenerationPreference;
  devProxy?: { baseUrl: string; model?: string; hasEnvKey: boolean } | null;
}): ModelConfig {
  const { providerLibrary, defaultConfig, preference, devProxy } = options;
  if (!providerLibrary) {
    return resolveEffectiveModelConfig(defaultConfig ?? DEFAULT_MODEL_CONFIG, preference);
  }
  const projected = projectActiveModelConfig(providerLibrary, preference);
  const usingActiveProfile =
    !preference?.providerId?.trim() ||
    preference.providerId.trim() === providerLibrary.activeProviderId;

  let resolved = projected;
  if (devProxy && usingActiveProfile) {
    const overrideModel = typeof preference?.model === 'string' ? preference.model.trim() : '';
    resolved = {
      ...projected,
      baseUrl: devProxy.baseUrl,
      model: overrideModel || devProxy.model || projected.model,
      apiKey: devProxy.hasEnvKey ? '' : projected.apiKey,
    };
  }
  return hydratePublicResearchKeyInMemory(providerLibrary, resolved);
}

/**
 * Reusable bottom composer toolbar containing an optional leading action slot,
 * DeepSeek Flash/Pro 2-way selector or multi-provider/model popover, unified
 * thinking toggle + protocol-aware stops, narrative-preset trigger + quick sheet,
 * Pro cost hint, and trailing send/stop slot.
 */
export function GenerationControls({
  model,
  reasoningEffort,
  providerLibrary,
  providerId,
  capabilities,
  disabled = false,
  onModelChange,
  onProviderModelChange,
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
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!providerMenuWrapRef.current?.contains(event.target)) {
        setProviderMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProviderMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [providerMenuOpen]);

  useEffect(() => {
    if (disabled && providerMenuOpen) {
      setProviderMenuOpen(false);
    }
  }, [disabled, providerMenuOpen]);

  const profiles = providerLibrary?.profiles ?? [];
  const activeProfile =
    (providerId ? profiles.find((profile) => profile.id === providerId) : undefined) ??
    (providerLibrary
      ? profiles.find((profile) => profile.id === providerLibrary.activeProviderId)
      : undefined) ??
    profiles[0];

  const useProviderSelector = !isSimpleOfficialDeepSeekMode(providerLibrary, activeProfile);
  const isOfficialDeepSeekActive = activeProfile
    ? activeProfile.presetId === 'deepseek' || isOfficialDeepSeekUrl(activeProfile.baseUrl)
    : true;
  const resolvedCapabilities =
    capabilities ??
    activeProfile?.capabilities ??
    (isOfficialDeepSeekActive
      ? PROVIDER_PRESETS.deepseek.capabilities
      : PROVIDER_PRESETS.custom.capabilities);
  const thinkingProtocol: ProviderThinkingProtocol = resolvedCapabilities.thinkingProtocol;

  const activeModel =
    !useProviderSelector && isOfficialDeepSeekActive
      ? normalizeOfficialDeepSeekModel(model)
      : (model || activeProfile?.defaultModel || activeProfile?.models[0]?.id || '').trim();
  const activeEffort = normalizeStopForProtocol(
    normalizeReasoningEffort(reasoningEffort),
    thinkingProtocol,
  );
  const isThinkingEnabled = activeEffort !== 'none';
  const thinkingStops =
    thinkingProtocol === 'deepseek' ? DEEPSEEK_THINKING_STOPS : OPENAI_THINKING_STOPS;
  const sliderIndex = thinkingStops.indexOf(activeEffort);

  const activeModelEntry = activeProfile?.models.find((entry) => entry.id === activeModel);
  const activeModelLabel = activeModelEntry?.label ?? (activeModel || '选择模型');
  const menuGroups =
    useProviderSelector && providerLibrary
      ? buildProviderModelMenuGroups(providerLibrary, activeProfile?.id, activeModel)
      : [];

  const hasPresetControls = Boolean(onPromptPackModeChange && onPrefixCompletionChange);
  const normalizedPromptPackMode =
    promptPackMode && promptPackMode !== 'inherit' ? promptPackMode : 'inherit';
  const normalizedPrefixCompletion =
    prefixCompletion && prefixCompletion !== 'inherit' ? prefixCompletion : 'inherit';
  const hasCustomOverride =
    normalizedPromptPackMode !== 'inherit' || normalizedPrefixCompletion !== 'inherit';

  const selectModelForProfile = (targetProviderId: string | undefined, targetModel: string) => {
    setProviderMenuOpen(false);
    if (onProviderModelChange) {
      onProviderModelChange({
        ...(targetProviderId ? { providerId: targetProviderId } : {}),
        model: targetModel,
      });
      return;
    }
    onModelChange(targetModel);
  };

  return (
    <div className="composer-toolbar" data-testid="composer-generation-controls">
      <div className="composer-toolbar-row">
        <div className="composer-toolbar-left">
          {leadingSlot}
          {!useProviderSelector ? (
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
                  onClick={() => selectModelForProfile(activeProfile?.id, option.value)}
                >
                  <span className="composer-model-tier">{option.tierLabel}</span>
                  <span className="composer-model-name">{option.shortLabel}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="composer-provider-model-wrap" ref={providerMenuWrapRef}>
              <button
                type="button"
                className="composer-provider-model-trigger"
                data-testid="composer-provider-model-trigger"
                aria-label={`当前模型：${activeProfile?.name ?? ''} ${activeModelLabel}`.trim()}
                aria-haspopup="menu"
                aria-expanded={providerMenuOpen}
                disabled={disabled}
                onClick={() => setProviderMenuOpen((open) => !open)}
              >
                {activeProfile && (
                  <>
                    <span className="composer-provider-model-provider">{activeProfile.name}</span>
                    <span className="composer-provider-model-sep" aria-hidden="true">·</span>
                  </>
                )}
                <span className="composer-provider-model-label">{activeModelLabel}</span>
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>

              {providerMenuOpen && (
                <div
                  className="composer-provider-model-menu"
                  data-testid="composer-provider-model-menu"
                  role="menu"
                  aria-label="切换服务商与模型"
                >
                  {menuGroups.map((group) => (
                    <div key={group.profileId} className="composer-provider-model-group" role="group" aria-label={group.profileName}>
                      <div className="composer-provider-model-group-title">{group.profileName}</div>
                      {group.models.length > 0 ? (
                        group.models.map((entry) => {
                          const isSelected =
                            group.profileId === activeProfile?.id && entry.id === activeModel;
                          return (
                            <button
                              key={`${group.profileId}-${entry.id}`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              className="composer-provider-model-option"
                              data-testid={`composer-provider-model-option-${group.profileId}-${entry.id}`}
                              disabled={disabled}
                              onClick={() => selectModelForProfile(group.profileId, entry.id)}
                            >
                              <span className="composer-provider-model-option-copy">
                                <strong>{entry.label ?? entry.id}</strong>
                                {entry.label && <small>{entry.id}</small>}
                              </span>
                              {isSelected && (
                                <Check size={14} strokeWidth={2} aria-hidden="true" />
                              )}
                            </button>
                          );
                        })
                      ) : (
                        <div className="composer-provider-model-empty">未配置常用模型</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            className="composer-reasoning-control"
            data-testid="composer-reasoning-control"
          >
            <button
              type="button"
              className="composer-thinking-toggle"
              data-testid="composer-thinking-toggle"
              aria-pressed={isThinkingEnabled}
              aria-label={isThinkingEnabled ? '关闭深度思考' : '开启深度思考'}
              disabled={disabled}
              onClick={() =>
                onReasoningEffortChange(
                  resolveComposerThinkingToggleEffort(activeEffort, thinkingProtocol),
                )
              }
            >
              <span>思考</span>
              {!isThinkingEnabled && (
                <span className="composer-thinking-toggle-state">关闭</span>
              )}
            </button>

            {isThinkingEnabled && (
              <>
                <input
                  type="range"
                  min={0}
                  max={thinkingStops.length - 1}
                  step={1}
                  value={sliderIndex >= 0 ? sliderIndex : 1}
                  disabled={disabled}
                  aria-label="思考强度"
                  aria-valuetext={REASONING_LABELS[activeEffort]}
                  data-testid="composer-reasoning-slider"
                  className="composer-reasoning-slider"
                  onChange={(event) => {
                    const index = Number(event.currentTarget.value);
                    const next = thinkingStops[index] ?? thinkingStops[1] ?? 'high';
                    onReasoningEffortChange(next);
                  }}
                />
                <div
                  className="composer-reasoning-stops"
                  role="group"
                  aria-label="思考强度档位"
                >
                  {thinkingStops.map((effort) => (
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
              </>
            )}
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

      {isOfficialDeepSeekActive && activeModel === 'deepseek-v4-pro' && (
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
          prefixProtocol={resolvedCapabilities.prefixProtocol}
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
