import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDeepSeekBalance,
  isOfficialDeepSeekUrl,
  recordBalanceCheckDiagnostic,
  type BalanceFetchLike,
  type DeepSeekBalanceErrorReason,
  type DiagnosticCollector,
  type ParsedDeepSeekBalance,
} from '../harness/index.ts';

export type SettingsBalanceState =
  | { status: 'idle' }
  | { status: 'loading'; previous?: ParsedDeepSeekBalance }
  | ({ status: 'loaded' } & ParsedDeepSeekBalance)
  | { status: 'error'; reason: DeepSeekBalanceErrorReason; message: string };

export interface DeepSeekBalanceSyncParams {
  active: boolean;
  hasCredentials: boolean;
  useDevEnvKey: boolean;
  apiKey: string;
  baseUrl: string;
  supportsBalanceQuery?: boolean;
  keyBoundSeq?: number;
}

export interface DeepSeekBalanceControllerOptions {
  fetchImpl?: BalanceFetchLike;
  diagnostics?: Pick<DiagnosticCollector, 'recordEvent'>;
  timeoutMs?: number;
  onStateChange?: (state: SettingsBalanceState) => void;
}

export interface DeepSeekBalanceController {
  getState(): SettingsBalanceState;
  sync(params: DeepSeekBalanceSyncParams): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}

function resolveSupportsBalanceQuery(params: DeepSeekBalanceSyncParams): boolean {
  if (params.supportsBalanceQuery !== undefined) {
    return params.supportsBalanceQuery;
  }
  return isOfficialDeepSeekUrl(params.baseUrl);
}

function buildContextKey(params: DeepSeekBalanceSyncParams): string {
  return `${resolveSupportsBalanceQuery(params) ? 1 : 0}|${params.hasCredentials ? 1 : 0}|${params.useDevEnvKey ? 1 : 0}|${params.apiKey}|${params.baseUrl}|${params.keyBoundSeq ?? 0}`;
}

function toPreviousBalance(state: SettingsBalanceState): ParsedDeepSeekBalance | undefined {
  if (state.status === 'loaded') {
    return {
      isAvailable: state.isAvailable,
      balances: state.balances,
      formattedBalance: state.formattedBalance,
    };
  }
  if (state.status === 'loading') {
    return state.previous;
  }
  return undefined;
}

/**
 * Memory-only controller for querying DeepSeek account total balance inside Settings.
 * Prevents concurrent/double-click requests, cancels stale requests on key/view change,
 * skips dev-proxy mode, and records only sanitized status/latency diagnostics.
 */
export function createDeepSeekBalanceController(
  options: DeepSeekBalanceControllerOptions = {},
): DeepSeekBalanceController {
  let state: SettingsBalanceState = { status: 'idle' };
  let currentParams: DeepSeekBalanceSyncParams | null = null;
  let lastContextKey = '';
  let wasActive = false;
  let requestSeq = 0;
  let inFlight = false;
  let activeAbortController: AbortController | null = null;

  const setState = (next: SettingsBalanceState) => {
    state = next;
    options.onStateChange?.(next);
  };

  const abortInFlight = () => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    inFlight = false;
    requestSeq += 1;
  };

  const executeFetch = async (
    params: DeepSeekBalanceSyncParams,
    { resetPrevious }: { resetPrevious: boolean },
  ): Promise<void> => {
    abortInFlight();
    const seq = requestSeq;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeAbortController = controller;
    inFlight = true;

    const previous = resetPrevious ? undefined : toPreviousBalance(state);
    setState(previous ? { status: 'loading', previous } : { status: 'loading' });

    const result = await fetchDeepSeekBalance({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: controller?.signal,
    });

    if (seq !== requestSeq) {
      return;
    }

    activeAbortController = null;
    inFlight = false;

    if (result.status === 'aborted') {
      setState(previous ? { status: 'loaded', ...previous } : { status: 'idle' });
      return;
    }

    if (options.diagnostics) {
      recordBalanceCheckDiagnostic(options.diagnostics, result);
    }

    if (result.status === 'ok') {
      setState({
        status: 'loaded',
        isAvailable: result.isAvailable,
        balances: result.balances,
        formattedBalance: result.formattedBalance,
      });
      return;
    }

    setState({
      status: 'error',
      reason: result.reason,
      message: result.message,
    });
  };

  return {
    getState: () => state,

    async sync(params: DeepSeekBalanceSyncParams): Promise<void> {
      currentParams = params;
      if (!resolveSupportsBalanceQuery(params) || !params.hasCredentials || params.useDevEnvKey) {
        abortInFlight();
        lastContextKey = '';
        wasActive = params.active;
        if (state.status !== 'idle') {
          setState({ status: 'idle' });
        }
        return;
      }

      if (!params.active) {
        if (inFlight) {
          const previous = toPreviousBalance(state);
          abortInFlight();
          setState(previous ? { status: 'loaded', ...previous } : { status: 'idle' });
        }
        wasActive = false;
        return;
      }

      const nextContextKey = buildContextKey(params);
      const contextChanged = nextContextKey !== lastContextKey;
      const enteringActive = !wasActive;
      wasActive = true;
      lastContextKey = nextContextKey;

      if (enteringActive || contextChanged) {
        await executeFetch(params, { resetPrevious: contextChanged });
      }
    },

    async refresh(): Promise<void> {
      if (
        !currentParams ||
        !currentParams.active ||
        !resolveSupportsBalanceQuery(currentParams) ||
        !currentParams.hasCredentials ||
        currentParams.useDevEnvKey
      ) {
        return;
      }
      if (inFlight) {
        return;
      }
      await executeFetch(currentParams, { resetPrevious: false });
    },

    dispose(): void {
      abortInFlight();
      currentParams = null;
      lastContextKey = '';
      wasActive = false;
      state = { status: 'idle' };
    },
  };
}

export function useDeepSeekBalance(
  params: DeepSeekBalanceSyncParams & {
    diagnostics?: Pick<DiagnosticCollector, 'recordEvent'>;
  },
): {
  balanceState: SettingsBalanceState;
  refreshBalance: () => void;
} {
  const [balanceState, setBalanceState] = useState<SettingsBalanceState>({ status: 'idle' });
  const controllerRef = useRef<DeepSeekBalanceController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createDeepSeekBalanceController({
      diagnostics: params.diagnostics,
      onStateChange: setBalanceState,
    });
  }

  useEffect(() => {
    void controllerRef.current?.sync({
      active: params.active,
      hasCredentials: params.hasCredentials,
      useDevEnvKey: params.useDevEnvKey,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      supportsBalanceQuery: params.supportsBalanceQuery,
      keyBoundSeq: params.keyBoundSeq,
    });
  }, [
    params.active,
    params.hasCredentials,
    params.useDevEnvKey,
    params.apiKey,
    params.baseUrl,
    params.supportsBalanceQuery,
    params.keyBoundSeq,
  ]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
    };
  }, []);

  const refreshBalance = useCallback(() => {
    void controllerRef.current?.refresh();
  }, []);

  return { balanceState, refreshBalance };
}
