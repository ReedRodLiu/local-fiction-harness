import { describe, expect, it, vi } from 'vitest';
import {
  createCapacitorTextFetcher,
  type NativeHttpPluginLike,
} from '../../src/platform/capacitorHttpText.ts';

describe('Capacitor NativeHttp text fetcher', () => {
  it('forwards url, headers, maxBytes, timeoutMs and maps 2xx response to ok=true', async () => {
    const fetchText = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://example.com/final',
      text: 'Hello world',
      truncated: false,
    }));
    const plugin: NativeHttpPluginLike = { fetchText };
    const fetcher = createCapacitorTextFetcher(plugin);

    const result = await fetcher('https://example.com/start', {
      headers: { Accept: 'text/html' },
      maxBytes: 65536,
      timeoutMs: 5000,
    });

    expect(fetchText).toHaveBeenCalledWith({
      url: 'https://example.com/start',
      headers: { Accept: 'text/html' },
      maxBytes: 65536,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      finalUrl: 'https://example.com/final',
      text: 'Hello world',
      truncated: false,
    });
  });

  it('maps non-2xx status to ok=false and defaults missing text/truncated', async () => {
    const fetchText = vi.fn(async () => ({
      status: 404,
      finalUrl: 'https://example.com/missing',
    }));
    const fetcher = createCapacitorTextFetcher({ fetchText });

    const result = await fetcher('https://example.com/missing');

    expect(result).toEqual({
      ok: false,
      status: 404,
      finalUrl: 'https://example.com/missing',
      text: '',
      truncated: false,
    });
  });

  it('rejects with AbortError when signal is already aborted before plugin call', async () => {
    const fetchText = vi.fn(async () => ({ status: 200, text: 'ok' }));
    const fetcher = createCapacitorTextFetcher({ fetchText });
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetcher('https://example.com', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when signal aborts during plugin call', async () => {
    const controller = new AbortController();
    const fetchText = vi.fn(async () => {
      controller.abort();
      return { status: 200, text: 'late', truncated: true };
    });
    const fetcher = createCapacitorTextFetcher({ fetchText });

    await expect(
      fetcher('https://example.com', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});
