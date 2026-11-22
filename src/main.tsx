import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPlatformRuntime } from './platform/runtime.ts';
import { App } from './ui/App.tsx';
import { AppErrorBoundary } from './ui/AppErrorBoundary.tsx';
import './ui/styles.css';

const runtime = createPlatformRuntime();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary runtime={runtime} onAsyncError={() => undefined}>
      <App runtime={runtime} />
    </AppErrorBoundary>
  </StrictMode>,
);
