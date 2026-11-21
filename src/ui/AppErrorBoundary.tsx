import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { DiagnosticBundle, DiagnosticBundleTrigger, PlatformRuntime } from '../harness/index.ts';
import { buildCrashDiagnosticBundle } from './crashDiagnosticContext.ts';
import { DiagnosticsPreview } from './DiagnosticsPreview.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';

export interface AppAsyncErrorNotice {
  id: number;
  action: 'unhandled_window_error' | 'unhandled_rejection';
  message: string;
}

type AsyncErrorListener = (notice: AppAsyncErrorNotice) => void;
const asyncErrorListeners = new Set<AsyncErrorListener>();
let nextAsyncErrorId = 0;

export function subscribeAppAsyncErrors(listener: AsyncErrorListener): () => void {
  asyncErrorListeners.add(listener);
  return () => {
    asyncErrorListeners.delete(listener);
  };
}

export function useAppAsyncError(): {
  asyncError: AppAsyncErrorNotice | null;
  dismissAsyncError: () => void;
} {
  const [asyncError, setAsyncError] = useState<AppAsyncErrorNotice | null>(null);

  useEffect(() => {
    return subscribeAppAsyncErrors((notice) => {
      setAsyncError(notice);
    });
  }, []);

  return {
    asyncError,
    dismissAsyncError: () => setAsyncError(null),
  };
}

interface AppErrorBoundaryProps {
  runtime: PlatformRuntime;
  children: ReactNode;
  onAsyncError?: (notice: AppAsyncErrorNotice) => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  diagnosticsMounted: boolean;
  diagnosticsOpen: boolean;
  diagnosticsRevision: number;
  diagnosticsTrigger: DiagnosticBundleTrigger;
  asyncError: AppAsyncErrorNotice | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    diagnosticsMounted: false,
    diagnosticsOpen: false,
    diagnosticsRevision: 0,
    diagnosticsTrigger: 'crash_boundary',
    asyncError: null,
  };

  private diagnosticsTriggerRef: HTMLButtonElement | null = null;

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidMount(): void {
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.recordCrash('unhandled_render_crash', error);
  }

  private readonly handleWindowError = (event: ErrorEvent): void => {
    this.receiveAsyncError('unhandled_window_error', event.error ?? new Error('Unhandled window error'));
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.receiveAsyncError('unhandled_rejection', event.reason);
  };

  receiveAsyncError(
    action: 'unhandled_window_error' | 'unhandled_rejection',
    error: unknown,
  ): void {
    this.recordCrash(action, error);

    nextAsyncErrorId += 1;
    const notice: AppAsyncErrorNotice = {
      id: nextAsyncErrorId,
      action,
      message: '后台操作出现异常，当前界面和本地存档未受影响。',
    };

    this.props.onAsyncError?.(notice);
    for (const listener of asyncErrorListeners) {
      listener(notice);
    }

    if (!this.props.onAsyncError && !this.state.hasError) {
      this.setState({ asyncError: notice });
    }
  }

  private readonly dismissAsyncError = (): void => {
    this.setState({ asyncError: null });
  };

  private readonly openDiagnostics = (
    trigger: DiagnosticBundleTrigger = 'crash_boundary',
  ): void => {
    this.setState((state) => ({
      diagnosticsMounted: true,
      diagnosticsOpen: true,
      diagnosticsRevision: state.diagnosticsRevision + 1,
      diagnosticsTrigger: trigger,
    }));
  };

  private readonly closeDiagnostics = (): void => {
    this.setState({ diagnosticsOpen: false });
  };

  private readonly finishDiagnosticsExit = (): void => {
    this.setState({ diagnosticsMounted: false });
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => this.diagnosticsTriggerRef?.focus());
    }
  };

  private recordCrash(
    action: 'unhandled_render_crash' | 'unhandled_window_error' | 'unhandled_rejection',
    error: unknown,
  ): void {
    try {
      this.props.runtime.diagnostics.recordError({
        category: 'crash',
        action,
        error,
      });
    } catch {
      // Keep the fallback available if diagnostics storage itself is unavailable.
    }
  }

  private buildBundle = (options?: { userNote?: string }): DiagnosticBundle => {
    const base = buildCrashDiagnosticBundle(this.props.runtime);
    const trimmedNote = options?.userNote?.trim();
    if (this.state.diagnosticsTrigger === 'crash_boundary' && !trimmedNote) {
      return base;
    }
    return {
      ...base,
      trigger: this.state.diagnosticsTrigger,
      ...(trimmedNote ? { userNote: trimmedNote } : {}),
    };
  };

  render(): ReactNode {
    const diagnosticsDialog = this.state.diagnosticsMounted && (
      <DiagnosticsPreview
        key={this.state.diagnosticsRevision}
        open={this.state.diagnosticsOpen}
        buildBundle={this.buildBundle}
        reassurance="本地故事存档保存在设备上，重新载入界面不会删除已保存的故事。"
        onReload={() => window.location.reload()}
        onExport={(fileName, json) =>
          this.props.runtime.backupExporter.exportJsonFile(fileName, json)
        }
        onRecordDiagnostic={(action) => {
          try {
            this.props.runtime.diagnostics.recordEvent({
              level: 'info',
              category: 'ui',
              action,
            });
          } catch {
            // Never throw when recording diagnostics export breadcrumb.
          }
        }}
        onClose={this.closeDiagnostics}
        onExitComplete={this.finishDiagnosticsExit}
      />
    );

    if (!this.state.hasError) {
      return (
        <>
          {this.state.asyncError && !this.props.onAsyncError && (
            <div className="async-error-toast" data-testid="async-error-toast">
              <BannerAlert
                tone="danger"
                testId="async-error-banner"
                action={{
                  label: '导出日志',
                  onClick: () => this.openDiagnostics('error_banner'),
                }}
                onDismiss={this.dismissAsyncError}
              >
                <span>{this.state.asyncError.message}</span>
              </BannerAlert>
            </div>
          )}
          {this.props.children}
          {diagnosticsDialog}
        </>
      );
    }

    return (
      <main className="crash-recovery" role="alert" aria-labelledby="crash-title" data-testid="crash-recovery">
        <section className="crash-recovery-card" data-testid="crash-recovery-card">
          <span className="crash-recovery-mark" aria-hidden="true">
            <ShieldCheck size={26} strokeWidth={1.75} />
          </span>
          <h2 id="crash-title">界面遇到意外波动</h2>
          <p>本地故事存档未受损。你可以重新载入界面，或导出排障日志反馈问题。</p>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              重新载入界面
            </button>
            <button
              type="button"
              className="btn"
              data-testid="crash-open-diagnostics"
              onClick={(event) => {
                this.diagnosticsTriggerRef = event.currentTarget;
                this.openDiagnostics('crash_boundary');
              }}
            >
              导出排障日志
            </button>
          </div>
        </section>
        {diagnosticsDialog}
      </main>
    );
  }
}
