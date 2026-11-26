import {
  isReasoningEffort,
  normalizeReasoningEffort,
  sanitizeDiagnosticModelName,
} from './keyConfig.ts';
import type {
  KeyValueStorage,
  LlmTransport,
  NodeDiagnostics,
  ReasoningEffort,
  Story,
  StoryStorage,
} from './types.ts';
import type { RefusalDiagnosticEvent } from './refusalWrapper.ts';
import {
  buildRedactedStorySkeleton,
  buildRedactedWorkspaceSkeleton,
  type RedactedStorySkeleton,
  type RedactedWorkspaceSkeleton,
  type WorkspaceSkeletonInput,
} from './storySkeleton.ts';

export const DIAGNOSTIC_WINDOW_MS = 60 * 60 * 1000;
export const MAX_DIAGNOSTIC_EVENTS = 600;
export const MAX_DIAGNOSTIC_RADARS = 20;
export const DIAGNOSTIC_STORAGE_KEY = 'lfh.diagnostics.v2';
export const LEGACY_DIAGNOSTIC_STORAGE_KEY = 'lfh.diagnostics.v1';
export const DIAGNOSTIC_BUNDLE_FILENAME_PREFIX = 'folio-logs-';

const MAX_MESSAGE_CHARS = 320;
const MAX_ERROR_REASON_CHARS = 180;
const MAX_USER_NOTE_CHARS = 280;
const MAX_STACK_FRAMES = 5;
const STACK_MODULES = new Set([
  // V0.1 modules
  'App.tsx', 'AppErrorBoundary.tsx', 'DeepSeekImportPanel.tsx', 'indexedDbStorage.ts',
  'diagnostics.ts', 'harness.ts', 'sse.ts', 'deepseekImport.ts', 'binaryDownload.ts',
  'capacitorSseTransport.ts', 'capacitorBinaryDownloader.ts', 'capacitorVaultAdapters.ts',
  'bundle.js',
  // V0.2 modules
  'markdownProposal.ts', 'markdownDiff.ts', 'MarkdownView.tsx', 'ProposalCard.tsx',
  'migration.ts', 'backup.ts', 'creative.ts', 'entryRouter.ts', 'DraftPane.tsx', 'CharacterPane.tsx',
  'WelcomeView.tsx', 'SettingsPage.tsx', 'useCreativeReply.ts', 'useCreativeWorkspace.ts',
  'useManuscriptAutosave.ts', 'useAutoScrollTimeline.ts', 'useDeepSeekBalance.ts', 'CompanionSheet.tsx',
  'markdownDocuments.ts', 'storyStorage.ts', 'storySkeleton.ts', 'context.ts',
  'branches.ts', 'storyTree.ts',
  // Android in-app update modules
  'appUpdate.ts', 'capacitorUpdater.ts', 'useAppUpdater.ts', 'AppUpdateModal.tsx',
]);

const OFFICIAL_MODEL_HOSTS = new Set([
  'api.deepseek.com',
  'api.openai.com',
  'openrouter.ai',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'qianfan.baidubce.com',
]);

const BARE_DOMAIN_FILE_SUFFIXES = new Set(['ts', 'tsx', 'js', 'mjs', 'json', 'java', 'kt', 'css', 'html', 'map']);
const LOCAL_MODEL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DIAGNOSTIC_LEVELS = new Set<DiagnosticLevel>(['info', 'warn', 'error']);
const DIAGNOSTIC_CATEGORIES = new Set<DiagnosticCategory>([
  'llm',
  'branch',
  'storage',
  'import',
  'ui',
  'crash',
]);
const MARKDOWN_PROPOSAL_ACTIONS = {
  none: 'markdown_proposal_none',
  invalid: 'markdown_proposal_invalid',
  recognized: 'markdown_proposal_recognized',
  incomplete: 'markdown_proposal_incomplete',
} as const;
const DIAGNOSTIC_ACTIONS = new Set([
  // V0.1 actions
  'stream_done',
  'stream_aborted',
  'stream_error',
  ...Object.values(MARKDOWN_PROPOSAL_ACTIONS),
  'switch_branch',
  'switch_branch_failed',
  'list_stories',
  'list_stories_error',
  'get_story',
  'get_story_error',
  'save_story',
  'save_story_error',
  'delete_story',
  'delete_story_error',
  'get_active_story_id',
  'get_active_story_id_error',
  'get_active_story_selection',
  'get_active_story_selection_error',
  'set_active_story_id',
  'set_active_story_id_error',
  'compare_and_set_active_story_id',
  'compare_and_set_active_story_id_error',
  'deepseek_scan_error',
  'deepseek_url_error',
  'deepseek_import_error',
  'unhandled_render_crash',
  'unhandled_window_error',
  'unhandled_rejection',
  'import_complete',
  // V0.2 single-entry routing
  'entry_route_classified',
  'entry_route_ambiguous',
  'entry_neutral_persisted',
  'entry_misroute_corrected',
  // V0.2 proposals & diffs
  'proposal_parsed',
  'proposal_needs_review',
  'proposal_applied',
  'proposal_dismissed',
  'proposal_reverted',
  'patch_reapplied',
  'patch_conflict',
  'asset_derived_from_proposal',
  // V0.2 background silent summary
  'summary_background_done',
  'summary_background_skipped',
  'summary_background_failed',
  'summary_window_trimmed',
  // V0.2 manuscript editing & undo
  'manuscript_save_queued',
  'manuscript_save_flushed',
  'manuscript_save_error',
  'manuscript_suggestion_adopted',
  'manuscript_undo',
  // V0.2 backup & migration
  'backup_export_v3',
  'backup_import_v3',
  'backup_import_legacy',
  'migration_v02_done',
  'migration_v02_error',
  // V0.2 log share/export
  'diagnostics_exported',
  'diagnostics_shared',
  // V0.2+ balance check (zero-content status/latency only)
  'balance_check_done',
  'balance_check_failed',
  // V0.4 refusal governance (zero-content metrics only)
  'refusal_detected',
  'refusal_retry_recovered',
  'refusal_retry_exhausted',
  'refusal_partial_delivered',
  'refusal_original_restored',
  // Android in-app updates (zero-content status/outcome only)
  'update_check_done',
  'update_check_failed',
  'update_download_done',
  'update_download_failed',
  'update_verify_failed',
  'update_install_permission_needed',
  'update_install_launched',
  'update_install_failed',
  // V0.4.2 auto-scroll anomalies & transitions (zero-content metrics only)
  'autoscroll_target_missing',
  'autoscroll_target_non_scrollable',
  'autoscroll_follow_transition',
  'autoscroll_follow_anomaly',
  // UI swipe gesture diagnostics (zero-content surface/reason only)
  'swipe_gesture_canceled',
  'swipe_gesture_rejected',
  'other',
]);
const REFUSAL_DIAGNOSTIC_ACTIONS = new Set([
  'refusal_detected',
  'refusal_retry_recovered',
  'refusal_retry_exhausted',
  'refusal_partial_delivered',
  'refusal_original_restored',
]);
const REFUSAL_SAFE_METRICS = new Set([
  'packEnabled',
  'slotChars',
  'prefixMode',
  'refusalRoute',
  'matchedRuleId',
  'retryCount',
]);
const CRASH_DIAGNOSTIC_ACTIONS = new Set([
  'unhandled_render_crash',
  'unhandled_window_error',
  'unhandled_rejection',
]);
const DIAGNOSTIC_BUNDLE_TRIGGERS = new Set<DiagnosticBundleTrigger>([
  'settings_manual',
  'error_banner',
  'crash_boundary',
]);
const DIAGNOSTIC_ACTIVE_VIEWS = new Set<DiagnosticActiveView>([
  'welcome',
  'story',
  'writing',
  'character',
  'import',
  'settings',
  'unknown',
]);
const DIAGNOSTIC_THEMES = new Set<DiagnosticTheme>(['system', 'light', 'dark', 'warm']);

const SAFE_NUMERIC_METRICS = new Set([
  'chunks',
  'messageCount',
  'addedLines',
  'removedLines',
  'durationMs',
  'hydratedCount',
  'migratedCount',
  'retryCount',
  'updateBytes',
  'scrollTop',
  'scrollHeight',
  'clientHeight',
  'scrollGapPx',
]);
const SAFE_ENUM_METRICS: Record<string, ReadonlySet<string>> = {
  target: new Set([
    'public',
    'container',
    'local',
    'character',
    'draft',
    'story',
    'setting',
    'memory',
    'branch_note',
    'manuscript',
    'unknown',
  ]),
  op: new Set([
    'patch',
    'append',
    'section',
    'full',
    'replace',
    'insert',
    'create',
    'delete',
    'unknown',
  ]),
  routeMode: new Set(['story', 'writing', 'character', 'neutral', 'ambiguous', 'unknown']),
  scrollMode: new Set(['story', 'writing', 'character', 'welcome', 'unknown']),
  scrollState: new Set(['following', 'user_paused', 'overlay_paused', 'unknown']),
  scrollOverflowY: new Set(['auto', 'scroll', 'overlay', 'visible', 'hidden', 'clip', 'unknown']),
  reasoningEffort: new Set(['none', 'low', 'high', 'max']),
  prefixMode: new Set(['off', 'on_retry', 'always']),
  refusalRoute: new Set(['pass', 'retry', 'retry-skeleton', 'partial_refused', 'refused_exhausted']),
  updateOutcome: new Set([
    'up_to_date',
    'available',
    'skipped',
    'cached',
    'downloaded',
    'installed',
    'browser_fallback',
  ]),
  swipeSurface: new Set(['drawer_open', 'drawer_close', 'overlay_back']),
};
const SAFE_REASON_CODE_UPPER_ALLOWLIST = new Set([
  'TIMEOUT',
  'CONTENT_FILTER',
  'INCOMPLETE',
  'ABORTED',
  'NETWORK_ERROR',
  'QUOTA_EXCEEDED',
  'PATCH_CONFLICT',
  'SHA256_MISMATCH',
  'SIGNATURE_MISMATCH',
  'PACKAGE_MISMATCH',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
]);
const SAFE_SNAKE_CODE_REGEX = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CREDENTIAL_PREFIX_REGEX = /^(?:sk|rk|pk|tvly|key|token|secret|password|bearer|authorization)[_-]/i;
const SAFE_ERROR_NAME_REGEX = /^(?:Error|[A-Z][A-Za-z0-9]{0,47}(?:Error|Exception))$/;
const SAFE_ERROR_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const SAFE_ENV_VERSION_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/+ -]{0,47}$/;

const SAFE_FRAGMENT_TYPE_REGEX = /^[A-Z][A-Z0-9_]{0,31}$/;
const SAFE_ATTACHMENT_EXTENSION_REGEX = /^\.[a-z0-9]{1,8}$/;
const MODEL_HOSTNAME_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticCategory = 'llm' | 'branch' | 'storage' | 'import' | 'ui' | 'crash';
export type EndpointHostKind = 'official' | 'relay' | 'local' | 'unset';
export type DiagnosticActiveView =
  | 'welcome'
  | 'story'
  | 'writing'
  | 'character'
  | 'import'
  | 'settings'
  | 'unknown';
export type DiagnosticTheme = 'system' | 'light' | 'dark' | 'warm';

export interface SanitizedEndpointProfile {
  hostKind: EndpointHostKind;
  host: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  memoryOnly: boolean;
  hasApiKey: boolean;
  isDevProxy: boolean;
}

export interface EndpointProfileInput {
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  apiKey?: string;
  memoryOnly: boolean;
  isDevProxy?: boolean;
}

export interface DeepSeekImportRadar {
  ts: number;
  durationMs?: number;
  exportFormatVersion: number | null;
  sourceMode: 'zip_file' | 'url';
  totalSessions: number;
  selectedSessions: number;
  danglingParentCount: number;
  emptyTitleCount: number;
  unknownFragmentTypes: string[];
  attachmentExtensions: Record<string, number>;
  scriptConfidenceCounts: { strong: number; ambiguous: number };
  status: 'success' | 'error';
}

export type DiagnosticMetaValue =
  | string
  | number
  | boolean
  | null
  | { head: number; mid: number; tail: number };

export interface DiagnosticEvent {
  ts: number;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  action: string;
  durationMs?: number;
  statusCode?: number;
  errorName?: string;
  errorCode?: string;
  sanitizedReason?: string;
  sanitizedMessage?: string;
  stackTop?: string[];
  meta?: Record<string, DiagnosticMetaValue>;
}

export interface DiagnosticBundle {
  schemaVersion: 2;
  generatedAt: string;
  platform: 'web' | 'android';
  windowMinutes: 60;
  trigger: DiagnosticBundleTrigger;
  appEnv: DiagnosticAppEnvironment;
  endpointProfile: SanitizedEndpointProfile;
  importRadars: DeepSeekImportRadar[];
  events: Array<Omit<DiagnosticEvent, 'ts'> & { tsOffsetSec: number }>;
  userNote?: string;
  activeStorySkeleton?: RedactedStorySkeleton;
  workspaceSkeleton?: RedactedWorkspaceSkeleton;
}

export type DiagnosticBundleTrigger = 'settings_manual' | 'error_banner' | 'crash_boundary';

export interface DiagnosticAppEnvironment {
  platform: 'web' | 'android';
  appVersion: string;
  osVersion?: string;
  webviewVersion?: string;
  theme?: DiagnosticTheme;
  viewport: string;
  activeView: DiagnosticActiveView;
  storyCount: number;
  workCount?: number;
  characterCount?: number;
}

export interface DiagnosticBundleBuildOptions {
  trigger?: DiagnosticBundleTrigger;
  appEnv?: Partial<DiagnosticAppEnvironment>;
  userNote?: string;
  activeStory?: Story;
  workspace?: WorkspaceSkeletonInput;
  extraSecrets?: readonly string[];
}

export interface DiagnosticCollectorOptions {
  platform: 'web' | 'android';
  storage?: KeyValueStorage;
  now?: () => number;
}

export interface DiagnosticCollector {
  recordEvent(input: Omit<DiagnosticEvent, 'ts'> & { ts?: number }): void;
  recordError(input: {
    category: DiagnosticCategory;
    action: string;
    error: unknown;
    durationMs?: number;
    statusCode?: number;
    errorCode?: string | number;
    stack?: string;
    meta?: Record<string, DiagnosticMetaValue>;
  }): void;
  recordImportRadar(radar: Omit<DeepSeekImportRadar, 'ts'> & { ts?: number }): void;
  buildBundle(
    endpointConfig: EndpointProfileInput,
    options?: DiagnosticBundleBuildOptions,
  ): DiagnosticBundle;
  clear(): void;
}


/** Records one zero-content refusal breadcrumb through the same fail-closed allowlist. */
export function recordRefusalDiagnostic(
  collector: DiagnosticCollector,
  event: RefusalDiagnosticEvent,
): void {
  try {
    collector.recordEvent({
      level: event.action === 'refusal_retry_exhausted' ? 'warn' : 'info',
      category: 'llm',
      action: event.action,
      meta: event.metrics as unknown as Record<string, DiagnosticMetaValue>,
    });
  } catch {
    // Diagnostics must never alter generation behavior.
  }
}

export function recordRefusalOriginalRestoredDiagnostic(
  collector: DiagnosticCollector,
  nodeDiagnostics?: Pick<NodeDiagnostics, 'refusalRoute' | 'retriedWithPrefix' | 'matchedRuleId'>,
): void {
  const route = nodeDiagnostics?.refusalRoute;
  const retryCount = route
    ? route === 'pass' ? 0 : 1
    : nodeDiagnostics?.retriedWithPrefix ? 1 : undefined;
  recordRefusalDiagnostic(collector, {
    action: 'refusal_original_restored',
    metrics: {
      ...(route ? { refusalRoute: route } : {}),
      ...(nodeDiagnostics?.matchedRuleId ? { matchedRuleId: nodeDiagnostics.matchedRuleId } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
    },
  });
}

export type AutoScrollDiagnosticAction =
  | 'autoscroll_target_missing'
  | 'autoscroll_target_non_scrollable'
  | 'autoscroll_follow_transition'
  | 'autoscroll_follow_anomaly';

export interface AutoScrollDiagnosticMetrics {
  scrollMode?: 'story' | 'writing' | 'character' | 'welcome' | 'unknown';
  scrollState?: 'following' | 'user_paused' | 'overlay_paused' | 'unknown';
  scrollOverflowY?: 'auto' | 'scroll' | 'overlay' | 'visible' | 'hidden' | 'clip' | 'unknown';
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  scrollGapPx?: number;
  reasonCode?: string;
}

export interface AutoScrollDiagnosticEvent {
  level?: 'info' | 'warn';
  action: AutoScrollDiagnosticAction;
  metrics?: AutoScrollDiagnosticMetrics;
}

/** Records one zero-content auto-scroll breadcrumb through the fail-closed allowlist. */
export function recordAutoScrollDiagnostic(
  collector: DiagnosticCollector | undefined,
  event: AutoScrollDiagnosticEvent,
): void {
  if (!collector) return;
  try {
    collector.recordEvent({
      level: event.level ?? (event.action === 'autoscroll_follow_transition' ? 'info' : 'warn'),
      category: 'ui',
      action: event.action,
      meta: event.metrics as unknown as Record<string, DiagnosticMetaValue>,
    });
  } catch {
    // Diagnostics must never alter scroll behavior.
  }
}

export interface SwipeDiagnosticInput {
  action: 'swipe_gesture_canceled' | 'swipe_gesture_rejected';
  surface: 'drawer_open' | 'drawer_close' | 'overlay_back';
  reasonCode: 'pointer_cancel_pending' | 'pointer_cancel_horizontal' | 'below_threshold';
}

/** Records one zero-content UI swipe breadcrumb through the fail-closed diagnostics allowlist. */
export function recordSwipeDiagnostic(
  collector: Pick<DiagnosticCollector, 'recordEvent'>,
  event: SwipeDiagnosticInput,
): void {
  try {
    collector.recordEvent({
      level: event.action === 'swipe_gesture_canceled' ? 'warn' : 'info',
      category: 'ui',
      action: event.action,
      meta: {
        swipeSurface: event.surface,
        reasonCode: event.reasonCode,
      },
    });
  } catch {
    // Diagnostics must never interfere with UI touch handling.
  }
}

export function formatDiagnosticBundleFileName(date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `${DIAGNOSTIC_BUNDLE_FILENAME_PREFIX}${stamp}.json`;
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseHostFromUrl(rawUrl: string): { scheme: string; host: string } | null {
  const match = rawUrl.trim().match(/^(https?):\/\/([^/?#\s]+)/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let authority = match[2];
  const atIdx = authority.lastIndexOf('@');
  if (atIdx !== -1) {
    authority = authority.slice(atIdx + 1);
  }
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    const ipv6 = closeIdx !== -1 ? authority.slice(0, closeIdx + 1) : authority;
    return { scheme, host: ipv6.toLowerCase() };
  }
  const colonIdx = authority.indexOf(':');
  const host = (colonIdx !== -1 ? authority.slice(0, colonIdx) : authority).toLowerCase();
  return host ? { scheme, host } : null;
}

export function classifyAndRedactHost(rawHost: string): {
  hostKind: EndpointHostKind;
  host: string;
} {
  const normalized = rawHost.trim().toLowerCase();
  if (!normalized) {
    return { hostKind: 'unset', host: '' };
  }
  if (OFFICIAL_MODEL_HOSTS.has(normalized)) {
    return { hostKind: 'official', host: normalized };
  }
  if (LOCAL_MODEL_HOSTS.has(normalized)) {
    return { hostKind: 'local', host: normalized };
  }
  return { hostKind: 'relay', host: `relay_${fnv1a32Hex(normalized)}` };
}

export function sanitizeEndpointProfile(input: EndpointProfileInput): SanitizedEndpointProfile {
  const config: Record<string, unknown> = isRecord(input) ? input : {};
  const trimmedUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const isDevProxy = config.isDevProxy === true;
  let hostKind: EndpointHostKind = 'unset';
  let host = '';
  if (isDevProxy) {
    hostKind = 'local';
    host = 'dev_proxy';
  } else {
    const parsed = parseHostFromUrl(trimmedUrl);
    if (parsed) {
      const classified = classifyAndRedactHost(parsed.host);
      hostKind = classified.hostKind;
      host = classified.host;
    }
  }
  const reasoningEffort = isReasoningEffort(config.reasoningEffort)
    ? config.reasoningEffort
    : undefined;
  return {
    hostKind,
    host,
    model: sanitizeModel(config.model, apiKey, trimmedUrl),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    memoryOnly: config.memoryOnly === true,
    hasApiKey: apiKey.length > 0,
    isDevProxy,
  };
}

function sanitizeModel(rawModel: unknown, apiKey: string, baseUrl: string): string {
  const model = sanitizeDiagnosticModelName(rawModel);
  if (!model) return 'unset';

  const normalized = model.toLowerCase();
  const components = normalized.split('/');
  const endpoint = readEndpointModelSecrets(baseUrl);
  const containsEndpointHost =
    endpoint.host &&
    (components.some((component) => component.split(':', 1)[0] === endpoint.host) ||
      (endpoint.host.length >= 4 && normalized.includes(endpoint.host)));
  if (
    CREDENTIAL_PREFIX_REGEX.test(model) ||
    (apiKey && normalized.includes(apiKey.toLowerCase())) ||
    containsEndpointHost ||
    endpoint.values.some((value) => components.includes(value.toLowerCase()))
  ) {
    return 'unset';
  }
  return model;
}

function readEndpointModelSecrets(baseUrl: string): { host: string; values: string[] } {
  const parsed = parseHostFromUrl(baseUrl);
  if (!parsed) return { host: '', values: [] };

  const urlParts = baseUrl.trim().match(
    /^https?:\/\/([^/?#\s]+)(?:\/[^?#\s]*)?(?:\?([^#\s]*))?(?:#\S*)?$/i,
  );
  if (!urlParts) return { host: parsed.host.replace(/\.$/, ''), values: [] };

  const values: string[] = [];
  const authority = urlParts[1]!;
  const atIndex = authority.lastIndexOf('@');
  if (atIndex >= 0) {
    const userInfo = authority.slice(0, atIndex);
    const separator = userInfo.indexOf(':');
    values.push(
      decodeUrlComponent(separator >= 0 ? userInfo.slice(0, separator) : userInfo),
      ...(separator >= 0 ? [decodeUrlComponent(userInfo.slice(separator + 1))] : []),
    );
  }
  if (urlParts[2]) {
    for (const pair of urlParts[2].split('&')) {
      const separator = pair.indexOf('=');
      if (separator >= 0) values.push(decodeUrlComponent(pair.slice(separator + 1)));
    }
  }

  return {
    host: parsed.host.replace(/\.$/, ''),
    values: values.filter(Boolean),
  };
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

export function sanitizeDiagnosticText(raw: string, maxLen = MAX_MESSAGE_CHARS): string {
  if (!raw) return '';
  let text = raw;
  // 1. Scrub Bearer tokens
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  // 2. Scrub sk-* / tvly-* keys
  text = text.replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_KEY]');
  // 3. Scrub key/token query or header assignments
  text = text.replace(
    /\b((?:x-)?api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s&"',;]+/gi,
    '$1=[REDACTED]',
  );
  // 4. Scrub URLs: keep official/local host or hashed relay_<8hex>, strip path/query/fragment/userinfo
  text = text.replace(/https?:\/\/[^\s"'`<>()]+/gi, (matchedUrl) => {
    const parsed = parseHostFromUrl(matchedUrl);
    if (!parsed) return '[REDACTED_URL]';
    const { host } = classifyAndRedactHost(parsed.host);
    return `${parsed.scheme}://${host || 'unknown'}`;
  });
  // 5. Scrub local/device filesystem paths BEFORE filename redaction so paths don't leak directory names
  text = text.replace(/(?:file|content):\/\/[^\s"'`<>]+/gi, '[REDACTED_PATH]');
  text = text.replace(
    /(?:\/Users|\/home|\/var\/mobile|\/private\/var|\/data\/user|\/data\/data|\/storage\/emulated\/\d+|\/sdcard)\/[^\s"'`<>:]+/g,
    '[REDACTED_PATH]',
  );
  text = text.replace(/[A-Za-z]:\\Users\\[^\s"'`<>:]+/gi, '[REDACTED_PATH]');
  // 6. Scrub backup & attachment-like file names (keep only extension) and bare hostnames / IPv4 literals
  text = text.replace(
    /[^\s"'`<>/\\:：，（）()]*[^\s"'`<>/\\:：，（）().]\.(?:lfh|folio)\.json\b/gi,
    '[file].json',
  );
  text = text.replace(
    /[^\s"'`<>/\\:：，（）()]*[^\s"'`<>/\\:：，（）().]\.(docx?|md|txt|pdf|zip|png|jpe?g|gif|webp|bmp|svg)\b/gi,
    (_m, ext: string) => `[file].${ext.toLowerCase()}`,
  );
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => classifyAndRedactHost(ip).host);
  text = text.replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi, (candidate) => {
    const lower = candidate.toLowerCase();
    if (BARE_DOMAIN_FILE_SUFFIXES.has(lower.slice(lower.lastIndexOf('.') + 1))) return candidate;
    return classifyAndRedactHost(lower).host;
  });

  if (text.length > maxLen) {
    if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen));
    return `${text.slice(0, maxLen - 1)}…`;
  }
  return text;
}

function sanitizeSingleLineText(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!collapsed) return undefined;
  const sanitized = sanitizeDiagnosticText(collapsed, maxLen).trim();
  return sanitized || undefined;
}

function sanitizeReasonCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  if (SAFE_REASON_CODE_UPPER_ALLOWLIST.has(trimmed)) return trimmed;
  if (
    SAFE_SNAKE_CODE_REGEX.test(trimmed) &&
    !CREDENTIAL_PREFIX_REGEX.test(trimmed)
  ) {
    return trimmed;
  }
  return undefined;
}

function sanitizeMeta(
  meta: Record<string, DiagnosticMetaValue> | undefined,
  action: string,
): Record<string, DiagnosticMetaValue> | undefined {
  if (!meta) return undefined;
  const out: Record<string, DiagnosticMetaValue> = {};
  const refusalAction = REFUSAL_DIAGNOSTIC_ACTIONS.has(action);
  for (const [k, v] of Object.entries(meta)) {
    if (refusalAction && !REFUSAL_SAFE_METRICS.has(k)) continue;
    if (SAFE_NUMERIC_METRICS.has(k)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        out[k] = Math.round(v);
      }
      continue;
    }
    const enumSet = SAFE_ENUM_METRICS[k];
    if (enumSet) {
      if (typeof v === 'string' && enumSet.has(v)) {
        out[k] = v;
      }
      continue;
    }
    if (k === 'packEnabled') {
      if (typeof v === 'boolean') out[k] = v;
      continue;
    }
    if (k === 'slotChars') {
      if (isRecord(v)) {
        const head = normalizeCount(v.head);
        const mid = normalizeCount(v.mid);
        const tail = normalizeCount(v.tail);
        out[k] = { head, mid, tail };
      }
      continue;
    }
    if (k === 'matchedRuleId') {
      if (typeof v === 'string' && /^(?:L[1-4]-\d{2}|skeleton-\d{2})$/.test(v)) out[k] = v;
      continue;
    }
    if (k === 'model') {
      const safeModel = sanitizeDiagnosticModelName(v);
      if (safeModel) out[k] = safeModel;
      continue;
    }
    if (k === 'reasonCode') {
      const code = sanitizeReasonCode(v);
      if (code) out[k] = code;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function normalizeStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function normalizeErrorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return SAFE_ERROR_NAME_REGEX.test(trimmed) ? trimmed : 'Error';
}

function normalizeErrorCode(value: unknown, statusCode?: number): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const status = normalizeStatusCode(value);
    if (status !== undefined) return `HTTP_${status}`;
    if (value >= 0 && value <= 999999) return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      trimmed &&
      SAFE_ERROR_CODE_REGEX.test(trimmed) &&
      !CREDENTIAL_PREFIX_REGEX.test(trimmed) &&
      !MODEL_HOSTNAME_REGEX.test(trimmed) &&
      !/^https?$/i.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return statusCode !== undefined ? `HTTP_${statusCode}` : undefined;
}

function extractErrorDetails(
  error: unknown,
  explicitStatusCode?: number,
  explicitErrorCode?: string | number,
): {
  statusCode?: number;
  errorName?: string;
  errorCode?: string;
  sanitizedReason?: string;
} {
  const statusCode = explicitStatusCode ?? extractStatusCode(error);
  let rawName: unknown;
  let rawCode: unknown = explicitErrorCode;
  let rawMessage: unknown;

  try {
    if (typeof error === 'string') {
      rawMessage = error;
    } else if (error && typeof error === 'object') {
      const errRecord = error as { name?: unknown; code?: unknown; message?: unknown };
      rawName = errRecord.name;
      if (rawCode === undefined) rawCode = errRecord.code;
      rawMessage = errRecord.message;
    }
  } catch {
    // Ignore hostile error getters
  }

  const errorName =
    rawName !== undefined
      ? normalizeErrorName(rawName)
      : error instanceof Error
        ? 'Error'
        : undefined;
  const errorCode = normalizeErrorCode(rawCode, statusCode);
  const sanitizedReason = sanitizeSingleLineText(rawMessage, MAX_ERROR_REASON_CHARS);

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(sanitizedReason ? { sanitizedReason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStackTop(frames: unknown): string[] {
  if (!Array.isArray(frames)) return [];
  const safe: string[] = [];
  for (const frame of frames.slice(0, MAX_STACK_FRAMES)) {
    if (typeof frame !== 'string') continue;
    const match = /^([\w.-]+):(\d{1,8}):(\d{1,8})$/.exec(frame);
    if (match && STACK_MODULES.has(match[1])) safe.push(frame);
  }
  return safe;
}

function readStackTop(error: unknown, suppliedStack?: string): string[] {
  try {
    const stack = suppliedStack ?? (error instanceof Error ? error.stack : undefined);
    if (typeof stack !== 'string') return [];
    const frames: string[] = [];
    // Keep only numbered locations in known application modules.
    for (const [, file, line, column] of stack.slice(-16000).matchAll(
      /[/\\]([\w.-]+\.(?:tsx?|js)):(\d{1,8}):(\d{1,8})(?=\)?\s*$)/gm,
    )) {
      const module = /^index-[\w-]{8}\.js$/.test(file) ? 'bundle.js' : file;
      if (STACK_MODULES.has(module)) frames.push(`${module}:${line}:${column}`);
      if (frames.length === MAX_STACK_FRAMES) break;
    }
    return frames;
  } catch {
    return [];
  }
}

function normalizeEvent(value: unknown): DiagnosticEvent | null {
  if (!isRecord(value)) return null;
  const { ts, level, category, action } = value;
  if (
    typeof ts !== 'number' ||
    !Number.isFinite(ts) ||
    typeof level !== 'string' ||
    !DIAGNOSTIC_LEVELS.has(level as DiagnosticLevel) ||
    typeof category !== 'string' ||
    !DIAGNOSTIC_CATEGORIES.has(category as DiagnosticCategory)
  ) {
    return null;
  }

  const rawAction = typeof action === 'string' ? action : '';
  if (
    (category === 'crash' &&
      (!CRASH_DIAGNOSTIC_ACTIONS.has(rawAction) || level !== 'error')) ||
    (category !== 'crash' && CRASH_DIAGNOSTIC_ACTIONS.has(rawAction))
  ) {
    return null;
  }
  const safeAction = DIAGNOSTIC_ACTIONS.has(rawAction) ? rawAction : 'other';
  const refusalAction = REFUSAL_DIAGNOSTIC_ACTIONS.has(safeAction);
  const durationMs = refusalAction ? undefined : normalizeDurationMs(value.durationMs);
  const statusCode = refusalAction ? undefined : normalizeStatusCode(value.statusCode);
  const errorName = !refusalAction && level === 'error' ? normalizeErrorName(value.errorName) : undefined;
  const errorCode = !refusalAction && level === 'error'
    ? normalizeErrorCode(value.errorCode, statusCode)
    : undefined;
  const sanitizedReason = !refusalAction && level === 'error'
    ? sanitizeSingleLineText(value.sanitizedReason, MAX_ERROR_REASON_CHARS)
    : undefined;
  const stackTop = refusalAction ? [] : normalizeStackTop(value.stackTop);
  const sanitizedMessage = !refusalAction && level === 'error'
    ? `${safeAction.replaceAll('_', ' ')}${statusCode === undefined ? '' : ` (HTTP ${statusCode})`}`
    : undefined;
  const meta = isRecord(value.meta)
    ? sanitizeMeta(value.meta as Record<string, DiagnosticMetaValue>, safeAction)
    : undefined;

  return {
    ts,
    level: level as DiagnosticLevel,
    category: category as DiagnosticCategory,
    action: safeAction,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(sanitizedReason ? { sanitizedReason } : {}),
    ...(sanitizedMessage ? { sanitizedMessage } : {}),
    ...(stackTop.length ? { stackTop } : {}),
    ...(meta ? { meta } : {}),
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeImportRadar(value: unknown): DeepSeekImportRadar | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.ts !== 'number' ||
    !Number.isFinite(value.ts) ||
    (value.sourceMode !== 'zip_file' && value.sourceMode !== 'url') ||
    (value.status !== 'success' && value.status !== 'error')
  ) {
    return null;
  }

  const version = value.exportFormatVersion;
  const exportFormatVersion =
    version === null || (typeof version === 'number' && Number.isInteger(version) && version >= 0)
      ? version
      : null;
  const scriptCounts = isRecord(value.scriptConfidenceCounts)
    ? value.scriptConfidenceCounts
    : {};
  const extensionCounts: Record<string, number> = {};
  if (isRecord(value.attachmentExtensions)) {
    for (const [rawExtension, rawCount] of Object.entries(value.attachmentExtensions)) {
      const extension = SAFE_ATTACHMENT_EXTENSION_REGEX.test(rawExtension.toLowerCase())
        ? rawExtension.toLowerCase()
        : '.other';
      const count = normalizeCount(rawCount);
      if (count > 0) extensionCounts[extension] = (extensionCounts[extension] ?? 0) + count;
    }
  }

  const unknownFragmentTypes = Array.isArray(value.unknownFragmentTypes)
    ? Array.from(
        new Set(
          value.unknownFragmentTypes.map((type) =>
            typeof type === 'string' && SAFE_FRAGMENT_TYPE_REGEX.test(type)
              ? type
              : 'INVALID_TYPE_NAME',
          ),
        ),
      )
        .sort()
        .slice(0, 100)
    : [];
  const durationMs = normalizeDurationMs(value.durationMs);

  return {
    ts: value.ts,
    ...(durationMs !== undefined ? { durationMs } : {}),
    exportFormatVersion,
    sourceMode: value.sourceMode,
    totalSessions: normalizeCount(value.totalSessions),
    selectedSessions: normalizeCount(value.selectedSessions),
    danglingParentCount: normalizeCount(value.danglingParentCount),
    emptyTitleCount: normalizeCount(value.emptyTitleCount),
    unknownFragmentTypes,
    attachmentExtensions: extensionCounts,
    scriptConfidenceCounts: {
      strong: normalizeCount(scriptCounts.strong),
      ambiguous: normalizeCount(scriptCounts.ambiguous),
    },
    status: value.status,
  };
}

function normalizeSafeEnvVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed || !SAFE_ENV_VERSION_REGEX.test(collapsed)) return undefined;
  if (
    collapsed.startsWith('/') ||
    collapsed.includes('//') ||
    collapsed.includes('..') ||
    /(?:^|\/)(?:Users|home|var|data|storage|sdcard)\b/i.test(collapsed) ||
    /(?:api[_-]?key|token|secret|password|authorization|bearer)/i.test(collapsed) ||
    /\b(?:sk|tvly)-[A-Za-z0-9_-]{3,}/i.test(collapsed)
  ) {
    return undefined;
  }
  return collapsed;
}

function normalizeAppEnvironment(
  value: Partial<DiagnosticAppEnvironment> | undefined,
  platform: 'web' | 'android',
): DiagnosticAppEnvironment {
  const appVersion =
    typeof value?.appVersion === 'string' &&
    value.appVersion.length <= 32 &&
    /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.appVersion)
      ? value.appVersion
      : 'unknown';
  const osVersion = normalizeSafeEnvVersion(value?.osVersion);
  const webviewVersion = normalizeSafeEnvVersion(value?.webviewVersion);
  const theme =
    typeof value?.theme === 'string' && DIAGNOSTIC_THEMES.has(value.theme as DiagnosticTheme)
      ? (value.theme as DiagnosticTheme)
      : undefined;
  const viewport =
    typeof value?.viewport === 'string' && /^\d{1,5}x\d{1,5}$/.test(value.viewport)
      ? value.viewport
      : 'unknown';
  const activeView =
    typeof value?.activeView === 'string' &&
    DIAGNOSTIC_ACTIVE_VIEWS.has(value.activeView as DiagnosticActiveView)
      ? (value.activeView as DiagnosticActiveView)
      : 'unknown';

  return {
    platform,
    appVersion,
    ...(osVersion ? { osVersion } : {}),
    ...(webviewVersion ? { webviewVersion } : {}),
    ...(theme ? { theme } : {}),
    viewport,
    activeView,
    storyCount: normalizeCount(value?.storyCount),
    ...(value?.workCount !== undefined ? { workCount: normalizeCount(value.workCount) } : {}),
    ...(value?.characterCount !== undefined
      ? { characterCount: normalizeCount(value.characterCount) }
      : {}),
  };
}

interface PersistedDiagnosticsPayload {
  events: DiagnosticEvent[];
  radars: DeepSeekImportRadar[];
}

export function createDiagnosticCollector(
  options: DiagnosticCollectorOptions,
): DiagnosticCollector {
  const now = options.now ?? (() => Date.now());
  let events: DiagnosticEvent[] = [];
  let radars: DeepSeekImportRadar[] = [];

  const prune = (currentTs: number): void => {
    const cutoff = currentTs - DIAGNOSTIC_WINDOW_MS;
    events = events.filter((e) => e.ts >= cutoff);
    if (events.length > MAX_DIAGNOSTIC_EVENTS) {
      events = events.slice(events.length - MAX_DIAGNOSTIC_EVENTS);
    }
    radars = radars.filter((r) => r.ts >= cutoff);
    if (radars.length > MAX_DIAGNOSTIC_RADARS) {
      radars = radars.slice(radars.length - MAX_DIAGNOSTIC_RADARS);
    }
  };

  const persist = (): void => {
    if (!options.storage) return;
    try {
      const payload: PersistedDiagnosticsPayload = { events, radars };
      options.storage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Never throw from diagnostics persistence
    }
  };

  const loadFromStorage = (): void => {
    if (!options.storage) return;
    try {
      const rawV2 = options.storage.getItem(DIAGNOSTIC_STORAGE_KEY);
      const rawLegacy = rawV2 ? null : options.storage.getItem(LEGACY_DIAGNOSTIC_STORAGE_KEY);
      const raw = rawV2 ?? rawLegacy;
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedDiagnosticsPayload>;
      if (Array.isArray(parsed.events)) {
        events = parsed.events
          .map(normalizeEvent)
          .filter((event): event is DiagnosticEvent => event !== null);
      }
      if (Array.isArray(parsed.radars)) {
        radars = parsed.radars
          .map(normalizeImportRadar)
          .filter((radar): radar is DeepSeekImportRadar => radar !== null);
      }
      prune(now());
      // Rewrite older payloads through the same zero-content projection before they remain persisted.
      persist();
      if (rawLegacy !== null) {
        options.storage.removeItem(LEGACY_DIAGNOSTIC_STORAGE_KEY);
      }
    } catch {
      events = [];
      radars = [];
      persist();
      try {
        options.storage.removeItem(LEGACY_DIAGNOSTIC_STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  };

  loadFromStorage();

  return {
    recordEvent(input): void {
      const ts = input.ts ?? now();
      const event = normalizeEvent({ ...input, ts });
      if (!event) return;
      events.push(event);
      prune(ts);
      persist();
    },

    recordError(input): void {
      const details = extractErrorDetails(input.error, input.statusCode, input.errorCode);
      this.recordEvent({
        level: 'error',
        category: input.category,
        action: input.action,
        durationMs: input.durationMs,
        statusCode: details.statusCode,
        errorName: details.errorName,
        errorCode: details.errorCode,
        sanitizedReason: details.sanitizedReason,
        stackTop: readStackTop(input.error, input.stack),
        meta: input.meta,
      });
    },

    recordImportRadar(radar): void {
      const ts = radar.ts ?? now();
      const normalized = normalizeImportRadar({ ...radar, ts });
      if (!normalized) return;
      radars.push(normalized);
      prune(ts);
      persist();
    },

    buildBundle(endpointConfig, bundleOptions = {}): DiagnosticBundle {
      const currentTs = now();
      prune(currentTs);
      persist();
      const trigger = DIAGNOSTIC_BUNDLE_TRIGGERS.has(bundleOptions.trigger as DiagnosticBundleTrigger)
        ? bundleOptions.trigger!
        : 'settings_manual';
      const extraSecrets = Array.from(
        new Set(
          (bundleOptions.extraSecrets ?? [])
            .map((secret) => (typeof secret === 'string' ? secret.trim() : ''))
            .filter((secret) => secret.length >= 6),
        ),
      );
      const scrubExtraSecrets = (value: string): string => {
        let scrubbed = value;
        for (const secret of extraSecrets) {
          if (scrubbed.includes(secret)) {
            scrubbed = scrubbed.split(secret).join('[REDACTED_KEY]');
          }
        }
        return scrubbed;
      };
      const rawUserNote = sanitizeSingleLineText(bundleOptions.userNote, MAX_USER_NOTE_CHARS);
      const userNote = rawUserNote ? scrubExtraSecrets(rawUserNote) : undefined;
      const activeStorySkeleton = bundleOptions.activeStory
        ? buildRedactedStorySkeleton(bundleOptions.activeStory)
        : undefined;
      const workspaceSkeleton = bundleOptions.workspace
        ? buildRedactedWorkspaceSkeleton(bundleOptions.workspace)
        : undefined;
      return {
        schemaVersion: 2,
        generatedAt: new Date(currentTs).toISOString(),
        platform: options.platform,
        windowMinutes: 60,
        trigger,
        appEnv: normalizeAppEnvironment(bundleOptions.appEnv, options.platform),
        endpointProfile: sanitizeEndpointProfile(endpointConfig),
        importRadars: radars
          .map(normalizeImportRadar)
          .filter((radar): radar is DeepSeekImportRadar => radar !== null),
        events: events
          .map(normalizeEvent)
          .filter((event): event is DiagnosticEvent => event !== null)
          .map(({ ts, ...event }) => ({
            ...event,
            ...(event.sanitizedReason
              ? { sanitizedReason: scrubExtraSecrets(event.sanitizedReason) }
              : {}),
            ...(event.sanitizedMessage
              ? { sanitizedMessage: scrubExtraSecrets(event.sanitizedMessage) }
              : {}),
            ...(event.stackTop
              ? { stackTop: event.stackTop.map(scrubExtraSecrets) }
              : {}),
            tsOffsetSec: Math.round((ts - currentTs) / 1000),
          })),
        ...(userNote ? { userNote } : {}),
        ...(activeStorySkeleton ? { activeStorySkeleton } : {}),
        ...(workspaceSkeleton ? { workspaceSkeleton } : {}),
      };
    },

    clear(): void {
      events = [];
      radars = [];
      try {
        options.storage?.removeItem(DIAGNOSTIC_STORAGE_KEY);
        options.storage?.removeItem(LEGACY_DIAGNOSTIC_STORAGE_KEY);
      } catch {
        // Ignore
      }
    },
  };
}

function extractStatusCode(err: unknown): number | undefined {
  try {
    if (err && typeof err === 'object') {
      const status = normalizeStatusCode((err as { status?: unknown }).status);
      if (status !== undefined) return status;
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string') {
        const match = message.match(/\b([45]\d{2})\b/);
        if (match) return normalizeStatusCode(Number(match[1]));
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Wraps an LlmTransport so streams and Markdown proposal parsing can record zero-content breadcrumbs.
 */
export function createDiagnosticTransport(
  inner: LlmTransport,
  collector: DiagnosticCollector,
  now: () => number = () => Date.now(),
): LlmTransport {
  return {
    recordMarkdownProposal(status) {
      collector.recordEvent({
        level: status === 'invalid' || status === 'incomplete' ? 'warn' : 'info',
        category: 'llm',
        action: MARKDOWN_PROPOSAL_ACTIONS[status],
      });
    },
    async *streamChat(req) {
      const startedAt = now();
      let chunkCount = 0;
      const effort = normalizeReasoningEffort(
        req.reasoningEffort ??
          req.reasoning_effort ??
          (req.thinking?.type === 'disabled' ? 'none' : 'high'),
      );
      const streamMeta = {
        model: req.model,
        reasoningEffort: effort,
      };
      try {
        for await (const delta of inner.streamChat(req)) {
          chunkCount += 1;
          yield delta;
        }
        collector.recordEvent({
          level: 'info',
          category: 'llm',
          action: 'stream_done',
          durationMs: now() - startedAt,
          meta: { chunks: chunkCount, messageCount: req.messages.length, ...streamMeta },
        });
      } catch (err) {
        const aborted = Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError');
        if (aborted) {
          collector.recordEvent({
            level: 'warn',
            category: 'llm',
            action: 'stream_aborted',
            durationMs: now() - startedAt,
            meta: streamMeta,
          });
        } else {
          collector.recordError({
            category: 'llm',
            action: 'stream_error',
            error: err,
            durationMs: now() - startedAt,
            statusCode: extractStatusCode(err),
            meta: streamMeta,
          });
        }
        throw err;
      }
    },
  };
}

/**
 * Wraps StoryStorage to record read/write breadcrumbs (never story content).
 */
export function createDiagnosticStoryStorage(
  inner: StoryStorage,
  collector: DiagnosticCollector,
  now: () => number = () => Date.now(),
): StoryStorage {
  const track = async <T>(action: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      const result = await run();
      collector.recordEvent({
        level: 'info',
        category: 'storage',
        action,
        durationMs: now() - startedAt,
      });
      return result;
    } catch (err) {
      collector.recordError({
        category: 'storage',
        action: `${action}_error`,
        error: err,
        durationMs: now() - startedAt,
      });
      throw err;
    }
  };
  return {
    listStories: () => track('list_stories', () => inner.listStories()),
    getStory: (id) => track('get_story', () => inner.getStory(id)),
    saveStory: (story, expectedUpdatedAt) => track('save_story', () => inner.saveStory(story, expectedUpdatedAt)),
    deleteStory: (id) => track('delete_story', () => inner.deleteStory(id)),
    getActiveStorySelection: () => track(
      'get_active_story_selection',
      () => inner.getActiveStorySelection(),
    ),
    setActiveStoryId: (id) => track('set_active_story_id', () => inner.setActiveStoryId(id)),
    compareAndSetActiveStoryId: (expected, next) => track(
      'compare_and_set_active_story_id',
      () => inner.compareAndSetActiveStoryId(expected, next),
    ),
  };
}
