import { describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_DEV_PROXY_BALANCE_NOTICE,
  DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION,
  DEEPSEEK_OFFICIAL_TOP_UP_URL,
  createDiagnosticCollector,
  fetchDeepSeekBalance,
  formatDeepSeekBalances,
  parseDeepSeekBalanceResponse,
  recordBalanceCheckDiagnostic,
} from '../../src/harness/index.ts';

describe('DeepSeek official balance check & formatting (Issue #111)', () => {
  it('exports official top-up URL, declaration, and dev-proxy notice constants', () => {
    expect(DEEPSEEK_OFFICIAL_TOP_UP_URL).toBe('https://platform.deepseek.com/top_up');
    expect(DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION).toBe(
      '将跳转至 DeepSeek 开放平台官方充值页，与网页/App 端额度独立，本应用不经手支付',
    );
    expect(DEEPSEEK_DEV_PROXY_BALANCE_NOTICE).toBe(
      '当前为开发代理模式，不查询个人账户余额',
    );
  });

  it('parses single CNY/USD, multi-currency, empty array, and insufficient balance without topped_up/granted breakdown', () => {
    const cny = parseDeepSeekBalanceResponse({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '42.50',
          granted_balance: '10.00',
          topped_up_balance: '32.50',
        },
      ],
    });
    expect(cny).toEqual({
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '42.50' }],
      formattedBalance: '¥42.50',
    });
    expect(JSON.stringify(cny)).not.toContain('32.50');
    expect(JSON.stringify(cny)).not.toContain('10.00');
    expect(JSON.stringify(cny)).not.toContain('topped_up');
    expect(JSON.stringify(cny)).not.toContain('granted');

    const usd = parseDeepSeekBalanceResponse({
      is_available: true,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: '5.20',
          granted_balance: '1.20',
          topped_up_balance: '4.00',
        },
      ],
    });
    expect(usd).toEqual({
      isAvailable: true,
      balances: [{ currency: 'USD', totalBalance: '5.20' }],
      formattedBalance: '$5.20',
    });

    const multi = parseDeepSeekBalanceResponse({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' },
        { currency: 'USD', total_balance: '5.67', granted_balance: '0.00', topped_up_balance: '5.67' },
      ],
    });
    expect(multi).toEqual({
      isAvailable: true,
      balances: [
        { currency: 'CNY', totalBalance: '12.34' },
        { currency: 'USD', totalBalance: '5.67' },
      ],
      formattedBalance: '¥12.34 / $5.67',
    });

    const empty = parseDeepSeekBalanceResponse({
      is_available: false,
      balance_infos: [],
    });
    expect(empty).toEqual({
      isAvailable: false,
      balances: [],
      formattedBalance: '¥0.00',
    });

    expect(formatDeepSeekBalances([])).toBe('¥0.00');
    expect(parseDeepSeekBalanceResponse(null)).toBeNull();
    expect(parseDeepSeekBalanceResponse({ is_available: 'yes', balance_infos: [] })).toBeNull();
    expect(parseDeepSeekBalanceResponse({ is_available: true, balance_infos: [{ foo: 'bar' }] })).toBeNull();
  });

  it('calls GET /user/balance with Bearer key and classifies 401, 402/403, 5xx, timeout, network, parse, and aborted results', async () => {
    const fetchOk = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer sk-balance-123');
      expect(init.headers.Accept).toBe('application/json');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            is_available: false,
            balance_infos: [
              { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
            ],
          }),
      };
    });

    const okRes = await fetchDeepSeekBalance({
      apiKey: '  sk-balance-123\n',
      fetchImpl: fetchOk,
      now: () => 1000,
    });
    expect(okRes).toEqual({
      status: 'ok',
      isAvailable: false,
      balances: [{ currency: 'CNY', totalBalance: '0.00' }],
      formattedBalance: '¥0.00',
      durationMs: 0,
    });

    const emptyKeyFetch = vi.fn();
    const emptyKeyRes = await fetchDeepSeekBalance({
      apiKey: '   ',
      fetchImpl: emptyKeyFetch,
    });
    expect(emptyKeyRes.status).toBe('error');
    if (emptyKeyRes.status === 'error') {
      expect(emptyKeyRes.reason).toBe('invalid_key');
    }
    expect(emptyKeyFetch).not.toHaveBeenCalled();

    const res401 = await fetchDeepSeekBalance({
      apiKey: 'sk-bad-key',
      fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    expect(res401.status).toBe('error');
    if (res401.status === 'error') {
      expect(res401.reason).toBe('invalid_key');
      expect(res401.statusCode).toBe(401);
      expect(res401.message).toContain('API Key');
    }

    const res403 = await fetchDeepSeekBalance({
      apiKey: 'sk-blocked',
      fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    expect(res403.status).toBe('error');
    if (res403.status === 'error') {
      expect(res403.reason).toBe('quota_or_blocked');
      expect(res403.statusCode).toBe(403);
    }

    const res502 = await fetchDeepSeekBalance({
      apiKey: 'sk-valid',
      fetchImpl: async () => ({ ok: false, status: 502 }),
    });
    expect(res502.status).toBe('error');
    if (res502.status === 'error') {
      expect(res502.reason).toBe('server_error');
      expect(res502.statusCode).toBe(502);
      expect(res502.message).toContain('502');
    }

    const resTimeout = await fetchDeepSeekBalance({
      apiKey: 'sk-valid',
      fetchImpl: async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    expect(resTimeout.status).toBe('error');
    if (resTimeout.status === 'error') {
      expect(resTimeout.reason).toBe('timeout');
      expect(resTimeout.message).toContain('超时');
    }

    const resNet = await fetchDeepSeekBalance({
      apiKey: 'sk-valid',
      fetchImpl: async () => {
        throw new Error('Failed to fetch');
      },
    });
    expect(resNet.status).toBe('error');
    if (resNet.status === 'error') {
      expect(resNet.reason).toBe('network_error');
    }

    const resParse = await fetchDeepSeekBalance({
      apiKey: 'sk-valid',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => 'not-json',
      }),
    });
    expect(resParse.status).toBe('error');
    if (resParse.status === 'error') {
      expect(resParse.reason).toBe('parse_error');
    }

    const abortedRes = await fetchDeepSeekBalance({
      apiKey: 'sk-valid',
      signal: { aborted: true },
      fetchImpl: emptyKeyFetch,
    });
    expect(abortedRes.status).toBe('aborted');
    expect(emptyKeyFetch).not.toHaveBeenCalled();
  });

  it('records only sanitized balance check status and latency in diagnostics without amounts, currencies, or API keys', () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    const secretKey = 'sk-canary-balance-998877';

    recordBalanceCheckDiagnostic(collector, {
      status: 'ok',
      isAvailable: false,
      balances: [
        { currency: 'CNY', totalBalance: '123.45' },
        { currency: 'USD', totalBalance: '67.89' },
      ],
      formattedBalance: '¥123.45 / $67.89',
      durationMs: 184,
    });

    recordBalanceCheckDiagnostic(collector, {
      status: 'error',
      reason: 'invalid_key',
      statusCode: 401,
      message: `Unauthorized ${secretKey}`,
      durationMs: 92,
    });

    recordBalanceCheckDiagnostic(collector, {
      status: 'aborted',
      durationMs: 12,
    });

    const bundle = collector.buildBundle({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: secretKey,
      memoryOnly: false,
    });
    const json = JSON.stringify(bundle);

    expect(bundle.events).toHaveLength(2);
    expect(bundle.events[0]).toMatchObject({
      level: 'info',
      category: 'llm',
      action: 'balance_check_done',
      durationMs: 184,
    });
    expect(bundle.events[1]).toMatchObject({
      level: 'error',
      category: 'llm',
      action: 'balance_check_failed',
      statusCode: 401,
      durationMs: 92,
      meta: { reasonCode: 'invalid_key' },
    });

    for (const forbidden of ['123.45', '67.89', 'CNY', 'USD', '¥', '$', 'isAvailable', secretKey]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
