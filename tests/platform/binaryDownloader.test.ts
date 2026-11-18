import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createWebBinaryDownloader,
  validateHttpsZipUrl,
  hasZipMagicBytes,
  type BinaryFetchLike,
} from '../../src/harness/index.ts';
import { createWebPlatformRuntime } from '../../src/platform/webRuntime.ts';
import { createAndroidPlatformRuntime } from '../../src/platform/androidRuntime.ts';
import {
  createCapacitorBinaryDownloader,
  type NativeBinaryEventMap,
  type NativeBinaryPluginLike,
} from '../../src/platform/capacitorBinaryDownloader.ts';

function makeValidZipBytes(): Uint8Array {
  return zipSync({ 'manifest.json': strToU8('{"export_format_version":3}') });
}

describe('Slice 4 (#22): BinaryDownloader contracts (Web + Android Capacitor)', () => {
  it('validates HTTPS ZIP URLs and rejects HTTP, share links, and malformed URLs', () => {
    expect(() => validateHttpsZipUrl('')).toThrow(/https:\/\//);
    expect(() => validateHttpsZipUrl('http://cdn.deepseek.com/export.zip')).toThrow(/HTTPS/);
    expect(() => validateHttpsZipUrl('https://chat.deepseek.com/share/xyz123')).toThrow(
      /公开分享网页/,
    );
    expect(validateHttpsZipUrl('  https://cdn.deepseek.com/export.zip?token=1  ')).toBe(
      'https://cdn.deepseek.com/export.zip?token=1',
    );
    expect(hasZipMagicBytes(makeValidZipBytes())).toBe(true);
    expect(hasZipMagicBytes(strToU8('<html>login</html>'))).toBe(false);
  });

  it('enforces maxBytes streaming ceiling, PK magic check, HTTP 401/403, CORS fallback, and abort on Web', async () => {
    // 1. Oversized stream rejected mid-stream before full buffering
    const bigChunkFetch: BinaryFetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/zip' },
      body: (async function* () {
        yield new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
        yield new Uint8Array(100);
      })(),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const smallLimitDownloader = createWebBinaryDownloader(bigChunkFetch);
    await expect(
      smallLimitDownloader.downloadZipBytes('https://cdn.example/export.zip', 50),
    ).rejects.toThrow(/大小上限/);

    // 2. HTML login page rejected even on HTTP 200
    const htmlFetch: BinaryFetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html; charset=utf-8' },
      body: (async function* () {
        yield strToU8('<!DOCTYPE html><html><body>请登录</body></html>');
      })(),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      createWebBinaryDownloader(htmlFetch).downloadZipBytes('https://cdn.example/export.zip', 1024 * 1024),
    ).rejects.toThrow(/HTML|登录/);

    // 3. HTTP 403 -> clear Chinese guidance to download locally
    const forbiddenFetch: BinaryFetchLike = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => 'text/plain' },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      createWebBinaryDownloader(forbiddenFetch).downloadZipBytes('https://cdn.example/export.zip', 1024 * 1024),
    ).rejects.toThrow(/403|本地/);

    // 4. CORS TypeError -> clear Chinese guidance
    const corsFetch: BinaryFetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(
      createWebBinaryDownloader(corsFetch).downloadZipBytes('https://cdn.example/export.zip', 1024 * 1024),
    ).rejects.toThrow(/CORS|本地/);

    // 5. AbortSignal cancellation
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWebBinaryDownloader(bigChunkFetch).downloadZipBytes(
        'https://cdn.example/export.zip',
        1024 * 1024,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // 6. Valid ZIP bytes via createWebPlatformRuntime
    const validZip = makeValidZipBytes();
    const runtime = createWebPlatformRuntime({
      keyValueStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      binaryFetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/zip' },
        body: (async function* () {
          yield validZip.slice(0, 10);
          yield validZip.slice(10);
        })(),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });
    const res = await runtime.binaryDownloader.downloadZipBytes(
      'https://cdn.example/export.zip',
      1024 * 1024,
    );
    expect(res.bytes).toEqual(validZip);
    expect(res.contentType).toBe('application/zip');
  });

  it('streams base64 chunks through Capacitor BinaryDownloader bridge and supports abort', async () => {
    const validZip = makeValidZipBytes();
    const listeners: {
      [K in keyof NativeBinaryEventMap]?: Array<(ev: NativeBinaryEventMap[K]) => void>;
    } = {};

    const abortSpy = vi.fn(async ({ requestId }: { requestId: string }) => {
      for (const cb of listeners.binaryError ?? []) {
        cb({ requestId, message: '操作已中止。', aborted: true });
      }
    });

    const mockPlugin: NativeBinaryPluginLike = {
      async addListener(eventName, fn) {
        const list = (listeners[eventName] ??= []) as Array<(ev: NativeBinaryEventMap[typeof eventName]) => void>;
        list.push(fn);
        return {
          remove: async () => {
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
          },
        };
      },
      async startDownload({ requestId }) {
        queueMicrotask(() => {
          // Foreign requestId noise should be ignored
          for (const cb of listeners.binaryChunk ?? []) {
            cb({ requestId: 'other-req', chunkBase64: Buffer.from([1, 2, 3]).toString('base64') });
            cb({ requestId, chunkBase64: Buffer.from(validZip.slice(0, 12)).toString('base64') });
            cb({ requestId, chunkBase64: Buffer.from(validZip.slice(12)).toString('base64') });
          }
          for (const cb of listeners.binaryComplete ?? []) {
            cb({ requestId, contentType: 'application/zip' });
          }
        });
      },
      abortDownload: abortSpy,
    };

    let seq = 0;
    const downloader = createCapacitorBinaryDownloader(mockPlugin, () => `dl-${++seq}`);
    const runtime = createAndroidPlatformRuntime({ binaryDownloader: downloader });

    const downloaded = await runtime.binaryDownloader.downloadZipBytes(
      'https://cdn.deepseek.com/export.zip',
      1024 * 1024,
    );
    expect(downloaded.bytes).toEqual(validZip);
    expect(downloaded.contentType).toBe('application/zip');

    // Mid-flight abort
    const slowPlugin: NativeBinaryPluginLike = {
      ...mockPlugin,
      async startDownload() {
        // Hold open until aborted
      },
    };
    const controller = new AbortController();
    const slowDownloader = createCapacitorBinaryDownloader(slowPlugin, () => 'dl-abort');
    const pending = slowDownloader.downloadZipBytes(
      'https://cdn.deepseek.com/export.zip',
      1024 * 1024,
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 15));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortSpy).toHaveBeenCalledWith({ requestId: 'dl-abort' });
  });
});
