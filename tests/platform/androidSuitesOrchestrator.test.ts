import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2E_SCENARIO_IDS,
  SMOKE_SCENARIO_IDS,
  createDryRunHarness,
  parseCliArgs,
  runAndroidSuite,
} from '../../scripts/android-test-runner/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDirs: string[] = [];

function createTempRoot(prefix = 'lfh-suites-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Android .e2e and .smoke suite orchestrators', () => {
  it('exports exact E2E-01..E2E-07 and SMK-01..SMK-06 scenario IDs', () => {
    expect(E2E_SCENARIO_IDS).toEqual([
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
    expect(SMOKE_SCENARIO_IDS).toEqual([
      'SMK-01',
      'SMK-02',
      'SMK-03',
      'SMK-04',
      'SMK-05',
      'SMK-06',
    ]);
  });

  it('orchestrates full .e2e suite with MockSseServer, screenrecord on timed/gesture scenarios, and Hard Gate LLM review', async () => {
    const rootDir = createTempRoot();
    const harness = createDryRunHarness({ suite: 'e2e' });
    let capturedMockRequests = 0;

    const result = await runAndroidSuite({
      suite: 'e2e',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'test-e2e-pass',
      dryRun: true,
      adbRunner: harness.adbRunner,
      cdpFactory: harness.cdpFactory,
      uiDriver: harness.uiDriver,
      timings: {
        backgroundHoldMs: 15,
        lockscreenHoldMs: 15,
        launcherStabilityMs: 320,
      },
      mockSseFactory: async () => {
        const { startMockSseServer } = await import('../../scripts/android-driver/index.mjs');
        const srv = await startMockSseServer();
        const origClose = srv.close.bind(srv);
        srv.close = async () => {
          capturedMockRequests = srv.getRecordedRequests().length;
          return origClose();
        };
        return srv;
      },
    });

    expect(result.packageId).toBe('io.localfiction.harness.e2e');
    expect(result.overallHardGate).toBe('PASS');
    expect(result.llmReview?.llmReviewVerdict).toBe('CONFIRMED_PASS');
    expect(result.scenarios).toHaveLength(9);
    for (const sc of result.scenarios) {
      expect(sc.hardOutcome).toBe('PASS');
    }

    // Real MockSseServer received requests from E2E-05, E2E-06A, E2E-06B, E2E-06C
    expect(capturedMockRequests).toBeGreaterThanOrEqual(8);

    // screenrecord enabled on E2E-03, E2E-05, E2E-06A, E2E-06B and cleaned up on PASS
    for (const recId of ['E2E-03', 'E2E-05', 'E2E-06A', 'E2E-06B']) {
      expect(harness.screenrecordStarts.some((cmd) => cmd.includes(recId))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'scenarios', recId, 'screenrecord.mp4'))).toBe(
        false,
      );
    }

    expect(fs.existsSync(path.join(result.runDir, 'run.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, 'timeline.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, 'llm-review-input.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, 'llm-review-output.json'))).toBe(true);

    const reviewInput = JSON.parse(
      fs.readFileSync(path.join(result.runDir, 'llm-review-input.json'), 'utf8'),
    );
    const reviewOutput = JSON.parse(
      fs.readFileSync(path.join(result.runDir, 'llm-review-output.json'), 'utf8'),
    );
    expect(reviewInput.runId).toBe('test-e2e-pass');
    expect(reviewInput.suite).toBe('e2e');
    expect(reviewInput.packageId).toBe('io.localfiction.harness.e2e');
    expect(reviewInput.device).toMatchObject({
      serial: 'emulator-5554',
      clockOffsetMs: expect.any(Number),
    });
    expect(reviewOutput.runId).toBe('test-e2e-pass');
    expect(reviewOutput.scenarioReviews[0].hardOutcome).toBe('PASS');

    // --no-llm-review scope creep removed; scripts contain zero @lfh-op stubs
    expect(() => parseCliArgs(['--no-llm-review'])).toThrow(/Unknown CLI flag/i);
    for (const rel of [
      'scripts/android-test-runner/common.mjs',
      'scripts/android-test-runner/scenarios-e2e.mjs',
      'scripts/android-test-runner/scenarios-smoke.mjs',
    ]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src).not.toContain('@lfh-op');
    }
  });

  it('marks E2E-06B as SKIPPED_LOCKSCREEN_PROTECTED when device has lockscreen password', async () => {
    const rootDir = createTempRoot();
    const result = await runAndroidSuite({
      suite: 'e2e',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'test-e2e-lockscreen',
      dryRun: true,
      lockscreenProtected: true,
      only: ['E2E-06B'],
    });

    expect(result.overallHardGate).toBe('PASS');
    expect(result.scenarios[0].scenarioId).toBe('E2E-06B');
    expect(result.scenarios[0].hardOutcome).toBe('SKIPPED_LOCKSCREEN_PROTECTED');
    expect(result.llmReview?.scenarioReviews[0].reviewStatus).toBe('SKIPPED_ACKNOWLEDGED');
  });

  it('captures failure artifacts and retains screenrecord.mp4 without silent retry when a scenario fails', async () => {
    const rootDir = createTempRoot();
    const harness = createDryRunHarness({
      suite: 'e2e',
      failScenario: 'E2E-06A',
    });

    let attemptCount = 0;

    const result = await runAndroidSuite({
      suite: 'e2e',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'test-e2e-fail',
      dryRun: true,
      only: ['E2E-06A'],
      adbRunner: harness.adbRunner,
      cdpFactory: harness.cdpFactory,
      uiDriver: {
        ...harness.uiDriver,
        sendTurn: async (ctx, opts) => {
          attemptCount += 1;
          return harness.uiDriver.sendTurn(ctx, opts);
        },
      },
      timings: { backgroundHoldMs: 10 },
    });

    // Zero silent retries: invoked only once
    expect(attemptCount).toBe(1);
    expect(result.overallHardGate).toBe('FAIL');
    expect(result.scenarios[0].hardOutcome).toBe('FAIL');
    expect(result.llmReview?.overallHardGate).toBe('FAIL');
    expect(result.llmReview?.llmReviewVerdict).toBe('CONFIRMED_FAIL');

    const scDir = path.join(result.runDir, 'scenarios', 'E2E-06A');
    expect(fs.existsSync(path.join(scDir, 'failure.png'))).toBe(true);
    expect(fs.existsSync(path.join(scDir, 'failure.dom.json'))).toBe(true);
    expect(fs.existsSync(path.join(scDir, 'screenrecord.mp4'))).toBe(true);
  });

  it('enforces .smoke security invariants, conditional SMK-06 skip/run, and ID-scoped cleanup on PASS and FAIL', { timeout: 15000 }, async () => {
    const rootDir = createTempRoot();

    // 1) Without custom profile -> SMK-06 SKIPPED_NO_CUSTOM_PROFILE, pre-existing entities preserved, new entities deleted
    const harnessSkip = createDryRunHarness({ suite: 'smoke', hasCustomProfile: false });
    const passRes = await runAndroidSuite({
      suite: 'smoke',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'smoke-skip-custom',
      dryRun: true,
      adbRunner: harnessSkip.adbRunner,
      cdpFactory: harnessSkip.cdpFactory,
      uiDriver: harnessSkip.uiDriver,
      timings: { smokeBackgroundHoldMs: 10 },
    });

    expect(passRes.packageId).toBe('io.localfiction.harness.smoke');
    expect(passRes.overallHardGate).toBe('PASS');
    expect(passRes.scenarios.find((s) => s.scenarioId === 'SMK-06')?.hardOutcome).toBe(
      'SKIPPED_NO_CUSTOM_PROFILE',
    );
    expect(harnessSkip.pmClearCalls).toEqual([]);
    expect(harnessSkip.evaluatedExpressions.some((e) => /\bloadApiKey\b/.test(e))).toBe(false);
    expect(harnessSkip.adbCalls.some((c) => c.args.join(' ').includes('pm clear'))).toBe(false);

    // Pre-existing stories/works/characters preserved; newly created IDs deleted
    expect(harnessSkip.state.stories).toEqual([
      expect.objectContaining({ id: 'preexisting-story-1' }),
    ]);
    expect(harnessSkip.state.works).toEqual([
      expect.objectContaining({ id: 'preexisting-work-1' }),
    ]);
    expect(harnessSkip.state.characters).toEqual([
      expect.objectContaining({ id: 'preexisting-char-1' }),
    ]);
    expect(harnessSkip.deletedEntities.storyIds.length).toBeGreaterThanOrEqual(4);
    expect(harnessSkip.deletedEntities.workIds.length).toBe(1);
    expect(harnessSkip.deletedEntities.characterIds.length).toBe(2);

    // 2) With custom profile + keepStories=true -> SMK-06 PASS and created entities retained
    const harnessKeep = createDryRunHarness({ suite: 'smoke', hasCustomProfile: true });
    const keepRes = await runAndroidSuite({
      suite: 'smoke',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'smoke-keep-stories',
      dryRun: true,
      keepStories: true,
      adbRunner: harnessKeep.adbRunner,
      cdpFactory: harnessKeep.cdpFactory,
      uiDriver: harnessKeep.uiDriver,
      timings: { smokeBackgroundHoldMs: 10 },
    });
    expect(keepRes.scenarios.find((s) => s.scenarioId === 'SMK-06')?.hardOutcome).toBe('PASS');
    expect(harnessKeep.deletedEntities.storyIds).toEqual([]);
    expect((harnessKeep.state.stories as Array<unknown>).length).toBeGreaterThan(1);

    // 3) Failure cleanup still deletes newly created entities while keeping preexisting entities
    const harnessFail = createDryRunHarness({
      suite: 'smoke',
      failScenario: 'SMK-02',
    });
    const failRes = await runAndroidSuite({
      suite: 'smoke',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'smoke-fail-cleanup',
      dryRun: true,
      only: ['SMK-01', 'SMK-02'],
      adbRunner: harnessFail.adbRunner,
      cdpFactory: harnessFail.cdpFactory,
      uiDriver: harnessFail.uiDriver,
    });
    expect(failRes.overallHardGate).toBe('FAIL');
    expect(harnessFail.state.stories).toEqual([
      expect.objectContaining({ id: 'preexisting-story-1' }),
    ]);
    expect(harnessFail.deletedEntities.storyIds.length).toBe(1);

    // 4) Guarded .smoke runner rejects NativeVault.loadApiKey() and pm clear
    const harnessGuard = createDryRunHarness({ suite: 'smoke' });
    const guardFail = await runAndroidSuite({
      suite: 'smoke',
      serial: 'emulator-5554',
      artifactsDir: rootDir,
      label: 'smoke-guard-reject',
      dryRun: true,
      only: ['SMK-01'],
      adbRunner: harnessGuard.adbRunner,
      cdpFactory: harnessGuard.cdpFactory,
      uiDriver: {
        ...harnessGuard.uiDriver,
        sendSmokeTurn: async (ctx) => {
          // Attempt forbidden loadApiKey call via CDP wrapper
          await ctx.session!.client.evaluate('NativeVault.loadApiKey()');
          return {};
        },
      },
    });
    expect(guardFail.overallHardGate).toBe('FAIL');
    expect(guardFail.scenarios[0].error).toMatch(/SECURITY VIOLATION/i);
  });

  it('executes android-e2e.mjs --dry-run and android-smoke.mjs --dry-run CLI entrypoints cleanly', { timeout: 15000 }, () => {
    const rootDir = createTempRoot();
    const e2eOut = execFileSync(
      'node',
      [
        path.join(REPO_ROOT, 'scripts', 'android-e2e.mjs'),
        '--dry-run',
        '--artifacts-dir',
        rootDir,
        '--label',
        'cli-e2e',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsedE2e = JSON.parse(e2eOut);
    expect(parsedE2e.suite).toBe('e2e');
    expect(parsedE2e.overallHardGate).toBe('PASS');
    expect(parsedE2e.llmReviewVerdict).toBe('CONFIRMED_PASS');

    const smokeOut = execFileSync(
      'node',
      [
        path.join(REPO_ROOT, 'scripts', 'android-smoke.mjs'),
        '--dry-run',
        '--artifacts-dir',
        rootDir,
        '--label',
        'cli-smoke',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsedSmoke = JSON.parse(smokeOut);
    expect(parsedSmoke.suite).toBe('smoke');
    expect(parsedSmoke.overallHardGate).toBe('PASS');
    expect(parsedSmoke.llmReviewVerdict).toBe('CONFIRMED_PASS');
  });
});
