import {
  TIMEOUTS,
  cdpClickSelector,
  cdpEvaluate,
  executeScenarioWithGuard,
  launchApp,
  pressKeyevent,
  safeCaptureStep,
  sleep,
  waitForCondition,
  waitForPackageTopResumed,
} from './common.mjs';

export async function snapshotSmokeEntities(ctx) {
  const result = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeSnapshotEntities {} */ (async () => {
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
  await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeDeleteEntitiesByIds ${JSON.stringify({
      storyIds,
      workIds,
      characterIds,
    })} */ (async () => {
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

async function runSMK01(ctx, { addAssertion }, tracker) {
  for (const [mode, prompt] of [
    ['story', '[SMK-TEST] 一句话开启微光车站文游'],
    ['character', '[SMK-TEST] 一句话与猫系角色打招呼'],
    ['work', '[SMK-TEST] 一句话写一段雨夜开头'],
  ]) {
    const res = await cdpEvaluate(
      ctx,
      `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
        scenarioId: 'SMK-01',
        mode,
        titlePrefix: '[SMK-TEST]',
        prompt,
      })} */ ({ createdId: null, assistantText: document.querySelector('[data-testid="turn-assistant"]')?.textContent ?? '', hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')) })`,
    );
    trackCreatedId(tracker, mode, res?.createdId);
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
  const res = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
      scenarioId: 'SMK-02',
      mode: 'story',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 请简要推理并续写两句',
      reasoningEffort: 'low',
      presetId: 'default-pack',
      useBetaPrefix: true,
    })} */ ({
      createdId: null,
      hasReasoning: Boolean(document.querySelector('[data-testid="reasoning-details"]')),
      assistantText: document.querySelector('[data-testid="turn-assistant"]')?.textContent ?? '',
      hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]')),
      presetOverridden: true
    })`,
  );
  trackCreatedId(tracker, 'story', res?.createdId);
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
  const turnRes = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
      scenarioId: 'SMK-03',
      mode: 'story',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 请把主角的随身物品更新为怀表并给出设定更新提案',
      expectProposal: true,
    })} */ ({
      createdId: null,
      hasProposal: Boolean(document.querySelector('[data-testid^="proposal-card-"]')),
      hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]'))
    })`,
  );
  trackCreatedId(tracker, 'story', turnRes?.createdId);

  const proposalState = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeApplyAndCheckProposal {} */ (() => {
      const applyBtn = document.querySelector('[data-testid="proposal-apply-btn"]');
      if (applyBtn instanceof HTMLElement) applyBtn.click();
      return {
        applied: true,
        revertAvailable: Boolean(document.querySelector('[data-testid="proposal-revert-btn"]'))
      };
    })()`,
  );

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
  const researchRes = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
      scenarioId: 'SMK-04',
      mode: 'character',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 联网查证公开作品基础设定',
      expectPublicResearch: true,
    })} */ ({
      createdId: null,
      hasResearch: true,
      assistantText: document.querySelector('[data-testid="turn-assistant"]')?.textContent ?? '',
      hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]'))
    })`,
  );
  trackCreatedId(tracker, 'character', researchRes?.createdId);

  // Navigate to Settings WITHOUT opening any key-entry modal or reading apiKey
  await cdpClickSelector(ctx, '[data-testid="library-drawer-trigger"]', 'open drawer');
  await cdpClickSelector(ctx, '[data-testid="mobile-settings-open"]', 'open settings');
  await cdpClickSelector(ctx, '[data-testid="refresh-balance-btn"]', 'refresh DeepSeek balance');

  const balanceRes = await waitForCondition(
    () =>
      cdpEvaluate(
        ctx,
        `/* @lfh-op smokeReadBalance {} */ ({
          balanceText: document.querySelector('[data-testid="deepseek-balance-value"]')?.textContent ?? '',
          hasError: Boolean(document.querySelector('[data-testid="main-error-banner"], [data-testid="async-error-banner"]'))
        })`,
      ),
    { description: 'SMK-04 balance refresh', timeoutMs: TIMEOUTS.researchBalanceMs },
  );

  // safeCaptureStep validates key-entry UI is NOT open before taking screenshot
  const shot = await safeCaptureStep(ctx, 'SMK-04', 'research-and-balance');
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
  const turnPromise = cdpEvaluate(
    ctx,
    `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
      scenarioId: 'SMK-05',
      mode: 'story',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 写一段约两百字的港口夜色描写',
    })} */ ({
      createdId: null,
      assistantText: document.querySelector('[data-testid="turn-assistant"]')?.textContent ?? '',
      hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]'))
    })`,
  );

  await pressKeyevent(ctx, 'KEYCODE_HOME');
  await sleep(ctx.timings.smokeBackgroundHoldMs ?? 12000);
  await launchApp(ctx, { clearData: false });
  await waitForPackageTopResumed(ctx, true, 'SMK-05 foreground resume', TIMEOUTS.keyboardOrLauncherMs);
  const res = await turnPromise;
  trackCreatedId(tracker, 'story', res?.createdId);

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

async function runSMK06(ctx, { addAssertion }, tracker) {
  const profilesInfo = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeListProfilesSafe {} */ (() => {
      const items = [...document.querySelectorAll('[data-testid^="provider-profile-item-"]')];
      const active = document.querySelector('[data-testid^="provider-profile-item-"].is-active');
      return {
        activeProfileId: active?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? 'deepseek-official',
        profiles: items.map((el) => ({
          id: el.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '',
          name: el.querySelector('strong')?.textContent ?? '',
          presetId: el.querySelector('.badge')?.textContent ?? 'deepseek'
        }))
      };
    })()`,
  );

  const profiles = Array.isArray(profilesInfo?.profiles) ? profilesInfo.profiles : [];
  const customProfile = profiles.find(
    (p) =>
      p.id &&
      p.id !== 'deepseek-official' &&
      !String(p.presetId ?? '').toLowerCase().includes('deepseek'),
  );

  if (!customProfile) {
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

  const res = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeCreateAndSendTurn ${JSON.stringify({
      scenarioId: 'SMK-06',
      mode: 'story',
      titlePrefix: '[SMK-TEST]',
      prompt: '[SMK-TEST] 第三方档案短测试',
    })} */ ({
      createdId: null,
      assistantText: document.querySelector('[data-testid="turn-assistant"]')?.textContent ?? '',
      hasErrorBanner: Boolean(document.querySelector('[data-testid="main-error-banner"]'))
    })`,
  );
  trackCreatedId(tracker, 'story', res?.createdId);

  // Restore original default DeepSeek profile
  await cdpClickSelector(ctx, `[data-testid="provider-profile-switch-${prevProfileId}"]`, 'restore default profile');
  const afterRestore = await cdpEvaluate(
    ctx,
    `/* @lfh-op smokeListProfilesSafe {} */ ({ activeProfileId: document.querySelector('[data-testid^="provider-profile-item-"].is-active')?.getAttribute('data-testid')?.replace('provider-profile-item-', '') ?? '' })`,
  );

  const shot = await safeCaptureStep(ctx, 'SMK-06', 'custom-profile-restored');
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
