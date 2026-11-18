import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPlatformRuntime } from '../../src/platform/runtime.ts';
import { App } from '../../src/ui/App.tsx';
import { AppErrorBoundary } from '../../src/ui/AppErrorBoundary.tsx';
import { setCrashDiagnosticBundleBuilder } from '../../src/ui/crashDiagnosticContext.ts';
import '../../src/ui/styles.css';

function RenderFault() {
  const [shouldThrow, setShouldThrow] = useState(false);
  if (shouldThrow) {
    throw new Error('SYNTHETIC_RENDER_BODY secret Bearer SYNTHETIC_BEARER_VALUE');
  }
  return (
    <>
      <button type="button" onClick={() => setShouldThrow(true)}>触发测试渲染崩溃</button>
      <button
        type="button"
        onClick={() => {
          setCrashDiagnosticBundleBuilder(runtime, () => {
            throw new Error('SYNTHETIC_BROKEN_DIAGNOSTIC_CONTEXT');
          });
          setShouldThrow(true);
        }}
      >
        触发损坏诊断上下文的崩溃
      </button>
    </>
  );
}

const runtime = createPlatformRuntime();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary runtime={runtime}>
      <RenderFault />
      <App runtime={runtime} />
    </AppErrorBoundary>
  </StrictMode>,
);
