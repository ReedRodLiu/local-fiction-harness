import type { AbortSignalLike, FetchResponseLike } from './types.ts';

export const DEEPSEEK_OFFICIAL_KEYS_URL = 'https://platform.deepseek.com/api_keys';

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
