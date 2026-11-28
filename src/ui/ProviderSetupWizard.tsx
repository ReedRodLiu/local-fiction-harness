import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, RefreshCw, Search, X } from 'lucide-react';
import { isDevProxyBaseUrl } from '../platform/devProxy.ts';
import {
  ANTHROPIC_CONSOLE_KEYS_URL,
  DEEPSEEK_OFFICIAL_KEYS_URL,
  PROVIDER_PRESETS,
  PUBLIC_RESEARCH_PRESETS,
  createDefaultId,
  createProviderProfileFromPreset,
  normalizeProviderApiProtocol,
  normalizeProviderBaseUrl,
  probeAssistantPrefillCompatibility,
  sanitizeApiKeyInput,
  validateApiKeyFormat,
  validateProviderApiKeyFormat,
  verifyDeepSeekApiKey,
  verifyProviderConnection,
  type CustomModelPricing,
  type ProviderApiProtocol,
  type ProviderConnectionVerifyResult,
  type ProviderModelEntry,
  type ProviderPrefixProtocol,
  type ProviderPresetId,
  type ProviderProfile,
  type ProviderThinkingDialect,
  type PublicResearchConfig,
  type PublicResearchSearchPresetId,
} from '../harness/index.ts';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { ModalDialog } from './primitives/ModalDialog.tsx';

export interface ProviderSetupSaveResult {
  profile: ProviderProfile;
  publicResearch?: PublicResearchConfig;
}

export interface ProviderSetupWizardProps {
  open: boolean;
  initialKey?: string;
  initialProfile?: ProviderProfile;
  initialPublicResearch?: PublicResearchConfig;
  mode?: 'onboarding' | 'add' | 'edit';
  hasDeepSeekProfileInLibrary?: boolean;
  isWebPlatform?: boolean;
  pendingLabel?: string | null;
  verifyUrlBase?: string;
  onComplete?: (apiKey: string) => void;
  onSaveProfile?: (result: ProviderSetupSaveResult) => void;
  onCancel: () => void;
  onExitComplete: () => void;
  onVerifyingChange?: (isVerifying: boolean) => void;
}

export interface ProviderWizardDraft {
  profileId?: string;
  presetId: ProviderPresetId;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelEntry[];
  defaultModel: string;
  backgroundModel: string;
  pricingCurrency: 'CNY' | 'USD';
  inputPriceText: string;
  cacheHitPriceText: string;
  outputPriceText: string;
  apiProtocol: ProviderApiProtocol;
  thinkingDialect?: ProviderThinkingDialect;
  prefixProtocol: ProviderPrefixProtocol;
  prefillProbeStatus: 'untested' | 'supported' | 'unsupported';
  searchProvider: PublicResearchSearchPresetId;
  searchApiKey: string;
  searchDeepSeekProfileId?: string;
}

export interface ProviderPresetCategoryGroup {
  id: 'recommended' | 'domestic' | 'overseas' | 'aggregated_local_custom';
  label: string;
  presetIds: readonly ProviderPresetId[];
}

export const PROVIDER_PRESET_CATEGORIES: readonly ProviderPresetCategoryGroup[] = [
  {
    id: 'recommended',
    label: '推荐与内置',
    presetIds: ['deepseek'],
  },
  {
    id: 'domestic',
    label: '国内大模型',
    presetIds: [
      'moonshot',
      'moonshot_coding',
      'zhipu',
      'zhipu_coding',
      'dashscope',
      'dashscope_coding',
      'volcengine',
      'volcengine_coding',
      'minimax',
      'minimax_token_plan',
      'qianfan',
      'qianfan_token_plan',
      'hunyuan',
      'hunyuan_coding',
      'spark',
      'sensenova',
      'sensenova_token_plan',
      'stepfun',
      'stepfun_plan',
      'lingyi',
    ],
  },
  {
    id: 'overseas',
    label: '海外大模型',
    presetIds: ['openai', 'anthropic', 'gemini', 'xai', 'groq'],
  },
  {
    id: 'aggregated_local_custom',
    label: '聚合・本地・自定义',
    presetIds: ['openrouter', 'siliconflow', 'local', 'custom'],
  },
];

const PRESET_SEARCH_KEYWORDS: Readonly<Record<ProviderPresetId, readonly string[]>> = {
  deepseek: ['deepseek', '深度求索', 'ds', '官方推荐'],
  moonshot: ['moonshot', 'kimi', '月之暗面', '按量'],
  moonshot_coding: ['moonshot', 'kimi', 'kimicode', 'kimi code', '月之暗面', 'coding', 'token'],
  zhipu: ['zhipu', 'glm', '智谱', 'bigmodel', '按量'],
  zhipu_coding: ['zhipu', 'glm', '智谱', 'bigmodel', 'coding', 'token'],
  dashscope: ['dashscope', 'qwen', '通义千问', '百炼', '阿里云', 'aliyun', '按量'],
  dashscope_coding: ['dashscope', 'qwen', '通义千问', '百炼', '阿里云', 'aliyun', 'coding', 'token'],
  volcengine: ['volcengine', 'ark', 'doubao', '火山方舟', '豆包', 'volces', '按量'],
  volcengine_coding: ['volcengine', 'ark', 'doubao', '火山方舟', '豆包', 'volces', 'coding', 'token'],
  minimax: ['minimax', 'minimaxi', '海螺', '按量'],
  minimax_token_plan: ['minimax', 'minimaxi', '海螺', 'token', 'coding', 'subscription'],
  qianfan: ['qianfan', 'ernie', '文心', '百度', '千帆', 'baidubce', '按量'],
  qianfan_token_plan: ['qianfan', 'ernie', '文心', '百度', '千帆', 'baidubce', 'token', 'coding'],
  hunyuan: ['hunyuan', 'tencent', '腾讯', '混元', '按量'],
  hunyuan_coding: ['hunyuan', 'tencent', 'lkeap', '腾讯', '混元', '腾讯云', 'coding', 'token'],
  spark: ['spark', 'xfyun', 'xf-yun', '讯飞', '星火'],
  sensenova: ['sensenova', 'sensecore', '商汤', '日日新', '按量'],
  sensenova_token_plan: ['sensenova', 'sensecore', '商汤', '日日新', 'token'],
  stepfun: ['stepfun', 'step', '阶跃星辰', '按量'],
  stepfun_plan: ['stepfun', 'step', 'step plan', '阶跃星辰', 'token'],
  lingyi: ['lingyi', 'yi', '零一万物', 'lingyiwanwu'],
  openai: ['openai', 'chatgpt', 'gpt', 'o4', 'responses'],
  anthropic: ['anthropic', 'claude', 'sonnet', 'opus', 'haiku'],
  gemini: ['gemini', 'google', 'aistudio', '谷歌'],
  xai: ['xai', 'grok'],
  groq: ['groq', 'llama'],
  openrouter: ['openrouter', '聚合', '路由'],
  siliconflow: ['siliconflow', '硅基流动'],
  local: ['local', 'ollama', 'lm studio', 'lmstudio', '本地', 'localhost'],
  custom: ['custom', 'relay', '中转', '自定义', '兼容'],
};

interface ProviderSubscriptionNoticeSpec {
  testId: string;
  message: string;
  linkUrl: string;
  linkLabel: string;
  linkTestId?: string;
  hintTestId?: string;
  matches: (draft: Pick<ProviderWizardDraft, 'presetId' | 'apiProtocol'>) => boolean;
}

const PROVIDER_SUBSCRIPTION_NOTICES: readonly ProviderSubscriptionNoticeSpec[] = [
  {
    testId: 'provider-gemini-billing-note',
    message:
      'Google AI Studio 提供免费测试额度；消费级 Gemini AI Pro 会员订阅不包含 API 调用额度，需在开发者平台创建 API Key。',
    linkUrl: 'https://aistudio.google.com/apikey',
    linkLabel: '前往 Google AI Studio 获取 API Key',
    matches: (draft) => draft.presetId === 'gemini' || draft.apiProtocol === 'gemini_native',
  },
  {
    testId: 'anthropic-subscription-notice',
    message:
      'Claude Pro / Max 网页会员订阅不含 API 调用额度，需在 Anthropic Console 创建按量 API Key。',
    linkUrl: ANTHROPIC_CONSOLE_KEYS_URL,
    linkLabel: '前往 Anthropic Console 获取 API Key',
    linkTestId: 'anthropic-console-keys-link',
    matches: (draft) => draft.presetId === 'anthropic',
  },
  {
    testId: 'openai-subscription-notice',
    message:
      PROVIDER_PRESETS.openai.setupHint ??
      'ChatGPT Plus/Pro 消费级订阅不含 API 调用额度，需在 OpenAI Platform 单独创建 API Key 并充值。',
    linkUrl: PROVIDER_PRESETS.openai.consoleUrl ?? 'https://platform.openai.com/api-keys',
    linkLabel: '前往 OpenAI Platform 获取 API Key',
    linkTestId: 'provider-console-link',
    hintTestId: 'provider-setup-hint',
    matches: (draft) => draft.presetId === 'openai',
  },
];

function resolveProviderSubscriptionNotice(
  draft: Pick<ProviderWizardDraft, 'presetId' | 'apiProtocol'>,
): ProviderSubscriptionNoticeSpec | null {
  return PROVIDER_SUBSCRIPTION_NOTICES.find((entry) => entry.matches(draft)) ?? null;
}

/**
 * Returns whether the preset picker panel should start expanded for the given wizard mode.
 */
export function resolveInitialPresetPickerOpen(mode: 'onboarding' | 'add' | 'edit'): boolean {
  return mode === 'add';
}

/**
 * Filters the 4 categorized provider preset groups by Chinese/English name, presetId,
 * baseUrl domain, models, or curated aliases.
 */
export function filterProviderPresetGroups(query: string): ProviderPresetCategoryGroup[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) {
    return PROVIDER_PRESET_CATEGORIES.map((group) => ({ ...group }));
  }

  const matchesPreset = (presetId: ProviderPresetId): boolean => {
    const spec = PROVIDER_PRESETS[presetId];
    if (!spec) return false;
    const searchable = [
      spec.presetId,
      spec.name,
      spec.baseUrl,
      spec.defaultModel,
      ...(spec.backgroundModel ? [spec.backgroundModel] : []),
      ...spec.models.map((m) => `${m.id} ${m.label ?? ''}`),
      ...(PRESET_SEARCH_KEYWORDS[presetId] ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  };

  return PROVIDER_PRESET_CATEGORIES.map((group) => ({
    ...group,
    presetIds: group.presetIds.filter(matchesPreset),
  })).filter((group) => group.presetIds.length > 0);
}

const SEARCH_PRESET_ORDER: readonly PublicResearchSearchPresetId[] = [
  'auto',
  'none',
  'tavily',
  'bocha',
  'deepseek_account',
];

function formatPriceInput(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function parsePriceInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function mergeProviderModels(
  existing: readonly ProviderModelEntry[],
  discoveredIds: readonly string[],
): ProviderModelEntry[] {
  const seen = new Set<string>();
  const merged: ProviderModelEntry[] = [];
  for (const entry of existing) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ ...entry, id });
  }
  for (const rawId of discoveredIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ id });
  }
  return merged;
}

export function createWizardDraftFromPreset(
  presetId: ProviderPresetId,
  options?: {
    apiKey?: string;
    publicResearch?: PublicResearchConfig;
  },
): ProviderWizardDraft {
  const preset = PROVIDER_PRESETS[presetId] ?? PROVIDER_PRESETS.custom;
  return {
    presetId: preset.presetId,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: options?.apiKey ?? '',
    models: preset.models.map((entry) => ({ ...entry })),
    defaultModel: preset.defaultModel,
    backgroundModel: preset.backgroundModel ?? '',
    pricingCurrency: 'CNY',
    inputPriceText: '',
    cacheHitPriceText: '',
    outputPriceText: '',
    apiProtocol: preset.capabilities.apiProtocol ?? 'openai_chat',
    ...(preset.capabilities.thinkingDialect
      ? { thinkingDialect: preset.capabilities.thinkingDialect }
      : {}),
    prefixProtocol: preset.capabilities.prefixProtocol,
    prefillProbeStatus: 'untested',
    searchProvider: options?.publicResearch?.provider ?? 'auto',
    searchApiKey: options?.publicResearch?.apiKey ?? '',
    searchDeepSeekProfileId: options?.publicResearch?.deepseekProfileId,
  };
}

export function createWizardDraftFromProfile(
  profile: ProviderProfile,
  publicResearch?: PublicResearchConfig,
): ProviderWizardDraft {
  const pricing = profile.defaultPricing;
  return {
    profileId: profile.id,
    presetId: profile.presetId,
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    models: profile.models.map((entry) => ({ ...entry })),
    defaultModel: profile.defaultModel,
    backgroundModel: profile.backgroundModel ?? '',
    pricingCurrency: pricing?.currency ?? 'CNY',
    inputPriceText: formatPriceInput(pricing?.inputPerMillion),
    cacheHitPriceText: formatPriceInput(pricing?.cacheHitInputPerMillion),
    outputPriceText: formatPriceInput(pricing?.outputPerMillion),
    apiProtocol: normalizeProviderApiProtocol(profile.capabilities.apiProtocol, 'openai_chat'),
    ...(profile.capabilities.thinkingDialect
      ? { thinkingDialect: profile.capabilities.thinkingDialect }
      : {}),
    prefixProtocol: profile.capabilities.prefixProtocol,
    prefillProbeStatus: profile.prefillProbeStatus ?? 'untested',
    searchProvider: publicResearch?.provider ?? 'auto',
    searchApiKey: publicResearch?.apiKey ?? '',
    searchDeepSeekProfileId: publicResearch?.deepseekProfileId,
  };
}

const THIRD_PARTY_RESEARCH_LABELS: Record<Exclude<PublicResearchSearchPresetId, 'auto'>, string> = {
  none: '已关闭联网查证',
  tavily: 'Tavily 搜索（已配置）',
  bocha: '博查搜索（已配置）',
  deepseek_account: '已借用 DeepSeek 账号',
};

export function resolveProviderCapabilitySummary(options: {
  presetId: ProviderPresetId;
  searchProvider: PublicResearchSearchPresetId;
  hasCustomPricing: boolean;
  isWebPlatform?: boolean;
}): [string, string, string] {
  const line1 = '💬 聊天、文游与叙事预设：始终可用';
  if (options.presetId === 'deepseek') {
    const deepseekResearchLabel =
      options.searchProvider === 'none' ? '已关闭联网查证' : '已随账号自带，免配';
    return [
      line1,
      `🔍 自动查原作与角色设定：${deepseekResearchLabel}`,
      '💰 余额与省费统计：自动查余额与省费',
    ];
  }
  const researchLabel =
    options.searchProvider === 'auto'
      ? options.isWebPlatform === false
        ? '默认自动（安卓端免密钥免费查公开网页）'
        : '不配搜索也能正常玩；安卓端会自动尝试免费查原作，网页端如需查证可在此选配免费搜索'
      : THIRD_PARTY_RESEARCH_LABELS[options.searchProvider];
  const billingLabel = options.hasCustomPricing
    ? '已填写自定义单价，将同时统计节省 Token 与估算花费'
    : '默认统计节省 Token，选填单价后可算花费';
  return [
    line1,
    `🔍 自动查原作与角色设定：${researchLabel}`,
    `💰 余额与省费统计：${billingLabel}`,
  ];
}

export function buildProviderSaveResultFromDraft(
  draft: ProviderWizardDraft,
  options?: {
    hasDeepSeekProfileInLibrary?: boolean;
    discoveredModels?: readonly string[];
    overrideApiKey?: string;
    overrideBaseUrl?: string;
  },
): ProviderSetupSaveResult {
  const isDeepSeek = draft.presetId === 'deepseek';
  const preset = PROVIDER_PRESETS[draft.presetId] ?? PROVIDER_PRESETS.custom;
  const cleanedKey = sanitizeApiKeyInput(options?.overrideApiKey ?? draft.apiKey);
  const inputPrice = parsePriceInput(draft.inputPriceText);
  const cacheHitPrice = parsePriceInput(draft.cacheHitPriceText);
  const outputPrice = parsePriceInput(draft.outputPriceText);
  const hasCustomPricing =
    inputPrice !== undefined || outputPrice !== undefined || cacheHitPrice !== undefined;
  const defaultPricing: CustomModelPricing | undefined = hasCustomPricing
    ? {
        currency: draft.pricingCurrency,
        inputPerMillion: inputPrice ?? 0,
        ...(cacheHitPrice !== undefined ? { cacheHitInputPerMillion: cacheHitPrice } : {}),
        outputPerMillion: outputPrice ?? 0,
      }
    : undefined;

  const trimmedModel = draft.defaultModel.trim();
  const baseModels = mergeProviderModels(draft.models, options?.discoveredModels ?? []);
  const models = trimmedModel ? mergeProviderModels(baseModels, [trimmedModel]) : baseModels;
  const defaultModel = isDeepSeek
    ? preset.models.some((m) => m.id === trimmedModel)
      ? trimmedModel
      : preset.defaultModel
    : trimmedModel || models[0]?.id || preset.defaultModel;
  const backgroundModel = draft.backgroundModel.trim() || undefined;
  const resolvedId =
    draft.profileId?.trim() ||
    (isDeepSeek && !options?.hasDeepSeekProfileInLibrary ? 'deepseek-official' : createDefaultId());

  const resolvedBaseUrl = isDeepSeek
    ? preset.baseUrl
    : normalizeProviderBaseUrl(options?.overrideBaseUrl ?? draft.baseUrl);

  const apiProtocol: ProviderApiProtocol = isDeepSeek
    ? (preset.capabilities.apiProtocol ?? 'openai_chat')
    : normalizeProviderApiProtocol(
        draft.apiProtocol,
        preset.capabilities.apiProtocol ?? 'openai_chat',
      );
  const prefixProtocol: ProviderPrefixProtocol = isDeepSeek
    ? preset.capabilities.prefixProtocol
    : apiProtocol === 'openai_responses' || apiProtocol === 'gemini_native'
      ? 'none'
      : draft.prefixProtocol;

  const thinkingDialect =
    draft.thinkingDialect ?? preset.capabilities.thinkingDialect;

  const profile = createProviderProfileFromPreset(draft.presetId, {
    id: resolvedId,
    name: isDeepSeek ? preset.name : draft.name.trim() || preset.name,
    baseUrl: resolvedBaseUrl,
    apiKey: cleanedKey,
    models: isDeepSeek ? preset.models : models,
    defaultModel,
    ...(backgroundModel ? { backgroundModel } : { backgroundModel: undefined }),
    ...(defaultPricing ? { defaultPricing } : {}),
    capabilities: {
      ...preset.capabilities,
      apiProtocol,
      ...(thinkingDialect ? { thinkingDialect } : {}),
      prefixProtocol,
    },
    ...(isDeepSeek ? {} : { prefillProbeStatus: draft.prefillProbeStatus }),
  });

  if (isDeepSeek) {
    return { profile };
  }

  const searchPreset = PUBLIC_RESEARCH_PRESETS[draft.searchProvider] ?? PUBLIC_RESEARCH_PRESETS.auto;
  const cleanedSearchKey = sanitizeApiKeyInput(draft.searchApiKey);
  const publicResearch: PublicResearchConfig = {
    provider: searchPreset.id,
    ...(searchPreset.requiresApiKey && cleanedSearchKey ? { apiKey: cleanedSearchKey } : {}),
    ...(searchPreset.id === 'deepseek_account'
      ? { deepseekProfileId: draft.searchDeepSeekProfileId || 'deepseek-official' }
      : {}),
  };

  return { profile, publicResearch };
}

export interface WizardVerificationOutcome {
  ok: boolean;
  errorMsg?: string;
  allowFallbackSave: boolean;
  discoveredModels: string[];
  saveResult?: ProviderSetupSaveResult;
}

export async function verifyWizardDraftConnection(options: {
  draft: ProviderWizardDraft;
  verifyUrlBase?: string;
  isWebPlatform?: boolean;
  hasDeepSeekProfileInLibrary?: boolean;
  verifyDeepSeekImpl?: typeof verifyDeepSeekApiKey;
  verifyProviderImpl?: typeof verifyProviderConnection;
}): Promise<WizardVerificationOutcome> {
  const { draft } = options;

  if (draft.presetId === 'deepseek') {
    const verifyFn = options.verifyDeepSeekImpl ?? verifyDeepSeekApiKey;
    const formatCheck = validateApiKeyFormat(draft.apiKey);
    if (!formatCheck.ok) {
      return {
        ok: false,
        errorMsg: formatCheck.message,
        allowFallbackSave: false,
        discoveredModels: [],
      };
    }

    const result = await verifyFn({
      apiKey: formatCheck.key,
      baseUrl: options.verifyUrlBase || PROVIDER_PRESETS.deepseek.baseUrl,
    });
    if (result.status === 'valid') {
      return {
        ok: true,
        allowFallbackSave: false,
        discoveredModels: [],
        saveResult: buildProviderSaveResultFromDraft(draft, {
          hasDeepSeekProfileInLibrary: options.hasDeepSeekProfileInLibrary,
          overrideApiKey: result.key,
        }),
      };
    }
    return {
      ok: false,
      errorMsg: result.message,
      allowFallbackSave: result.status === 'network_error',
      discoveredModels: [],
    };
  }

  const verifyProviderFn = options.verifyProviderImpl ?? verifyProviderConnection;
  const result: ProviderConnectionVerifyResult = await verifyProviderFn({
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    apiProtocol: draft.apiProtocol,
    requireSkPrefix: false,
    allowEmptyKey: true,
    allowRelativeBaseUrl: import.meta.env.DEV && isDevProxyBaseUrl(draft.baseUrl),
    isWebPlatform: options.isWebPlatform ?? true,
  });

  if (result.status === 'valid') {
    return {
      ok: true,
      allowFallbackSave: false,
      discoveredModels: result.models,
      saveResult: buildProviderSaveResultFromDraft(draft, {
        hasDeepSeekProfileInLibrary: options.hasDeepSeekProfileInLibrary,
        discoveredModels: result.models,
        overrideApiKey: result.key,
        overrideBaseUrl: result.baseUrl,
      }),
    };
  }

  return {
    ok: false,
    errorMsg: result.message,
    allowFallbackSave: result.status === 'network_error' || result.status === 'models_unsupported',
    discoveredModels: [],
  };
}

export function validateWizardFallbackSave(
  draft: ProviderWizardDraft,
  hasDeepSeekProfileInLibrary?: boolean,
): { ok: true; saveResult: ProviderSetupSaveResult } | { ok: false; errorMsg: string } {
  if (draft.presetId === 'deepseek') {
    const formatCheck = validateApiKeyFormat(draft.apiKey);
    if (!formatCheck.ok) {
      return { ok: false, errorMsg: formatCheck.message };
    }
    return {
      ok: true,
      saveResult: buildProviderSaveResultFromDraft(draft, {
        hasDeepSeekProfileInLibrary,
        overrideApiKey: formatCheck.key,
      }),
    };
  }

  const normalizedUrl = normalizeProviderBaseUrl(draft.baseUrl);
  const allowDevProxy = import.meta.env.DEV && isDevProxyBaseUrl(normalizedUrl);
  if (!/^https?:\/\/[^/\s?#]+(?:[/?#].*)?$/i.test(normalizedUrl) && !allowDevProxy) {
    return { ok: false, errorMsg: '请填写有效的服务商接口地址（以 https:// 或 http:// 开头）。' };
  }
  const keyCheck = validateProviderApiKeyFormat(draft.apiKey, {
    requireSkPrefix: false,
    allowEmpty: true,
  });
  if (!keyCheck.ok) {
    return { ok: false, errorMsg: keyCheck.message };
  }
  return {
    ok: true,
    saveResult: buildProviderSaveResultFromDraft(draft, {
      hasDeepSeekProfileInLibrary,
      overrideApiKey: keyCheck.key,
      overrideBaseUrl: normalizedUrl,
    }),
  };
}

function createInitialDraft(props: {
  initialProfile?: ProviderProfile;
  initialPublicResearch?: PublicResearchConfig;
  initialKey?: string;
}): ProviderWizardDraft {
  if (props.initialProfile) {
    return createWizardDraftFromProfile(props.initialProfile, props.initialPublicResearch);
  }
  return createWizardDraftFromPreset('deepseek', {
    apiKey: props.initialKey ?? '',
    publicResearch: props.initialPublicResearch,
  });
}

export function ProviderSetupWizard({
  open,
  initialKey = '',
  initialProfile,
  initialPublicResearch,
  mode = initialProfile ? 'edit' : 'onboarding',
  hasDeepSeekProfileInLibrary = false,
  isWebPlatform = true,
  pendingLabel,
  verifyUrlBase,
  onComplete,
  onSaveProfile,
  onCancel,
  onExitComplete,
  onVerifyingChange,
}: ProviderSetupWizardProps) {
  const [draft, setDraft] = useState<ProviderWizardDraft>(() =>
    createInitialDraft({ initialProfile, initialPublicResearch, initialKey }),
  );
  const [pickerOpen, setPickerOpen] = useState<boolean>(() =>
    resolveInitialPresetPickerOpen(mode),
  );
  const [presetSearch, setPresetSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchModelsMsg, setFetchModelsMsg] = useState<string | null>(null);
  const [isProbingPrefill, setIsProbingPrefill] = useState(false);
  const [prefillProbeMsg, setPrefillProbeMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allowFallbackSave, setAllowFallbackSave] = useState(false);
  const verifySeqRef = useRef(0);
  const wasOpenRef = useRef(open);
  const lastProfileIdRef = useRef(initialProfile?.id);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    const profileChanged = open && initialProfile?.id !== lastProfileIdRef.current;
    wasOpenRef.current = open;
    lastProfileIdRef.current = initialProfile?.id;
    if (justOpened || profileChanged) {
      setDraft(createInitialDraft({ initialProfile, initialPublicResearch, initialKey }));
      setPickerOpen(resolveInitialPresetPickerOpen(mode));
      setPresetSearch('');
      setErrorMsg(null);
      setAllowFallbackSave(false);
      setFetchModelsMsg(null);
      setPrefillProbeMsg(null);
      setShowKey(false);
    }
  }, [open, mode, initialProfile, initialPublicResearch, initialKey]);

  useEffect(() => {
    onVerifyingChange?.(isVerifying);
    return () => {
      if (isVerifying) onVerifyingChange?.(false);
    };
  }, [isVerifying, onVerifyingChange]);

  const busy = isVerifying || isFetchingModels || isProbingPrefill;
  const activePreset = PROVIDER_PRESETS[draft.presetId] ?? PROVIDER_PRESETS.custom;
  const totalPresetCount = Object.keys(PROVIDER_PRESETS).length;
  const filteredPresetGroups = filterProviderPresetGroups(presetSearch);
  const isDeepSeek = draft.presetId === 'deepseek';
  const prefillDisabledByProtocol =
    draft.apiProtocol === 'openai_responses' || draft.apiProtocol === 'gemini_native';
  const activeSearchPreset =
    PUBLIC_RESEARCH_PRESETS[draft.searchProvider] ?? PUBLIC_RESEARCH_PRESETS.auto;
  const hasCustomPricing =
    parsePriceInput(draft.inputPriceText) !== undefined ||
    parsePriceInput(draft.outputPriceText) !== undefined ||
    parsePriceInput(draft.cacheHitPriceText) !== undefined;
  const capabilityLines = resolveProviderCapabilitySummary({
    presetId: draft.presetId,
    searchProvider: draft.searchProvider,
    hasCustomPricing,
    isWebPlatform,
  });
  const subscriptionNotice = resolveProviderSubscriptionNotice(draft);
  const showGuidanceHint = Boolean(activePreset.setupHint && !subscriptionNotice?.hintTestId);
  const showGuidanceConsoleLink = Boolean(
    activePreset.consoleUrl && activePreset.consoleUrl !== subscriptionNotice?.linkUrl,
  );

  const handleSelectPreset = (nextPresetId: ProviderPresetId) => {
    if (busy) return;
    setErrorMsg(null);
    setAllowFallbackSave(false);
    setFetchModelsMsg(null);
    setPrefillProbeMsg(null);
    setPickerOpen(false);
    setPresetSearch('');
    setDraft((prev) => {
      const keepKey = prev.presetId === nextPresetId ? prev.apiKey : '';
      return {
        ...createWizardDraftFromPreset(nextPresetId, {
          apiKey: keepKey,
          publicResearch:
            nextPresetId === 'deepseek'
              ? undefined
              : {
                  provider: prev.searchProvider,
                  ...(prev.searchApiKey ? { apiKey: prev.searchApiKey } : {}),
                  ...(prev.searchDeepSeekProfileId
                    ? { deepseekProfileId: prev.searchDeepSeekProfileId }
                    : {}),
                },
        }),
        ...(mode === 'edit' && prev.profileId ? { profileId: prev.profileId } : {}),
      };
    });
  };

  const handleOpenPlatform = () => {
    window.open(activePreset.consoleUrl ?? DEEPSEEK_OFFICIAL_KEYS_URL, '_blank', 'noopener,noreferrer');
  };

  const handleFetchModels = async () => {
    if (busy || isDeepSeek) return;
    setIsFetchingModels(true);
    setErrorMsg(null);
    setFetchModelsMsg(null);
    setAllowFallbackSave(false);

    const result = await verifyProviderConnection({
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      apiProtocol: draft.apiProtocol,
      requireSkPrefix: false,
      allowEmptyKey: true,
      allowRelativeBaseUrl: import.meta.env.DEV && isDevProxyBaseUrl(draft.baseUrl),
      isWebPlatform,
    });

    setIsFetchingModels(false);

    if (result.status === 'valid') {
      setDraft((prev) => {
        const merged = mergeProviderModels(prev.models, result.models);
        return {
          ...prev,
          baseUrl: result.baseUrl,
          models: merged,
          defaultModel: prev.defaultModel.trim() || result.models[0] || '',
        };
      });
      setFetchModelsMsg(
        result.models.length > 0
          ? `已拉取 ${result.models.length} 个可用模型，可点选或手动输入。`
          : '连接成功，该服务商未返回模型列表，请手动填写模型 ID。',
      );
      return;
    }

    setErrorMsg(result.message);
    setAllowFallbackSave(result.status === 'network_error' || result.status === 'models_unsupported');
  };

  const handleProbePrefill = async () => {
    if (busy || isDeepSeek) return;
    setIsProbingPrefill(true);
    setPrefillProbeMsg(null);
    const probeModel = draft.defaultModel.trim() || draft.models[0]?.id || '';
    const result = await probeAssistantPrefillCompatibility({
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      model: probeModel,
      apiProtocol: draft.apiProtocol,
    });
    setIsProbingPrefill(false);
    setDraft((prev) => ({
      ...prev,
      prefillProbeStatus: result.supported ? 'supported' : 'unsupported',
      prefixProtocol: result.supported ? 'standard_assistant_prefill' : 'none',
    }));
    setPrefillProbeMsg(result.supported ? '支持' : result.message);
  };

  const finishSave = (result: ProviderSetupSaveResult) => {
    onSaveProfile?.(result);
    onComplete?.(result.profile.apiKey);
  };

  const handleVerifyAndSave = async () => {
    if (isVerifying) return;
    const seq = ++verifySeqRef.current;
    setIsVerifying(true);
    setErrorMsg(null);
    setAllowFallbackSave(false);

    const outcome = await verifyWizardDraftConnection({
      draft,
      verifyUrlBase,
      isWebPlatform,
      hasDeepSeekProfileInLibrary,
    });

    if (verifySeqRef.current !== seq) return;
    setIsVerifying(false);

    if (outcome.ok && outcome.saveResult) {
      if (outcome.discoveredModels.length > 0) {
        setDraft((prev) => ({
          ...prev,
          models: outcome.saveResult!.profile.models,
          defaultModel: outcome.saveResult!.profile.defaultModel,
        }));
      }
      finishSave(outcome.saveResult);
      return;
    }

    setErrorMsg(outcome.errorMsg ?? '连接验证失败，请检查配置后重试。');
    setAllowFallbackSave(outcome.allowFallbackSave);
  };

  const handleFallbackSave = () => {
    const check = validateWizardFallbackSave(draft, hasDeepSeekProfileInLibrary);
    if (!check.ok) {
      setErrorMsg(check.errorMsg);
      setAllowFallbackSave(false);
      return;
    }
    finishSave(check.saveResult);
  };

  return (
    <ModalDialog
      open={open}
      label="连接模型服务"
      className="modal-dialog wizard-dialog"
      testId="deepseek-setup-wizard"
      closeDisabled={isVerifying}
      onClose={onCancel}
      onExitComplete={onExitComplete}
      onCancel={(event) => {
        if (isVerifying) event.preventDefault();
      }}
    >
      <div className="wizard-dialog-content" data-verifying={isVerifying ? 'true' : 'false'}>
        <div className="wizard-header">
          <div>
            <h3 id="wizard-title">连接模型服务</h3>
            <p className="wizard-subtitle">
              {isDeepSeek
                ? '连接 DeepSeek · 只需 3 步连接官方服务，API Key 只保存在本机'
                : '连接所选模型服务商，API Key 只保存在本机'}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            aria-label="关闭引导"
            disabled={isVerifying}
            onClick={onCancel}
          >
            关闭
          </button>
        </div>

        {pendingLabel && (
          <div className="wizard-pending-banner">
            完成连接后将自动继续：<strong>{pendingLabel}</strong>
          </div>
        )}

        <div className="provider-preset-picker">
          <button
            type="button"
            className="provider-preset-picker-trigger"
            data-testid="provider-preset-picker-trigger"
            aria-expanded={pickerOpen}
            disabled={busy}
            onClick={() => setPickerOpen((prev) => !prev)}
          >
            <span className="provider-preset-picker-current">
              <span className="provider-preset-picker-prefix">当前预设：</span>
              <span className="provider-preset-label">{activePreset.name}</span>
              {activePreset.presetId === 'deepseek' && (
                <span className="provider-preset-badge">官方推荐</span>
              )}
            </span>
            <span className="provider-preset-picker-action">
              <span>切换服务商（{totalPresetCount} 项）</span>
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                className={pickerOpen ? 'provider-preset-chevron is-open' : 'provider-preset-chevron'}
                aria-hidden="true"
              />
            </span>
          </button>

          {pickerOpen && (
            <div
              className="provider-preset-picker-panel"
              data-testid="provider-preset-picker-panel"
              role="region"
              aria-label="选择模型服务预设"
            >
              <div className="provider-preset-search-row">
                <Search
                  size={16}
                  strokeWidth={1.75}
                  className="provider-preset-search-icon"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  className="provider-preset-search-input"
                  data-testid="provider-preset-search-input"
                  aria-label="搜索模型服务商"
                  placeholder="搜索服务商名称、英文或域名（如 Kimi、百炼、claude）"
                  value={presetSearch}
                  disabled={busy}
                  onChange={(event) => setPresetSearch(event.target.value)}
                />
                {presetSearch && (
                  <button
                    type="button"
                    className="icon-button provider-preset-search-clear"
                    aria-label="清空服务商搜索"
                    disabled={busy}
                    onClick={() => setPresetSearch('')}
                  >
                    <X size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>

              {filteredPresetGroups.length === 0 ? (
                <p className="wizard-privacy-note provider-preset-empty">
                  未找到匹配的服务商预设，可清空搜索关键词或选择「自定义服务商」。
                </p>
              ) : (
                <div className="provider-preset-groups">
                  {filteredPresetGroups.map((group) => (
                    <section key={group.id} className="provider-preset-group" aria-label={group.label}>
                      <h4 className="provider-preset-group-title">{group.label}</h4>
                      <div className="provider-preset-grid" role="group" aria-label={group.label}>
                        {group.presetIds.map((presetId) => {
                          const spec = PROVIDER_PRESETS[presetId];
                          const active = draft.presetId === presetId;
                          return (
                            <button
                              key={presetId}
                              type="button"
                              className="provider-preset-card"
                              data-testid={`provider-preset-${presetId}`}
                              aria-pressed={active}
                              disabled={busy}
                              onClick={() => handleSelectPreset(presetId)}
                            >
                              <span className="provider-preset-label">{spec.name}</span>
                              {presetId === 'deepseek' && (
                                <span className="provider-preset-badge">官方推荐</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {isDeepSeek ? (
          <ol className="wizard-steps">
            <li className="wizard-step-card">
              <div className="wizard-step-title">
                <span className="wizard-step-num">1</span>
                <strong>前往 DeepSeek 开放平台</strong>
              </div>
              <p className="wizard-step-desc">前往 DeepSeek 开放平台获取 API Key：</p>
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="wizard-open-platform-btn"
                onClick={handleOpenPlatform}
              >
                打开 DeepSeek 开放平台
              </button>
            </li>

            <li className="wizard-step-card">
              <div className="wizard-step-title">
                <span className="wizard-step-num">2</span>
                <strong>创建并复制 API Key</strong>
              </div>
              <ul className="wizard-mini-list">
                <li>使用手机号或微信登录开放平台；</li>
                <li>点左侧菜单「API keys」→「创建 API key」（名称随便填）；</li>
                <li>点击「复制」（密钥只显示一次，请当场复制）。</li>
              </ul>
            </li>

            <li className="wizard-step-card">
              <div className="wizard-step-title">
                <span className="wizard-step-num">3</span>
                <strong>回到这里粘贴并验证</strong>
              </div>

              <div className="field">
                <label htmlFor="byok-api-key">DeepSeek API Key</label>
                <div className="key-input-row">
                  <input
                    id="byok-api-key"
                    name="apiKey"
                    type={showKey ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={draft.apiKey}
                    disabled={isVerifying}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, apiKey: value }));
                      setErrorMsg(null);
                      setAllowFallbackSave(false);
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    aria-pressed={showKey}
                    disabled={isVerifying}
                    onClick={() => setShowKey((prev) => !prev)}
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>

              <p className="wizard-privacy-note">
                模型请求会由你的设备直接发送至 DeepSeek 官方 API；API Key 只保存在本机，不会交给项目方。
              </p>
            </li>
          </ol>
        ) : (
          <div className="provider-form-stack">
            <div className="wizard-step-card">
              {(showGuidanceHint || showGuidanceConsoleLink) && (
                <div className="provider-preset-guidance" data-testid="provider-preset-guidance">
                  {showGuidanceHint && activePreset.setupHint && (
                    <p className="wizard-privacy-note" data-testid="provider-setup-hint">
                      {activePreset.setupHint}
                    </p>
                  )}
                  {showGuidanceConsoleLink && activePreset.consoleUrl && (
                    <a
                      className="provider-search-docs-link"
                      data-testid="provider-console-link"
                      href={activePreset.consoleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span>前往 {activePreset.name} 控制台获取 API Key</span>
                      <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
              <div className="field">
                <label htmlFor="provider-name-input">服务名称</label>
                <input
                  id="provider-name-input"
                  data-testid="provider-name-input"
                  type="text"
                  value={draft.name}
                  placeholder="例如：我的 OpenAI"
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((prev) => ({ ...prev, name: value }));
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="provider-base-url-input">服务商地址</label>
                <input
                  id="provider-base-url-input"
                  data-testid="provider-base-url-input"
                  type="url"
                  value={draft.baseUrl}
                  placeholder={
                    draft.apiProtocol === 'gemini_native'
                      ? 'https://generativelanguage.googleapis.com/v1beta'
                      : 'https://api.openai.com/v1'
                  }
                  disabled={busy}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((prev) => ({ ...prev, baseUrl: value }));
                    setErrorMsg(null);
                    setAllowFallbackSave(false);
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="byok-api-key">API Key（本地服务可留空）</label>
                <div className="key-input-row">
                  <input
                    id="byok-api-key"
                    name="apiKey"
                    type={showKey ? 'text' : 'password'}
                    placeholder={
                      draft.apiProtocol === 'anthropic_messages'
                        ? 'sk-ant-...'
                        : draft.apiProtocol === 'gemini_native'
                          ? 'AIza... 或 AQ....（由 Google AI Studio 创建）'
                          : 'sk-...（本地服务可不填）'
                    }
                    value={draft.apiKey}
                    disabled={busy}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, apiKey: value }));
                      setErrorMsg(null);
                      setAllowFallbackSave(false);
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    aria-pressed={showKey}
                    disabled={busy}
                    onClick={() => setShowKey((prev) => !prev)}
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>

              {subscriptionNotice && (
                <BannerAlert tone="info" testId={subscriptionNotice.testId}>
                  <div className="provider-subscription-notice">
                    <span data-testid={subscriptionNotice.hintTestId}>
                      {subscriptionNotice.message}
                    </span>
                    <a
                      className="provider-search-docs-link"
                      data-testid={subscriptionNotice.linkTestId}
                      href={subscriptionNotice.linkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span>{subscriptionNotice.linkLabel}</span>
                      <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  </div>
                </BannerAlert>
              )}

              <div className="field">
                <label htmlFor="provider-model-input">常用模型</label>
                <div className="provider-model-input-row">
                  <input
                    id="provider-model-input"
                    data-testid="provider-model-input"
                    type="text"
                    list="provider-fetched-models-datalist"
                    placeholder="输入模型 ID，或点右侧拉取"
                    value={draft.defaultModel}
                    disabled={busy}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, defaultModel: value }));
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="provider-fetch-models-btn"
                    disabled={busy}
                    onClick={() => void handleFetchModels()}
                  >
                    <RefreshCw
                      size={16}
                      strokeWidth={1.75}
                      className={isFetchingModels ? 'settings-balance-spin' : undefined}
                      aria-hidden="true"
                    />
                    <span>{isFetchingModels ? '拉取中...' : '拉取模型列表'}</span>
                  </button>
                </div>
                <datalist id="provider-fetched-models-datalist">
                  {draft.models.map((entry) => (
                    <option key={entry.id} value={entry.id} />
                  ))}
                </datalist>
                {draft.models.length > 0 && (
                  <div className="provider-model-chips" role="group" aria-label="快捷选择模型">
                    {draft.models.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="provider-model-chip"
                        aria-pressed={draft.defaultModel === entry.id}
                        disabled={busy}
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, defaultModel: entry.id }))
                        }
                      >
                        {entry.label ? `${entry.label} (${entry.id})` : entry.id}
                      </button>
                    ))}
                  </div>
                )}
                {fetchModelsMsg && <p className="wizard-privacy-note">{fetchModelsMsg}</p>}
              </div>
            </div>

            <section
              className="wizard-step-card provider-public-research-card"
              data-testid="provider-public-research-section"
              aria-label="联网查原作设定（可选）"
            >
              <div className="provider-section-heading">
                <strong>联网查原作设定（可选）</strong>
                <span className="provider-section-hint">不配置也可正常游玩，需要查同人原作时启用</span>
              </div>
              <div className="provider-search-preset-list" role="group" aria-label="联网检索源预设">
                {SEARCH_PRESET_ORDER.map((presetKey) => {
                  const preset = PUBLIC_RESEARCH_PRESETS[presetKey];
                  const selected = draft.searchProvider === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className="provider-search-preset-btn"
                      data-testid={`provider-search-preset-${preset.id}`}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, searchProvider: preset.id }))
                      }
                    >
                      <span className="provider-search-preset-title">{preset.title}</span>
                      <span className="provider-search-preset-quota">{preset.quotaHint}</span>
                    </button>
                  );
                })}
              </div>

              <div className="provider-search-detail">
                <p className="wizard-step-desc">{activeSearchPreset.description}</p>
                <p className="wizard-privacy-note">{activeSearchPreset.quotaHint}</p>
                {draft.searchProvider === 'deepseek_account' && !hasDeepSeekProfileInLibrary && (
                  <p className="wizard-privacy-note">
                    当前档案库暂未连接 DeepSeek 官方账号，后续连接后即可自动借用。
                  </p>
                )}
                {activeSearchPreset.docsUrl && (
                  <a
                    className="provider-search-docs-link"
                    href={activeSearchPreset.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>前往获取免费 Search API Key</span>
                    <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                )}
                {activeSearchPreset.requiresApiKey && (
                  <div className="field">
                    <label htmlFor="provider-search-key-input">Search API Key</label>
                    <input
                      id="provider-search-key-input"
                      data-testid="provider-search-key-input"
                      type={showKey ? 'text' : 'password'}
                      placeholder="粘贴搜索服务 API Key"
                      value={draft.searchApiKey}
                      disabled={busy}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((prev) => ({ ...prev, searchApiKey: value }));
                      }}
                    />
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        <section
          className="provider-capability-summary"
          data-testid="provider-capability-summary"
          aria-label="当前服务能力说明"
        >
          {capabilityLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </section>

        <details className="provider-advanced-details" data-testid="provider-advanced-settings">
          <summary>更多可选设置</summary>
          <div className="provider-advanced-body">
            {!isDeepSeek && (
              <div className="field">
                <label htmlFor="provider-protocol-select">接口协议</label>
                <select
                  id="provider-protocol-select"
                  data-testid="provider-protocol-select"
                  value={draft.apiProtocol}
                  disabled={busy}
                  onChange={(event) => {
                    const nextProtocol = normalizeProviderApiProtocol(
                      event.target.value,
                      'openai_chat',
                    );
                    setDraft((prev) => ({
                      ...prev,
                      apiProtocol: nextProtocol,
                      ...(nextProtocol === 'openai_responses' || nextProtocol === 'gemini_native'
                        ? { prefixProtocol: 'none' }
                        : {}),
                    }));
                  }}
                >
                  <option value="openai_chat">OpenAI Chat Completions (/chat/completions)</option>
                  <option value="openai_responses">OpenAI Responses API (/responses)</option>
                  <option value="anthropic_messages">Anthropic Messages (/v1/messages)</option>
                  <option value="gemini_native">Google Gemini 原生 (/v1beta)</option>
                </select>
                <span className="wizard-privacy-note">
                  OpenAI 官方默认 Responses API，Anthropic 默认 Messages API，Google Gemini 默认原生 /v1beta；兼容或中转站可按需切换
                </span>
              </div>
            )}

            <div className="field">
              <label htmlFor="provider-background-model-input">后台轻量模型（可选）</label>
              <input
                id="provider-background-model-input"
                data-testid="provider-background-model-input"
                type="text"
                placeholder="留空时自动复用当前主模型"
                value={draft.backgroundModel}
                disabled={busy}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((prev) => ({ ...prev, backgroundModel: value }));
                }}
              />
              <span className="wizard-privacy-note">留空时自动复用当前主模型，用于后台摘要与设定提取</span>
            </div>

            <div className="provider-pricing-section">
              <span className="provider-pricing-heading">自定义计费单价（可选，每百万 Token）</span>
              <div className="provider-pricing-grid">
                <div className="field">
                  <label htmlFor="provider-pricing-currency">币种</label>
                  <select
                    id="provider-pricing-currency"
                    data-testid="provider-pricing-currency"
                    value={draft.pricingCurrency}
                    disabled={busy}
                    onChange={(event) => {
                      const currency = event.target.value === 'USD' ? 'USD' : 'CNY';
                      setDraft((prev) => ({ ...prev, pricingCurrency: currency }));
                    }}
                  >
                    <option value="CNY">CNY (¥)</option>
                    <option value="USD">USD ($)</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="provider-pricing-input">输入单价</label>
                  <input
                    id="provider-pricing-input"
                    data-testid="provider-pricing-input"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={draft.inputPriceText}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, inputPriceText: value }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="provider-pricing-cache-input">缓存命中单价</label>
                  <input
                    id="provider-pricing-cache-input"
                    data-testid="provider-pricing-cache-input"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="选填"
                    value={draft.cacheHitPriceText}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, cacheHitPriceText: value }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="provider-pricing-output">输出单价</label>
                  <input
                    id="provider-pricing-output"
                    data-testid="provider-pricing-output"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={draft.outputPriceText}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((prev) => ({ ...prev, outputPriceText: value }));
                    }}
                  />
                </div>
              </div>
            </div>

            {!isDeepSeek && (
              <div className="provider-prefill-section">
                <label className="provider-prefill-toggle-row">
                  <span>尝试增强续写（仅部分服务商支持）</span>
                  <input
                    type="checkbox"
                    data-testid="provider-prefill-toggle"
                    checked={
                      !prefillDisabledByProtocol &&
                      draft.prefixProtocol === 'standard_assistant_prefill'
                    }
                    disabled={busy || prefillDisabledByProtocol}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setDraft((prev) => ({
                        ...prev,
                        prefixProtocol: enabled ? 'standard_assistant_prefill' : 'none',
                      }));
                    }}
                  />
                </label>
                <div className="provider-prefill-probe-row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid="provider-probe-prefill-btn"
                    disabled={busy || prefillDisabledByProtocol}
                    onClick={() => void handleProbePrefill()}
                  >
                    {isProbingPrefill ? '正在探测...' : '测一下支不支持'}
                  </button>
                  {(prefillProbeMsg || draft.prefillProbeStatus !== 'untested') && (
                    <span
                      className="wizard-privacy-note"
                      data-testid="provider-probe-prefill-result"
                    >
                      {prefillProbeMsg ||
                        (draft.prefillProbeStatus === 'supported'
                          ? '支持'
                          : '暂不支持，已保持通用稳定模式')}
                    </span>
                  )}
                </div>
                {prefillDisabledByProtocol ? (
                  <span className="wizard-privacy-note">
                    当前所选接口协议不支持助手预填，已自动使用标准多轮续写
                  </span>
                ) : (
                  draft.apiProtocol === 'anthropic_messages' && (
                    <span className="wizard-privacy-note">
                      Anthropic 原生协议在未开启思考时支持助手尾段预填；开启思考后将自动降级为标准多轮续写
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        </details>

        {errorMsg && (
          <BannerAlert tone="danger" testId="wizard-error">
            {errorMsg}
          </BannerAlert>
        )}

        <div className="wizard-footer">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="wizard-verify-save-btn"
            disabled={isVerifying}
            onClick={() => void handleVerifyAndSave()}
          >
            {isVerifying ? '正在验证连接...' : '验证并保存'}
          </button>
          {allowFallbackSave && (
            <button
              type="button"
              className="btn"
              data-testid="wizard-fallback-save-btn"
              disabled={isVerifying}
              onClick={handleFallbackSave}
            >
              先保存，稍后再试
            </button>
          )}
          <button type="button" className="btn" disabled={isVerifying} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
