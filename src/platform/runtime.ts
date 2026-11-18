import { Capacitor } from '@capacitor/core';
import type { PlatformRuntime } from '../harness/index.ts';
import { createAndroidPlatformRuntime } from './androidRuntime.ts';
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
export { createAndroidPlatformRuntime, type AndroidRuntimeOptions } from './androidRuntime.ts';
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
 */
export function createPlatformRuntime(options: WebRuntimeOptions = {}): PlatformRuntime {
  const platform = detectRuntimePlatform();
  if (platform === 'android') {
    return createAndroidPlatformRuntime(options);
  }
  return createWebPlatformRuntime(options);
}
