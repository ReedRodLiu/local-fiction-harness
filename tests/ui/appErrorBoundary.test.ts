import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticCollector, type PlatformRuntime } from '../../src/harness/index.ts';
import { AppErrorBoundary } from '../../src/ui/AppErrorBoundary.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

function createStubRuntime(): PlatformRuntime {
  const diagnostics = createDiagnosticCollector({ platform: 'web', now: () => 1000 });
  return {
    platform: 'web',
    diagnostics,
    transport: {} as never,
    binaryDownloader: {} as never,
    storyStorage: {} as never,
    secretStore: {} as never,
    backupExporter: { exportJsonFile: vi.fn(async () => undefined) },
    supportsMemoryOnlySession: true,
  };
}

describe('AppErrorBoundary noise reduction & crash recovery', () => {
  it('takes over full screen ONLY on React render crashes and does NOT auto-open JSON modal', () => {
    const runtime = createStubRuntime();
    const boundary = new AppErrorBoundary({
      runtime,
      children: createElement('div', null, '正常内容'),
    });

    const derived = AppErrorBoundary.getDerivedStateFromError();
    expect(derived).toEqual({ hasError: true });

    const setStateSpy = vi.fn();
    boundary.setState = setStateSpy;
    boundary.componentDidCatch(new Error('Render boom'), { componentStack: '' });

    // Records render crash but does NOT auto-open DiagnosticsPreview modal
    const bundle = runtime.diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: false });
    expect(bundle.events.some((event) => event.action === 'unhandled_render_crash')).toBe(true);
    expect(setStateSpy).not.toHaveBeenCalled();
    expect(boundary.state.diagnosticsMounted).toBe(false);
    expect(boundary.state.diagnosticsOpen).toBe(false);

    // Rendered recovery screen offers calm reload + secondary 导出排障日志 without auto-opened modal
    boundary.state = { ...boundary.state, ...derived };
    const recoveryMarkup = renderToStaticMarkup(boundary.render() as never);
    expect(recoveryMarkup).toContain('data-testid="crash-recovery"');
    expect(recoveryMarkup).toContain('重新载入界面');
    expect(recoveryMarkup).toContain('导出排障日志');
    expect(recoveryMarkup).not.toContain('data-testid="diagnostics-preview"');
  });

  it('keeps app mounted on non-fatal window.error and unhandledrejection and surfaces dismissible alert', () => {
    const runtime = createStubRuntime();
    const onAsyncError = vi.fn();
    const boundary = new AppErrorBoundary({
      runtime,
      onAsyncError,
      children: createElement('div', { 'data-testid': 'app-root' }, '正常主界面'),
    });

    const stateUpdates: Array<Record<string, unknown>> = [];
    boundary.setState = ((updater: unknown) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: typeof boundary.state) => Partial<typeof boundary.state>)(boundary.state)
          : (updater as Partial<typeof boundary.state>);
      boundary.state = { ...boundary.state, ...next };
      stateUpdates.push(next as Record<string, unknown>);
    }) as typeof boundary.setState;

    // Simulate non-fatal window.error & unhandledrejection
    boundary.receiveAsyncError('unhandled_window_error', new Error('Network hiccup'));
    boundary.receiveAsyncError('unhandled_rejection', new Error('Async rejection'));

    expect(boundary.state.hasError).toBe(false);
    expect(boundary.state.diagnosticsMounted).toBe(false);
    expect(boundary.state.diagnosticsOpen).toBe(false);
    expect(stateUpdates.some((patch) => patch.hasError === true)).toBe(false);

    const bundle = runtime.diagnostics.buildBundle({ baseUrl: '', model: '', memoryOnly: false });
    expect(bundle.events.some((event) => event.action === 'unhandled_window_error')).toBe(true);
    expect(bundle.events.some((event) => event.action === 'unhandled_rejection')).toBe(true);
    expect(onAsyncError).toHaveBeenCalledTimes(2);

    // Without external onAsyncError, built-in lightweight dismissible BannerAlert renders alongside children
    const boundaryWithBuiltinToast = new AppErrorBoundary({
      runtime,
      children: createElement('div', { 'data-testid': 'app-root' }, '正常主界面'),
    });
    boundaryWithBuiltinToast.setState = ((updater: unknown) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: typeof boundaryWithBuiltinToast.state) => Partial<typeof boundaryWithBuiltinToast.state>)(
              boundaryWithBuiltinToast.state,
            )
          : (updater as Partial<typeof boundaryWithBuiltinToast.state>);
      boundaryWithBuiltinToast.state = { ...boundaryWithBuiltinToast.state, ...next };
    }) as typeof boundaryWithBuiltinToast.setState;

    boundaryWithBuiltinToast.receiveAsyncError('unhandled_rejection', new Error('Async fail'));
    expect(boundaryWithBuiltinToast.state.hasError).toBe(false);
    const mountedMarkup = renderToStaticMarkup(boundaryWithBuiltinToast.render() as never);
    expect(mountedMarkup).toContain('正常主界面');
    expect(mountedMarkup).toContain('data-testid="async-error-banner"');
    expect(mountedMarkup).toContain('导出日志');
    expect(mountedMarkup).toContain('data-testid="async-error-banner-dismiss"');
  });
});
