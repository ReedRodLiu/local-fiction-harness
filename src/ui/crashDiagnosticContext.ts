import type { DiagnosticBundle, PlatformRuntime } from '../harness/index.ts';

const bundleBuilders = new WeakMap<PlatformRuntime, () => DiagnosticBundle>();

export function setCrashDiagnosticBundleBuilder(
  runtime: PlatformRuntime,
  buildBundle: () => DiagnosticBundle,
): void {
  bundleBuilders.set(runtime, buildBundle);
}

export function buildCrashDiagnosticBundle(runtime: PlatformRuntime): DiagnosticBundle {
  const buildBundle = bundleBuilders.get(runtime);
  if (buildBundle) {
    try {
      return buildBundle();
    } catch {
      // Keep crash diagnostics available if contextual collection itself fails.
    }
  }

  return runtime.diagnostics.buildBundle(
    { baseUrl: '', model: '', memoryOnly: false },
    {
      trigger: 'crash_boundary',
      appEnv: {
        platform: runtime.platform,
        appVersion: 'unknown',
        viewport:
          typeof window === 'undefined' ? 'unknown' : `${window.innerWidth}x${window.innerHeight}`,
        activeView: 'unknown',
        storyCount: 0,
      },
    },
  );
}
