import { Capacitor } from '@capacitor/core';
import type { PlatformRuntime } from '../harness/index.ts';
import { createWebPlatformRuntime, type WebRuntimeOptions } from './webRuntime.ts';

export {
  DEV_PROXY_BASE_URL,
  clearDevSessionProxy,
  fetchDevTestConfig,
  isDevProxyBaseUrl,
  readDevSessionProxy,
  writeDevSessionProxy,
  type DevTestConfigResponse,
} from './devProxy.ts';
export { createWebPlatformRuntime, type WebRuntimeOptions } from './webRuntime.ts';

export interface CapacitorDetector {
  isNativePlatform(): boolean;
  getPlatform(): string;
}

/**
 * Detects whether the app is executing inside a native Android Capacitor shell or a Web browser.
 */
export function detectRuntimePlatform(
  capacitor: CapacitorDetector = Capacitor,
): 'web' | 'android' {
  try {
    if (capacitor.isNativePlatform() && capacitor.getPlatform() === 'android') {
      return 'android';
    }
  } catch {
    // Fall back to web outside browser/Capacitor contexts
  }
  return 'web';
}

/**
 * Resolves the active PlatformRuntime at app startup.
 * Native Android bridges are plugged in via Slices C & D; until then Android falls back
 * explicitly to Web-compatible adapters (`platform: 'web'`, dev proxy disabled).
 */
export function createPlatformRuntime(options: WebRuntimeOptions = {}): PlatformRuntime {
  const platform = detectRuntimePlatform();
  if (platform === 'android') {
    return createWebPlatformRuntime({ ...options, isDev: false });
  }
  return createWebPlatformRuntime(options);
}
