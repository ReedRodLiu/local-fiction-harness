import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  maskApiKey,
  normalizeOfficialModelConfig,
  sanitizeApiKeyInput,
  validateApiKeyFormat,
  verifyDeepSeekApiKey,
} from '../../src/harness/index.ts';

describe('DeepSeek official key validation & config normalization', () => {
  it('normalizes legacy model configs to official DeepSeek-Flash defaults', () => {
    expect(DEFAULT_MODEL_CONFIG).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: '',
      memoryOnly: false,
    });

    const normalized = normalizeOfficialModelConfig({
      baseUrl: 'https://custom.proxy/v1',
      model: 'deepseek-chat',
      apiKey: '  sk-legacy-1234  ',
      memoryOnly: true,
    });

    expect(normalized).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: '',
      memoryOnly: false,
    });
    expect(normalizeOfficialModelConfig({ ...normalized, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-official' }).apiKey)
      .toBe('sk-official');
  });

  it('sanitizes, validates, and masks API keys', () => {
    expect(sanitizeApiKeyInput('  sk-abc\r\ndef  \n')).toBe('sk-abcdef');

    expect(validateApiKeyFormat('')).toEqual({
      ok: false,
      message: expect.stringContaining('请先粘贴或输入'),
    });
    expect(validateApiKeyFormat('我的钥匙sk-123456')).toEqual({
      ok: false,
      message: expect.stringContaining('空格或中文字符'),
    });
    expect(validateApiKeyFormat('key-123456')).toEqual({
      ok: false,
      message: expect.stringContaining('sk-'),
    });
    expect(validateApiKeyFormat('  sk-valid123\n')).toEqual({
      ok: true,
      key: 'sk-valid123',
    });

    expect(maskApiKey('')).toBe('');
    expect(maskApiKey('sk-123')).toBe('••••');
    expect(maskApiKey('sk-abcdef1234')).toBe('sk-••••1234');
  });

  it('verifies valid keys via zero-token GET /models and skips fetch on format errors', async () => {
    const fetchMock = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      expect(url).toBe('https://api.deepseek.com/models');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer sk-good-key-123');
      return { ok: true, status: 200 };
    });

    const formatFail = await verifyDeepSeekApiKey({
      apiKey: 'not-a-key',
      fetchImpl: fetchMock,
    });
    expect(formatFail.status).toBe('format_error');
    expect(fetchMock).not.toHaveBeenCalled();

    const validRes = await verifyDeepSeekApiKey({
      apiKey: ' sk-good-key-123\n',
      fetchImpl: fetchMock,
    });
    expect(validRes).toEqual({ status: 'valid', key: 'sk-good-key-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies 401, 402/403, 5xx, network errors, and timeouts cleanly', async () => {
    const res401 = await verifyDeepSeekApiKey({
      apiKey: 'sk-bad-key-123',
      fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    expect(res401.status).toBe('invalid_key');

    const res402 = await verifyDeepSeekApiKey({
      apiKey: 'sk-empty-quota',
      fetchImpl: async () => ({ ok: false, status: 402 }),
    });
    expect(res402.status).toBe('quota_or_blocked');

    const res503 = await verifyDeepSeekApiKey({
      apiKey: 'sk-valid-key-123',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    expect(res503.status).toBe('network_error');

    const resThrow = await verifyDeepSeekApiKey({
      apiKey: 'sk-valid-key-123',
      fetchImpl: async () => {
        throw new Error('Failed to fetch');
      },
    });
    expect(resThrow.status).toBe('network_error');

    const resAbort = await verifyDeepSeekApiKey({
      apiKey: 'sk-valid-key-123',
      fetchImpl: async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    expect(resAbort.status).toBe('network_error');
    if (resAbort.status === 'network_error') {
      expect(resAbort.message).toContain('超时');
    }
  });
});
