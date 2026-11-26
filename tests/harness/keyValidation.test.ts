import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  maskApiKey,
  normalizeOfficialModelConfig,
  normalizeProviderBaseUrl,
  probeAssistantPrefillCompatibility,
  sanitizeApiKeyInput,
  validateApiKeyFormat,
  validateProviderApiKeyFormat,
  verifyDeepSeekApiKey,
  verifyProviderConnection,
} from '../../src/harness/index.ts';

describe('DeepSeek official key validation & config normalization', () => {
  it('normalizes legacy model configs to official DeepSeek-Flash defaults', () => {
    expect(DEFAULT_MODEL_CONFIG).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      reasoningEffort: 'none',
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
      reasoningEffort: 'none',
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

describe('Generic OpenAI-compatible provider validation & prefill probing', () => {
  it('normalizes provider base URLs cleanly', () => {
    expect(normalizeProviderBaseUrl('  https://api.openai.com/v1/  ')).toBe('https://api.openai.com/v1');
    expect(normalizeProviderBaseUrl('https://api.openai.com/v1/chat/completions/')).toBe('https://api.openai.com/v1');
    expect(normalizeProviderBaseUrl('https://openrouter.ai/api/v1/models')).toBe('https://openrouter.ai/api/v1');
    expect(normalizeProviderBaseUrl(' /__dev_llm_proxy/ ')).toBe('/__dev_llm_proxy');
  });

  it('validates provider API keys with configurable sk- requirement and allowEmpty', () => {
    expect(validateProviderApiKeyFormat('')).toMatchObject({ ok: false });
    expect(validateProviderApiKeyFormat('', { allowEmpty: true })).toEqual({ ok: true, key: '' });
    expect(validateProviderApiKeyFormat('or-key-123')).toEqual({ ok: true, key: 'or-key-123' });
    expect(validateProviderApiKeyFormat('or-key-123', { requireSkPrefix: true })).toMatchObject({ ok: false });
    expect(validateProviderApiKeyFormat('sk-123456', { requireSkPrefix: true })).toEqual({ ok: true, key: 'sk-123456' });
    expect(validateProviderApiKeyFormat('密钥 key')).toMatchObject({ ok: false });
  });

  it('verifies provider connections, parses /models, omits Authorization for empty keys, and classifies errors', async () => {
    const fetchMock = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer or-custom-token');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }),
      };
    });

    const valid = await verifyProviderConnection({
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: ' or-custom-token ',
      fetchImpl: fetchMock,
    });
    expect(valid).toEqual({
      status: 'valid',
      key: 'or-custom-token',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini'],
    });

    const localNoKey = await verifyProviderConnection({
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: '',
      allowEmptyKey: true,
      fetchImpl: async (url, init) => {
        expect(url).toBe('http://localhost:11434/v1/models');
        expect(init.headers.Authorization).toBeUndefined();
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'llama3.2' }] }),
        };
      },
    });
    expect(localNoKey).toEqual({
      status: 'valid',
      key: '',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3.2'],
    });

    const badUrl = await verifyProviderConnection({
      baseUrl: 'ftp://invalid.local',
      apiKey: 'sk-123456',
      fetchImpl: fetchMock,
    });
    expect(badUrl.status).toBe('format_error');

    const res401 = await verifyProviderConnection({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'bad',
      fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    expect(res401.status).toBe('invalid_key');

    const res403 = await verifyProviderConnection({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    expect(res403.status).toBe('quota_or_blocked');

    const res404 = await verifyProviderConnection({
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'key',
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    expect(res404.status).toBe('models_unsupported');

    const res405 = await verifyProviderConnection({
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'key',
      fetchImpl: async () => ({ ok: false, status: 405 }),
    });
    expect(res405.status).toBe('models_unsupported');

    const webCors = await verifyProviderConnection({
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'key',
      isWebPlatform: true,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(webCors.status).toBe('network_error');
    if (webCors.status === 'network_error') {
      expect(webCors.message).toContain('跨域');
      expect(webCors.message).toContain('安卓 App');
    }
  });

  it('probes assistant prefill compatibility cleanly', async () => {
    const supported = await probeAssistantPrefillCompatibility({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://api.example.com/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body).toEqual({
          model: 'model-x',
          stream: false,
          max_tokens: 16,
          messages: [
            { role: 'user', content: '请接着下面半句话继续写几个字。' },
            { role: 'assistant', content: '窗外的雨' },
          ],
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ choices: [{ message: { content: '落了下来。' } }] }),
          body: null,
        };
      },
    });
    expect(supported).toEqual({
      supported: true,
      message: '当前服务商支持增强续写',
    });

    const emptyChoice = await probeAssistantPrefillCompatibility({
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'model-x',
      fetchImpl: async (_url, init) => {
        expect(init.headers.Authorization).toBeUndefined();
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
          body: null,
        };
      },
    });
    expect(emptyChoice).toEqual({
      supported: false,
      message: '当前服务商暂不支持增强续写，已保持通用稳定模式',
      statusCode: 200,
    });

    const rejected = await probeAssistantPrefillCompatibility({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'last message must be user',
        body: null,
      }),
    });
    expect(rejected).toEqual({
      supported: false,
      message: '当前服务商暂不支持增强续写，已保持通用稳定模式',
      statusCode: 400,
    });
  });
});
