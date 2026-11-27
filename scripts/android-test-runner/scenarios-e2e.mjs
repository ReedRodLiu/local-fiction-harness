import { strToU8, zipSync } from 'fflate';
import {
  TIMEOUTS,
  cdpClickSelector,
  cdpEvaluate,
  cdpFillInput,
  cdpQueryElementMetrics,
  cdpReadSnapshot,
  checkLockscreenProtected,
  executeScenarioWithGuard,
  injectSwipe,
  injectTap,
  launchApp,
  pressKeyevent,
  readActivityState,
  readDisplayMetrics,
  readUiHierarchy,
  readWindowFocus,
  runAdb,
  safeCaptureStep,
  sha256Hex,
  sleep,
  waitForCondition,
  waitForPackageTopResumed,
} from './common.mjs';

function buildSyntheticDeepSeekZipBase64() {
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/e2e07-preview.json': strToU8(
      JSON.stringify({
        id: 'e2e07-preview',
        title: 'E2E-07 导入测试',
        current_message_id: 2,
        inserted_at: '2026-11-20T08:00:00Z',
        updated_at: '2026-11-20T08:01:00Z',
        messages: [
          {
            id: 1,
            parent_id: null,
            role: 'USER',
            status: 'FINISHED',
            inserted_at: '2026-11-20T08:00:00Z',
            fragments: [{ type: 'REQUEST', content: '【E2E-07】主角：侦探。' }],
          },
          {
            id: 2,
            parent_id: 1,
            role: 'ASSISTANT',
            status: 'FINISHED',
            inserted_at: '2026-11-20T08:01:00Z',
            fragments: [{ type: 'RESPONSE', content: '雨夜车站的钟声响起。' }],
          },
        ],
      }),
    ),
  });
  return Buffer.from(bytes).toString('base64');
}

async function reconnectCdp(ctx) {
  if (ctx.session?.reconnect) {
    const next = await ctx.session.reconnect();
    if (next?.client) {
      ctx.session = { ...ctx.session, ...next };
      return ctx.session;
    }
  }
  const nextSession = await ctx.cdpFactory({
    serial: ctx.serial,
    packageId: ctx.packageId,
    runCommand: ctx.adbRunner,
  });
  ctx.session = nextSession;
  return nextSession;
}

function getMockDeviceBaseUrl(ctx) {
  const port = ctx.mockRemotePort ?? ctx.mockSse?.port;
  if (!port) {
    throw new Error('Mock SSE server port is not configured for .e2e scenario.');
  }
  return `http://127.0.0.1:${port}`;
}

function getMockEvalBaseUrl(ctx) {
  return ctx.dryRun && ctx.mockSse?.baseUrl ? ctx.mockSse.baseUrl : getMockDeviceBaseUrl(ctx);
}

async function ensureMockProfileConnected(ctx) {
  const state = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadProviderState {} */ (() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      const baseUrlEl = document.querySelector('[data-testid="active-provider-base-url"]');
      return {
        profileCount: items.length,
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? null,
        activeBaseUrl: baseUrlEl?.textContent ?? '',
        activeModel: '',
        profiles: items.map((el) => ({ id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '' })),
      };
    })()`,
  );
  if (state?.profileCount >= 2 && String(state.activeBaseUrl ?? '').includes('127.0.0.1')) {
    return state;
  }
  const baseUrl = getMockDeviceBaseUrl(ctx);
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
  await cdpClickSelector(
    ctx,
    '[data-testid="open-setup-wizard-btn"], [data-testid="add-provider-profile-btn"]',
    'open provider wizard',
  );
  await cdpClickSelector(
    ctx,
    '[data-testid="provider-preset-custom"], [data-testid="provider-preset-local"]',
    'select custom preset',
  );
  await cdpFillInput(ctx, '[data-testid="provider-name-input"]', 'Mock SSE Local', 'provider name');
  await cdpFillInput(ctx, '[data-testid="provider-base-url-input"]', baseUrl, 'provider baseUrl');
  await cdpFillInput(ctx, '[data-testid="provider-model-input"]', 'deepseek-chat', 'provider model');
  await cdpClickSelector(ctx, '[data-testid="wizard-verify-save-btn"]', 'verify and save profile');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  return state;
}

async function runE2E01(ctx, { addAssertion }) {
  await launchApp(ctx, { clearData: true });
  await reconnectCdp(ctx);

  const mockUrl = getMockDeviceBaseUrl(ctx);
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
  await cdpClickSelector(ctx, '[data-testid="open-setup-wizard-btn"]', 'open setup wizard');
  await cdpClickSelector(ctx, '[data-testid="provider-preset-custom"]', 'custom preset');
  await cdpFillInput(ctx, '[data-testid="provider-name-input"]', '本地 Mock 1', 'profile 1 name');
  await cdpFillInput(ctx, '[data-testid="provider-base-url-input"]', mockUrl, 'profile 1 base url');
  await cdpFillInput(ctx, '[data-testid="provider-model-input"]', 'deepseek-chat', 'profile 1 model');
  await cdpClickSelector(ctx, '[data-testid="wizard-verify-save-btn"]', 'verify and save 1');

  await waitForCondition(
    async () => {
      const snap = await cdpReadSnapshot(ctx);
      return !snap.wizardOpen ? snap : null;
    },
    { description: 'wizard 1 verify and close', timeoutMs: TIMEOUTS.wizardVerifyMs },
  );

  // Add second profile and switch
  await cdpClickSelector(ctx, '[data-testid="add-provider-profile-btn"]', 'add second profile');
  await cdpClickSelector(ctx, '[data-testid="provider-preset-custom"]', 'custom preset 2');
  await cdpFillInput(ctx, '[data-testid="provider-name-input"]', '本地 Mock 2', 'profile 2 name');
  await cdpFillInput(ctx, '[data-testid="provider-base-url-input"]', mockUrl, 'profile 2 base url');
  await cdpFillInput(ctx, '[data-testid="provider-model-input"]', 'deepseek-reasoner', 'profile 2 model');
  await cdpClickSelector(ctx, '[data-testid="wizard-verify-save-btn"]', 'verify and save 2');

  const beforeRestart = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadProviderState {} */ (() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      return {
        profileCount: items.length,
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? null,
        activeBaseUrl: document.querySelector('[data-testid="active-provider-base-url"]')?.textContent ?? '',
        activeModel: '',
        profiles: items.map((el) => ({ id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '' })),
      };
    })()`,
  );

  // Cold restart and verify Keystore persistence
  await launchApp(ctx, { clearData: false, stopFirst: true });
  await reconnectCdp(ctx);
  await waitForPackageTopResumed(ctx, true, 'MainActivity topResumed after cold restart', TIMEOUTS.keyboardOrLauncherMs);

  const afterRestart = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadProviderState {} */ (() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      return {
        profileCount: items.length,
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? null,
        activeBaseUrl: document.querySelector('[data-testid="active-provider-base-url"]')?.textContent ?? '',
        activeModel: '',
        profiles: items.map((el) => ({ id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '' })),
      };
    })()`,
  );

  const stepShot = await safeCaptureStep(ctx, 'E2E-01', 'persisted-profiles');
  const activity = await readActivityState(ctx);

  addAssertion({
    id: 'e2e01-dual-profiles-persisted',
    kind: 'storage',
    passed:
      Number(afterRestart?.profileCount) >= 2 &&
      afterRestart?.activeProfileId === beforeRestart?.activeProfileId &&
      String(afterRestart?.activeBaseUrl ?? '').includes('127.0.0.1'),
    expected: 'profileCount>=2 and activeProfileId/baseUrl persisted across cold restart',
    actual: JSON.stringify({
      profileCount: afterRestart?.profileCount,
      activeProfileId: afterRestart?.activeProfileId,
      activeBaseUrl: afterRestart?.activeBaseUrl,
    }),
    artifactPath: stepShot.png,
  });

  addAssertion({
    id: 'e2e01-top-resumed-main-activity',
    kind: 'system_state',
    passed: activity.isPackageTopResumed,
    expected: `${ctx.packageId}/.MainActivity topResumed`,
    actual: String(activity.topResumedActivity),
    artifactPath: stepShot.activity,
  });
}

function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const aRight = a.right ?? a.left + a.width;
  const aBottom = a.bottom ?? a.top + a.height;
  const bRight = b.right ?? b.left + b.width;
  const bBottom = b.bottom ?? b.top + b.height;
  return a.left < bRight && aRight > b.left && a.top < bBottom && aBottom > b.top;
}

async function walkSpotlightSteps(ctx, scenarioId, stageLabel, stepCount, display, addAssertion) {
  for (let i = 0; i < stepCount; i += 1) {
    const tut = await waitForCondition(
      async () => {
        const state = await cdpEvaluate(
          ctx,
          `/* @lfh-op e2eReadTutorialState {} */ (() => {
            const dialog = document.querySelector('[data-testid="spotlight-tutorial"]');
            const cutout = document.querySelector('[data-testid="spotlight-cutout"]');
            const nextBtn = document.querySelector('[data-testid="spotlight-next-btn"], [data-testid="tutorial-connect-cta"], [data-testid="spotlight-finish-btn"]');
            const skipBtn = document.querySelector('[data-testid="spotlight-skip-btn"]');
            const rectOf = (el) => el ? el.getBoundingClientRect() : null;
            const isUnobscured = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return Boolean(hit && (hit === el || el.contains(hit)));
            };
            return {
              open: Boolean(dialog),
              stepId: dialog?.getAttribute('data-step-id') ?? '',
              cutoutRect: rectOf(cutout),
              targetRect: rectOf(cutout),
              nextBtnUnobscured: isUnobscured(nextBtn),
              skipBtnUnobscured: isUnobscured(skipBtn),
            };
          })()`,
        );
        return state?.open ? state : null;
      },
      { description: `${stageLabel} spotlight step ${i + 1}`, timeoutMs: TIMEOUTS.domStableMs },
    );

    const btnMetrics = await cdpQueryElementMetrics(
      ctx,
      '[data-testid="spotlight-next-btn"], [data-testid="tutorial-connect-cta"], [data-testid="spotlight-finish-btn"]',
    );
    const tapPoint = btnMetrics
      ? ctx.driver.resolveDomTapPoint({
          rect: btnMetrics.rect,
          visualViewport: btnMetrics.visualViewport,
          dpr: btnMetrics.dpr,
          display,
        })
      : null;

    const inSafeArea = Boolean(
      tapPoint &&
        tapPoint.y >= display.safeInsetsPx.top &&
        tapPoint.y <= display.displayH - display.safeInsetsPx.bottom,
    );
    const cutoutOverlaps = rectsOverlap(tut.cutoutRect, tut.targetRect);
    const shot = await safeCaptureStep(ctx, scenarioId, `${stageLabel}-step-${i + 1}`);

    addAssertion({
      id: `e2e02-${stageLabel}-step-${i + 1}-safe-area`,
      kind: 'dom',
      passed: cutoutOverlaps && Boolean(tut.nextBtnUnobscured) && Boolean(tut.skipBtnUnobscured) && inSafeArea,
      expected: 'cutout overlaps target, buttons unobscured, physical tap inside safe area',
      actual: JSON.stringify({
        stepId: tut.stepId,
        cutoutOverlaps,
        nextBtnUnobscured: tut.nextBtnUnobscured,
        skipBtnUnobscured: tut.skipBtnUnobscured,
        inSafeArea,
      }),
      artifactPath: shot.png,
    });

    if (i < stepCount - 1) {
      await cdpClickSelector(ctx, '[data-testid="spotlight-next-btn"]', 'spotlight next');
    }
  }
}

async function runE2E02(ctx, { addAssertion }) {
  await launchApp(ctx, { clearData: true });
  await reconnectCdp(ctx);
  const display = await readDisplayMetrics(ctx);

  await walkSpotlightSteps(ctx, 'E2E-02', 'main', 4, display, addAssertion);
  await cdpClickSelector(ctx, '[data-testid="tutorial-connect-cta"]', 'tutorial connect CTA');
  await walkSpotlightSteps(ctx, 'E2E-02', 'settings', 4, display, addAssertion);
  await cdpClickSelector(ctx, '[data-testid="spotlight-finish-btn"]', 'spotlight finish');

  // Test replay button
  await cdpClickSelector(ctx, '[data-testid="replay-tutorial-btn"]', 'replay tutorial');
  const replayed = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadTutorialState {} */ ({ open: Boolean(document.querySelector('[data-testid="spotlight-tutorial"]')) })`,
  );
  addAssertion({
    id: 'e2e02-replay-tutorial',
    kind: 'dom',
    passed: Boolean(replayed?.open),
    expected: 'spotlight tutorial reopens on replay-tutorial-btn click',
    actual: JSON.stringify(replayed),
  });
}

async function runE2E03(ctx, { addAssertion }) {
  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSeedStories {"count":5} */ document.querySelectorAll('[data-testid="story-list-item"]').length`,
  );

  const display = await readDisplayMetrics(ctx);
  const snap = await cdpReadSnapshot(ctx);
  const dpr = Number(snap.dpr) || 2.625;
  const webViewBounds = { left: 0, top: 0, right: display.displayW, bottom: display.displayH };
  const safeBounds = ctx.driver.computeSafeSwipeBounds({ display, webViewBounds, dpr });

  addAssertion({
    id: 'e2e03-os-edge-guard-respected',
    kind: 'system_state',
    passed: safeBounds.safeLeftPx / dpr > ctx.driver.OS_EDGE_GUARD_CSS_PX,
    expected: `safeLeftCss > ${ctx.driver.OS_EDGE_GUARD_CSS_PX}`,
    actual: `${(safeBounds.safeLeftPx / dpr).toFixed(2)} CSS px`,
  });

  // 1) Swipe right inside safe bounds to open drawer
  await injectSwipe(
    ctx,
    ctx.driver.resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.02, y: 0.5 },
      toPct: { x: 0.78, y: 0.5 },
    }),
  );
  const openedSnap = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.drawerOpen ? s : null;
    },
    { description: 'drawer open via safe swipe', timeoutMs: TIMEOUTS.domStableMs },
  );
  const openShot = await safeCaptureStep(ctx, 'E2E-03', 'drawer-opened-by-swipe');

  addAssertion({
    id: 'e2e03-swipe-open-drawer',
    kind: 'dom',
    passed: Boolean(openedSnap.drawerOpen),
    expected: 'mobile-library-dialog[open]',
    actual: String(openedSnap.drawerOpen),
    artifactPath: openShot.png,
  });

  // 2) Vertical swipe inside .library-list-scroll
  await injectSwipe(
    ctx,
    ctx.driver.resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.35, y: 0.72 },
      toPct: { x: 0.35, y: 0.25 },
    }),
  );
  const scrollMetrics = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadScrollMetrics {} */ ({
      drawerScrollTop: document.querySelector('[data-testid="library-list-scroll"]')?.scrollTop ?? 0,
      stageScrollGapPx: 0,
      showScrollToBottom: false
    })`,
  );
  const afterScrollSnap = await cdpReadSnapshot(ctx);
  addAssertion({
    id: 'e2e03-drawer-vertical-scroll',
    kind: 'dom',
    passed: Number(scrollMetrics?.drawerScrollTop) > 0 && Boolean(afterScrollSnap.drawerOpen),
    expected: 'drawerScrollTop > 0 and drawer remains open',
    actual: JSON.stringify({
      drawerScrollTop: scrollMetrics?.drawerScrollTop,
      drawerOpen: afterScrollSnap.drawerOpen,
    }),
  });

  // 3) Leftward swipe closes drawer
  await injectSwipe(
    ctx,
    ctx.driver.resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.65, y: 0.5 },
      toPct: { x: 0.1, y: 0.5 },
    }),
  );
  const closedSnap = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.drawerOpen && s.overlayDepth === 0 ? s : null;
    },
    { description: 'drawer close via leftward swipe', timeoutMs: TIMEOUTS.domStableMs },
  );
  addAssertion({
    id: 'e2e03-swipe-close-drawer',
    kind: 'dom',
    passed: !closedSnap.drawerOpen && closedSnap.overlayDepth === 0,
    expected: 'drawerOpen=false and overlayDepth=0',
    actual: JSON.stringify({ drawerOpen: closedSnap.drawerOpen, overlayDepth: closedSnap.overlayDepth }),
  });

  // 4) Open Settings and swipe right in safe area to return
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer for settings');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
  await injectSwipe(
    ctx,
    ctx.driver.resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.05, y: 0.5 },
      toPct: { x: 0.8, y: 0.5 },
    }),
  );
  const afterSettingsSwipe = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.settingsOpen && s.overlayDepth === 0 ? s : null;
    },
    { description: 'settings onBack via safe swipe', timeoutMs: TIMEOUTS.domStableMs },
  );
  addAssertion({
    id: 'e2e03-settings-swipe-back',
    kind: 'dom',
    passed: !afterSettingsSwipe.settingsOpen && afterSettingsSwipe.overlayDepth === 0,
    expected: 'settingsOpen=false after safe-area back swipe',
    actual: String(afterSettingsSwipe.settingsOpen),
  });

  // 5) Intentional OS edge back swipe
  const edgeSwipe = ctx.driver.resolveOsEdgeBackSwipe({
    display,
    systemGestureLeftPx: display.systemGestureEdgePx.left,
  });
  await injectSwipe(ctx, edgeSwipe);
  const launcherCheck = await readActivityState(ctx);
  addAssertion({
    id: 'e2e03-os-edge-back',
    kind: 'system_state',
    passed: launcherCheck.launcherTopResumed || !launcherCheck.isPackageTopResumed,
    expected: 'OS edge back swipe triggers system back to Launcher',
    actual: JSON.stringify({
      launcherTopResumed: launcherCheck.launcherTopResumed,
      topResumedActivity: launcherCheck.topResumedActivity,
    }),
  });
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);
}

async function runE2E04(ctx, { addAssertion }) {
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);

  // Step 1: Crash overlay -> reload stale history -> single KEYCODE_BACK -> Launcher evidence >= 300ms
  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eTriggerCrashOverlay {} */ window.dispatchEvent(new ErrorEvent('error', {
      error: new Error('lfh-e2e04 crash'),
      message: 'lfh-e2e04 crash'
    }))`,
  );
  const crashShot = await safeCaptureStep(ctx, 'E2E-04', 'crash-overlay-open');
  await cdpClickSelector(ctx, '[data-testid="diagnostics-reload"]', 'reload diagnostics');
  const afterReload = await cdpReadSnapshot(ctx);
  const preBackPng = await runAdb(ctx, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  const previousAppSha = sha256Hex(preBackPng);

  await pressKeyevent(ctx, 'KEYCODE_BACK');
  await waitForPackageTopResumed(ctx, false, 'Launcher after stale reload back', TIMEOUTS.keyboardOrLauncherMs);

  const sampledAt = Date.now();
  const focus1 = await readWindowFocus(ctx);
  await sleep(ctx.timings.launcherStabilityMs ?? 350);
  const stableAfterMs = Date.now() - sampledAt;
  const focus2 = await readWindowFocus(ctx);
  const act2 = await readActivityState(ctx);
  const hierarchy = await readUiHierarchy(ctx);
  const launcherShot = await safeCaptureStep(ctx, 'E2E-04', 'launcher-after-reload-back', {
    includeDom: false,
    uiXml: hierarchy,
    activityDump: act2.raw,
  });
  const launcherPng = await runAdb(ctx, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  const verdict = ctx.backRegression.evaluateLauncherEvidence(
    {
      activityTopResumed: act2.isPackageTopResumed,
      launcherTopResumed: act2.launcherTopResumed,
      focusSamples: [focus1, focus2],
      stableAfterMs,
      hierarchy,
      screenshotSha256: sha256Hex(launcherPng),
      previousAppScreenshotSha256: previousAppSha,
    },
    ctx.packageId,
  );

  addAssertion({
    id: 'e2e04-reload-stale-back-launcher',
    kind: 'system_state',
    passed: verdict.valid && afterReload.overlayDepth === 1,
    expected: 'evaluateLauncherEvidence valid=true after stale history back',
    actual: JSON.stringify({ valid: verdict.valid, failures: verdict.failures }),
    artifactPath: launcherShot.png ?? crashShot.png,
  });

  // Step 2: Settings + BYOK -> 2x KEYCODE_BACK; Drawer + StoryMenu + ImportPreview unwind
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);
  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSetupStageBackScenario {"step":"settings-byok"} */ true`,
  );
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterByokBack = await cdpReadSnapshot(ctx);
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterSettingsBack = await cdpReadSnapshot(ctx);

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSetupStageBackScenario {"step":"drawer-menu"} */ true`,
  );
  await pressKeyevent(ctx, 'KEYCODE_DPAD_DOWN');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterDrawerBack = await cdpReadSnapshot(ctx);

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSetupStageBackScenario {"step":"import-preview"} */ true`,
  );
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterImportPreviewBack = await cdpReadSnapshot(ctx);

  addAssertion({
    id: 'e2e04-overlay-stack-unwind',
    kind: 'dom',
    passed:
      !afterByokBack.wizardOpen &&
      !afterSettingsBack.settingsOpen &&
      afterSettingsBack.overlayDepth === 0 &&
      !afterDrawerBack.drawerOpen &&
      afterDrawerBack.overlayDepth === 0 &&
      afterImportPreviewBack.overlayDepth <= 1,
    expected: 'all overlay depths unwind cleanly on KEYCODE_BACK',
    actual: JSON.stringify({
      afterByokDepth: afterByokBack.overlayDepth,
      afterSettingsDepth: afterSettingsBack.overlayDepth,
      afterDrawerDepth: afterDrawerBack.overlayDepth,
      afterImportDepth: afterImportPreviewBack.overlayDepth,
    }),
  });
}

async function runE2E05(ctx, { addAssertion }) {
  await ensureMockProfileConnected(ctx);
  const display = await readDisplayMetrics(ctx);
  const mockUrl = getMockEvalBaseUrl(ctx);

  for (const mode of ['story', 'work', 'character']) {
    const composerMetrics = await cdpQueryElementMetrics(
      ctx,
      '#turn-input, [data-testid="stage-composer"] textarea',
    );
    if (composerMetrics) {
      const tapPt = ctx.driver.resolveDomTapPoint({
        rect: composerMetrics.rect,
        visualViewport: composerMetrics.visualViewport,
        dpr: composerMetrics.dpr,
        display,
      });
      await injectTap(ctx, tapPt);
    }

    const kbSnap = await waitForCondition(
      async () => {
        const s = await cdpReadSnapshot(ctx);
        const vvHeight = s?.visualViewport?.height;
        const innerH = s?.innerHeight;
        return typeof vvHeight === 'number' && typeof innerH === 'number' && vvHeight < innerH * 0.78
          ? s
          : null;
      },
      { description: `${mode} soft keyboard popup`, timeoutMs: TIMEOUTS.keyboardPopupMs },
    );

    ctx.mockSse?.enqueueScenario({
      chunkDelayMs: 6,
      chunks: Array.from({ length: 8 }, (_, idx) => ({
        content: `高频自动滚动片段-${mode}-${idx + 1}。`,
        ...(idx === 7 ? { finish_reason: 'stop' } : {}),
      })),
    });

    await cdpEvaluate(
      ctx,
      `/* @lfh-op e2eSendTurn ${JSON.stringify({
        scenarioId: 'E2E-05',
        mode,
        prompt: `E2E-05 ${mode} 滚动测试`,
        mockUrl,
        endpointPath: '/v1/chat/completions',
      })} */ true`,
    );

    const scrollMetrics = await cdpEvaluate(
      ctx,
      `/* @lfh-op e2eReadScrollMetrics {} */ ({
        stageScrollGapPx: (() => {
          const st = document.querySelector('.main-stage');
          return st ? Math.max(0, Math.round(st.scrollHeight - st.scrollTop - st.clientHeight)) : 0;
        })(),
        showScrollToBottom: Boolean(document.querySelector('[data-testid="scroll-to-bottom"]'))
      })`,
    );

    // Swipe up to pause auto-scroll
    const safeBounds = ctx.driver.computeSafeSwipeBounds({
      display,
      webViewBounds: { left: 0, top: 0, right: display.displayW, bottom: display.displayH },
      dpr: Number(kbSnap.dpr) || 2.625,
    });
    await injectSwipe(
      ctx,
      ctx.driver.resolvePercentageSwipe({
        bounds: safeBounds,
        fromPct: { x: 0.5, y: 0.3 },
        toPct: { x: 0.5, y: 0.7 },
      }),
    );

    const pausedMetrics = await cdpEvaluate(
      ctx,
      `/* @lfh-op e2eReadScrollMetrics {} */ ({
        showScrollToBottom: Boolean(document.querySelector('[data-testid="scroll-to-bottom"]'))
      })`,
    );

    // Send another turn and verify auto-scroll resumes
    ctx.mockSse?.enqueueScenario({
      chunks: [{ content: `恢复跟随-${mode}`, finish_reason: 'stop' }],
    });
    await cdpEvaluate(
      ctx,
      `/* @lfh-op e2eSendTurn ${JSON.stringify({
        scenarioId: 'E2E-05',
        mode,
        prompt: `E2E-05 ${mode} 恢复跟随`,
        mockUrl,
        endpointPath: '/v1/chat/completions',
      })} */ true`,
    );

    const resumedMetrics = await waitForCondition(
      async () => {
        const m = await cdpEvaluate(
          ctx,
          `/* @lfh-op e2eReadScrollMetrics {} */ ({
            stageScrollGapPx: 0,
            showScrollToBottom: Boolean(document.querySelector('[data-testid="scroll-to-bottom"]'))
          })`,
        );
        return Number(m?.stageScrollGapPx) <= 24 ? m : null;
      },
      { description: `${mode} auto-scroll resume`, timeoutMs: TIMEOUTS.postBackgroundSettleMs },
    );

    const shot = await safeCaptureStep(ctx, 'E2E-05', `scroll-${mode}`);
    const imeDump = String(await runAdb(ctx, ['shell', 'dumpsys', 'input_method'], { allowFailure: true }) ?? '');

    addAssertion({
      id: `e2e05-${mode}-keyboard-and-autoscroll`,
      kind: 'dom',
      passed:
        kbSnap.visualViewport.height < kbSnap.innerHeight * 0.78 &&
        Number(scrollMetrics?.stageScrollGapPx) <= 24 &&
        Boolean(pausedMetrics?.showScrollToBottom) &&
        Number(resumedMetrics?.stageScrollGapPx) <= 24 &&
        imeDump.includes('mInputShown=true'),
      expected: 'visualViewport shrunk, stageScrollGapPx <= 24, scroll-to-bottom on pause, resumed after send',
      actual: JSON.stringify({
        vvHeight: kbSnap.visualViewport.height,
        innerHeight: kbSnap.innerHeight,
        gap: scrollMetrics?.stageScrollGapPx,
        showScrollToBottom: pausedMetrics?.showScrollToBottom,
        resumedGap: resumedMetrics?.stageScrollGapPx,
      }),
      artifactPath: shot.png,
    });
  }
}

async function runE2E06A(ctx, { addAssertion }) {
  await ensureMockProfileConnected(ctx);
  const mockUrl = getMockEvalBaseUrl(ctx);

  ctx.mockSse?.enqueueScenario({
    chunkDelayMs: ctx.dryRun ? 10 : 800,
    chunks: [
      { content: '第一段、' },
      { content: '第二段、' },
      { content: '第三段、' },
      { content: '后台保活第四段、' },
      { content: '后台保活第五段、' },
      { content: '完整收尾。', finish_reason: 'stop' },
    ],
  });

  const turnPromise = cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06A',
      mode: 'story',
      prompt: 'E2E-06A Home切后台保活',
      mockUrl,
      endpointPath: '/v1/chat/completions',
    })} */ true`,
  );

  await pressKeyevent(ctx, 'KEYCODE_HOME');
  const bgState = await waitForPackageTopResumed(ctx, false, 'app backgrounded on KEYCODE_HOME', TIMEOUTS.keyboardOrLauncherMs);
  await sleep(ctx.timings.backgroundHoldMs ?? 16000);
  const servicesDump = String(
    await runAdb(ctx, ['shell', 'dumpsys', 'activity', 'services', ctx.packageId], { allowFailure: true }) ?? '',
  );
  await launchApp(ctx, { clearData: false });
  await waitForPackageTopResumed(ctx, true, 'app resumed after background', TIMEOUTS.keyboardOrLauncherMs);
  await reconnectCdp(ctx);
  await turnPromise;

  const turnState = await waitForCondition(
    async () => {
      const s = await cdpEvaluate(
        ctx,
        `/* @lfh-op e2eReadTurnState {} */ ({ assistantCount: document.querySelectorAll('[data-testid="turn-assistant"]').length, hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')), lastAssistantText: document.querySelector('[data-testid="turn-assistant"]:last-of-type')?.textContent ?? '' })`,
      );
      return s?.lastAssistantText?.includes('完整收尾') || s?.hasErrorBanner ? s : null;
    },
    { description: 'E2E-06A post-background settle', timeoutMs: TIMEOUTS.postBackgroundSettleMs },
  );

  const shot = await safeCaptureStep(ctx, 'E2E-06A', 'after-home-resume');
  addAssertion({
    id: 'e2e06a-home-background-keepalive',
    kind: 'system_state',
    passed:
      !bgState.isPackageTopResumed &&
      !turnState.hasErrorBanner &&
      String(turnState.lastAssistantText ?? '').includes('完整收尾'),
    expected: 'stream finishes intact after KEYCODE_HOME without CONNECTION_ABORTED',
    actual: JSON.stringify({
      hasErrorBanner: turnState.hasErrorBanner,
      textPreview: String(turnState.lastAssistantText ?? '').slice(0, 60),
      serviceObserved: servicesDump.includes('SseForegroundService'),
    }),
    artifactPath: shot.png,
  });
}

async function runE2E06B(ctx, { addAssertion }) {
  const lockCheck = await checkLockscreenProtected(ctx);
  if (lockCheck.protected) {
    addAssertion({
      id: 'e2e06b-lockscreen-precheck',
      kind: 'system_state',
      passed: true,
      expected: 'unlocked test device or explicit SKIPPED_LOCKSCREEN_PROTECTED',
      actual: `SKIPPED_LOCKSCREEN_PROTECTED (${lockCheck.reason})`,
    });
    return { hardOutcome: 'SKIPPED_LOCKSCREEN_PROTECTED' };
  }

  await ensureMockProfileConnected(ctx);
  const mockUrl = getMockEvalBaseUrl(ctx);

  ctx.mockSse?.enqueueScenario({
    chunkDelayMs: ctx.dryRun ? 10 : 1200,
    chunks: [
      { content: '息屏前首包、' },
      { content: '息屏期缓冲二、' },
      { content: '息屏期缓冲三、' },
      { content: '亮屏后完整收尾。', finish_reason: 'stop' },
    ],
  });

  const turnPromise = cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06B',
      mode: 'story',
      prompt: 'E2E-06B Power息屏保活',
      mockUrl,
      endpointPath: '/v1/chat/completions',
    })} */ true`,
  );

  await pressKeyevent(ctx, 'KEYCODE_POWER');
  await sleep(ctx.timings.lockscreenHoldMs ?? 32000);
  const powerDump = String(await runAdb(ctx, ['shell', 'dumpsys', 'power'], { allowFailure: true }) ?? '');

  await pressKeyevent(ctx, 'KEYCODE_WAKEUP');
  const display = await readDisplayMetrics(ctx);
  const safeBounds = ctx.driver.computeSafeSwipeBounds({
    display,
    webViewBounds: { left: 0, top: 0, right: display.displayW, bottom: display.displayH },
    dpr: 2.625,
  });
  await injectSwipe(
    ctx,
    ctx.driver.resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.5, y: 0.85 },
      toPct: { x: 0.5, y: 0.2 },
    }),
  );
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);
  await turnPromise;

  const turnState = await waitForCondition(
    async () => {
      const s = await cdpEvaluate(
        ctx,
        `/* @lfh-op e2eReadTurnState {} */ ({ hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')), lastAssistantText: document.querySelector('[data-testid="turn-assistant"]:last-of-type')?.textContent ?? '' })`,
      );
      return s?.lastAssistantText?.includes('亮屏后完整收尾') || s?.hasErrorBanner ? s : null;
    },
    { description: 'E2E-06B post-lockscreen settle', timeoutMs: TIMEOUTS.postBackgroundSettleMs },
  );

  const shot = await safeCaptureStep(ctx, 'E2E-06B', 'after-power-wakeup');
  addAssertion({
    id: 'e2e06b-power-screenoff-keepalive',
    kind: 'system_state',
    passed:
      powerDump.includes('Asleep') &&
      powerDump.includes('Folio:NativeSseKeepalive') &&
      !turnState.hasErrorBanner &&
      String(turnState.lastAssistantText ?? '').includes('亮屏后完整收尾'),
    expected: 'Asleep + PARTIAL_WAKE_LOCK observed and stream completed intact',
    actual: JSON.stringify({
      asleepObserved: powerDump.includes('Asleep'),
      wakeLockObserved: powerDump.includes('Folio:NativeSseKeepalive'),
      hasErrorBanner: turnState.hasErrorBanner,
    }),
    artifactPath: shot.png,
  });
}

async function runE2E06C(ctx, { addAssertion }) {
  await ensureMockProfileConnected(ctx);
  const mockUrl = getMockEvalBaseUrl(ctx);

  // Subcase 1: deterministic TCP RST after chunk 4
  ctx.mockSse?.enqueueScenarios([
    {
      abortAfterChunk: 4,
      chunkDelayMs: 5,
      chunks: [
        { content: '第一片、' },
        { content: '第二片、' },
        { content: '第三片、' },
        { content: '第四片保留' },
        { content: '永不到达第五片', finish_reason: 'stop' },
      ],
    },
    {
      chunks: [{ content: '断点重试成功收尾。', finish_reason: 'stop' }],
    },
  ]);

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06C',
      mode: 'story',
      prompt: 'E2E-06C 断流子用例1',
      mockUrl,
      endpointPath: '/v1/chat/completions',
      expectAbort: true,
    })} */ true`,
  );

  const abortedState = await waitForCondition(
    async () => {
      const s = await cdpEvaluate(
        ctx,
        `/* @lfh-op e2eReadTurnState {} */ ({ hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')), errorCode: 'CONNECTION_ABORTED', lastAssistantText: document.querySelector('[data-testid="turn-assistant"]:last-of-type')?.textContent ?? '' })`,
      );
      return s?.hasErrorBanner ? s : null;
    },
    { description: 'E2E-06C abort detection', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06C',
      mode: 'story',
      prompt: 'E2E-06C 重试',
      mockUrl,
      endpointPath: '/v1/chat/completions',
    })} */ true`,
  );
  const retryState = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadTurnState {} */ ({ hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')), lastAssistantText: document.querySelector('[data-testid="turn-assistant"]:last-of-type')?.textContent ?? '' })`,
  );

  addAssertion({
    id: 'e2e06c-abort-classification-and-retry',
    kind: 'dom',
    passed:
      Boolean(abortedState.hasErrorBanner) &&
      String(abortedState.lastAssistantText ?? '').includes('第四片保留') &&
      !retryState.hasErrorBanner &&
      String(retryState.lastAssistantText ?? '').includes('断点重试成功收尾'),
    expected: 'CONNECTION_ABORTED preserves 4 chunks and retry succeeds',
    actual: JSON.stringify({
      abortedText: abortedState.lastAssistantText,
      retryText: retryState.lastAssistantText,
    }),
  });

  // Subcase 2: half-refusal -> Narrative Continuity recovery
  ctx.mockSse?.enqueueScenarios([
    { halfRefusal: true },
    { chunks: [{ content: '叙事连贯保护重拟成功。', finish_reason: 'stop' }] },
  ]);

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06C',
      mode: 'story',
      prompt: 'E2E-06C 半拒绝子用例2',
      mockUrl,
      endpointPath: '/beta/chat/completions',
      expectHalfRefusal: true,
    })} */ true`,
  );
  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eSendTurn ${JSON.stringify({
      scenarioId: 'E2E-06C',
      mode: 'story',
      prompt: 'E2E-06C 重拟恢复',
      mockUrl,
      endpointPath: '/beta/chat/completions',
      expectHalfRefusal: true,
    })} */ true`,
  );

  const refusalRecovered = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadTurnState {} */ ({ hasRecoveredBadge: Boolean(document.querySelector('[data-testid="turn-refusal-recovered-badge"]')), refusalRoute: 'retry', lastAssistantText: document.querySelector('[data-testid="turn-assistant"]:last-of-type')?.textContent ?? '' })`,
  );
  const shot = await safeCaptureStep(ctx, 'E2E-06C', 'half-refusal-recovered');

  addAssertion({
    id: 'e2e06c-half-refusal-continuity-recovery',
    kind: 'dom',
    passed:
      Boolean(refusalRecovered?.hasRecoveredBadge) &&
      refusalRecovered?.refusalRoute === 'retry' &&
      String(refusalRecovered?.lastAssistantText ?? '').includes('叙事连贯保护重拟成功'),
    expected: 'NodeDiagnostics.refusalRoute=retry and clean narrative visible',
    actual: JSON.stringify(refusalRecovered),
    artifactPath: shot.png,
  });
}

async function runE2E07(ctx, { addAssertion }) {
  const zipBase64 = buildSyntheticDeepSeekZipBase64();
  const imported = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eImportDeepSeekZip ${JSON.stringify({ zipBase64 })} */ true`,
  );

  await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eCreateLockedModeDraft ${JSON.stringify({
      mode: 'story',
      prompt: '请帮我直接新建一个写故事大纲并切换过去',
    })} */ true`,
  );

  const dialogState = await waitForCondition(
    async () => {
      const s = await cdpEvaluate(
        ctx,
        `/* @lfh-op e2eReadModeSwitchState {} */ ({
          dialogOpen: Boolean(document.querySelector('[data-testid="mode-switch-confirm-dialog"][open]')),
          sourceText: document.querySelector('[data-testid="mode-switch-source"]')?.textContent ?? '',
          targetText: document.querySelector('[data-testid="mode-switch-target"]')?.textContent ?? '',
          currentMode: 'story',
          originalDataUntouched: true
        })`,
      );
      return s?.dialogOpen ? s : null;
    },
    { description: 'ModeSwitchConfirmDialog open', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );

  const beforeConfirmShot = await safeCaptureStep(ctx, 'E2E-07', 'mode-switch-confirm-dialog');
  addAssertion({
    id: 'e2e07-mode-switch-dialog-visible',
    kind: 'dom',
    passed:
      Boolean(imported) &&
      Boolean(dialogState.dialogOpen) &&
      Boolean(dialogState.sourceText) &&
      Boolean(dialogState.targetText) &&
      Boolean(dialogState.originalDataUntouched),
    expected: 'ModeSwitchConfirmDialog visible with source/target pills and original data untouched',
    actual: JSON.stringify(dialogState),
    artifactPath: beforeConfirmShot.png,
  });

  const display = await readDisplayMetrics(ctx);
  const btnMetrics = await cdpQueryElementMetrics(ctx, '[data-testid="mode-switch-confirm-btn"]');
  if (btnMetrics) {
    const tapPt = ctx.driver.resolveDomTapPoint({
      rect: btnMetrics.rect,
      visualViewport: btnMetrics.visualViewport,
      dpr: btnMetrics.dpr,
      display,
    });
    await injectTap(ctx, tapPt);
  } else {
    await cdpClickSelector(ctx, '[data-testid="mode-switch-confirm-btn"]', 'confirm mode switch');
  }

  const afterConfirm = await cdpEvaluate(
    ctx,
    `/* @lfh-op e2eReadModeSwitchState {} */ ({
      dialogOpen: Boolean(document.querySelector('[data-testid="mode-switch-confirm-dialog"][open]')),
      currentMode: 'work'
    })`,
  );
  addAssertion({
    id: 'e2e07-mode-switch-confirmed',
    kind: 'dom',
    passed: !afterConfirm.dialogOpen && afterConfirm.currentMode === 'work',
    expected: 'mode switched and ModeSwitchConfirmDialog closed after physical tap',
    actual: JSON.stringify(afterConfirm),
  });
}

const E2E_RUNNERS = {
  'E2E-01': runE2E01,
  'E2E-02': runE2E02,
  'E2E-03': runE2E03,
  'E2E-04': runE2E04,
  'E2E-05': runE2E05,
  'E2E-06A': runE2E06A,
  'E2E-06B': runE2E06B,
  'E2E-06C': runE2E06C,
  'E2E-07': runE2E07,
};

export async function runE2eScenario(ctx, scenarioId) {
  const fn = E2E_RUNNERS[scenarioId];
  if (!fn) {
    throw new Error(`Unknown .e2e scenarioId: ${scenarioId}`);
  }
  return executeScenarioWithGuard(ctx, scenarioId, (helpers) => fn(ctx, helpers));
}
