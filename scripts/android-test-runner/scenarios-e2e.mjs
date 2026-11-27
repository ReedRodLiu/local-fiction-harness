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

async function dismissTutorialIfOpen(ctx) {
  if (ctx.uiDriver) {
    const tut = await ctx.uiDriver.readTutorialState(ctx);
    if (tut?.open) {
      await cdpClickSelector(ctx, '[data-testid="spotlight-skip-btn"]', 'skip spotlight tutorial');
    }
    return;
  }
  const hasSkip = await cdpEvaluate(
    ctx,
    `Boolean(document.querySelector('[data-testid="spotlight-tutorial"][open] [data-testid="spotlight-skip-btn"]'))`,
  );
  if (hasSkip) {
    await cdpClickSelector(
      ctx,
      '[data-testid="spotlight-tutorial"][open] [data-testid="spotlight-skip-btn"]',
      'skip spotlight tutorial',
    );
    await waitForCondition(
      async () => {
        const open = await cdpEvaluate(
          ctx,
          `Boolean(document.querySelector('[data-testid="spotlight-tutorial"][open]'))`,
        );
        return !open;
      },
      { description: 'spotlight tutorial closed', timeoutMs: TIMEOUTS.domStableMs },
    );
  }
}

async function openSettingsPage(ctx, { dismissTutorial = true } = {}) {
  if (dismissTutorial) {
    await dismissTutorialIfOpen(ctx);
  }
  const snap = await cdpReadSnapshot(ctx);
  if (!snap.settingsOpen) {
    await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
    await waitForCondition(
      async () => {
        const s = await cdpReadSnapshot(ctx);
        return s.drawerOpen ? s : null;
      },
      { description: 'drawer open for settings', timeoutMs: TIMEOUTS.domStableMs },
    );
    await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
    await waitForCondition(
      async () => {
        const s = await cdpReadSnapshot(ctx);
        return s.settingsOpen ? s : null;
      },
      { description: 'settings page open', timeoutMs: TIMEOUTS.domStableMs },
    );
  }
  if (dismissTutorial) {
    await dismissTutorialIfOpen(ctx);
  }
}

async function closeSettingsPage(ctx) {
  const snap = await cdpReadSnapshot(ctx);
  if (!snap.settingsOpen) return;
  await cdpClickSelector(ctx, '[data-testid="settings-page"] button[aria-label="返回"]', 'close settings');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.settingsOpen ? s : null;
    },
    { description: 'settings page closed', timeoutMs: TIMEOUTS.domStableMs },
  );
}

async function readProviderState(ctx) {
  if (ctx.uiDriver?.readProviderState) {
    return ctx.uiDriver.readProviderState(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      const activeModelBtn = document.querySelector('[data-testid^="settings-model-option-"][aria-pressed="true"]');
      const activeModelAttr = activeModelBtn?.getAttribute('data-testid') ?? '';
      const activeModel = activeModelAttr.startsWith('settings-model-option-')
        ? activeModelAttr.slice('settings-model-option-'.length)
        : '';
      const baseUrlCode =
        document.querySelector('[data-testid="active-provider-base-url"] code')?.textContent?.trim() ??
        document.querySelector('[data-testid="active-provider-base-url"]')?.textContent?.trim() ??
        '';
      return {
        profileCount: items.length,
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? null,
        activeBaseUrl: baseUrlCode,
        activeModel,
        profiles: items.map((el) => ({
          id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '',
          name: el.querySelector('strong')?.textContent?.trim() ?? '',
          presetId: el.querySelector('.badge')?.textContent?.trim() ?? '',
        })),
      };
    })()`,
  );
}

async function readTutorialState(ctx) {
  if (ctx.uiDriver?.readTutorialState) {
    return ctx.uiDriver.readTutorialState(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(() => {
      const STEP_TARGETS = {
        'main-welcome-library': ['#turn-input', '[data-testid="stage-composer"] textarea'],
        'main-model-reasoning': ['[data-testid="composer-generation-controls"]'],
        'main-narrative-presets': ['[data-testid="composer-narrative-preset-trigger"]'],
        'main-connect-deepseek': [
          '[data-testid="welcome-key-hint"]',
          '[data-testid="desktop-settings-open"]',
          '[data-testid="library-drawer-trigger"]',
          '[data-testid="desktop-library-toggle"]',
        ],
        'settings-connection': ['[data-testid="settings-connection-group"]'],
        'settings-usage-overview': ['[data-testid="settings-usage-overview"]'],
        'settings-narrative-presets': ['[data-testid="settings-narrative-presets-group"]'],
        'settings-backup-replay': ['[data-testid="settings-backup-group"]'],
      };
      const dialog = document.querySelector('[data-testid="spotlight-tutorial"][open]');
      if (!dialog) {
        return {
          open: false,
          stepId: null,
          cutoutRect: null,
          targetRect: null,
          nextBtnUnobscured: false,
          skipBtnUnobscured: false,
        };
      }
      const stepId = dialog.getAttribute('data-step-id') ?? '';
      const cutout = document.querySelector('[data-testid="spotlight-cutout"]');
      const nextBtn = document.querySelector(
        '[data-testid="spotlight-next-btn"], [data-testid="tutorial-connect-cta"], [data-testid="spotlight-finish-btn"]',
      );
      const skipBtn = document.querySelector('[data-testid="spotlight-skip-btn"]');
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      let targetEl = null;
      for (const sel of STEP_TARGETS[stepId] ?? []) {
        const candidate = document.querySelector(sel);
        if (candidate) {
          const r = candidate.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            targetEl = candidate;
            break;
          }
        }
      }
      const isUnobscured = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cx = Math.max(0, Math.min(r.left + r.width / 2, window.innerWidth - 1));
        const cy = Math.max(0, Math.min(r.top + r.height / 2, window.innerHeight - 1));
        const hit = document.elementFromPoint(cx, cy);
        return Boolean(hit && (hit === el || el.contains(hit)));
      };
      return {
        open: true,
        stepId,
        cutoutRect: rectOf(cutout),
        targetRect: rectOf(targetEl),
        nextBtnUnobscured: isUnobscured(nextBtn),
        skipBtnUnobscured: isUnobscured(skipBtn),
      };
    })()`,
  );
}

async function readScrollMetrics(ctx) {
  if (ctx.uiDriver?.readScrollMetrics) {
    return ctx.uiDriver.readScrollMetrics(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(() => {
      const stage =
        document.querySelector('[data-testid="writing-discussion-timeline"]') ??
        document.querySelector('[data-testid="character-timeline"]') ??
        document.querySelector('.main-stage');
      const stageScrollGapPx = stage
        ? Math.max(0, Math.round(stage.scrollHeight - stage.scrollTop - stage.clientHeight))
        : 0;
      const drawerList = document.querySelector('[data-testid="library-list-scroll"]');
      return {
        drawerScrollTop: drawerList ? drawerList.scrollTop : 0,
        stageScrollGapPx,
        showScrollToBottom: Boolean(document.querySelector('[data-testid="scroll-to-bottom"]')),
        stageScrollHeight: stage ? stage.scrollHeight : 0,
        stageClientHeight: stage ? stage.clientHeight : 0,
      };
    })()`,
  );
}

async function selectLockedCategoryAndNewCreation(ctx, modeLabel) {
  await dismissTutorialIfOpen(ctx);
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.drawerOpen ? s : null;
    },
    { description: 'drawer open for mode switch', timeoutMs: TIMEOUTS.domStableMs },
  );
  if (ctx.uiDriver?.selectLibraryCategory) {
    const modeMap = { 文游: 'story', 写故事: 'writing', 角色互动: 'character' };
    await ctx.uiDriver.selectLibraryCategory(ctx, modeMap[modeLabel] ?? 'story');
  } else {
    const clickedTab = await cdpEvaluate(
      ctx,
      `(() => {
        const tabs = [...document.querySelectorAll('.library-categories button')];
        const target = tabs.find((b) => b.textContent?.trim() === ${JSON.stringify(modeLabel)});
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`,
    );
    if (!clickedTab) {
      throw new Error(`Library category tab "${modeLabel}" not found.`);
    }
  }
  await cdpClickSelector(ctx, '[data-testid="mobile-library-new-creation"]', 'new creation');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.drawerOpen ? s : null;
    },
    { description: 'drawer closed after new creation', timeoutMs: TIMEOUTS.domStableMs },
  );
}

async function submitComposerPrompt(ctx, opts) {
  if (ctx.uiDriver?.sendTurn) {
    return ctx.uiDriver.sendTurn(ctx, opts);
  }
  const textareaSelector =
    opts.textareaSelector ??
    '#turn-input, #writing-discussion-input, #character-chat-input, [data-testid="stage-composer"] textarea';
  await cdpFillInput(ctx, textareaSelector, opts.prompt, 'composer prompt');
  await cdpClickSelector(
    ctx,
    '[data-testid="stage-composer"] button[type="submit"], .composer-send[type="submit"]',
    'submit composer turn',
  );
  return true;
}

async function readTurnState(ctx) {
  if (ctx.uiDriver?.readTurnState) {
    return ctx.uiDriver.readTurnState(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(async () => {
      const cards = [...document.querySelectorAll('[data-testid="turn-assistant"]')];
      const lastCard = cards[cards.length - 1] ?? null;
      const streamingEl = document.querySelector('.turn-streaming');
      const errorBanner = document.querySelector('[data-testid="main-error-banner"], [data-testid="async-error-banner"]');
      let errorCode = null;
      try {
        const rawDiag = localStorage.getItem('lfh.diagnostics.v2');
        if (rawDiag) {
          const parsed = JSON.parse(rawDiag);
          const events = Array.isArray(parsed?.events) ? parsed.events : [];
          for (let i = events.length - 1; i >= 0; i -= 1) {
            if (events[i]?.errorCode) {
              errorCode = events[i].errorCode;
              break;
            }
          }
        }
      } catch {}

      let refusalRoute = null;
      try {
        const nv = window.Capacitor?.Plugins?.NativeVault;
        if (nv && typeof nv.listStories === 'function') {
          const res = await nv.listStories();
          const stories = [...(res?.stories ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          for (const st of stories) {
            const nodes = Object.values(st?.nodes ?? {});
            const assistantNodes = nodes
              .filter((n) => n && n.role === 'assistant' && n.diagnostics?.refusalRoute)
              .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            if (assistantNodes[0]?.diagnostics?.refusalRoute) {
              refusalRoute = assistantNodes[0].diagnostics.refusalRoute;
              break;
            }
          }
        }
      } catch {}

      return {
        assistantCount: cards.length,
        lastAssistantText: lastCard?.textContent ?? '',
        isStreaming: Boolean(streamingEl),
        hasErrorBanner: Boolean(errorBanner),
        errorBannerText: errorBanner?.textContent ?? '',
        errorCode,
        hasRecoveredBadge: Boolean(document.querySelector('[data-testid="turn-refusal-recovered-badge"]')),
        refusalRoute,
        reasoningPresent: Boolean(document.querySelector('[data-testid="reasoning-details"]')),
      };
    })()`,
  );
}

async function ensurePresetPickerExpanded(ctx) {
  if (ctx.uiDriver?.clickSelector) {
    const snap = await cdpReadSnapshot(ctx);
    if (snap?.presetPickerOpen === false) {
      await cdpClickSelector(ctx, '[data-testid="provider-preset-picker-trigger"]', 'expand preset picker');
    }
    return;
  }
  const needsExpand = await cdpEvaluate(
    ctx,
    `Boolean(document.querySelector('[data-testid="provider-preset-picker-trigger"][aria-expanded="false"]'))`,
  );
  if (needsExpand) {
    await cdpClickSelector(ctx, '[data-testid="provider-preset-picker-trigger"]', 'expand preset picker');
  }
}

async function ensureMockProfileConnected(ctx) {
  await openSettingsPage(ctx);
  const state = await readProviderState(ctx);
  if (state?.profileCount >= 2 && String(state.activeBaseUrl ?? '').includes('127.0.0.1')) {
    await closeSettingsPage(ctx);
    return state;
  }
  const baseUrl = getMockDeviceBaseUrl(ctx);
  await cdpClickSelector(
    ctx,
    '[data-testid="open-setup-wizard-btn"], [data-testid="add-provider-profile-btn"]',
    'open provider wizard',
  );
  await ensurePresetPickerExpanded(ctx);
  await cdpClickSelector(
    ctx,
    '[data-testid="provider-preset-custom"], [data-testid="provider-preset-local"]',
    'select custom preset',
  );
  await cdpFillInput(ctx, '[data-testid="provider-name-input"]', 'Mock SSE Local', 'provider name');
  await cdpFillInput(ctx, '[data-testid="provider-base-url-input"]', baseUrl, 'provider baseUrl');
  await cdpFillInput(ctx, '[data-testid="provider-model-input"]', 'deepseek-chat', 'provider model');
  await cdpClickSelector(ctx, '[data-testid="wizard-verify-save-btn"]', 'verify and save profile');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.wizardOpen ? s : null;
    },
    { description: 'wizard verify and close', timeoutMs: TIMEOUTS.wizardVerifyMs },
  );
  const updated = await readProviderState(ctx);
  await closeSettingsPage(ctx);
  return updated;
}

async function runE2E01(ctx, { addAssertion }) {
  await launchApp(ctx, { clearData: true });
  await reconnectCdp(ctx);

  const mockUrl = getMockDeviceBaseUrl(ctx);
  await openSettingsPage(ctx);
  await cdpClickSelector(ctx, '[data-testid="open-setup-wizard-btn"]', 'open setup wizard');
  await ensurePresetPickerExpanded(ctx);
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

  await cdpClickSelector(ctx, '[data-testid="add-provider-profile-btn"]', 'add second profile');
  await ensurePresetPickerExpanded(ctx);
  await cdpClickSelector(ctx, '[data-testid="provider-preset-custom"]', 'custom preset 2');
  await cdpFillInput(ctx, '[data-testid="provider-name-input"]', '本地 Mock 2', 'profile 2 name');
  await cdpFillInput(ctx, '[data-testid="provider-base-url-input"]', mockUrl, 'profile 2 base url');
  await cdpFillInput(ctx, '[data-testid="provider-model-input"]', 'deepseek-reasoner', 'profile 2 model');
  await cdpClickSelector(ctx, '[data-testid="wizard-verify-save-btn"]', 'verify and save 2');

  await waitForCondition(
    async () => {
      const snap = await cdpReadSnapshot(ctx);
      return !snap.wizardOpen ? snap : null;
    },
    { description: 'wizard 2 verify and close', timeoutMs: TIMEOUTS.wizardVerifyMs },
  );

  // Switch between profiles AND switch model in Settings + Composer trigger
  const afterCreate = await readProviderState(ctx);
  const firstProfile = afterCreate.profiles.find((p) => p.id !== afterCreate.activeProfileId) ?? afterCreate.profiles[0];
  const secondProfile = afterCreate.profiles.find((p) => p.id === afterCreate.activeProfileId) ?? afterCreate.profiles[1];

  if (firstProfile && secondProfile && firstProfile.id !== secondProfile.id) {
    await cdpClickSelector(
      ctx,
      `[data-testid="provider-profile-switch-${firstProfile.id}"]`,
      'switch to profile 1',
    );
    await cdpClickSelector(
      ctx,
      `[data-testid="provider-profile-switch-${secondProfile.id}"]`,
      'switch back to profile 2',
    );
  }

  // Switch model in Settings then via composer-provider-model-trigger
  await cdpClickSelector(
    ctx,
    '[data-testid="settings-model-option-deepseek-chat"]',
    'switch model in settings',
  );
  await closeSettingsPage(ctx);
  await cdpClickSelector(
    ctx,
    '[data-testid="composer-provider-model-trigger"]',
    'open composer provider/model menu',
  );
  if (secondProfile) {
    await cdpClickSelector(
      ctx,
      `[data-testid="composer-provider-model-option-${secondProfile.id}-deepseek-reasoner"]`,
      'select reasoner in composer menu',
    );
  }
  await openSettingsPage(ctx);
  const beforeRestart = await readProviderState(ctx);

  // Cold restart and reopen Settings before reading provider-profile-list & active-provider-base-url
  await launchApp(ctx, { clearData: false, stopFirst: true });
  await reconnectCdp(ctx);
  await waitForPackageTopResumed(ctx, true, 'MainActivity topResumed after cold restart', TIMEOUTS.keyboardOrLauncherMs);
  await openSettingsPage(ctx);

  const afterRestart = await readProviderState(ctx);
  const stepShot = await safeCaptureStep(ctx, 'E2E-01', 'persisted-profiles');
  const activity = await readActivityState(ctx);

  addAssertion({
    id: 'e2e01-dual-profiles-persisted',
    kind: 'storage',
    passed:
      Number(afterRestart?.profileCount) >= 2 &&
      afterRestart?.activeProfileId === beforeRestart?.activeProfileId &&
      afterRestart?.activeModel === beforeRestart?.activeModel &&
      String(afterRestart?.activeBaseUrl ?? '').includes('127.0.0.1'),
    expected: 'profileCount>=2 and activeProfileId/activeModel/baseUrl persisted across cold restart',
    actual: JSON.stringify({
      profileCount: afterRestart?.profileCount,
      activeProfileId: afterRestart?.activeProfileId,
      beforeProfileId: beforeRestart?.activeProfileId,
      activeModel: afterRestart?.activeModel,
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

  await closeSettingsPage(ctx);
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
        const state = await readTutorialState(ctx);
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
        tapPoint.y <= display.displayH - display.safeInsetsPx.bottom &&
        tapPoint.x >= display.safeInsetsPx.left &&
        tapPoint.x <= display.displayW - display.safeInsetsPx.right,
    );
    const cutoutOverlaps = rectsOverlap(tut.cutoutRect, tut.targetRect);
    const shot = await safeCaptureStep(ctx, scenarioId, `${stageLabel}-step-${i + 1}`);

    addAssertion({
      id: `e2e02-${stageLabel}-step-${i + 1}-safe-area`,
      kind: 'dom',
      passed:
        cutoutOverlaps &&
        Boolean(tut.nextBtnUnobscured) &&
        Boolean(tut.skipBtnUnobscured) &&
        inSafeArea,
      expected: 'cutout overlaps real targetRect, buttons unobscured via elementFromPoint, tap in safe area',
      actual: JSON.stringify({
        stepId: tut.stepId,
        cutoutRect: tut.cutoutRect,
        targetRect: tut.targetRect,
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

  // Restart app and verify tutorial does NOT auto-open once completed
  await launchApp(ctx, { clearData: false, stopFirst: true });
  await reconnectCdp(ctx);
  await waitForPackageTopResumed(ctx, true, 'MainActivity resumed after tutorial completion', TIMEOUTS.keyboardOrLauncherMs);
  await sleep(ctx.dryRun ? 10 : 400);
  const afterRestart = await readTutorialState(ctx);

  // Open Settings and verify replay-tutorial-btn reopens tutorial
  await openSettingsPage(ctx, { dismissTutorial: false });
  await cdpClickSelector(ctx, '[data-testid="replay-tutorial-btn"]', 'replay tutorial');
  const replayed = await waitForCondition(
    async () => {
      const state = await readTutorialState(ctx);
      return state?.open ? state : null;
    },
    { description: 'spotlight tutorial reopened on replay', timeoutMs: TIMEOUTS.domStableMs },
  );

  addAssertion({
    id: 'e2e02-replay-tutorial',
    kind: 'dom',
    passed: !afterRestart?.open && Boolean(replayed?.open),
    expected: 'tutorial stays closed across restart and reopens on replay-tutorial-btn',
    actual: JSON.stringify({ autoOpenedAfterRestart: afterRestart?.open, replayedOpen: replayed?.open }),
  });

  await dismissTutorialIfOpen(ctx);
}

async function seedStoriesForScroll(ctx, count = 12) {
  if (ctx.uiDriver?.seedStories) {
    return ctx.uiDriver.seedStories(ctx, count);
  }
  await cdpEvaluate(
    ctx,
    `(async () => {
      const nv = window.Capacitor?.Plugins?.NativeVault;
      const now = Date.now();
      for (let i = 1; i <= ${count}; i += 1) {
        const storyId = 'e2e03-seed-' + i;
        const story = {
          id: storyId,
          title: '滑动测试故事 ' + i,
          updatedAt: now + i,
          activeLeafNodeId: null,
          nodes: {},
          setupNodeIds: [],
          settingMarkdown: '## 设定\\n滑动测试',
        };
        if (nv && typeof nv.saveStory === 'function') {
          await nv.saveStory({ story });
        }
      }
      location.reload();
      return true;
    })()`,
  );
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.readyState === 'complete' ? s : null;
    },
    { description: 'page reloaded with seeded stories', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );
  return count;
}

async function runE2E03(ctx, { addAssertion }) {
  await dismissTutorialIfOpen(ctx);
  await seedStoriesForScroll(ctx, 12);

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
  const scrollMetrics = await readScrollMetrics(ctx);
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
  await openSettingsPage(ctx);
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

  // 5) Intentional OS edge back swipe -> waitForCondition for Launcher / background activity transition
  const edgeSwipe = ctx.driver.resolveOsEdgeBackSwipe({
    display,
    systemGestureLeftPx: display.systemGestureEdgePx.left,
  });
  await injectSwipe(ctx, edgeSwipe);
  const launcherCheck = await waitForCondition(
    async () => {
      const st = await readActivityState(ctx);
      return st.launcherTopResumed || !st.isPackageTopResumed ? st : null;
    },
    { description: 'Launcher after OS edge back swipe', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );
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

async function injectZipIntoDeepSeekPanel(ctx, zipBase64) {
  if (ctx.uiDriver?.importDeepSeekZip) {
    return ctx.uiDriver.importDeepSeekZip(ctx, { zipBase64 });
  }
  const injected = await cdpEvaluate(
    ctx,
    `(() => {
      const input = document.querySelector('#deepseek-zip-input');
      if (!(input instanceof HTMLInputElement)) return false;
      const bin = atob(${JSON.stringify(zipBase64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'deepseek-export.zip', { type: 'application/zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!injected) {
    throw new Error('Failed to inject synthetic DeepSeek zip into #deepseek-zip-input.');
  }
  return true;
}

async function runE2E04(ctx, { addAssertion }) {
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);
  await dismissTutorialIfOpen(ctx);

  // Step 1: Crash / async error -> open DiagnosticsPreview -> reload stale history -> single KEYCODE_BACK -> Launcher
  if (ctx.uiDriver?.triggerCrashDiagnostics) {
    await ctx.uiDriver.triggerCrashDiagnostics(ctx);
  } else {
    await cdpEvaluate(
      ctx,
      `window.dispatchEvent(new ErrorEvent('error', {
        error: new Error('lfh-e2e04 crash'),
        message: 'lfh-e2e04 crash'
      }))`,
    );
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('[data-testid="async-error-banner-action"]'))`))
          ? true
          : null,
      { description: 'async error banner open', timeoutMs: TIMEOUTS.domStableMs },
    );
    await cdpClickSelector(ctx, '[data-testid="async-error-banner-action"]', 'open diagnostics from error banner');
    await waitForCondition(
      async () => {
        const s = await cdpReadSnapshot(ctx);
        return s.diagnosticsOpen ? s : null;
      },
      { description: 'diagnostics preview open', timeoutMs: TIMEOUTS.domStableMs },
    );
  }
  const beforeReloadSnap = await cdpReadSnapshot(ctx);
  const crashShot = await safeCaptureStep(ctx, 'E2E-04', 'crash-overlay-open');
  await cdpClickSelector(ctx, '[data-testid="diagnostics-reload"]', 'reload diagnostics');
  const afterReload = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.readyState === 'complete' && s.sessionToken !== beforeReloadSnap.sessionToken ? s : null;
    },
    { description: 'page reloaded after diagnostics-reload', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );
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
    passed: verdict.valid && afterReload.overlayDepth === 0,
    expected: 'evaluateLauncherEvidence valid=true after stale history back',
    actual: JSON.stringify({
      valid: verdict.valid,
      failures: verdict.failures,
      overlayDepth: afterReload.overlayDepth,
    }),
    artifactPath: launcherShot.png ?? crashShot.png,
  });

  // Step 2: Real Settings + BYOK -> 2x KEYCODE_BACK; Drawer + StoryMenu -> unwind; ImportPreview -> unwind
  await launchApp(ctx, { clearData: false });
  await reconnectCdp(ctx);
  await dismissTutorialIfOpen(ctx);

  await openSettingsPage(ctx);
  await cdpClickSelector(
    ctx,
    '[data-testid="change-key-btn"], [data-testid="open-setup-wizard-btn"]',
    'open BYOK wizard',
  );
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.wizardOpen ? s : null;
    },
    { description: 'BYOK wizard open in Settings', timeoutMs: TIMEOUTS.domStableMs },
  );
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterByokBack = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.wizardOpen ? s : null;
    },
    { description: 'wizard closed on back', timeoutMs: TIMEOUTS.domStableMs },
  );
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterSettingsBack = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.settingsOpen && s.overlayDepth === 0 ? s : null;
    },
    { description: 'settings closed on back', timeoutMs: TIMEOUTS.domStableMs },
  );

  // Drawer + Story overflow menu
  await seedStoriesForScroll(ctx, 2);
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer for menu');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.drawerOpen ? s : null;
    },
    { description: 'drawer open for story menu', timeoutMs: TIMEOUTS.domStableMs },
  );
  await cdpClickSelector(ctx, '[data-testid="story-menu-trigger"]', 'open story overflow menu');
  await pressKeyevent(ctx, 'KEYCODE_DPAD_DOWN');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterDrawerBack = await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.drawerOpen && s.overlayDepth === 0 ? s : null;
    },
    { description: 'drawer + story menu unwound on back', timeoutMs: TIMEOUTS.domStableMs },
  );

  // DeepSeek import + preview sheet unwind
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer for import preview');
  await cdpClickSelector(ctx, '[data-testid="mobile-library-start-deepseek"]', 'open DeepSeek import');
  if (!ctx.uiDriver) {
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('#deepseek-zip-input'))`)) ? true : null,
      { description: 'DeepSeek import zip input ready', timeoutMs: TIMEOUTS.domStableMs },
    );
    await injectZipIntoDeepSeekPanel(ctx, buildSyntheticDeepSeekZipBase64());
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('[data-testid="ds-session-preview-trigger"]'))`))
          ? true
          : null,
      { description: 'DeepSeek session preview trigger visible', timeoutMs: TIMEOUTS.domStableMs },
    );
  }
  await cdpClickSelector(ctx, '[data-testid="ds-session-preview-trigger"]', 'open preview sheet');
  await pressKeyevent(ctx, 'KEYCODE_BACK');
  const afterImportPreviewBack = await cdpReadSnapshot(ctx);
  await pressKeyevent(ctx, 'KEYCODE_BACK');

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

  const modePairs = [
    ['story', '文游'],
    ['work', '写故事'],
    ['character', '角色互动'],
  ];

  for (const [mode, modeLabel] of modePairs) {
    await selectLockedCategoryAndNewCreation(ctx, modeLabel);
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

    const routeMode = mode === 'work' ? 'writing' : mode;
    ctx.mockSse?.enqueueScenario({
      chunkDelayMs: 6,
      chunks: [
        {
          content: `\`\`\`lfh-route\nmode: ${routeMode}\ntitle: E2E-05-${mode}\n---\n## 设定\n自动滚动长文测试\n\`\`\`\n`,
        },
        ...Array.from({ length: 12 }, (_, idx) => ({
          content: `高频自动滚动长文本段落-${mode}-${idx + 1}：雨夜车站的灯光沿着湿润站台延伸，远处的信号灯依次亮起。\n\n`,
          ...(idx === 11 ? { finish_reason: 'stop' } : {}),
        })),
      ],
    });

    await submitComposerPrompt(ctx, {
      scenarioId: 'E2E-05',
      mode,
      prompt: `E2E-05 ${mode} 滚动测试`,
      mockUrl,
      endpointPath: '/v1/chat/completions',
    });

    await waitForCondition(
      async () => {
        const ts = await readTurnState(ctx);
        return !ts.isStreaming && String(ts.lastAssistantText ?? '').includes(`高频自动滚动长文本段落-${mode}-12`)
          ? ts
          : null;
      },
      { description: `${mode} initial streaming turn complete`, timeoutMs: TIMEOUTS.postBackgroundSettleMs },
    );

    const scrollMetrics = await readScrollMetrics(ctx);

    // Swipe down finger movement (scrolls upward in history) to pause auto-scroll
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

    const pausedMetrics = await waitForCondition(
      async () => {
        const m = await readScrollMetrics(ctx);
        return m?.showScrollToBottom ? m : null;
      },
      { description: `${mode} scroll-to-bottom visible after upward scroll`, timeoutMs: TIMEOUTS.domStableMs },
    );

    // Send another turn and verify auto-scroll resumes
    ctx.mockSse?.enqueueScenario({
      chunks: [{ content: `恢复跟随-${mode}`, finish_reason: 'stop' }],
    });
    await submitComposerPrompt(ctx, {
      scenarioId: 'E2E-05',
      mode,
      prompt: `E2E-05 ${mode} 恢复跟随`,
      mockUrl,
      endpointPath: '/v1/chat/completions',
    });

    const resumedMetrics = await waitForCondition(
      async () => {
        const ts = await readTurnState(ctx);
        const m = await readScrollMetrics(ctx);
        if (!ts.isStreaming && String(ts.lastAssistantText ?? '').includes(`恢复跟随-${mode}`) && Number(m?.stageScrollGapPx) <= 24) {
          return m;
        }
        return null;
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
  await selectLockedCategoryAndNewCreation(ctx, '文游');
  const mockUrl = getMockEvalBaseUrl(ctx);

  ctx.mockSse?.enqueueScenario({
    chunkDelayMs: ctx.dryRun ? 15 : 800,
    chunks: [
      { content: '```lfh-route\nmode: story\ntitle: E2E-06A保活\n---\n## 设定\n保活测试\n```\n' },
      { content: '第一段、' },
      { content: '第二段、' },
      { content: '第三段、' },
      { content: '后台保活第四段、' },
      { content: '后台保活第五段、' },
      { content: '完整收尾。', finish_reason: 'stop' },
    ],
  });

  const turnPromise = submitComposerPrompt(ctx, {
    scenarioId: 'E2E-06A',
    mode: 'story',
    prompt: 'E2E-06A Home切后台保活',
    mockUrl,
    endpointPath: '/v1/chat/completions',
  });

  // Wait until >= 3 SSE chunks appear in DOM BEFORE sending KEYCODE_HOME
  await waitForCondition(
    async () => {
      const ts = await readTurnState(ctx);
      if (ts.hasErrorBanner) return ts;
      if (typeof ts.streamingChunkCount === 'number' && ts.streamingChunkCount >= 3) return ts;
      if (String(ts.lastAssistantText ?? '').includes('第三段')) return ts;
      if (!ts.isStreaming && String(ts.lastAssistantText ?? '').includes('完整收尾')) return ts;
      return null;
    },
    { description: 'E2E-06A >= 3 SSE chunks visible in DOM before KEYCODE_HOME', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
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
      const s = await readTurnState(ctx);
      return (!s.isStreaming && String(s.lastAssistantText ?? '').includes('完整收尾')) || s.hasErrorBanner
        ? s
        : null;
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
      errorCode: turnState.errorCode,
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
  await selectLockedCategoryAndNewCreation(ctx, '文游');
  const mockUrl = getMockEvalBaseUrl(ctx);

  ctx.mockSse?.enqueueScenario({
    chunkDelayMs: ctx.dryRun ? 20 : 1200,
    chunks: [
      { content: '```lfh-route\nmode: story\ntitle: E2E-06B息屏保活\n---\n## 设定\n息屏测试\n```\n' },
      { content: '息屏前首包、' },
      { content: '息屏期缓冲二、' },
      { content: '息屏期缓冲三、' },
      { content: '亮屏后完整收尾。', finish_reason: 'stop' },
    ],
  });

  const turnPromise = submitComposerPrompt(ctx, {
    scenarioId: 'E2E-06B',
    mode: 'story',
    prompt: 'E2E-06B Power息屏保活',
    mockUrl,
    endpointPath: '/v1/chat/completions',
  });

  // Wait until >= 1 SSE chunk appears in DOM BEFORE sending KEYCODE_POWER
  await waitForCondition(
    async () => {
      const ts = await readTurnState(ctx);
      if (ts.hasErrorBanner) return ts;
      if (typeof ts.streamingChunkCount === 'number' && ts.streamingChunkCount >= 1) return ts;
      if (String(ts.lastAssistantText ?? '').includes('息屏前首包')) return ts;
      if (!ts.isStreaming && String(ts.lastAssistantText ?? '').includes('亮屏后完整收尾')) return ts;
      return null;
    },
    { description: 'E2E-06B >= 1 SSE chunk visible in DOM before KEYCODE_POWER', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
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
      const s = await readTurnState(ctx);
      return (!s.isStreaming && String(s.lastAssistantText ?? '').includes('亮屏后完整收尾')) || s.hasErrorBanner
        ? s
        : null;
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
  await selectLockedCategoryAndNewCreation(ctx, '文游');
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

  await submitComposerPrompt(ctx, {
    scenarioId: 'E2E-06C',
    mode: 'story',
    prompt: 'E2E-06C 断流子用例1',
    mockUrl,
    endpointPath: '/v1/chat/completions',
    expectAbort: true,
  });

  const abortedState = await waitForCondition(
    async () => {
      const s = await readTurnState(ctx);
      return s?.hasErrorBanner ? s : null;
    },
    { description: 'E2E-06C abort detection in DOM', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );

  const abortLogcat = String(
    await runAdb(ctx, ['logcat', '-d', '-v', 'threadtime'], { allowFailure: true }) ?? '',
  );
  const logcatClassificationMatch = abortLogcat.match(
    /SseStreamClient[^\n]*(CONNECTION_ABORTED|STREAM_EOF|SOCKET_RESET)/,
  );
  const detectedAbortCode =
    logcatClassificationMatch?.[1] ??
    abortedState.errorCode ??
    null;

  await submitComposerPrompt(ctx, {
    scenarioId: 'E2E-06C',
    mode: 'story',
    prompt: 'E2E-06C 重试',
    mockUrl,
    endpointPath: '/v1/chat/completions',
  });

  const retryState = await waitForCondition(
    async () => {
      const s = await readTurnState(ctx);
      return !s.isStreaming && String(s.lastAssistantText ?? '').includes('断点重试成功收尾') ? s : null;
    },
    { description: 'E2E-06C retry recovery', timeoutMs: TIMEOUTS.domStableMs },
  );

  addAssertion({
    id: 'e2e06c-abort-classification-and-retry',
    kind: 'dom',
    passed:
      Boolean(abortedState.hasErrorBanner) &&
      (detectedAbortCode === 'CONNECTION_ABORTED' ||
        detectedAbortCode === 'STREAM_EOF' ||
        detectedAbortCode === 'SOCKET_RESET') &&
      !retryState.hasErrorBanner &&
      String(retryState.lastAssistantText ?? '').includes('断点重试成功收尾'),
    expected: 'real SseStreamClient abort classification (CONNECTION_ABORTED/STREAM_EOF/SOCKET_RESET) + retry succeeds',
    actual: JSON.stringify({
      detectedAbortCode,
      abortedBanner: abortedState.hasErrorBanner,
      retryText: retryState.lastAssistantText,
    }),
  });

  // Subcase 2: half-refusal -> Narrative Continuity automatic recovery
  ctx.mockSse?.enqueueScenarios([
    { halfRefusal: true },
    { chunks: [{ content: '叙事连贯保护重拟成功。', finish_reason: 'stop' }] },
  ]);

  await submitComposerPrompt(ctx, {
    scenarioId: 'E2E-06C',
    mode: 'story',
    prompt: 'E2E-06C 半拒绝子用例2',
    mockUrl,
    endpointPath: '/beta/chat/completions',
    expectHalfRefusal: true,
  });

  const refusalRecovered = await waitForCondition(
    async () => {
      const s = await readTurnState(ctx);
      return !s.isStreaming && String(s.lastAssistantText ?? '').includes('叙事连贯保护重拟成功')
        ? s
        : null;
    },
    { description: 'E2E-06C half-refusal recovery', timeoutMs: TIMEOUTS.postBackgroundSettleMs },
  );
  const shot = await safeCaptureStep(ctx, 'E2E-06C', 'half-refusal-recovered');

  addAssertion({
    id: 'e2e06c-half-refusal-continuity-recovery',
    kind: 'dom',
    passed:
      Boolean(refusalRecovered?.hasRecoveredBadge) &&
      refusalRecovered?.refusalRoute === 'retry' &&
      String(refusalRecovered?.lastAssistantText ?? '').includes('叙事连贯保护重拟成功'),
    expected: 'persisted NodeDiagnostics.refusalRoute=retry and recovered badge visible',
    actual: JSON.stringify(refusalRecovered),
    artifactPath: shot.png,
  });
}

async function readModeSwitchState(ctx) {
  if (ctx.uiDriver?.readModeSwitchState) {
    return ctx.uiDriver.readModeSwitchState(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(async () => {
      const dialog = document.querySelector('[data-testid="mode-switch-confirm-dialog"][open]');
      const sourceText = document.querySelector('[data-testid="mode-switch-source"]')?.textContent?.trim() ?? '';
      const targetText = document.querySelector('[data-testid="mode-switch-target"]')?.textContent?.trim() ?? '';
      const currentMode = document.querySelector('[data-testid="writing-page"]')
        ? 'writing'
        : document.querySelector('[data-testid="character-page"]')
          ? 'character'
          : 'story';
      let storyCount = 0;
      try {
        const nv = window.Capacitor?.Plugins?.NativeVault;
        if (nv && typeof nv.listStories === 'function') {
          const res = await nv.listStories();
          storyCount = Array.isArray(res?.stories) ? res.stories.length : 0;
        }
      } catch {}
      return {
        dialogOpen: Boolean(dialog),
        sourceText,
        targetText,
        currentMode,
        storyCount,
      };
    })()`,
  );
}

async function runE2E07(ctx, { addAssertion }) {
  const zipBase64 = buildSyntheticDeepSeekZipBase64();
  await dismissTutorialIfOpen(ctx);

  if (ctx.uiDriver?.importDeepSeekZip) {
    await ctx.uiDriver.importDeepSeekZip(ctx, { zipBase64 });
  } else {
    await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer for import');
    await cdpClickSelector(ctx, '[data-testid="mobile-library-start-deepseek"]', 'open DeepSeek import');
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('#deepseek-zip-input'))`)) ? true : null,
      { description: 'DeepSeek import file input visible', timeoutMs: TIMEOUTS.domStableMs },
    );
    await injectZipIntoDeepSeekPanel(ctx, zipBase64);
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('[data-testid="ds-confirm-import-btn"]'))`))
          ? true
          : null,
      { description: 'DeepSeek confirm import button ready', timeoutMs: TIMEOUTS.domStableMs },
    );
    await cdpClickSelector(ctx, '[data-testid="ds-confirm-import-btn"]', 'confirm DeepSeek import');
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('[data-testid^="ds-receipt-open-"]'))`))
          ? true
          : null,
      { description: 'DeepSeek import receipt visible', timeoutMs: TIMEOUTS.domStableMs },
    );
    await cdpClickSelector(ctx, '[data-testid^="ds-receipt-open-"]', 'open imported story');
    await waitForCondition(
      async () =>
        (await cdpEvaluate(ctx, `Boolean(document.querySelector('[data-testid="story-timeline"]'))`))
          ? true
          : null,
      { description: 'imported story timeline active', timeoutMs: TIMEOUTS.domStableMs },
    );
  }

  const beforeSwitch = await readModeSwitchState(ctx);
  if (ctx.uiDriver?.triggerModeSwitch) {
    await ctx.uiDriver.triggerModeSwitch(ctx, {
      mode: 'story',
      prompt: '切换到写故事',
    });
  } else {
    await submitComposerPrompt(ctx, {
      scenarioId: 'E2E-07',
      mode: 'story',
      prompt: '切换到写故事',
    });
  }

  const dialogState = await waitForCondition(
    async () => {
      const s = await readModeSwitchState(ctx);
      return s?.dialogOpen ? s : null;
    },
    { description: 'ModeSwitchConfirmDialog open', timeoutMs: TIMEOUTS.keyboardOrLauncherMs },
  );

  const beforeConfirmShot = await safeCaptureStep(ctx, 'E2E-07', 'mode-switch-confirm-dialog');
  const originalDataUntouched =
    ctx.uiDriver
      ? Boolean(dialogState.originalDataUntouched)
      : dialogState.storyCount === beforeSwitch.storyCount && dialogState.currentMode === 'story';

  addAssertion({
    id: 'e2e07-mode-switch-dialog-visible',
    kind: 'dom',
    passed:
      Boolean(dialogState.dialogOpen) &&
      Boolean(dialogState.sourceText) &&
      Boolean(dialogState.targetText) &&
      originalDataUntouched,
    expected: 'ModeSwitchConfirmDialog visible with source/target pills and original data untouched',
    actual: JSON.stringify({ ...dialogState, originalDataUntouched }),
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

  const afterConfirm = await waitForCondition(
    async () => {
      const s = await readModeSwitchState(ctx);
      return !s.dialogOpen && s.currentMode === 'writing' ? s : null;
    },
    { description: 'mode switched to writing after confirm tap', timeoutMs: TIMEOUTS.domStableMs },
  );
  addAssertion({
    id: 'e2e07-mode-switch-confirmed',
    kind: 'dom',
    passed: !afterConfirm.dialogOpen && afterConfirm.currentMode === 'writing',
    expected: 'mode switched to writing and ModeSwitchConfirmDialog closed after physical tap',
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
