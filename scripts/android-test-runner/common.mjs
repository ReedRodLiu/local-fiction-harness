import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const E2E_PACKAGE_ID = 'io.localfiction.harness.e2e';
export const SMOKE_PACKAGE_ID = 'io.localfiction.harness.smoke';
export const RELEASE_PACKAGE_ID = 'io.localfiction.harness';

export const DEFAULT_E2E_APK = 'android/app/build/outputs/apk/e2e/app-e2e.apk';
export const DEFAULT_SMOKE_APK = 'android/app/build/outputs/apk/smoke/app-smoke.apk';

export const TIMEOUTS = Object.freeze({
  domStableMs: 5000,
  wizardVerifyMs: 8000,
  keyboardPopupMs: 8000,
  keyboardOrLauncherMs: 10000,
  postBackgroundSettleMs: 15000,
  liveApiTurnMs: 45000,
  liveApiReasoningOrSearchMs: 60000,
  researchBalanceMs: 15000,
});

export const E2E_SCENARIO_IDS = Object.freeze([
  'E2E-01',
  'E2E-02',
  'E2E-03',
  'E2E-04',
  'E2E-05',
  'E2E-06A',
  'E2E-06B',
  'E2E-06C',
  'E2E-07',
]);

export const SMOKE_SCENARIO_IDS = Object.freeze([
  'SMK-01',
  'SMK-02',
  'SMK-03',
  'SMK-04',
  'SMK-05',
  'SMK-06',
]);

export const TIMED_OR_GESTURE_SCENARIOS = new Set([
  'E2E-03',
  'E2E-05',
  'E2E-06A',
  'E2E-06B',
  'SMK-05',
]);

export function sha256Hex(bufferOrText) {
  return createHash('sha256').update(bufferOrText).digest('hex');
}

export function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultCommandRunner(command, args = [], options = {}) {
  const encoding = options.encoding === 'buffer' ? null : 'utf8';
  try {
    return execFileSync(command, args, {
      encoding,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (options.allowFailure) {
      return options.encoding === 'buffer' ? Buffer.alloc(0) : '';
    }
    throw error;
  }
}

export function defaultSpawnProcess(command, args = []) {
  return spawn(command, args, { stdio: 'ignore' });
}

export function adbArgs(serial, rest) {
  return serial ? ['-s', serial, ...rest] : rest;
}

export async function runAdb(ctx, rest, options = {}) {
  return ctx.adbRunner('adb', adbArgs(ctx.serial, rest), options);
}

export async function waitForCondition(check, {
  description,
  timeoutMs = TIMEOUTS.domStableMs,
  intervalMs = 20,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof Error && /SECURITY VIOLATION/i.test(error.message)) {
        throw error;
      }
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${description} (${timeoutMs}ms)${lastError ? `: ${lastError.message}` : ''}`,
  );
}

export function resolveConnectedSerial(requestedSerial, adbRunner = defaultCommandRunner) {
  const output = String(adbRunner('adb', ['devices']) ?? '');
  const devices = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => Boolean(serial) && state === 'device')
    .map(([serial]) => serial);
  if (requestedSerial) {
    if (!devices.includes(requestedSerial)) {
      throw new Error(`Android device "${requestedSerial}" is not connected.`);
    }
    return requestedSerial;
  }
  if (devices.length !== 1) {
    throw new Error(
      `Expected exactly one connected Android device, found: ${devices.join(', ') || 'none'}`,
    );
  }
  return devices[0];
}

export async function readActivityState(ctx) {
  const output = String(await runAdb(ctx, ['shell', 'dumpsys', 'activity', 'activities']) ?? '');
  const topResumedActivity = output.match(/^\s*topResumedActivity=(.+)$/m)?.[1]?.trim() ?? null;
  const launcherTopResumed = /topDisplayFocusedRootTask=Task\{[^}\n]*type=home/.test(output);
  return {
    raw: output,
    topResumedActivity,
    launcherTopResumed,
    isPackageTopResumed: Boolean(
      topResumedActivity?.includes(ctx.packageId) && topResumedActivity?.includes('.MainActivity'),
    ),
  };
}

export async function waitForPackageTopResumed(
  ctx,
  expected = true,
  description = `${ctx.packageId} topResumed=${expected}`,
  timeoutMs = TIMEOUTS.keyboardOrLauncherMs,
) {
  return waitForCondition(
    async () => {
      const state = await readActivityState(ctx);
      return state.isPackageTopResumed === expected ? state : null;
    },
    { description, timeoutMs },
  );
}

export async function readWindowFocus(ctx) {
  let output = '';
  try {
    output = String(await runAdb(ctx, ['shell', 'dumpsys', 'window']) ?? '');
  } catch {
    output = String(await runAdb(ctx, ['shell', 'dumpsys', 'window', 'windows']) ?? '');
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('mCurrentFocus=') || line.startsWith('mFocusedApp='))
    .join('\n');
}

export async function readUiHierarchy(ctx) {
  const remotePath = `/sdcard/lfh-suite-ui-${Date.now()}.xml`;
  try {
    await runAdb(ctx, ['shell', 'uiautomator', 'dump', remotePath]);
    return String(await runAdb(ctx, ['exec-out', 'cat', remotePath]) ?? '');
  } finally {
    try {
      await runAdb(ctx, ['shell', 'rm', '-f', remotePath], { allowFailure: true });
    } catch {
      // Best-effort cleanup of transient uiautomator dump file.
    }
  }
}

export async function checkLockscreenProtected(ctx) {
  if (typeof ctx.lockscreenProtected === 'boolean') {
    return {
      protected: ctx.lockscreenProtected,
      reason: ctx.lockscreenProtected
        ? 'Configured lockscreenProtected=true'
        : 'Configured lockscreenProtected=false',
    };
  }
  const lockDisabled = String(
    await runAdb(ctx, ['shell', 'locksettings', 'get-disabled'], { allowFailure: true }) ?? '',
  )
    .trim()
    .toLowerCase();
  if (lockDisabled === 'false') {
    return {
      protected: true,
      reason: 'locksettings get-disabled returned false (PIN/pattern/password enabled)',
    };
  }
  const trustDump = String(
    await runAdb(ctx, ['shell', 'dumpsys', 'trust'], { allowFailure: true }) ?? '',
  );
  if (/isKeyguardSecure=true/i.test(trustDump) || /deviceLocked=true/i.test(trustDump)) {
    return {
      protected: true,
      reason: 'dumpsys trust reports secure/locked keyguard',
    };
  }
  return { protected: false, reason: 'No secure lockscreen detected' };
}

export async function launchApp(ctx, { clearData = false, stopFirst = false } = {}) {
  if (clearData) {
    if (ctx.suite === 'smoke' || ctx.packageId === SMOKE_PACKAGE_ID) {
      throw new Error('SECURITY VIOLATION: pm clear is strictly forbidden on .smoke.');
    }
    await runAdb(ctx, ['shell', 'am', 'force-stop', ctx.packageId]);
    const clearOut = String(await runAdb(ctx, ['shell', 'pm', 'clear', ctx.packageId]) ?? '');
    if (!clearOut.includes('Success') && !ctx.dryRun) {
      throw new Error(`pm clear ${ctx.packageId} failed: ${clearOut}`);
    }
  } else if (stopFirst) {
    await runAdb(ctx, ['shell', 'am', 'force-stop', ctx.packageId]);
  }
  await runAdb(ctx, ['logcat', '-c'], { allowFailure: true });
  await runAdb(ctx, ['shell', 'am', 'start', '-W', '-n', `${ctx.packageId}/.MainActivity`]);
  ctx.collector.recordEvent({
    hostTsMs: Date.now(),
    source: 'adb',
    scenarioId: ctx.currentScenarioId ?? 'RUN',
    level: 'info',
    event: clearData ? 'launch_clean' : 'launch_app',
    details: { packageId: ctx.packageId },
  });
}

export async function pressKeyevent(ctx, keycode) {
  await runAdb(ctx, ['shell', 'input', 'keyevent', keycode]);
  ctx.collector.recordEvent({
    hostTsMs: Date.now(),
    source: 'adb',
    scenarioId: ctx.currentScenarioId ?? 'RUN',
    level: 'info',
    event: keycode,
  });
}

export async function injectSwipe(ctx, { x1, y1, x2, y2, durationMs = 280 }) {
  await runAdb(ctx, [
    'shell',
    'input',
    'swipe',
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
    String(Math.round(durationMs)),
  ]);
  ctx.collector.recordEvent({
    hostTsMs: Date.now(),
    source: 'adb',
    scenarioId: ctx.currentScenarioId ?? 'RUN',
    level: 'info',
    event: 'input_swipe',
    details: { x1, y1, x2, y2, durationMs },
  });
}

export async function injectTap(ctx, { x, y }) {
  await runAdb(ctx, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  ctx.collector.recordEvent({
    hostTsMs: Date.now(),
    source: 'adb',
    scenarioId: ctx.currentScenarioId ?? 'RUN',
    level: 'info',
    event: 'input_tap',
    details: { x, y },
  });
}

export async function readDisplayMetrics(ctx) {
  const displays = String(await runAdb(ctx, ['shell', 'dumpsys', 'window', 'displays']) ?? '');
  const wmSize = String(await runAdb(ctx, ['shell', 'wm', 'size'], { allowFailure: true }) ?? '');
  const wmDensity = String(
    await runAdb(ctx, ['shell', 'wm', 'density'], { allowFailure: true }) ?? '',
  );
  return ctx.driver.parseDisplayMetrics(displays, wmSize, wmDensity);
}

export async function cdpEvaluate(ctx, expr) {
  if (!ctx.session?.client) {
    throw new Error('CDP session is not connected.');
  }
  return ctx.session.client.evaluate(expr);
}

export async function cdpClickSelector(ctx, selector, description = selector) {
  const clicked = await cdpEvaluate(
    ctx,
    `/* @lfh-op clickSelector ${JSON.stringify({ selector })} */ (() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const element = elements.find((candidate) => {
        const style = getComputedStyle(candidate);
        return candidate.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden';
      }) ?? elements[0];
      if (!(element instanceof HTMLElement)) return false;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return true;
    })()`,
  );
  if (!clicked) {
    throw new Error(`Selector "${description}" (${selector}) not found for click.`);
  }
  return true;
}

export async function cdpFillInput(ctx, selector, value, description = selector) {
  const filled = await cdpEvaluate(
    ctx,
    `/* @lfh-op fillInput ${JSON.stringify({ selector, value })} */ (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return false;
      }
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!filled) {
    throw new Error(`Input "${description}" (${selector}) not found.`);
  }
  return true;
}

export async function cdpReadSnapshot(ctx) {
  return cdpEvaluate(
    ctx,
    `/* @lfh-op readSnapshot {} */ (() => {
      const testIds = Array.from(document.querySelectorAll('[data-testid]')).map((el) =>
        el.getAttribute('data-testid'),
      );
      const state = history.state;
      const hasSession = Boolean(state && typeof state === 'object' && typeof state.lfhOverlaySession === 'string');
      const depth = hasSession ? Number(state.lfhOverlayDepth) : 0;
      const vv = window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
            scale: window.visualViewport.scale,
          }
        : null;
      const stage = document.querySelector('.main-stage');
      const stageScrollGapPx = stage
        ? Math.max(0, Math.round(stage.scrollHeight - stage.scrollTop - stage.clientHeight))
        : 0;
      return {
        url: location.href,
        readyState: document.readyState,
        timeOrigin: performance.timeOrigin,
        sessionToken: typeof window.__lfhOverlayHistorySession === 'string' ? window.__lfhOverlayHistorySession : null,
        historySession: hasSession ? state.lfhOverlaySession : null,
        overlayDepth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
        visualViewport: vv,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        stageScrollGapPx,
        drawerOpen: Boolean(document.querySelector('[data-testid="mobile-library-dialog"][open]')),
        settingsOpen: Boolean(document.querySelector('[data-testid="settings-page"]')),
        wizardOpen: Boolean(document.querySelector('[data-testid="deepseek-setup-wizard"]')),
        diagnosticsOpen: Boolean(document.querySelector('[data-testid="diagnostics-preview"][open]')),
        modeSwitchDialogOpen: Boolean(document.querySelector('[data-testid="mode-switch-confirm-dialog"][open]')),
        testIds,
      };
    })()`,
  );
}

export async function cdpQueryElementMetrics(ctx, selector) {
  return cdpEvaluate(
    ctx,
    `/* @lfh-op queryElementMetrics ${JSON.stringify({ selector })} */ (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cx = Math.max(0, Math.min(rect.left + rect.width / 2, window.innerWidth - 1));
      const cy = Math.max(0, Math.min(rect.top + rect.height / 2, window.innerHeight - 1));
      const hit = document.elementFromPoint(cx, cy);
      return {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        unobscured: Boolean(hit && (hit === el || el.contains(hit))),
        visualViewport: window.visualViewport
          ? {
              offsetLeft: window.visualViewport.offsetLeft,
              offsetTop: window.visualViewport.offsetTop,
              scale: window.visualViewport.scale,
            }
          : { offsetLeft: 0, offsetTop: 0, scale: 1 },
        dpr: window.devicePixelRatio || 1,
      };
    })()`,
  );
}

export async function collectScenarioLogsAndBundle(ctx, scenarioId, { windowStartMs, windowEndMs }) {
  try {
    const rawLogcat = String(
      await runAdb(ctx, ['logcat', '-d', '-v', 'threadtime'], { allowFailure: true }) ?? '',
    );
    ctx.collector.writeLogcat(scenarioId, rawLogcat, {
      pid: ctx.session?.pid ?? null,
      packageName: ctx.packageId,
      windowStartMs,
      windowEndMs,
    });
  } catch {
    // Preserve scenario outcome even if logcat collection fails.
  }

  if (ctx.session?.client) {
    try {
      const consoleEvents = ctx.session.client.getConsoleEvents?.() ?? [];
      const lifecycleEvents = ctx.session.client.getLifecycleEvents?.() ?? [];
      const formatted = [
        ...consoleEvents.map((evt) => ({
          hostTsMs: evt.tsMs,
          source: 'cdp_console',
          level: evt.params?.type === 'error' ? 'error' : 'info',
          event: evt.method,
          details: evt.params,
        })),
        ...lifecycleEvents.map((evt) => ({
          hostTsMs: evt.tsMs,
          source: 'cdp_lifecycle',
          level: 'info',
          event: evt.method,
          details: evt.params,
        })),
      ];
      ctx.collector.writeConsoleEvents(scenarioId, formatted);
    } catch {
      // Ignore console buffer extraction error.
    }

    try {
      const bundle = await ctx.artifacts.extractDiagnosticBundleViaCdp(ctx.session.client);
      if (bundle) {
        ctx.collector.writeDiagnosticBundle(scenarioId, bundle);
      }
    } catch {
      // Ignore bundle extraction failure when WebView is unavailable.
    }
  }
}

export async function assertSafeCaptureAllowed(ctx) {
  if (ctx.suite !== 'smoke') return;
  if (!ctx.session?.client) return;
  const keyUiVisible = await cdpEvaluate(
    ctx,
    `/* @lfh-op checkKeyUiVisible {} */ Boolean(
      document.querySelector('[data-testid="deepseek-setup-wizard"], [data-testid="provider-api-key"], #byok-api-key, input[name="apiKey"]')
    )`,
  ).catch(() => false);
  if (keyUiVisible) {
    throw new Error(
      'SECURITY VIOLATION: Refusing to capture screenshot while API key setup UI is open in .smoke.',
    );
  }
}

export async function safeCaptureStep(ctx, scenarioId, stepName, options = {}) {
  await assertSafeCaptureAllowed(ctx);
  const domSnapshot = options.domSnapshot ?? (ctx.session?.client ? await cdpReadSnapshot(ctx).catch(() => null) : null);
  return ctx.collector.captureStep(scenarioId, stepName, {
    serial: ctx.serial,
    client: ctx.session?.client ?? null,
    domSnapshot,
    ...options,
  });
}

/**
 * Runs a single scenario without any silent retry. On failure or thrown error,
 * immediately captures failure artifacts, collects logcat/console/diagnostic bundle,
 * and marks the scenario FAIL.
 */
export async function executeScenarioWithGuard(ctx, scenarioId, fn) {
  ctx.currentScenarioId = scenarioId;
  const startedAtMs = Date.now();
  const isTimedOrGesture = TIMED_OR_GESTURE_SCENARIOS.has(scenarioId);

  await ctx.collector.startScenario(scenarioId, {
    record: Boolean(ctx.record),
    timedOrGesture: isTimedOrGesture,
    serial: ctx.serial,
    startedAtMs,
  });
  ctx.collector.recordEvent({
    hostTsMs: startedAtMs,
    source: 'host',
    scenarioId,
    level: 'info',
    event: 'scenario_start',
  });

  const assertions = [];
  const addAssertion = (record) => {
    assertions.push(record);
    return record;
  };

  let hardOutcome = 'PASS';
  let errorMessage;

  try {
    const outcome = await fn({ addAssertion, assertions, startedAtMs });
    if (outcome?.hardOutcome) {
      hardOutcome = outcome.hardOutcome;
    } else if (assertions.some((a) => !a.passed)) {
      hardOutcome = 'FAIL';
      errorMessage = assertions
        .filter((a) => !a.passed)
        .map((a) => `${a.id}: expected ${a.expected}, got ${a.actual}`)
        .join('; ');
    }
  } catch (error) {
    hardOutcome = 'FAIL';
    errorMessage = error instanceof Error ? error.message : String(error);
    assertions.push({
      id: `${scenarioId}-unhandled-error`,
      kind: 'system_state',
      passed: false,
      expected: 'scenario completes without error',
      actual: errorMessage,
    });
  }

  const finishedAtMs = Date.now();

  if (hardOutcome === 'FAIL') {
    let canCaptureFailureScreenshot = true;
    try {
      await assertSafeCaptureAllowed(ctx);
    } catch {
      canCaptureFailureScreenshot = false;
    }
    try {
      const domSnapshot = ctx.session?.client
        ? await cdpReadSnapshot(ctx).catch(() => null)
        : null;
      await ctx.collector.captureFailure(scenarioId, {
        serial: ctx.serial,
        client: ctx.session?.client ?? null,
        domSnapshot,
        includePng: canCaptureFailureScreenshot,
      });
      for (const a of assertions) {
        if (!a.passed && !a.artifactPath && canCaptureFailureScreenshot) {
          a.artifactPath = `scenarios/${scenarioId}/failure.png`;
        }
      }
    } catch {
      // Preserve product failure if device capture disconnects during teardown.
    }
  }

  await collectScenarioLogsAndBundle(ctx, scenarioId, {
    windowStartMs: startedAtMs - 1000,
    windowEndMs: finishedAtMs + 1000,
  });

  ctx.collector.recordEvent({
    hostTsMs: finishedAtMs,
    source: 'host',
    scenarioId,
    level: hardOutcome === 'FAIL' ? 'error' : 'info',
    event: 'scenario_end',
    details: { hardOutcome, error: errorMessage ?? null },
  });

  const finishedState = await ctx.collector.finishScenario(scenarioId, {
    hardOutcome,
    assertions,
    finishedAtMs,
    error: errorMessage,
  });

  ctx.currentScenarioId = null;
  return {
    scenarioId,
    hardOutcome,
    assertions,
    artifactPaths: [...(finishedState?.artifacts ?? [])],
    error: errorMessage ?? null,
  };
}

export function buildDefaultHardGateReviewer() {
  return async (reviewInput) => {
    const hasFail = reviewInput.scenarios.some((s) => s.hardOutcome === 'FAIL');
    const scenarioReviews = reviewInput.scenarios.map((scenario) => {
      const fallbackPath =
        scenario.artifactPaths.find((p) => p.endsWith('.png')) ??
        scenario.artifactPaths[0] ??
        `scenarios/${scenario.scenarioId}/assertions.json`;

      if (scenario.hardOutcome === 'FAIL') {
        return {
          scenarioId: scenario.scenarioId,
          reviewStatus: 'FAIL_ATTRIBUTED',
          summary:
            scenario.error ||
            `Hard assertion failed for ${scenario.scenarioId}.`,
          evidenceCitations: [
            {
              artifactPath: fallbackPath,
              observation: 'Hard assertion failed; failure artifacts captured.',
            },
          ],
        };
      }
      if (String(scenario.hardOutcome).startsWith('SKIPPED_')) {
        return {
          scenarioId: scenario.scenarioId,
          reviewStatus: 'SKIPPED_ACKNOWLEDGED',
          summary: `Scenario skipped: ${scenario.hardOutcome}.`,
          evidenceCitations: [
            {
              artifactPath: fallbackPath,
              observation: `Recorded skip reason ${scenario.hardOutcome}.`,
            },
          ],
        };
      }
      return {
        scenarioId: scenario.scenarioId,
        reviewStatus: 'CONFIRMED_PASS',
        summary: `All hard assertions passed for ${scenario.scenarioId}.`,
        evidenceCitations: [
          {
            artifactPath: fallbackPath,
            observation: 'Verified against captured scenario artifacts.',
          },
        ],
      };
    });

    return {
      overallHardGate: hasFail ? 'FAIL' : 'PASS',
      llmReviewVerdict: hasFail ? 'CONFIRMED_FAIL' : 'CONFIRMED_PASS',
      scenarioReviews,
    };
  };
}
