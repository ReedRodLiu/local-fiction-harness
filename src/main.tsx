import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPlatformRuntime } from './platform/runtime.ts';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const runtime = createPlatformRuntime();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
