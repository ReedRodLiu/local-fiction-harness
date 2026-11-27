import { registerPlugin } from '@capacitor/core';
import type { PublicTextFetcher } from '../harness/index.ts';
import { createAbortError } from './nativeBridgeHelpers.ts';

export interface NativeHttpPluginLike {
  fetchText(options: {
    url: string;
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<{
    status: number;
    finalUrl?: string;
    text?: string;
    truncated?: boolean;
  }>;
}

const NativeHttp = registerPlugin<NativeHttpPluginLike>('NativeHttp');

/**
 * Adapts the Capacitor NativeHttp plugin into the shared PublicTextFetcher contract.
 * Enforces abort signal checks before and after the native bridge call.
 */
export function createCapacitorTextFetcher(
  plugin: NativeHttpPluginLike = NativeHttp,
): PublicTextFetcher {
  return async (url, options) => {
    if (options?.signal?.aborted) {
      throw createAbortError('已取消公开网页文本抓取。');
    }

    const res = await plugin.fetchText({
      url,
      headers: options?.headers,
      maxBytes: options?.maxBytes,
      timeoutMs: options?.timeoutMs,
    });

    if (options?.signal?.aborted) {
      throw createAbortError('已取消公开网页文本抓取。');
    }

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      finalUrl: res.finalUrl,
      text: res.text ?? '',
      truncated: Boolean(res.truncated),
    };
  };
}
