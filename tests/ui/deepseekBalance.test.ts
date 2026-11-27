import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  DEEPSEEK_DEV_PROXY_BALANCE_NOTICE,
  DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION,
  DEEPSEEK_OFFICIAL_TOP_UP_URL,
  createDiagnosticCollector,
  type BalanceFetchLike,
} from '../../src/harness/index.ts';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';
import {
  createDeepSeekBalanceController,
  type SettingsBalanceState,
} from '../../src/ui/useDeepSeekBalance.ts';

function renderSettings(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsPage, {
      appVersion: '0.2.0',
      hasCredentials: true,
      config: { ...DEFAULT_MODEL_CONFIG, apiKey: 'sk-1234567890abcd' },
      useDevEnvKey: false,
      showDevTestProxy: false,
      themePreference: 'system',
      fontSize: 16,
      canExportCurrentStory: false,
      currentStoryTitle: '',
      onBack: vi.fn(),
      onOpenSetupWizard: vi.fn(),
      onClearSavedKey: vi.fn(),
      onApplyDevTestConfig: vi.fn(),
      onOpenDiagnostics: vi.fn(),
      onOpenPublicMemory: vi.fn(),
      onExportCurrentStory: vi.fn(),
      onImportBackupFile: vi.fn(),
      onThemePreferenceChange: vi.fn(),
      onFontSizeChange: vi.fn(),
      ...overrides,
    }),
  );
}

describe('Issue #111 Slice 3: memory-only DeepSeek balance controller', () => {
  it('auto-fetches on entering Settings, prevents concurrent double-clicks, and records sanitized diagnostics', async () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    let resolveFirst!: (value: { ok: boolean; status: number; text: () => Promise<string> }) => void;
    let callCount = 0;

    const fetchMock = vi.fn<BalanceFetchLike>(async () => {
      callCount += 1;
      if (callCount === 1) {
        return await new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            is_available: true,
            balance_infos: [
              { currency: 'CNY', total_balance: '88.80', topped_up_balance: '80.00', granted_balance: '8.80' },
            ],
          }),
      };
    });

    const states: string[] = [];
    const controller = createDeepSeekBalanceController({
      fetchImpl: fetchMock,
      diagnostics: collector,
      onStateChange: (next) => states.push(next.status),
    });

    expect(controller.getState()).toEqual({ status: 'idle' });

    // 1. Entering Settings with valid key triggers auto-check once
    const firstSync = controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-user-secret-001',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 0,
    });
    expect(controller.getState().status).toBe('loading');

    // 2. Concurrent refresh / double-click while loading must be ignored
    const duplicateClick = controller.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          is_available: false,
          balance_infos: [
            { currency: 'CNY', total_balance: '1.50', topped_up_balance: '1.50', granted_balance: '0.00' },
          ],
        }),
    });
    await firstSync;
    await duplicateClick;

    expect(controller.getState()).toEqual({
      status: 'loaded',
      isAvailable: false,
      balances: [{ currency: 'CNY', totalBalance: '1.50' }],
      formattedBalance: '¥1.50',
    });

    // 3. Unrelated re-sync with same active/key does NOT trigger extra network fetch
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-user-secret-001',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 4. Manual refresh keeps previous balance while loading and updates on resolve
    await controller.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({
      status: 'loaded',
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '88.80' }],
      formattedBalance: '¥88.80',
    });

    // 5. Diagnostics bundle contains ONLY status/latency, never amounts, currencies, or keys
    const bundleJson = JSON.stringify(
      collector.buildBundle({
        ...DEFAULT_MODEL_CONFIG,
        apiKey: 'sk-user-secret-001',
      }),
    );
    expect(bundleJson).toContain('balance_check_done');
    for (const secret of ['1.50', '88.80', '80.00', '8.80', 'CNY', '¥', 'sk-user-secret-001']) {
      expect(bundleJson).not.toContain(secret);
    }
    expect(states).toEqual(['loading', 'loaded', 'loading', 'loaded']);
  });

  it('skips /user/balance when useDevEnvKey is true and resets memory state on disconnect', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ is_available: true, balance_infos: [] }),
    }));
    const controller = createDeepSeekBalanceController({ fetchImpl: fetchMock });

    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: true,
      apiKey: '',
      baseUrl: '/__dev_llm_proxy',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: 'idle' });

    await controller.refresh();
    expect(fetchMock).not.toHaveBeenCalled();

    // Load real balance then disconnect -> must wipe balance from memory
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-real-key',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(controller.getState().status).toBe('loaded');

    await controller.sync({
      active: true,
      hasCredentials: false,
      useDevEnvKey: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(controller.getState()).toEqual({ status: 'idle' });
  });

  it('never calls /user/balance and resets to idle when supportsBalanceQuery is false or baseUrl is third-party', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ is_available: true, balance_infos: [] }),
    }));
    const controller = createDeepSeekBalanceController({ fetchImpl: fetchMock });

    // Load DeepSeek balance first
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-ds-key',
      baseUrl: 'https://api.deepseek.com',
      supportsBalanceQuery: true,
    });
    expect(controller.getState().status).toBe('loaded');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Switching to third-party with supportsBalanceQuery: false must reset to idle and never fetch
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-openai-key',
      baseUrl: 'https://api.openai.com/v1',
      supportsBalanceQuery: false,
    });
    expect(controller.getState()).toEqual({ status: 'idle' });
    await controller.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Omitting supportsBalanceQuery with a non-DeepSeek URL must also skip /user/balance
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-custom-key',
      baseUrl: 'https://relay.example.com/v1',
    });
    expect(controller.getState()).toEqual({ status: 'idle' });
    await controller.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auto-checks after binding a new key via wizard and supports retry after 401/5xx/timeout', async () => {
    let attempt = 0;
    const fetchMock = vi.fn<BalanceFetchLike>(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 401 };
      }
      if (attempt === 2) {
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'USD', total_balance: '12.00' }],
          }),
      };
    });

    const controller = createDeepSeekBalanceController({ fetchImpl: fetchMock });

    // Initial auto-check fails with 401
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-expired',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 0,
    });
    expect(controller.getState()).toMatchObject({
      status: 'error',
      reason: 'invalid_key',
    });

    // Retry fails with 503
    await controller.refresh();
    expect(controller.getState()).toMatchObject({
      status: 'error',
      reason: 'server_error',
    });

    // Binding new key (even same string or new key) triggers auto-check and succeeds
    await controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-fresh-key',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 1,
    });
    expect(controller.getState()).toEqual({
      status: 'loaded',
      isAvailable: true,
      balances: [{ currency: 'USD', totalBalance: '12.00' }],
      formattedBalance: '$12.00',
    });
  });

  it('aborts stale in-flight request when key changes or Settings closes', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<() => void> = [];

    const fetchMock: BalanceFetchLike = vi.fn(async (_url, init) => {
      signals.push(init.signal as AbortSignal);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      if (init.signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '99.00' }],
          }),
      };
    });

    const controller = createDeepSeekBalanceController({ fetchImpl: fetchMock });
    const p1 = controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-first',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 0,
    });

    // Key changes while first request is still pending
    const p2 = controller.sync({
      active: true,
      hasCredentials: true,
      useDevEnvKey: false,
      apiKey: 'sk-second',
      baseUrl: 'https://api.deepseek.com',
      keyBoundSeq: 1,
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    resolvers[0]?.();
    resolvers[1]?.();
    await Promise.all([p1, p2]);

    expect(controller.getState()).toMatchObject({
      status: 'loaded',
      formattedBalance: '¥99.00',
    });
  });
});

describe('Issue #111 Slice 4: SettingsPage balance & official top-up UI states', () => {
  it('hides balance panel and top-up link when unconnected', () => {
    const markup = renderSettings({
      hasCredentials: false,
      config: DEFAULT_MODEL_CONFIG,
    });
    expect(markup).not.toContain('data-testid="deepseek-balance-panel"');
    expect(markup).not.toContain('data-testid="deepseek-balance-dev-proxy-note"');
    expect(markup).not.toContain('data-testid="deepseek-topup-link"');
    expect(markup).not.toContain(DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION);
  });

  it('shows dev-proxy notice and skips balance panel when useDevEnvKey is true', () => {
    const markup = renderSettings({
      hasCredentials: true,
      useDevEnvKey: true,
      config: { ...DEFAULT_MODEL_CONFIG, baseUrl: '/__dev_llm_proxy', apiKey: '' },
    });
    expect(markup).toContain('data-testid="deepseek-balance-dev-proxy-note"');
    expect(markup).toContain(DEEPSEEK_DEV_PROXY_BALANCE_NOTICE);
    expect(markup).not.toContain('data-testid="refresh-balance-btn"');
    expect(markup).toContain('data-testid="deepseek-topup-link"');
    expect(markup).toContain(`href="${DEEPSEEK_OFFICIAL_TOP_UP_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION);
  });

  it('renders single CNY/USD, multi-currency, empty ¥0.00, and 余额不足 badge without breakdown', () => {
    const cases: Array<{ state: SettingsBalanceState; expectedText: string; insufficient: boolean }> = [
      {
        state: {
          status: 'loaded',
          isAvailable: true,
          balances: [{ currency: 'CNY', totalBalance: '42.50' }],
          formattedBalance: '¥42.50',
        },
        expectedText: '¥42.50',
        insufficient: false,
      },
      {
        state: {
          status: 'loaded',
          isAvailable: true,
          balances: [{ currency: 'USD', totalBalance: '5.20' }],
          formattedBalance: '$5.20',
        },
        expectedText: '$5.20',
        insufficient: false,
      },
      {
        state: {
          status: 'loaded',
          isAvailable: true,
          balances: [
            { currency: 'CNY', totalBalance: '12.34' },
            { currency: 'USD', totalBalance: '5.67' },
          ],
          formattedBalance: '¥12.34 / $5.67',
        },
        expectedText: '¥12.34 / $5.67',
        insufficient: false,
      },
      {
        state: {
          status: 'loaded',
          isAvailable: false,
          balances: [],
          formattedBalance: '¥0.00',
        },
        expectedText: '¥0.00',
        insufficient: true,
      },
    ];

    for (const item of cases) {
      const markup = renderSettings({ balanceState: item.state });
      expect(markup).toContain('data-testid="deepseek-balance-panel"');
      expect(markup).toContain('data-testid="deepseek-balance-value"');
      expect(markup).toContain(item.expectedText);
      expect(markup).toContain('data-testid="refresh-balance-btn"');
      expect(markup).toContain('刷新');
      expect(markup).toContain('前往 DeepSeek 充值');
      expect(markup).toContain(DEEPSEEK_OFFICIAL_TOP_UP_DECLARATION);
      expect(markup).not.toContain('赠送');
      expect(markup).not.toContain('topped_up');
      expect(markup).not.toContain('granted');
      if (item.insufficient) {
        expect(markup).toContain('data-testid="deepseek-balance-insufficient-badge"');
        expect(markup).toContain('余额不足');
      } else {
        expect(markup).not.toContain('data-testid="deepseek-balance-insufficient-badge"');
      }
    }
  });

  it('renders loading state and localized error state with retry without blocking other Settings controls', () => {
    const loadingMarkup = renderSettings({
      balanceState: { status: 'loading' },
    });
    expect(loadingMarkup).toContain('data-testid="deepseek-balance-loading"');
    expect(loadingMarkup).toContain('正在查询余额…');
    expect(loadingMarkup).toMatch(/data-testid="refresh-balance-btn"[^>]*disabled/);

    const errorMarkup = renderSettings({
      balanceState: {
        status: 'error',
        reason: 'invalid_key',
        message: 'API Key 无效或已失效，请更换密钥后重试。',
      },
    });
    expect(errorMarkup).toContain('data-testid="deepseek-balance-error"');
    expect(errorMarkup).toContain('API Key 无效或已失效，请更换密钥后重试。');
    expect(errorMarkup).toContain('data-testid="refresh-balance-btn"');
    expect(errorMarkup).toContain('重试');
    expect(errorMarkup).toContain('data-testid="change-key-btn"');
    expect(errorMarkup).toContain('data-testid="clear-key-btn"');
    expect(errorMarkup).toContain('data-testid="settings-default-model-block"');
    expect(errorMarkup).toContain('data-testid="open-diagnostics"');
  });

  it('strictly hides DeepSeek balance panel and top-up block when active profile is a third-party provider', () => {
    const markup = renderSettings({
      hasCredentials: true,
      config: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-third-party-1234',
        memoryOnly: false,
        providerId: 'openai-1',
        providerPresetId: 'openai',
        capabilities: {
          thinkingProtocol: 'openai_reasoning_effort',
          prefixProtocol: 'none',
          supportsBalanceQuery: false,
          supportsBuiltinSearch: false,
          supportsBuiltinPricing: false,
        },
      },
      balanceState: {
        status: 'loaded',
        isAvailable: true,
        balances: [{ currency: 'CNY', totalBalance: '88.80' }],
        formattedBalance: '¥88.80',
      },
    });
    expect(markup).not.toContain('data-testid="deepseek-balance-panel"');
    expect(markup).not.toContain('data-testid="deepseek-balance-dev-proxy-note"');
    expect(markup).not.toContain('data-testid="deepseek-topup-block"');
    expect(markup).not.toContain('data-testid="deepseek-topup-link"');
    expect(markup).not.toContain('¥88.80');
  });
});
