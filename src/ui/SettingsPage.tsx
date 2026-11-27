import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  Edit3,
  ExternalLink,
  FileUp,
  LifeBuoy,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  DEEPSEEK_DEV_PROXY_BALANCE_NOTICE,
  DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION,
  DEEPSEEK_OFFICIAL_TOP_UP_URL,
  PROVIDER_PRESETS,
  PUBLIC_RESEARCH_PRESETS,
  computeWorkspaceUsageSummary,
  createDefaultPromptPackLibrary,
  createProviderProfileFromPreset,
  isOfficialDeepSeekUrl,
  maskApiKey,
  normalizeOfficialDeepSeekModel,
  normalizeReasoningEffort,
  type ModelConfig,
  type OfficialDeepSeekModel,
  type PromptPackLibrary,
  type ProviderLibrary,
  type ProviderModelEntry,
  type ProviderProfile,
  type ProviderThinkingProtocol,
  type PublicResearchConfig,
  type ReasoningEffort,
  type WorkspaceUsageSummary,
} from '../harness/index.ts';
import {
  DISPLAY_FONT_SIZES,
  type DisplayFontSize,
  type DisplayThemePreference,
} from './displayPreferences.ts';
import { InsetGroup } from './primitives/InsetGroup.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { WorkspaceUsageSummaryCard } from './WorkspaceUsageSummaryCard.tsx';
import type { AppUpdaterController } from './useAppUpdater.ts';
import type { SettingsBalanceState } from './useDeepSeekBalance.ts';

export interface SettingsPageProps {
  appVersion: string;
  hasCredentials: boolean;
  config: ModelConfig;
  useDevEnvKey: boolean;
  showDevTestProxy: boolean;
  balanceState?: SettingsBalanceState;
  onRefreshBalance?: () => void;
  themePreference: DisplayThemePreference;
  fontSize: DisplayFontSize;
  canExportCurrentStory: boolean;
  currentStoryTitle: string;
  onBack: () => void;
  onOpenSetupWizard: () => void;
  onClearSavedKey: () => void;
  onApplyDevTestConfig: () => void;
  onOpenDiagnostics: () => void;
  onOpenPublicMemory: () => void;
  onOpenNarrativePresets?: () => void;
  onExportCurrentStory: () => void;
  onExportFullBackup?: () => void;
  canExportFullBackup?: boolean;
  backupSummaryText?: string;
  onImportBackupFile: (file: File) => void;
  onThemePreferenceChange: (preference: DisplayThemePreference) => void;
  onFontSizeChange: (fontSize: DisplayFontSize) => void;
  onDefaultModelChange?: (model: string) => void;
  onDefaultReasoningEffortChange?: (effort: ReasoningEffort) => void;
  providerLibrary?: ProviderLibrary;
  onSelectProviderProfile?: (profileId: string) => void;
  onOpenAddProviderWizard?: () => void;
  onOpenEditProviderWizard?: (profileId: string) => void;
  onDeleteProviderProfile?: (profileId: string) => void;
  onAddCustomModel?: (modelId: string) => void;
  onRemoveCustomModel?: (modelId: string) => void;
  promptPackLibrary?: PromptPackLibrary;
  workspaceUsageSummary?: WorkspaceUsageSummary;
  appUpdater?: AppUpdaterController;
  onReplayTutorial?: () => void;
}

const MODEL_OPTIONS: Array<{
  value: OfficialDeepSeekModel;
  label: string;
  subtitle: string;
}> = [
  { value: 'deepseek-flash', label: '日常轻量', subtitle: 'deepseek-flash' },
  { value: 'deepseek-v4-pro', label: '旗舰深度', subtitle: 'deepseek-v4-pro' },
];

const DEEPSEEK_THINKING_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '极限' },
];

const OPENAI_THINKING_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '极限',
};

const THEME_OPTIONS: Array<{
  value: DisplayThemePreference;
  label: string;
}> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深邃炭黑' },
  { value: 'warm', label: '暖纸护眼' },
];

const FONT_SIZE_OPTIONS: readonly DisplayFontSize[] = DISPLAY_FONT_SIZES;

export function resolveNextThinkingToggleEffort(
  currentEffort: ReasoningEffort,
  thinkingProtocol: ProviderThinkingProtocol,
): ReasoningEffort {
  if (currentEffort !== 'none') return 'none';
  return thinkingProtocol === 'deepseek' ? 'high' : 'medium';
}

function normalizeActiveStop(
  effort: ReasoningEffort,
  thinkingProtocol: ProviderThinkingProtocol,
): ReasoningEffort {
  if (effort === 'none') return 'none';
  if (thinkingProtocol === 'deepseek') {
    return effort === 'medium' ? 'high' : effort;
  }
  return effort === 'max' ? 'high' : effort;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsPage({
  appVersion,
  hasCredentials,
  config,
  useDevEnvKey,
  showDevTestProxy,
  balanceState = { status: 'idle' },
  onRefreshBalance,
  themePreference,
  fontSize,
  canExportCurrentStory,
  currentStoryTitle,
  onBack,
  onOpenSetupWizard,
  onClearSavedKey,
  onApplyDevTestConfig,
  onOpenDiagnostics,
  onOpenPublicMemory,
  onOpenNarrativePresets,
  onExportCurrentStory,
  onExportFullBackup,
  canExportFullBackup,
  backupSummaryText,
  onImportBackupFile,
  onThemePreferenceChange,
  onFontSizeChange,
  onDefaultModelChange,
  onDefaultReasoningEffortChange,
  providerLibrary,
  onSelectProviderProfile,
  onOpenAddProviderWizard,
  onOpenEditProviderWizard,
  onDeleteProviderProfile,
  onAddCustomModel,
  onRemoveCustomModel,
  promptPackLibrary = createDefaultPromptPackLibrary(),
  workspaceUsageSummary,
  appUpdater,
  onReplayTutorial,
}: SettingsPageProps) {
  const resolvedUsageSummary = workspaceUsageSummary ?? computeWorkspaceUsageSummary({});
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [storageStatus, setStorageStatus] = useState('正在读取本地占用…');
  const [customModelDraft, setCustomModelDraft] = useState('');

  const inferredDeepSeekFromConfig =
    useDevEnvKey ||
    config.providerPresetId === 'deepseek' ||
    (!config.providerPresetId && (!config.baseUrl || isOfficialDeepSeekUrl(config.baseUrl)));

  const fallbackProfile: ProviderProfile = inferredDeepSeekFromConfig
    ? createProviderProfileFromPreset('deepseek', {
        id: config.providerId || 'deepseek-official',
        apiKey: config.apiKey,
        defaultModel: normalizeOfficialDeepSeekModel(config.model),
        memoryOnly: config.memoryOnly,
        ...(config.capabilities ? { capabilities: config.capabilities } : {}),
      })
    : createProviderProfileFromPreset(config.providerPresetId ?? 'custom', {
        id: config.providerId || 'custom-active',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        models: config.model ? [{ id: config.model }] : [],
        defaultModel: config.model,
        memoryOnly: config.memoryOnly,
        ...(config.capabilities ? { capabilities: config.capabilities } : {}),
      });

  const profiles =
    providerLibrary && providerLibrary.profiles.length > 0
      ? providerLibrary.profiles
      : [fallbackProfile];
  const activeProfile =
    (providerLibrary
      ? profiles.find((profile) => profile.id === providerLibrary.activeProviderId)
      : undefined) ??
    profiles[0] ??
    fallbackProfile;

  const isThirdPartyPreset = providerLibrary
    ? activeProfile.presetId !== 'deepseek'
    : Boolean(config.providerPresetId && config.providerPresetId !== 'deepseek') ||
      (!useDevEnvKey && Boolean(config.baseUrl) && !isOfficialDeepSeekUrl(config.baseUrl));

  const activeBaseUrl = activeProfile.baseUrl || config.baseUrl;
  const activeApiKey = activeProfile.apiKey || config.apiKey;
  const isOfficialDeepSeekActive =
    !isThirdPartyPreset &&
    (useDevEnvKey || activeProfile.presetId === 'deepseek' || isOfficialDeepSeekUrl(activeBaseUrl));
  const supportsBalanceQuery =
    !isThirdPartyPreset &&
    Boolean(
      config.capabilities?.supportsBalanceQuery ??
        activeProfile.capabilities.supportsBalanceQuery ??
        (useDevEnvKey || isOfficialDeepSeekUrl(activeBaseUrl)),
    );
  const thinkingProtocol: ProviderThinkingProtocol =
    config.capabilities?.thinkingProtocol ??
    activeProfile.capabilities.thinkingProtocol ??
    (isOfficialDeepSeekActive ? 'deepseek' : 'openai_reasoning_effort');

  const activeModel = isOfficialDeepSeekActive
    ? normalizeOfficialDeepSeekModel(config.model || activeProfile.defaultModel)
    : (config.model || activeProfile.defaultModel || activeProfile.models[0]?.id || '').trim();

  const rawEffort = normalizeReasoningEffort(
    config.reasoningEffort ?? providerLibrary?.reasoningEffort,
  );
  const activeReasoningEffort = normalizeActiveStop(rawEffort, thinkingProtocol);
  const isThinkingEnabled = activeReasoningEffort !== 'none';
  const thinkingOptions =
    thinkingProtocol === 'deepseek' ? DEEPSEEK_THINKING_OPTIONS : OPENAI_THINKING_OPTIONS;
  const thinkingSliderIndex = Math.max(
    0,
    thinkingOptions.findIndex((option) => option.value === activeReasoningEffort),
  );

  const thirdPartyModels: ProviderModelEntry[] = (() => {
    const entries = [...activeProfile.models];
    if (activeModel && !entries.some((entry) => entry.id === activeModel)) {
      entries.unshift({ id: activeModel });
    }
    return entries;
  })();

  const activeResearchProvider =
    config.publicResearch?.provider ?? providerLibrary?.publicResearch?.provider ?? 'auto';
  const activeResearchPreset =
    PUBLIC_RESEARCH_PRESETS[activeResearchProvider] ?? PUBLIC_RESEARCH_PRESETS.auto;

  const activePreset = promptPackLibrary.activePackId
    ? promptPackLibrary.packs.find((pack) => pack.id === promptPackLibrary.activePackId) ??
      promptPackLibrary.packs[0]
    : null;
  const activePresetSummary = activePreset ? activePreset.title : '已停用';

  const handleBackupExport = onExportFullBackup ?? onExportCurrentStory;
  const exportEnabled = canExportFullBackup ?? (Boolean(onExportFullBackup) || canExportCurrentStory);
  const isBalanceLoading = balanceState.status === 'loading';
  const isBalanceError = balanceState.status === 'error';
  const displayedBalance =
    balanceState.status === 'loaded'
      ? balanceState
      : balanceState.status === 'loading'
        ? balanceState.previous
        : undefined;

  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      setStorageStatus('当前浏览器未提供本地占用估算，数据仍只保存在本机。');
      return;
    }
    void navigator.storage
      .estimate()
      .then((estimate) => {
        if (cancelled) return;
        const usage = formatBytes(estimate.usage ?? 0);
        const quota = estimate.quota === undefined ? null : formatBytes(estimate.quota);
        setStorageStatus(
          quota
            ? `已用约 ${usage}，可用上限约 ${quota}；由浏览器估算。`
            : `已用约 ${usage}；由浏览器估算。`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setStorageStatus('暂时无法读取本地占用；数据仍只保存在本机。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenEditActive = () => {
    if (onOpenEditProviderWizard) {
      onOpenEditProviderWizard(activeProfile.id);
      return;
    }
    onOpenSetupWizard();
  };

  const handleAddInlineModel = () => {
    const trimmed = customModelDraft.trim();
    if (!trimmed) return;
    onAddCustomModel?.(trimmed);
    onDefaultModelChange?.(trimmed);
    setCustomModelDraft('');
  };

  return (
    <OverlayPageShell title="设置" testId="settings-page" onBack={onBack}>
      <InsetGroup
        title={isOfficialDeepSeekActive ? '连接 DeepSeek' : '模型服务与连接'}
        description="API Key 只保存在你的设备上，由本地直接请求所选模型服务。"
        testId="settings-connection-group"
      >
        <section
          className="connected-key-card"
          data-testid="deepseek-connection-card"
          aria-label={isOfficialDeepSeekActive ? 'DeepSeek 连接状态' : '当前模型服务连接状态'}
        >
          <div className="connected-key-header">
            <strong>
              {isOfficialDeepSeekActive
                ? hasCredentials
                  ? '已连接 DeepSeek'
                  : '未连接 DeepSeek'
                : activeProfile.name}
            </strong>
            <span
              className={`badge ${hasCredentials ? 'badge-ok' : 'badge-pending'}`}
              data-testid={
                hasCredentials && !useDevEnvKey && activeApiKey ? 'connected-key-mask' : undefined
              }
            >
              {hasCredentials
                ? useDevEnvKey
                  ? '开发代理'
                  : maskApiKey(activeApiKey) || (isOfficialDeepSeekActive ? '本地已连接' : '免密已配置')
                : '未连接'}
            </span>
          </div>

          {isOfficialDeepSeekActive ? (
            <p className="wizard-privacy-note">
              请求会由你的设备直接发送至 DeepSeek 官方 API；API Key 仅保存在本机，不会上传至第三方。
            </p>
          ) : (
            <div className="provider-active-summary">
              <p className="wizard-privacy-note" data-testid="active-provider-base-url">
                服务商地址：<code>{activeBaseUrl || '未填写'}</code>
              </p>
              <p className="wizard-privacy-note" data-testid="active-provider-research-status">
                联网检索源：
                {activeResearchProvider === 'auto'
                  ? '默认自动（安卓免费查证，网页端需配置搜索）'
                  : activeResearchPreset.title}
                {activeProfile && onOpenEditProviderWizard && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => onOpenEditProviderWizard(activeProfile.id)}
                    >
                      配置
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {hasCredentials &&
            supportsBalanceQuery &&
            (useDevEnvKey ? (
              <p className="settings-balance-proxy-note" data-testid="deepseek-balance-dev-proxy-note">
                {DEEPSEEK_DEV_PROXY_BALANCE_NOTICE}
              </p>
            ) : (
              <div className="settings-balance-panel" data-testid="deepseek-balance-panel">
                <div className="settings-balance-row">
                  <div className="settings-balance-summary">
                    <span className="settings-balance-label">账户总余额</span>
                    {displayedBalance ? (
                      <div className="settings-balance-value-row">
                        <strong className="settings-balance-amount" data-testid="deepseek-balance-value">
                          {displayedBalance.formattedBalance}
                        </strong>
                        {!displayedBalance.isAvailable && (
                          <span className="badge badge-danger" data-testid="deepseek-balance-insufficient-badge">
                            余额不足
                          </span>
                        )}
                      </div>
                    ) : isBalanceLoading ? (
                      <span className="settings-balance-loading" data-testid="deepseek-balance-loading">
                        正在查询余额…
                      </span>
                    ) : isBalanceError ? (
                      <span className="settings-balance-idle" data-testid="deepseek-balance-unavailable">
                        暂未能获取余额
                      </span>
                    ) : (
                      <span className="settings-balance-idle" data-testid="deepseek-balance-idle">
                        点击刷新查看余额
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm settings-balance-refresh-btn"
                    data-testid="refresh-balance-btn"
                    disabled={isBalanceLoading}
                    onClick={() => onRefreshBalance?.()}
                  >
                    <RefreshCw
                      size={16}
                      strokeWidth={1.75}
                      className={isBalanceLoading ? 'settings-balance-spin' : undefined}
                      aria-hidden="true"
                    />
                    <span>{isBalanceLoading ? '刷新中…' : isBalanceError ? '重试' : '刷新'}</span>
                  </button>
                </div>
                {balanceState.status === 'error' && (
                  <p className="settings-balance-error" role="status" data-testid="deepseek-balance-error">
                    {balanceState.message}
                  </p>
                )}
              </div>
            ))}

          {hasCredentials && supportsBalanceQuery && (
            <div className="settings-topup-block" data-testid="deepseek-topup-block">
              <a
                className="btn settings-topup-link"
                href={DEEPSEEK_OFFICIAL_TOP_UP_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="deepseek-topup-link"
              >
                <span>前往 DeepSeek 充值</span>
                <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
              </a>
              <p className="settings-topup-note" data-testid="deepseek-topup-note">
                {DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION}
              </p>
            </div>
          )}

          {hasCredentials ? (
            <div className="settings-button-row">
              <button
                type="button"
                className="btn"
                data-testid="change-key-btn"
                onClick={handleOpenEditActive}
              >
                {isOfficialDeepSeekActive ? '更换 API Key' : '编辑服务商配置'}
              </button>
              <button type="button" className="btn" data-testid="clear-key-btn" onClick={onClearSavedKey}>
                断开连接
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="open-setup-wizard-btn"
              onClick={onOpenSetupWizard}
            >
              {isOfficialDeepSeekActive ? '连接 DeepSeek' : '连接模型服务'}
            </button>
          )}

          {import.meta.env.DEV && showDevTestProxy && (
            <button type="button" className="btn" data-testid="dev-proxy-toggle" onClick={onApplyDevTestConfig}>
              使用本地 .env.local 测试代理
            </button>
          )}
        </section>

        <section
          className="provider-profile-section"
          data-testid="provider-profile-list"
          aria-label="服务商档案列表"
        >
          <div className="settings-control-header">
            <h3>服务商档案列表</h3>
            <button
              type="button"
              className="btn btn-sm provider-add-btn"
              data-testid="add-provider-profile-btn"
              onClick={() => (onOpenAddProviderWizard ? onOpenAddProviderWizard() : onOpenSetupWizard())}
            >
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>添加服务商</span>
            </button>
          </div>

          <ul className="provider-profile-items">
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfile.id;
              const presetLabel =
                PROVIDER_PRESETS[profile.presetId]?.name ?? PROVIDER_PRESETS.custom.name;
              const keyLabel = profile.apiKey
                ? maskApiKey(profile.apiKey)
                : profile.presetId === 'local'
                  ? '本地免密'
                  : '未填 Key';
              return (
                <li
                  key={profile.id}
                  className={`provider-profile-item ${isActive ? 'is-active' : ''}`}
                  data-testid={`provider-profile-item-${profile.id}`}
                >
                  <div className="provider-profile-meta">
                    <div className="provider-profile-title-row">
                      <strong>{profile.name}</strong>
                      <span className="badge">{presetLabel}</span>
                      {isActive && (
                        <span className="badge badge-ok" aria-current="true">
                          <Check size={16} strokeWidth={1.75} aria-hidden="true" /> 当前使用
                        </span>
                      )}
                    </div>
                    <span className="provider-profile-sub">
                      {profile.defaultModel || '未指定默认模型'} · {keyLabel}
                    </span>
                  </div>
                  <div className="provider-profile-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`provider-profile-switch-${profile.id}`}
                      aria-pressed={isActive}
                      disabled={isActive}
                      onClick={() => onSelectProviderProfile?.(profile.id)}
                    >
                      {isActive ? '使用中' : '切换'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`provider-profile-edit-${profile.id}`}
                      aria-label={`编辑 ${profile.name}`}
                      onClick={() =>
                        onOpenEditProviderWizard
                          ? onOpenEditProviderWizard(profile.id)
                          : onOpenSetupWizard()
                      }
                    >
                      <Edit3 size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span>编辑</span>
                    </button>
                    {profiles.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`provider-profile-delete-${profile.id}`}
                        aria-label={`删除 ${profile.name}`}
                        onClick={() => onDeleteProviderProfile?.(profile.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="settings-control-block" data-testid="settings-default-model-block">
          <h3>全局默认模型</h3>
          <p className="settings-control-hint">未单独调整的故事、作品与角色将默认使用这里的设置。</p>
          {isOfficialDeepSeekActive ? (
            <>
              <div className="settings-model-grid" role="group" aria-label="全局默认模型">
                {MODEL_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="settings-model-option"
                    data-testid={`settings-model-option-${option.value}`}
                    aria-pressed={activeModel === option.value}
                    onClick={() => onDefaultModelChange?.(option.value)}
                  >
                    <strong>{option.label}</strong>
                    <span className="settings-model-id">{option.subtitle}</span>
                  </button>
                ))}
              </div>
              {activeModel === 'deepseek-v4-pro' && (
                <p className="settings-pro-cost-hint" data-testid="settings-pro-cost-hint">
                  旗舰深度响应耗时更长，额度消耗约为日常轻量的 3–4 倍。
                </p>
              )}
            </>
          ) : (
            <div className="settings-custom-models-wrap">
              <div className="settings-custom-model-list" role="group" aria-label="常用模型列表">
                {thirdPartyModels.map((entry) => (
                  <div key={entry.id} className="settings-custom-model-chip">
                    <button
                      type="button"
                      className="settings-model-option"
                      data-testid={`settings-model-option-${entry.id}`}
                      aria-pressed={activeModel === entry.id}
                      onClick={() => onDefaultModelChange?.(entry.id)}
                    >
                      <strong>{entry.label ?? entry.id}</strong>
                      {entry.label && <span className="settings-model-id">{entry.id}</span>}
                    </button>
                    {thirdPartyModels.length > 1 && onRemoveCustomModel && (
                      <button
                        type="button"
                        className="icon-button settings-remove-model-btn"
                        data-testid={`settings-remove-model-${entry.id}`}
                        aria-label={`移除模型 ${entry.id}`}
                        onClick={() => onRemoveCustomModel(entry.id)}
                      >
                        <X size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="settings-add-model-row">
                <input
                  type="text"
                  data-testid="settings-custom-model-input"
                  aria-label="添加或切换模型 ID"
                  placeholder="输入任意模型 ID，如 gpt-4o"
                  value={customModelDraft}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setCustomModelDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="settings-add-model-btn"
                  disabled={!customModelDraft.trim()}
                  onClick={handleAddInlineModel}
                >
                  添加并选用
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="settings-control-block" data-testid="settings-default-reasoning-block">
          <div className="settings-control-header">
            <h3>默认思考强度</h3>
            <div className="settings-thinking-toggle-wrap">
              <span className="settings-reasoning-value" data-testid="settings-reasoning-current-label">
                {REASONING_LABELS[activeReasoningEffort]}
              </span>
              <label className="settings-thinking-switch-label">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="开启默认深度思考"
                  data-testid="settings-thinking-toggle"
                  checked={isThinkingEnabled}
                  onChange={() =>
                    onDefaultReasoningEffortChange?.(
                      resolveNextThinkingToggleEffort(activeReasoningEffort, thinkingProtocol),
                    )
                  }
                />
                <span>{isThinkingEnabled ? '已开启' : '关闭'}</span>
              </label>
            </div>
          </div>

          {thinkingProtocol === 'openai_reasoning_effort' && (
            <p className="settings-control-hint" data-testid="settings-thinking-compatibility-hint">
              仅支持深度思考的模型可开启，若发送报错请关闭
            </p>
          )}

          {isThinkingEnabled && (
            <div className="settings-reasoning-slider-wrap">
              <input
                type="range"
                min={0}
                max={thinkingOptions.length - 1}
                step={1}
                value={thinkingSliderIndex}
                aria-label="默认思考强度"
                aria-valuetext={REASONING_LABELS[activeReasoningEffort]}
                data-testid="settings-reasoning-slider"
                className="settings-reasoning-slider"
                onChange={(event) => {
                  const index = Number(event.currentTarget.value);
                  const next = thinkingOptions[index]?.value ?? thinkingOptions[1]?.value ?? 'high';
                  onDefaultReasoningEffortChange?.(next);
                }}
              />
              <div
                className="settings-reasoning-stops settings-reasoning-stops-3"
                role="group"
                aria-label="默认思考强度档位"
              >
                {thinkingOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    data-testid={`settings-reasoning-option-${option.value}`}
                    aria-pressed={activeReasoningEffort === option.value}
                    onClick={() => onDefaultReasoningEffortChange?.(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="settings-privacy">
          <ShieldCheck size={16} strokeWidth={1.75} /> 不含项目方代理或云端存储。
        </p>
      </InsetGroup>

      <InsetGroup
        title="省 Token 与用量总览"
        description="统计本地全部文游、写故事与角色互动的历史实测用量（含分支与重试轮次）。"
        testId="settings-usage-overview"
      >
        <WorkspaceUsageSummaryCard summary={resolvedUsageSummary} />
      </InsetGroup>

      <InsetGroup
        title="阅读与外观"
        description="主题与字号会立即应用到当前设备，重启后仍会保留。"
        testId="settings-appearance-group"
      >
        <section className="appearance-preview" data-testid="settings-appearance-preview" aria-label="阅读效果预览">
          <p className="appearance-preview-kicker">实时预览</p>
          <p className="settings-reading-preview-user" data-testid="appearance-player-preview">
            我推开窗，决定沿着微亮的走廊继续前行。
          </p>
          <p className="appearance-narrative-preview" data-testid="appearance-narrative-preview">
            夜风穿过半开的窗，远处的钟声缓慢落下。你听见门外传来脚步声，故事仍在等待你的选择。
          </p>
        </section>

        <div className="settings-control-block">
          <h3>主题</h3>
          <div className="theme-option-grid" role="group" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="theme-option"
                data-testid={`theme-option-${option.value}`}
                aria-pressed={themePreference === option.value}
                onClick={() => onThemePreferenceChange(option.value)}
              >
                <span
                  className="settings-theme-swatches"
                  data-theme={option.value === 'system' ? 'light' : option.value}
                  aria-hidden="true"
                >
                  <span className="settings-theme-preview-bubble" />
                  <span className="settings-theme-preview-lines">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-control-block">
          <h3>正文字号</h3>
          <div className="font-size-segmented" role="group" aria-label="正文字号">
            {FONT_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                type="button"
                data-testid={`font-size-option-${size}`}
                aria-pressed={fontSize === size}
                onClick={() => onFontSizeChange(size)}
              >
                {size}px
              </button>
            ))}
          </div>
        </div>
      </InsetGroup>

      <InsetGroup title="我的记忆" description="管理跨故事、作品与角色共用的个人偏好与长期记忆。">
        <button type="button" className="btn" data-testid="open-my-memory" onClick={onOpenPublicMemory}>
          管理我的记忆
        </button>
      </InsetGroup>

      <InsetGroup
        title="叙事预设"
        description="管理本地叙事风格预设、导入外部模板与叙事连贯保护。"
        testId="settings-narrative-presets-group"
      >
        <button
          type="button"
          className="settings-nav-row"
          data-testid="open-narrative-presets"
          onClick={onOpenNarrativePresets}
        >
          <span className="settings-nav-row-copy">
            <strong>叙事预设</strong>
            <span className="settings-nav-row-value" data-testid="settings-narrative-presets-summary">
              {activePresetSummary}
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </InsetGroup>

      <InsetGroup
        title="全量数据备份与恢复"
        description="导出全部文游、写故事、角色互动、我的记忆、叙事预设与显示偏好；支持从 .folio.json 或旧版 .lfh.json 恢复。"
        testId="settings-backup-group"
      >
        <div className="settings-data-row">
          <div>
            <strong>工作区数据</strong>
            <p>
              {backupSummaryText ||
                (canExportCurrentStory ? `当前包含「${currentStoryTitle}」等本地内容（不含密钥）` : '包含全部本地创作内容与偏好（不含密钥）')}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            data-testid="export-current-story"
            disabled={!exportEnabled}
            onClick={handleBackupExport}
          >
            <Download size={18} strokeWidth={1.75} /> 导出全量备份 (.folio.json)
          </button>
        </div>
        <input
          ref={backupInputRef}
          type="file"
          accept=".folio.json,.lfh.json,.json,application/json"
          aria-label="从备份恢复"
          data-testid="backup-import-input"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImportBackupFile(file);
          }}
        />
        <button type="button" className="btn" data-testid="restore-backup-btn" onClick={() => backupInputRef.current?.click()}>
          <FileUp size={18} strokeWidth={1.75} /> 从备份恢复
        </button>
      </InsetGroup>

      <InsetGroup
        title="引导教程"
        description="随时重置主界面与设置页的新手引导进度并重新查看。"
        testId="settings-tutorial-group"
      >
        <button
          type="button"
          className="btn"
          data-testid="replay-tutorial-btn"
          onClick={onReplayTutorial}
        >
          <RotateCcw size={18} strokeWidth={1.75} aria-hidden="true" /> 重新查看引导教程
        </button>
      </InsetGroup>

      {appUpdater?.enabled && (
        <InsetGroup
          title="应用更新"
          description="从官方 Gitee 仓库检查 Folio Android 正式版更新，并在应用内完成校验安装。"
          testId="settings-update-group"
        >
          <div className="settings-update-card" data-testid="settings-update-card">
            <div className="settings-update-row">
              <div className="settings-update-summary">
                <strong>当前版本 Folio v{appVersion}</strong>
                <span data-testid="settings-update-status">
                  {appUpdater.checkStatus === 'checking'
                    ? '正在检查更新…'
                    : appUpdater.availableRelease
                      ? `发现新版本 v${appUpdater.availableRelease.version}`
                      : appUpdater.checkStatus === 'up_to_date'
                        ? '当前已是最新版本'
                        : appUpdater.checkStatus === 'error'
                          ? '检查更新失败'
                          : '点击右侧按钮检查是否有可用更新'}
                </span>
              </div>
              {appUpdater.availableRelease && (
                <span className="settings-update-badge" data-testid="settings-update-available-badge">
                  v{appUpdater.availableRelease.version} 可用
                </span>
              )}
            </div>

            {appUpdater.checkStatus === 'error' && appUpdater.checkError && (
              <p className="settings-update-error" role="status" data-testid="settings-update-error">
                {appUpdater.checkError}
              </p>
            )}

            <div className="settings-update-actions">
              <button
                type="button"
                className="btn"
                data-testid="check-app-update-btn"
                disabled={appUpdater.checkStatus === 'checking'}
                onClick={() => void appUpdater.checkForUpdatesManual()}
              >
                <RefreshCw
                  size={16}
                  strokeWidth={1.75}
                  className={appUpdater.checkStatus === 'checking' ? 'settings-balance-spin' : undefined}
                  aria-hidden="true"
                />
                <span>{appUpdater.checkStatus === 'checking' ? '检查中…' : '检查更新'}</span>
              </button>

              {appUpdater.availableRelease && (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="open-available-update-btn"
                  onClick={appUpdater.openUpdateModal}
                >
                  <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>查看 v{appUpdater.availableRelease.version} 更新</span>
                </button>
              )}

              {appUpdater.checkStatus === 'error' && (
                <button
                  type="button"
                  className="btn"
                  data-testid="settings-update-browser-btn"
                  onClick={() => void appUpdater.openReleaseInBrowser()}
                >
                  <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>打开发布页</span>
                </button>
              )}
            </div>

            <label className="settings-update-toggle">
              <div className="settings-update-toggle-text">
                <strong>启动时自动检查更新</strong>
                <span>每 24 小时最多检查一次 Gitee 正式版，不收集设备信息。</span>
              </div>
              <input
                type="checkbox"
                data-testid="auto-check-update-toggle"
                checked={appUpdater.autoCheckEnabled}
                onChange={(event) => appUpdater.setAutoCheckEnabled(event.target.checked)}
              />
            </label>
          </div>
        </InsetGroup>
      )}

      <InsetGroup
        title="问题反馈与日志"
        description="遇到异常时可导出脱敏排障日志，严禁包含剧本正文、设定或密钥。"
        testId="settings-diagnostics-group"
      >
        <button type="button" className="btn" data-testid="open-diagnostics" onClick={onOpenDiagnostics}>
          <LifeBuoy size={18} strokeWidth={1.75} /> 导出排障日志
        </button>
        <details className="settings-advanced-details" data-testid="settings-advanced-diagnostics">
          <summary>高级排障</summary>
          <div className="settings-advanced-body">
            <p className="settings-storage-status" data-testid="local-storage-status">{storageStatus}</p>
            <p className="settings-version" data-testid="settings-app-version">
              应用版本 <span>Folio v{appVersion}</span>
            </p>
          </div>
        </details>
      </InsetGroup>
    </OverlayPageShell>
  );
}
