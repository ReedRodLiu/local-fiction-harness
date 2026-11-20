import type { KeyValueStorage, LlmTransport, Story, StoryStorage } from './types.ts';
import { buildRedactedStorySkeleton, type RedactedStorySkeleton } from './storySkeleton.ts';

export const DIAGNOSTIC_WINDOW_MS = 30 * 60 * 1000;
export const MAX_DIAGNOSTIC_EVENTS = 400;
export const MAX_DIAGNOSTIC_RADARS = 20;
export const DIAGNOSTIC_STORAGE_KEY = 'lfh.diagnostics.v1';

const MAX_MESSAGE_CHARS = 320;
const MAX_STACK_FRAMES = 5;
const STACK_MODULES = new Set([
  'App.tsx', 'AppErrorBoundary.tsx', 'DeepSeekImportPanel.tsx', 'indexedDbStorage.ts',
  'diagnostics.ts', 'harness.ts', 'sse.ts', 'deepseekImport.ts', 'binaryDownload.ts',
  'capacitorSseTransport.ts', 'capacitorBinaryDownloader.ts', 'capacitorVaultAdapters.ts',
  'bundle.js',
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
const DIAGNOSTIC_ACTIONS = new Set([
  'stream_done',
  'stream_aborted',
  'stream_error',
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
  'set_active_story_id',
  'set_active_story_id_error',
  'deepseek_scan_error',
  'deepseek_url_error',
  'deepseek_import_error',
  'unhandled_render_crash',
  'unhandled_window_error',
  'unhandled_rejection',
  'import_complete',
  'other',
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
const SAFE_EVENT_METRICS = new Set(['chunks', 'messageCount']);
const SAFE_FRAGMENT_TYPE_REGEX = /^[A-Z][A-Z0-9_]{0,31}$/;
const SAFE_ATTACHMENT_EXTENSION_REGEX = /^\.[a-z0-9]{1,8}$/;
const SAFE_MODEL_IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?(?:\/[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)?$/;
const MODEL_HOSTNAME_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const LOCAL_MODEL_ALIASES = new Set([
  'localhost',
  'localhost.localdomain',
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
]);

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticCategory = 'llm' | 'branch' | 'storage' | 'import' | 'ui' | 'crash';
export type EndpointHostKind = 'official' | 'relay' | 'local' | 'unset';

export interface SanitizedEndpointProfile {
  hostKind: EndpointHostKind;
  host: string;
  model: string;
  memoryOnly: boolean;
  hasApiKey: boolean;
  isDevProxy: boolean;
}

export interface EndpointProfileInput {
  baseUrl: string;
  model: string;
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

export type DiagnosticMetaValue = string | number | boolean | null;

export interface DiagnosticEvent {
  ts: number;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  action: string;
  durationMs?: number;
  statusCode?: number;
  sanitizedMessage?: string;
  stackTop?: string[];
  meta?: Record<string, DiagnosticMetaValue>;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: string;
  platform: 'web' | 'android';
  windowMinutes: 30;
  trigger: DiagnosticBundleTrigger;
  appEnv: DiagnosticAppEnvironment;
  endpointProfile: SanitizedEndpointProfile;
  importRadars: DeepSeekImportRadar[];
  events: Array<Omit<DiagnosticEvent, 'ts'> & { tsOffsetSec: number }>;
  activeStorySkeleton?: RedactedStorySkeleton;
}

export type DiagnosticBundleTrigger = 'settings_manual' | 'error_banner' | 'crash_boundary';

export interface DiagnosticAppEnvironment {
  platform: 'web' | 'android';
  appVersion: string;
  viewport: string;
  activeView: 'story' | 'import' | 'unknown';
  storyCount: number;
}

export interface DiagnosticBundleBuildOptions {
  trigger?: DiagnosticBundleTrigger;
  appEnv?: Partial<DiagnosticAppEnvironment>;
  activeStory?: Story;
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
  return {
    hostKind,
    host,
    model: sanitizeModel(config.model, apiKey, trimmedUrl),
    memoryOnly: config.memoryOnly === true,
    hasApiKey: apiKey.length > 0,
    isDevProxy,
  };
}

function sanitizeModel(rawModel: unknown, apiKey: string, baseUrl: string): string {
  if (typeof rawModel !== 'string') return 'unset';
  const model = rawModel.trim();
  if (
    !model ||
    model.length > 128 ||
    /^(?:https?|ftp|file|data|blob|wss?):/i.test(model) ||
    !SAFE_MODEL_IDENTIFIER_REGEX.test(model)
  ) {
    return 'unset';
  }

  const normalized = model.toLowerCase();
  const components = normalized.split('/');
  const endpoint = readEndpointModelSecrets(baseUrl);
  const containsEndpointHost =
    endpoint.host &&
    (components.some((component) => component.split(':', 1)[0] === endpoint.host) ||
      (endpoint.host.length >= 4 && normalized.includes(endpoint.host)));
  if (
    (apiKey && normalized.includes(apiKey.toLowerCase())) ||
    components.some(isHostAlias) ||
    containsEndpointHost ||
    endpoint.values.some((value) => components.includes(value.toLowerCase())) ||
    /(?:api[_-]?key|secret|token|password|authorization|bearer)/i.test(model) ||
    /^(?:sk|rk|pk|key|token|secret)[_-]/i.test(model)
  ) {
    return 'unset';
  }
  return model;
}

function isHostAlias(value: string): boolean {
  const hostname = value.split(':', 1)[0]!;
  return (
    LOCAL_MODEL_ALIASES.has(hostname) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
    MODEL_HOSTNAME_REGEX.test(hostname)
  );
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
  // 2. Scrub sk-* keys
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]');
  // 3. Scrub key/token query or header assignments
  text = text.replace(
    /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s&"',;]+/gi,
    '$1=[REDACTED]',
  );
  // 4. Scrub URLs: keep official/local host or hashed relay_<8hex>, strip path/query/fragment/userinfo
  text = text.replace(/https?:\/\/[^\s"'`<>()]+/gi, (matchedUrl) => {
    const parsed = parseHostFromUrl(matchedUrl);
    if (!parsed) return '[REDACTED_URL]';
    const { host } = classifyAndRedactHost(parsed.host);
    return `${parsed.scheme}://${host || 'unknown'}`;
  });
  // 4b. Scrub attachment-like file names (keep only the extension) and bare hostnames / IPv4 literals
  text = text.replace(
    /[^\s"'`<>/\\:]*[^\s"'`<>/\\:.]\.(docx?|md|txt|pdf|zip|png|jpe?g|gif|webp|bmp|svg)\b/gi,
    (_m, ext: string) => `[file].${ext.toLowerCase()}`,
  );
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => classifyAndRedactHost(ip).host);
  text = text.replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi, (candidate) => {
    const lower = candidate.toLowerCase();
    if (BARE_DOMAIN_FILE_SUFFIXES.has(lower.slice(lower.lastIndexOf('.') + 1))) return candidate;
    return classifyAndRedactHost(lower).host;
  });
  // 5. Scrub local/device filesystem paths
  text = text.replace(/(?:file|content):\/\/[^\s"'`<>]+/gi, '[REDACTED_PATH]');
  text = text.replace(/(?:\/Users|\/home|\/var\/mobile|\/data\/user)\/[^\s"'`<>:]+/g, '[REDACTED_PATH]');
  text = text.replace(/[A-Za-z]:\\Users\\[^\s"'`<>:]+/gi, '[REDACTED_PATH]');

  if (text.length > maxLen) {
    return `${text.slice(0, maxLen)}…`;
  }
  return text;
}

function sanitizeMeta(
  meta?: Record<string, DiagnosticMetaValue>,
): Record<string, DiagnosticMetaValue> | undefined {
  if (!meta) return undefined;
  const out: Record<string, DiagnosticMetaValue> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_EVENT_METRICS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.round(v);
    } else if (typeof v === 'boolean') {
      out[k] = v;
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
  const durationMs = normalizeDurationMs(value.durationMs);
  const statusCode = normalizeStatusCode(value.statusCode);
  const stackTop = normalizeStackTop(value.stackTop);
  const sanitizedMessage = level === 'error'
    ? `${safeAction.replaceAll('_', ' ')}${statusCode === undefined ? '' : ` (HTTP ${statusCode})`}`
    : undefined;
  const meta = isRecord(value.meta)
    ? sanitizeMeta(value.meta as Record<string, DiagnosticMetaValue>)
    : undefined;

  return {
    ts,
    level: level as DiagnosticLevel,
    category: category as DiagnosticCategory,
    action: safeAction,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
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
  const viewport =
    typeof value?.viewport === 'string' && /^\d{1,5}x\d{1,5}$/.test(value.viewport)
      ? value.viewport
      : 'unknown';
  const activeView =
    value?.activeView === 'story' || value?.activeView === 'import' ? value.activeView : 'unknown';

  return {
    platform,
    appVersion,
    viewport,
    activeView,
    storyCount: normalizeCount(value?.storyCount),
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

  const loadFromStorage = (): void => {
    if (!options.storage) return;
    try {
      const raw = options.storage.getItem(DIAGNOSTIC_STORAGE_KEY);
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
    } catch {
      events = [];
      radars = [];
      persist();
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
      this.recordEvent({
        level: 'error',
        category: input.category,
        action: input.action,
        durationMs: input.durationMs,
        statusCode: input.statusCode ?? extractStatusCode(input.error),
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
      const activeStorySkeleton = bundleOptions.activeStory
        ? buildRedactedStorySkeleton(bundleOptions.activeStory)
        : undefined;
      return {
        schemaVersion: 1,
        generatedAt: new Date(currentTs).toISOString(),
        platform: options.platform,
        windowMinutes: 30,
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
            tsOffsetSec: Math.round((ts - currentTs) / 1000),
          })),
        ...(activeStorySkeleton ? { activeStorySkeleton } : {}),
      };
    },

    clear(): void {
      events = [];
      radars = [];
      try {
        options.storage?.removeItem(DIAGNOSTIC_STORAGE_KEY);
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
 * Wraps an LlmTransport so each stream records a zero-content breadcrumb (duration / status only).
 */
export function createDiagnosticTransport(
  inner: LlmTransport,
  collector: DiagnosticCollector,
  now: () => number = () => Date.now(),
): LlmTransport {
  return {
    async *streamChat(req) {
      const startedAt = now();
      let chunkCount = 0;
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
          meta: { chunks: chunkCount, messageCount: req.messages.length },
        });
      } catch (err) {
        const aborted = Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError');
        if (aborted) {
          collector.recordEvent({
            level: 'warn',
            category: 'llm',
            action: 'stream_aborted',
            durationMs: now() - startedAt,
          });
        } else {
          collector.recordError({
            category: 'llm',
            action: 'stream_error',
            error: err,
            durationMs: now() - startedAt,
            statusCode: extractStatusCode(err),
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
    getActiveStoryId: () => track('get_active_story_id', () => inner.getActiveStoryId()),
    setActiveStoryId: (id) => track('set_active_story_id', () => inner.setActiveStoryId(id)),
  };
}
