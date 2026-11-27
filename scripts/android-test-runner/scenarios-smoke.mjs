import {
  TIMEOUTS,
  cdpClickSelector,
  cdpEvaluate,
  cdpFillInput,
  cdpReadSnapshot,
  executeScenarioWithGuard,
  launchApp,
  pressKeyevent,
  safeCaptureStep,
  sleep,
  waitForCondition,
  waitForPackageTopResumed,
} from './common.mjs';

export async function snapshotSmokeEntities(ctx) {
  if (ctx.uiDriver?.snapshotSmokeEntities) {
    return ctx.uiDriver.snapshotSmokeEntities(ctx);
  }
  const result = await cdpEvaluate(
    ctx,
    `(async () => {
      const storyIds = [];
      const workIds = [];
      const characterIds = [];
      const nv = window.Capacitor?.Plugins?.NativeVault;
      if (nv && typeof nv.listStories === 'function') {
        const res = await nv.listStories();
        for (const s of res?.stories ?? []) {
          if (s?.id) storyIds.push(String(s.id));
        }
        if (typeof nv.loadCreativeWorkspace === 'function') {
          const wsRes = await nv.loadCreativeWorkspace();
          const ws = wsRes?.workspace;
          for (const w of ws?.works ?? []) if (w?.id) workIds.push(String(w.id));
          for (const c of ws?.characters ?? []) if (c?.id) characterIds.push(String(c.id));
        }
        return { storyIds, workIds, characterIds };
      }
      return { storyIds, workIds, characterIds };
    })()`,
  );
  return {
    storyIds: Array.isArray(result?.storyIds) ? result.storyIds : [],
    workIds: Array.isArray(result?.workIds) ? result.workIds : [],
    characterIds: Array.isArray(result?.characterIds) ? result.characterIds : [],
  };
}

export async function deleteSmokeEntitiesByIds(ctx, ids) {
  const storyIds = [...new Set(ids?.storyIds ?? [])];
  const workIds = [...new Set(ids?.workIds ?? [])];
  const characterIds = [...new Set(ids?.characterIds ?? [])];
  if (storyIds.length === 0 && workIds.length === 0 && characterIds.length === 0) {
    return { deleted: 0 };
  }
  if (ctx.uiDriver?.deleteSmokeEntitiesByIds) {
    return ctx.uiDriver.deleteSmokeEntitiesByIds(ctx, { storyIds, workIds, characterIds });
  }
  await cdpEvaluate(
    ctx,
    `(async () => {
      const sSet = new Set(${JSON.stringify(storyIds)});
      const wSet = new Set(${JSON.stringify(workIds)});
      const cSet = new Set(${JSON.stringify(characterIds)});
      const nv = window.Capacitor?.Plugins?.NativeVault;
      if (nv) {
        for (const id of sSet) {
          if (typeof nv.deleteStory === 'function') {
            await nv.deleteStory({ id });
          }
        }
        if ((wSet.size > 0 || cSet.size > 0) && typeof nv.loadCreativeWorkspace === 'function' && typeof nv.saveCreativeWorkspace === 'function') {
          const wsRes = await nv.loadCreativeWorkspace();
          const ws = wsRes?.workspace;
          if (ws) {
            const expected = ws.revision ?? 0;
            const next = {
              ...ws,
              revision: expected + 1,
              works: Array.isArray(ws.works) ? ws.works.filter((w) => !wSet.has(w.id)) : [],
              characters: Array.isArray(ws.characters) ? ws.characters.filter((c) => !cSet.has(c.id)) : [],
            };
            await nv.saveCreativeWorkspace({ workspace: next, expected });
          }
        }
      }
      return true;
    })()`,
  );
  return { deleted: storyIds.length + workIds.length + characterIds.length };
}

function trackCreatedId(tracker, mode, createdId) {
  if (!tracker || !createdId) return;
  if (mode === 'work') tracker.workIds.add(createdId);
  else if (mode === 'character') tracker.characterIds.add(createdId);
  else tracker.storyIds.add(createdId);
}

function findNewlyCreatedId(before, after, mode) {
  const pickNew = (prevList, nextList) => {
    const prevSet = new Set(prevList);
    return nextList.find((id) => !prevSet.has(id)) ?? null;
  };
  if (mode === 'work') return pickNew(before.workIds, after.workIds);
  if (mode === 'character') return pickNew(before.characterIds, after.characterIds);
  return pickNew(before.storyIds, after.storyIds);
}

async function selectSmokeModeAndNewCreation(ctx, modeLabel) {
  const modeMap = { 文游: 'story', 写故事: 'writing', 角色互动: 'character' };
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return s.drawerOpen ? s : null;
    },
    { description: 'drawer open in smoke', timeoutMs: TIMEOUTS.domStableMs },
  );
  if (ctx.uiDriver?.selectLibraryCategory) {
    await ctx.uiDriver.selectLibraryCategory(ctx, modeMap[modeLabel] ?? 'story');
  } else {
    const clicked = await cdpEvaluate(
      ctx,
      `(() => {
        const tabs = [...document.querySelectorAll('.library-categories button')];
        const target = tabs.find((b) => b.textContent?.trim() === ${JSON.stringify(modeLabel)});
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`,
    );
    if (!clicked) {
      throw new Error(`Smoke library category tab "${modeLabel}" not found.`);
    }
  }
  await cdpClickSelector(ctx, '[data-testid="mobile-library-new-creation"]', 'smoke new creation');
  await waitForCondition(
    async () => {
      const s = await cdpReadSnapshot(ctx);
      return !s.drawerOpen ? s : null;
    },
    { description: 'drawer closed after smoke new creation', timeoutMs: TIMEOUTS.domStableMs },
  );
}

async function readSmokeTurnDomState(ctx) {
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
      const presetTrigger = document.querySelector('[data-testid="composer-narrative-preset-trigger"]');
      const presetOverridden =
        presetTrigger?.getAttribute('data-overridden') === 'true' ||
        Boolean(document.querySelector('[data-testid="composer-narrative-preset-dot"]'));

      let hasResearch = false;
      try {
        const nv = window.Capacitor?.Plugins?.NativeVault;
        if (nv && typeof nv.loadCreativeWorkspace === 'function') {
          const wsRes = await nv.loadCreativeWorkspace();
          for (const ch of wsRes?.workspace?.characters ?? []) {
            for (const conv of ch?.conversations ?? []) {
              for (const node of Object.values(conv?.nodes ?? {})) {
                if (node?.publicResearch) {
                  hasResearch = true;
                  break;
                }
              }
            }
          }
        }
        if (!hasResearch && nv && typeof nv.listStories === 'function') {
          const stRes = await nv.listStories();
          for (const st of stRes?.stories ?? []) {
            for (const node of Object.values(st?.nodes ?? {})) {
              if (node?.publicResearch) {
                hasResearch = true;
                break;
              }
            }
          }
        }
      } catch {}

      return {
        isStreaming: Boolean(streamingEl),
        assistantText: lastCard?.textContent ?? '',
        hasReasoning: Boolean(document.querySelector('[data-testid="reasoning-details"]')),
        hasProposal: Boolean(document.querySelector('[data-testid^="proposal-card-"]')),
        hasResearch,
        hasErrorBanner: Boolean(errorBanner),
        presetOverridden,
      };
    })()`,
  );
}

async function executeSmokeTurn(ctx, tracker, opts) {
  const before = await snapshotSmokeEntities(ctx);
  if (ctx.uiDriver?.sendSmokeTurn) {
    const res = await ctx.uiDriver.sendSmokeTurn(ctx, opts);
    trackCreatedId(tracker, opts.mode, res?.createdId);
    return res;
  }

  await cdpFillInput(
    ctx,
    '#turn-input, [data-testid="stage-composer"] textarea',
    opts.prompt,
    'smoke prompt',
  );
  await cdpClickSelector(
    ctx,
    '[data-testid="stage-composer"] button[type="submit"], .composer-send[type="submit"]',
    'smoke send turn',
  );

  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.liveApiTurnMs;
  const domState = await waitForCondition(
    async () => {
      const s = await readSmokeTurnDomState(ctx);
      if (s.hasErrorBanner) return s;
      if (!s.isStreaming && String(s.assistantText ?? '').trim().length > 0) return s;
      return null;
    },
    { description: `${opts.scenarioId} (${opts.mode}) live turn complete`, timeoutMs },
  );

  const after = await snapshotSmokeEntities(ctx);
  const createdId = findNewlyCreatedId(before, after, opts.mode);
  trackCreatedId(tracker, opts.mode, createdId);
  return {
    createdId,
    mode: opts.mode,
    ...domState,
  };
}

async function runSMK01(ctx, { addAssertion }, tracker) {
  for (const [modeLabel, mode, prompt] of [
    ['文游', 'story', '[SMK-TEST] 一句话开启微光车站文游'],
    ['角色互动', 'character', '[SMK-TEST] 一句话与猫系角色打招呼'],
    ['写故事', 'work', '[SMK-TEST] 一句话写一段雨夜开头'],
  ]) {
    await selectSmokeModeAndNewCreation(ctx, modeLabel);
    const res = await executeSmokeTurn(ctx, tracker, {
      scenarioId: 'SMK-01',
      mode,
      titlePrefix: '[SMK-TEST]',
      prompt,
    });
    const shot = await safeCaptureStep(ctx, 'SMK-01', `mode-${mode}`);
    addAssertion({
      id: `smk01-${mode}-live-stream`,
      kind: 'dom',
      passed: !res?.hasErrorBanner && Boolean(String(res?.assistantText ?? '').trim()),
      expected: `${mode} turn-assistant streamed without error`,
      actual: JSON.stringify({
        createdId: res?.createdId ?? null,
        hasErrorBanner: res?.hasErrorBanner,
        textLen: String(res?.assistantText ?? '').length,
      }),
      artifactPath: shot.png,
    });
  }
}

async function runSMK02(ctx, { addAssertion }, tracker) {
  await selectSmokeModeAndNewCreation(ctx, '文游');

  // Enable reasoning (low) if off
  const thinkingOn = ctx.uiDriver
    ? false
    : await cdpEvaluate(
        ctx,
        `document.querySelector('[data-testid="composer-thinking-toggle"]')?.getAttribute('aria-pressed') === 'true'`,
      );
  if (!thinkingOn) {
    await cdpClickSelector(ctx, '[data-testid="composer-thinking-toggle"]', 'enable thinking');
  }
  await cdpClickSelector(ctx, '[data-testid="composer-reasoning-stop-low"]', 'select low reasoning');

  // Select narrative preset via NarrativePresetQuickSheet
  await cdpClickSelector(ctx, '[data-testid="composer-narrative-preset-trigger"]', 'open narrative preset quick sheet');
  await cdpClickSelector(
    ctx,
    '[data-testid="quick-preset-option-default-pack"], [data-testid^="quick-preset-option-"]:not([data-testid="quick-preset-option-inherit"]):not([data-testid="quick-preset-option-off"])',
    'select narrative preset in quick sheet',
  );
  await pressKeyevent(ctx, 'KEYCODE_BACK');

  const res = await executeSmokeTurn(ctx, tracker, {
    scenarioId: 'SMK-02',
    mode: 'story',
    titlePrefix: '[SMK-TEST]',
    prompt: '[SMK-TEST] 请简要推理并续写两句',
    reasoningEffort: 'low',
    presetId: 'default-pack',
    useBetaPrefix: true,
    timeoutMs: TIMEOUTS.liveApiReasoningOrSearchMs,
  });
  const shot = await safeCaptureStep(ctx, 'SMK-02', 'reasoning-and-preset');
  addAssertion({
    id: 'smk02-reasoning-and-preset',
    kind: 'dom',
    passed:
      Boolean(res?.hasReasoning) &&
      Boolean(res?.presetOverridden) &&
      !res?.hasErrorBanner &&
      Boolean(String(res?.assistantText ?? '').trim()),
    expected: 'reasoning-details rendered, preset active, no HTTP 4xx error',
    actual: JSON.stringify(res),
    artifactPath: shot.png,
  });
}

async function runSMK03(ctx, { addAssertion }, tracker) {
  await selectSmokeModeAndNewCreation(ctx, '文游');
  const turnRes = await executeSmokeTurn(ctx, tracker, {
    scenarioId: 'SMK-03',
    mode: 'story',
    titlePrefix: '[SMK-TEST]',
    prompt: '[SMK-TEST] 请把主角的随身物品更新为怀表并给出设定更新提案',
    expectProposal: true,
  });

  let proposalState;
  if (ctx.uiDriver?.applyAndCheckProposal) {
    proposalState = await ctx.uiDriver.applyAndCheckProposal(ctx);
  } else {
    if (turnRes.hasProposal) {
      const expanded = await cdpEvaluate(
        ctx,
        `Boolean(document.querySelector('[data-testid="proposal-drawer"]'))`,
      );
      if (!expanded) {
        await cdpClickSelector(ctx, '[data-testid="proposal-card-toggle"]', 'expand proposal card');
      }
      await cdpClickSelector(ctx, '[data-testid="proposal-apply-btn"]', 'apply proposal');
      proposalState = await waitForCondition(
        async () => {
          const revertAvailable = await cdpEvaluate(
            ctx,
            `Boolean(document.querySelector('[data-testid="proposal-revert-btn"]'))`,
          );
          return revertAvailable ? { applied: true, revertAvailable: true } : null;
        },
        { description: 'proposal applied and revert button visible', timeoutMs: TIMEOUTS.domStableMs },
      );
    } else {
      proposalState = { applied: false, revertAvailable: false };
    }
  }

  const shot = await safeCaptureStep(ctx, 'SMK-03', 'proposal-applied');
  addAssertion({
    id: 'smk03-proposal-apply-and-undo',
    kind: 'dom',
    passed:
      Boolean(turnRes?.hasProposal) &&
      Boolean(proposalState?.applied) &&
      Boolean(proposalState?.revertAvailable) &&
      !turnRes?.hasErrorBanner,
    expected: 'Proposal Card visible, applied, and undoable',
    actual: JSON.stringify({ ...turnRes, ...proposalState }),
    artifactPath: shot.png,
  });
}

async function runSMK04(ctx, { addAssertion }, tracker) {
  await selectSmokeModeAndNewCreation(ctx, '角色互动');
  const researchRes = await executeSmokeTurn(ctx, tracker, {
    scenarioId: 'SMK-04',
    mode: 'character',
    titlePrefix: '[SMK-TEST]',
    prompt: '[SMK-TEST] 联网查证公开作品基础设定',
    expectPublicResearch: true,
    timeoutMs: TIMEOUTS.liveApiReasoningOrSearchMs,
  });

  // Navigate to Settings WITHOUT opening any key-entry modal or reading apiKey
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
  await cdpClickSelector(ctx, '[data-testid="refresh-balance-btn"]', 'refresh DeepSeek balance');

  const balanceRes = await waitForCondition(
    async () => {
      if (ctx.uiDriver?.readBalance) {
        return ctx.uiDriver.readBalance(ctx);
      }
      const res = await cdpEvaluate(
        ctx,
        `({
          balanceText: document.querySelector('[data-testid="deepseek-balance-value"]')?.textContent ?? '',
          hasError: Boolean(document.querySelector('[data-testid="main-error-banner"], [data-testid="async-error-banner"], [data-testid="deepseek-balance-error"]'))
        })`,
      );
      return res?.balanceText || res?.hasError ? res : null;
    },
    { description: 'SMK-04 balance refresh', timeoutMs: TIMEOUTS.researchBalanceMs },
  );

  // safeCaptureStep validates key-entry UI is NOT open before taking screenshot
  const shot = await safeCaptureStep(ctx, 'SMK-04', 'research-and-balance');
  await cdpClickSelector(ctx, '[data-testid="settings-page"] button[aria-label="返回"]', 'close settings after balance');
  addAssertion({
    id: 'smk04-research-and-balance',
    kind: 'dom',
    passed:
      Boolean(researchRes?.hasResearch) &&
      !researchRes?.hasErrorBanner &&
      Boolean(String(balanceRes?.balanceText ?? '').trim()) &&
      !balanceRes?.hasError,
    expected: 'publicResearch persisted and deepseek-balance-value refreshed cleanly',
    actual: JSON.stringify({ research: researchRes?.hasResearch, balance: balanceRes?.balanceText }),
    artifactPath: shot.png,
  });
}

async function runSMK05(ctx, { addAssertion }, tracker) {
  await selectSmokeModeAndNewCreation(ctx, '文游');
  const before = await snapshotSmokeEntities(ctx);

  let turnPromise;
  if (ctx.uiDriver?.sendSmokeTurn) {
    turnPromise = ctx.uiDriver.sendSmokeTurn(ctx, {
      scenarioId: 'SMK-05',
      mode: 'story',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 写一段约两百字的港口夜色描写',
      streamDelayMs: 25,
    });
  } else {
    await cdpFillInput(
      ctx,
      '#turn-input, [data-testid="stage-composer"] textarea',
      '[SMK-TEST] 写一段约两百字的港口夜色描写',
      'SMK-05 prompt',
    );
    await cdpClickSelector(
      ctx,
      '[data-testid="stage-composer"] button[type="submit"], .composer-send[type="submit"]',
      'SMK-05 submit',
    );
  }

  // Wait until first chunk appears in DOM BEFORE sending KEYCODE_HOME
  await waitForCondition(
    async () => {
      if (ctx.uiDriver?.readTurnState) {
        const ts = await ctx.uiDriver.readTurnState(ctx);
        return (ts.streamingChunkCount >= 1 || !ts.isStreaming) && String(ts.lastAssistantText ?? '').trim()
          ? ts
          : null;
      }
      const s = await readSmokeTurnDomState(ctx);
      return String(s.assistantText ?? '').trim().length > 0 || s.hasErrorBanner ? s : null;
    },
    { description: 'SMK-05 first chunk visible before KEYCODE_HOME', timeoutMs: TIMEOUTS.liveApiTurnMs },
  );

  await pressKeyevent(ctx, 'KEYCODE_HOME');
  await sleep(ctx.timings.smokeBackgroundHoldMs ?? 12000);
  await launchApp(ctx, { clearData: false });
  await waitForPackageTopResumed(ctx, true, 'SMK-05 foreground resume', TIMEOUTS.keyboardOrLauncherMs);

  let res;
  if (turnPromise) {
    res = await turnPromise;
    trackCreatedId(tracker, 'story', res?.createdId);
  } else {
    res = await waitForCondition(
      async () => {
        const s = await readSmokeTurnDomState(ctx);
        if (s.hasErrorBanner) return s;
        if (!s.isStreaming && String(s.assistantText ?? '').trim().length > 0) return s;
        return null;
      },
      { description: 'SMK-05 live stream completion after resume', timeoutMs: TIMEOUTS.liveApiTurnMs },
    );
    const after = await snapshotSmokeEntities(ctx);
    trackCreatedId(tracker, 'story', findNewlyCreatedId(before, after, 'story'));
  }

  const shot = await safeCaptureStep(ctx, 'SMK-05', 'https-background-resume');
  addAssertion({
    id: 'smk05-https-background-survival',
    kind: 'system_state',
    passed: !res?.hasErrorBanner && Boolean(String(res?.assistantText ?? '').trim()),
    expected: 'real HTTPS stream finishes cleanly after 10-15s KEYCODE_HOME',
    actual: JSON.stringify({ hasErrorBanner: res?.hasErrorBanner, textLen: String(res?.assistantText ?? '').length }),
    artifactPath: shot.png,
  });
}

async function readProfilesInSettingsSafe(ctx) {
  if (ctx.uiDriver?.listProfilesSafe) {
    return ctx.uiDriver.listProfilesSafe(ctx);
  }
  return cdpEvaluate(
    ctx,
    `(() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      return {
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? 'deepseek-official',
        profiles: items.map((el) => ({
          id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '',
          name: el.querySelector('strong')?.textContent?.trim() ?? '',
          presetId: el.querySelector('.badge')?.textContent?.trim() ?? 'deepseek'
        }))
      };
    })()`,
  );
}

async function runSMK06(ctx, { addAssertion }, tracker) {
  // Open Settings BEFORE inspecting custom profiles
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer for SMK-06 settings');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings for SMK-06');

  const profilesInfo = await readProfilesInSettingsSafe(ctx);
  const profiles = Array.isArray(profilesInfo?.profiles) ? profilesInfo.profiles : [];
  const customProfile = profiles.find(
    (p) =>
      p.id &&
      p.id !== 'deepseek-official' &&
      !String(p.presetId ?? '').toLowerCase().includes('deepseek'),
  );

  if (!customProfile) {
    await cdpClickSelector(ctx, '[data-testid="settings-page"] button[aria-label="返回"]', 'close settings');
    addAssertion({
      id: 'smk06-custom-profile-check',
      kind: 'system_state',
      passed: true,
      expected: 'custom profile verified or explicitly SKIPPED_NO_CUSTOM_PROFILE',
      actual: 'SKIPPED_NO_CUSTOM_PROFILE',
    });
    return { hardOutcome: 'SKIPPED_NO_CUSTOM_PROFILE' };
  }

  const prevProfileId = profilesInfo.activeProfileId || 'deepseek-official';
  await cdpClickSelector(ctx, `[data-testid="provider-profile-switch-${customProfile.id}"]`, 'switch to custom profile');
  await cdpClickSelector(ctx, '[data-testid="settings-page"] button[aria-label="返回"]', 'close settings before custom turn');

  await selectSmokeModeAndNewCreation(ctx, '文游');
  const res = await executeSmokeTurn(ctx, tracker, {
    scenarioId: 'SMK-06',
    mode: 'story',
    titlePrefix: '[SMK-TEST]',
    prompt: '[SMK-TEST] 第三方档案短测试',
  });

  // Reopen Settings and restore original default DeepSeek profile
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer to restore profile');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings to restore profile');
  await cdpClickSelector(ctx, `[data-testid="provider-profile-switch-${prevProfileId}"]`, 'restore default profile');
  const afterRestore = await readProfilesInSettingsSafe(ctx);

  const shot = await safeCaptureStep(ctx, 'SMK-06', 'custom-profile-restored');
  await cdpClickSelector(ctx, '[data-testid="settings-page"] button[aria-label="返回"]', 'close settings after restore');
  addAssertion({
    id: 'smk06-custom-profile-isolation',
    kind: 'privacy_guard',
    passed:
      !res?.hasErrorBanner &&
      Boolean(String(res?.assistantText ?? '').trim()) &&
      afterRestore?.activeProfileId === prevProfileId,
    expected: 'custom profile succeeded and default profile restored without contamination',
    actual: JSON.stringify({
      customProfileId: customProfile.id,
      restoredProfileId: afterRestore?.activeProfileId,
    }),
    artifactPath: shot.png,
  });
}

const SMOKE_RUNNERS = {
  'SMK-01': runSMK01,
  'SMK-02': runSMK02,
  'SMK-03': runSMK03,
  'SMK-04': runSMK04,
  'SMK-05': runSMK05,
  'SMK-06': runSMK06,
};

export async function runSmokeScenario(ctx, scenarioId, tracker) {
  const fn = SMOKE_RUNNERS[scenarioId];
  if (!fn) {
    throw new Error(`Unknown .smoke scenarioId: ${scenarioId}`);
  }
  return executeScenarioWithGuard(ctx, scenarioId, (helpers) => fn(ctx, helpers, tracker));
}
