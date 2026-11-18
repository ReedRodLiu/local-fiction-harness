import type { LlmTransport, PlatformRuntime } from '../harness/index.ts';
import { createCapacitorSseTransport } from './capacitorSseTransport.ts';
import { createWebPlatformRuntime, type WebRuntimeOptions } from './webRuntime.ts';

export interface AndroidRuntimeOptions extends WebRuntimeOptions {
  transport?: LlmTransport;
}

/**
 * Creates the Android PlatformRuntime adapter using the native chunked SSE bridge for LlmTransport.
 * Native SecretStore, app-private StoryStorage, and BackupExporter (plus platform: 'android') are wired in Slice D.
 */
export function createAndroidPlatformRuntime(
  options: AndroidRuntimeOptions = {},
): PlatformRuntime {
  const webFallback = createWebPlatformRuntime({ ...options, isDev: false });
  return {
    ...webFallback,
    transport: options.transport ?? createCapacitorSseTransport(),
  };
}
