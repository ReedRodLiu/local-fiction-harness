import type { DiagnosticCollector } from './diagnostics.ts';
import type { AbortSignalLike, FetchResponseLike } from './types.ts';

export const DEEPSEEK_OFFICIAL_KEYS_URL = 'https://platform.deepseek.com/api_keys';
export const DEEPSEEK_OFFICIAL_TOP_UP_URL = 'https://platform.deepseek.com/top_up';
export const DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION =
  '将跳转至 DeepSeek 开放平台官方充值页，与网页/App 端额度独立，本应用不经手支付';
export const DEEPSEEK_DEV_PROXY_BALANCE_NOTICE =
  '当前为开发代理模式，不查询个人账户余额';

export type KeyVerificationFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignalLike;
  },
) => Promise<Pick<FetchResponseLike, 'ok' | 'status'>>;

export type KeyVerificationResult =
  | { status: 'valid'; key: string }
  | { status: 'format_error'; message: string }
  | { status: 'invalid_key'; message: string }
  | { status: 'quota_or_blocked'; message: string }
  | { status: 'network_error'; message: string };

export type KeyFormatCheckResult =
  | { ok: true; key: string }
  | { ok: false; message: string };

interface GlobalTimerHost {
  fetch?: KeyVerificationFetchLike;
  AbortController?: new () => AbortControllerLike;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

interface AbortControllerLike {
  signal: AbortSignalLike;
  abort(): void;
}

/**
 * Strips leading/trailing whitespace and embedded newlines from pasted API keys.
 */
export function sanitizeApiKeyInput(raw: string): string {
  return raw.replace(/[\r\n]+/g, '').trim();
}

/**
 * Performs local pre-flight format checks on a DeepSeek API key before hitting the network.
 */
export function validateApiKeyFormat(raw: string): KeyFormatCheckResult {
  const key = sanitizeApiKeyInput(raw);
  if (!key) {
    return { ok: false, message: '请先粘贴或输入你的 DeepSeek API Key。' };
  }
  if (/[\s\u4e00-\u9fff]/.test(key)) {
    return {
      ok: false,
      message: '这串 Key 包含空格或中文字符，请确认复制完整，不要复制成钥匙名称。',
    };
  }
  if (!key.startsWith('sk-') || key.length < 6) {
    return {
      ok: false,
      message: '这串 Key 好像不对，DeepSeek 的密钥通常以 sk- 开头，请确认复制完整。',
    };
  }
  return { ok: true, key };
}

/**
 * Masks an API key for display in the connected status card (e.g. sk-••••1234).
 */
export function maskApiKey(apiKey: string): string {
  const cleaned = sanitizeApiKeyInput(apiKey);
  if (!cleaned) return '';
  if (cleaned.length <= 6) {
    return '••••';
  }
  const prefix = cleaned.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}••••${cleaned.slice(-4)}`;
}

/**
 * Verifies a DeepSeek API key with a zero-token GET /models request and translates
 * failures into plain-language guidance.
 */
export async function verifyDeepSeekApiKey(options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: KeyVerificationFetchLike;
  timeoutMs?: number;
}): Promise<KeyVerificationResult> {
  const format = validateApiKeyFormat(options.apiKey);
  if (!format.ok) {
    return { status: 'format_error', message: format.message };
  }

  const host = globalThis as unknown as GlobalTimerHost;
  const fetchFn = options.fetchImpl ?? host.fetch;
  if (!fetchFn) {
    return {
      status: 'network_error',
      message: '当前环境不支持网络验证，可点击「先保存，稍后再试」。',
    };
  }

  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = host.AbortController ? new host.AbortController() : undefined;
  const timer =
    controller && host.setTimeout
      ? host.setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  try {
    const res = await fetchFn(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${format.key}`,
        Accept: 'application/json',
      },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (res.ok) {
      return { status: 'valid', key: format.key };
    }
    if (res.status === 401) {
      return {
        status: 'invalid_key',
        message: '这串 Key 好像不对或已失效，请确认复制完整，不要复制成钥匙名称。',
      };
    }
    if (res.status === 402 || res.status === 403) {
      return {
        status: 'quota_or_blocked',
        message: '当前账户额度不足或密钥权限受限，请前往 DeepSeek 开放平台查看。',
      };
    }
    return {
      status: 'network_error',
      message: `DeepSeek 服务暂时不可用（状态码 ${res.status}），可点击「先保存，稍后再试」。`,
    };
  } catch (err) {
    const isAbort =
      typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      (err as { name?: unknown }).name === 'AbortError';
    return {
      status: 'network_error',
      message: isAbort
        ? '连接 DeepSeek 超时，请检查手机网络后重试，或点击「先保存，稍后再试」。'
        : '暂时无法连接 DeepSeek，请检查手机网络后重试，或点击「先保存，稍后再试」。',
    };
  } finally {
    if (timer !== undefined && host.clearTimeout) {
      host.clearTimeout(timer);
    }
  }
}

export interface BalanceFetchResponseLike {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export type BalanceFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignalLike;
  },
) => Promise<BalanceFetchResponseLike>;

export interface DeepSeekCurrencyBalance {
  currency: string;
  totalBalance: string;
}

export interface ParsedDeepSeekBalance {
  isAvailable: boolean;
  balances: DeepSeekCurrencyBalance[];
  formattedBalance: string;
}

export type DeepSeekBalanceErrorReason =
  | 'invalid_key'
  | 'quota_or_blocked'
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'http_error'
  | 'network_error'
  | 'parse_error';

export type DeepSeekBalanceResult =
  | ({
      status: 'ok';
      durationMs: number;
    } & ParsedDeepSeekBalance)
  | {
      status: 'error';
      reason: DeepSeekBalanceErrorReason;
      message: string;
      statusCode?: number;
      durationMs: number;
    }
  | {
      status: 'aborted';
      durationMs: number;
    };

interface ListenableAbortSignalLike extends AbortSignalLike {
  addEventListener?: (type: 'abort', listener: () => void) => void;
  removeEventListener?: (type: 'abort', listener: () => void) => void;
}

interface GlobalBalanceHost extends Omit<GlobalTimerHost, 'fetch'> {
  fetch?: BalanceFetchLike;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatSingleCurrencyBalance(currency: string, totalBalance: string): string {
  const normalized = currency.trim().toUpperCase();
  if (normalized === 'CNY') return `¥${totalBalance}`;
  if (normalized === 'USD') return `$${totalBalance}`;
  return `${normalized} ${totalBalance}`;
}

/**
 * Formats parsed currency total balances for display (empty array -> ¥0.00).
 * Never exposes topped_up or granted breakdown.
 */
export function formatDeepSeekBalances(balances: readonly DeepSeekCurrencyBalance[]): string {
  if (balances.length === 0) return '¥0.00';
  return balances
    .map((entry) => formatSingleCurrencyBalance(entry.currency, entry.totalBalance))
    .join(' / ');
}

/**
 * Parses a DeepSeek GET /user/balance payload, keeping only is_available and total_balance per currency.
 */
export function parseDeepSeekBalanceResponse(payload: unknown): ParsedDeepSeekBalance | null {
  if (!isPlainRecord(payload)) return null;
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    return null;
  }

  const balances: DeepSeekCurrencyBalance[] = [];
  for (const rawEntry of payload.balance_infos) {
    if (!isPlainRecord(rawEntry)) continue;
    const rawCurrency = typeof rawEntry.currency === 'string' ? rawEntry.currency.trim().toUpperCase() : '';
    let totalBalance = '';
    if (typeof rawEntry.total_balance === 'string') {
      totalBalance = rawEntry.total_balance.trim();
    } else if (typeof rawEntry.total_balance === 'number' && Number.isFinite(rawEntry.total_balance)) {
      totalBalance = rawEntry.total_balance.toFixed(2);
    }
    if (!rawCurrency || !totalBalance) continue;
    balances.push({ currency: rawCurrency, totalBalance });
  }

  if (payload.balance_infos.length > 0 && balances.length === 0) {
    return null;
  }

  return {
    isAvailable: payload.is_available,
    balances,
    formattedBalance: formatDeepSeekBalances(balances),
  };
}

/**
 * Queries DeepSeek official GET /user/balance (zero token consumption) with timeout & abort support.
 */
export async function fetchDeepSeekBalance(options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: BalanceFetchLike;
  timeoutMs?: number;
  signal?: AbortSignalLike;
  now?: () => number;
}): Promise<DeepSeekBalanceResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));

  const externalSignal = options.signal as ListenableAbortSignalLike | undefined;
  if (externalSignal?.aborted) {
    return { status: 'aborted', durationMs: 0 };
  }

  const cleanedKey = sanitizeApiKeyInput(options.apiKey);
  if (!cleanedKey) {
    return {
      status: 'error',
      reason: 'invalid_key',
      message: '未检测到有效 API Key，请重新连接后再试。',
      durationMs: 0,
    };
  }

  const host = globalThis as unknown as GlobalBalanceHost;
  const fetchFn = options.fetchImpl ?? host.fetch;
  if (!fetchFn) {
    return {
      status: 'error',
      reason: 'network_error',
      message: '当前环境不支持网络查询，请稍后重试。',
      durationMs: 0,
    };
  }

  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = host.AbortController ? new host.AbortController() : undefined;
  let timedOut = false;
  let externalAborted = false;

  const onExternalAbort = () => {
    externalAborted = true;
    controller?.abort();
  };
  if (externalSignal?.addEventListener) {
    externalSignal.addEventListener('abort', onExternalAbort);
  }

  const timer =
    controller && host.setTimeout
      ? host.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  try {
    const res = await fetchFn(`${baseUrl}/user/balance`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cleanedKey}`,
        Accept: 'application/json',
      },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (externalAborted || externalSignal?.aborted) {
      return { status: 'aborted', durationMs: elapsedMs() };
    }

    if (res.status === 401) {
      return {
        status: 'error',
        reason: 'invalid_key',
        statusCode: 401,
        message: 'API Key 无效或已失效，请更换密钥后重试。',
        durationMs: elapsedMs(),
      };
    }

    if (res.status === 402 || res.status === 403) {
      return {
        status: 'error',
        reason: 'quota_or_blocked',
        statusCode: res.status,
        message: '当前账户权限受限或暂时无法查询余额，请前往 DeepSeek 开放平台查看。',
        durationMs: elapsedMs(),
      };
    }

    if (!res.ok) {
      if (res.status === 429) {
        return {
          status: 'error',
          reason: 'rate_limit',
          statusCode: 429,
          message: '查询过于频繁，请稍后重试。',
          durationMs: elapsedMs(),
        };
      }
      if (res.status >= 500) {
        return {
          status: 'error',
          reason: 'server_error',
          statusCode: res.status,
          message: `DeepSeek 服务暂时不可用（状态码 ${res.status}），请稍后重试。`,
          durationMs: elapsedMs(),
        };
      }
      return {
        status: 'error',
        reason: 'http_error',
        statusCode: res.status,
        message: `暂时无法获取余额信息（状态码 ${res.status}），请稍后重试。`,
        durationMs: elapsedMs(),
      };
    }

    let payload: unknown;
    try {
      if (typeof res.text === 'function') {
        payload = JSON.parse(await res.text());
      } else if (typeof res.json === 'function') {
        payload = await res.json();
      } else {
        payload = null;
      }
    } catch {
      return {
        status: 'error',
        reason: 'parse_error',
        statusCode: res.status,
        message: '余额数据格式异常，请稍后重试。',
        durationMs: elapsedMs(),
      };
    }

    const parsed = parseDeepSeekBalanceResponse(payload);
    if (!parsed) {
      return {
        status: 'error',
        reason: 'parse_error',
        statusCode: res.status,
        message: '余额数据格式异常，请稍后重试。',
        durationMs: elapsedMs(),
      };
    }

    return {
      status: 'ok',
      ...parsed,
      durationMs: elapsedMs(),
    };
  } catch (err) {
    if (externalAborted || externalSignal?.aborted) {
      return { status: 'aborted', durationMs: elapsedMs() };
    }
    const isAbort =
      timedOut ||
      (typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        (err as { name?: unknown }).name === 'AbortError');
    if (isAbort) {
      return {
        status: 'error',
        reason: 'timeout',
        message: '查询余额超时，请检查网络后重试。',
        durationMs: elapsedMs(),
      };
    }
    return {
      status: 'error',
      reason: 'network_error',
      message: '暂时无法连接 DeepSeek，请检查网络后重试。',
      durationMs: elapsedMs(),
    };
  } finally {
    if (timer !== undefined && host.clearTimeout) {
      host.clearTimeout(timer);
    }
    if (externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Records strictly sanitized balance-check outcome & latency (never amounts, currencies, or keys).
 */
export function recordBalanceCheckDiagnostic(
  collector: Pick<DiagnosticCollector, 'recordEvent'>,
  result: DeepSeekBalanceResult,
): void {
  if (result.status === 'aborted') return;
  try {
    if (result.status === 'ok') {
      collector.recordEvent({
        level: 'info',
        category: 'llm',
        action: 'balance_check_done',
        durationMs: result.durationMs,
      });
      return;
    }
    collector.recordEvent({
      level: 'error',
      category: 'llm',
      action: 'balance_check_failed',
      durationMs: result.durationMs,
      statusCode: result.statusCode,
      meta: { reasonCode: result.reason },
    });
  } catch {
    // Never break UI flows due to diagnostics recording.
  }
}
