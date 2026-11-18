import type {
  AbortSignalLike,
  BinaryDownloadResult,
  BinaryDownloader,
  BinaryFetchLike,
  BinaryFetchResponseLike,
} from './types.ts';

export const DEFAULT_ZIP_MAX_BYTES = 100 * 1024 * 1024;

const SHARE_PAGE_PATTERN = /^https:\/\/chat\.deepseek\.com\/share(?:\/|$|\?)/i;

function makeAbortError(message = '已取消拉取导出压缩包。'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortErr(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError');
}

/**
 * Validates that a user-supplied DeepSeek export download URL uses strict HTTPS
 * and does not point to an unsupported public HTML share page.
 */
export function validateHttpsZipUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('请先粘贴以 https:// 开头的 DeepSeek 导出 .zip 下载链接。');
  }
  if (!/^https:\/\/[^\s]+/i.test(trimmed)) {
    throw new Error('仅支持安全的 HTTPS（https://）下载链接；请核对链接或改用本地 .zip 文件导入。');
  }
  if (SHARE_PAGE_PATTERN.test(trimmed)) {
    throw new Error(
      '检测到 DeepSeek 公开分享网页链接，暂不支持爬取分享页面；请在 DeepSeek「设置 → 数据管理」导出完整数据后粘贴 .zip 下载链接，或选择本地 .zip 文件导入。',
    );
  }
  return trimmed;
}

/**
 * Verifies the leading ZIP local-file-header magic bytes (`PK`).
 */
export function hasZipMagicBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeHtml(bytes: Uint8Array, contentType?: string): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) {
    return true;
  }
  if (bytes.byteLength === 0) return false;
  let head = '';
  const limit = Math.min(bytes.byteLength, 32);
  for (let i = 0; i < limit; i += 1) {
    head += String.fromCharCode(bytes[i]);
  }
  return /^\s*<(?:!doctype|html|head|body)/i.test(head);
}

/**
 * Validates downloaded archive bytes against the size ceiling and ZIP magic header.
 */
export function validateDownloadedZipBytes(
  bytes: Uint8Array,
  maxBytes: number,
  contentType?: string,
): void {
  if (bytes.byteLength > maxBytes) {
    throw new Error(`导出压缩包体积超出安全大小上限（${Math.round(maxBytes / (1024 * 1024))} MB），已中止下载以防内存溢出。`);
  }
  if (!hasZipMagicBytes(bytes)) {
    if (looksLikeHtml(bytes, contentType)) {
      throw new Error(
        '链接返回了 HTML 登录/错误页面而非 .zip 压缩包（可能需要网页登录态或链接已过期），请先在浏览器打开链接下载 .zip 后改用本地文件导入。',
      );
    }
    throw new Error(
      '下载的内容不是有效的 .zip 压缩包（缺少 PK 魔数头），请检查链接或改用本地 .zip 文件导入。',
    );
  }
}

function concatByteChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function* iterateResponseBody(
  body: NonNullable<BinaryFetchResponseLike['body']>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (
    body as {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        releaseLock(): void;
      };
    }
  ).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readStreamWithLimit(
  response: BinaryFetchResponseLike,
  maxBytes: number,
  contentType: string | undefined,
  signal?: AbortSignalLike,
): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    validateDownloadedZipBytes(buf, maxBytes, contentType);
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let checkedHeader = false;

  for await (const chunk of iterateResponseBody(response.body)) {
    if (signal?.aborted) {
      throw makeAbortError();
    }
    if (chunk.byteLength === 0) continue;
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(
        `导出压缩包体积超出安全大小上限（${Math.round(maxBytes / (1024 * 1024))} MB），已中止拉取。`,
      );
    }
    chunks.push(chunk);
    if (!checkedHeader && totalBytes >= 4) {
      checkedHeader = true;
      const prefix = concatByteChunks(chunks, totalBytes);
      if (!hasZipMagicBytes(prefix)) {
        validateDownloadedZipBytes(prefix, maxBytes, contentType);
      }
    }
  }

  const merged = concatByteChunks(chunks, totalBytes);
  validateDownloadedZipBytes(merged, maxBytes, contentType);
  return merged;
}

/**
 * Creates a pure-TS Web BinaryDownloader over a Fetch-compatible GET function.
 * Enforces HTTPS, streaming maxBytes limits, ZIP magic bytes, and friendly CORS/auth guidance.
 */
export function createWebBinaryDownloader(fetchBinary: BinaryFetchLike): BinaryDownloader {
  return {
    async downloadZipBytes(
      rawUrl: string,
      maxBytes: number,
      signal?: AbortSignalLike,
    ): Promise<BinaryDownloadResult> {
      const url = validateHttpsZipUrl(rawUrl);
      if (signal?.aborted) {
        throw makeAbortError();
      }

      let response: BinaryFetchResponseLike;
      try {
        response = await fetchBinary(url, { method: 'GET', signal });
      } catch (err) {
        if (isAbortErr(err) || signal?.aborted) {
          throw makeAbortError();
        }
        throw new Error(
          '浏览器跨域（CORS）或网络拦截导致无法直接拉取该链接，请先在浏览器下载 .zip 文件后再选择本地文件导入。',
        );
      }

      if (signal?.aborted) {
        throw makeAbortError();
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `导出链接需要登录态或已失效（HTTP ${response.status}），请先在浏览器下载 .zip 后改用本地文件导入。`,
          );
        }
        throw new Error(
          `拉取导出压缩包失败（HTTP ${response.status} ${response.statusText}），请改用本地 .zip 文件导入。`,
        );
      }

      const contentType = response.headers?.get('content-type') ?? undefined;
      const contentLenHeader = response.headers?.get('content-length');
      if (contentLenHeader) {
        const declared = Number(contentLenHeader);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Error(
            `响应声明体积超出安全大小上限（${Math.round(maxBytes / (1024 * 1024))} MB），已拒绝下载。`,
          );
        }
      }

      const bytes = await readStreamWithLimit(response, maxBytes, contentType, signal);
      return { bytes, contentType };
    },
  };
}
