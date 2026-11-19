import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { DiagnosticBundle, PlatformRuntime } from '../harness/index.ts';
import { buildCrashDiagnosticBundle } from './crashDiagnosticContext.ts';
import { DiagnosticsPreview } from './DiagnosticsPreview.tsx';

interface AppErrorBoundaryProps {
  runtime: PlatformRuntime;
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  showDiagnostics: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    showDiagnostics: false,
  };

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
    this.setState({ showDiagnostics: true });
  }

  private readonly handleWindowError = (event: ErrorEvent): void => {
    this.recordCrash('unhandled_window_error', event.error ?? new Error('Unhandled window error'));
    this.setState({ hasError: true, showDiagnostics: true });
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.recordCrash('unhandled_rejection', event.reason);
    this.setState({ hasError: true, showDiagnostics: true });
  };

  private recordCrash(action: 'unhandled_render_crash' | 'unhandled_window_error' | 'unhandled_rejection', error: unknown): void {
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

  private buildBundle = (): DiagnosticBundle => buildCrashDiagnosticBundle(this.props.runtime);

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="crash-recovery" role="alert" aria-labelledby="crash-title" data-testid="crash-recovery">
        <section className="crash-recovery-card" data-testid="crash-recovery-card">
          <span className="crash-recovery-mark" aria-hidden="true">
            <ShieldCheck size={26} strokeWidth={1.75} />
          </span>
          <h2 id="crash-title">界面遇到意外波动</h2>
          <p>本地故事存档未受损。你可以重新载入界面，或先预览并导出脱敏诊断包。</p>
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
              onClick={() => this.setState({ showDiagnostics: true })}
            >
              预览并导出脱敏诊断包
            </button>
          </div>
        </section>
        {this.state.showDiagnostics && (
          <DiagnosticsPreview
            buildBundle={this.buildBundle}
            reassurance="本地故事存档保存在设备上，重新载入界面不会删除已保存的故事。"
            onReload={() => window.location.reload()}
            onExport={(fileName, json) =>
              this.props.runtime.backupExporter.exportJsonFile(fileName, json)
            }
            onClose={() => this.setState({ showDiagnostics: false })}
          />
        )}
      </main>
    );
  }
}
