import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as driver from '../android-driver/index.mjs';
import * as artifacts from '../android-artifacts/index.mjs';
import * as backRegression from '../android-back-regression.mjs';
import {
  DEFAULT_E2E_APK,
  DEFAULT_SMOKE_APK,
  E2E_PACKAGE_ID,
  E2E_SCENARIO_IDS,
  SMOKE_PACKAGE_ID,
  SMOKE_SCENARIO_IDS,
  buildDefaultHardGateReviewer,
  defaultCommandRunner,
  defaultSpawnProcess,
  launchApp,
  resolveConnectedSerial,
} from './common.mjs';
import { createDryRunHarness } from './dry-run.mjs';
import { runE2eScenario } from './scenarios-e2e.mjs';
import {
  deleteSmokeEntitiesByIds,
  runSmokeScenario,
  snapshotSmokeEntities,
} from './scenarios-smoke.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORBIDDEN_SMOKE_EVAL_PATTERNS = [
  /\bloadApiKey\b/,
  /\bsaveApiKey\b/,
  /\bclearApiKey\b/,
  /\bloadMeta\b/,
];

function wrapSmokeAdbRunner(adbRunner) {
  return (command, args = [], options = {}) => {
    const joined = `${command} ${args.join(' ')}`;
    if (/\bpm\s+clear\b/i.test(joined)) {
      throw new Error(`SECURITY VIOLATION: pm clear is strictly forbidden in .smoke (${joined}).`);
    }
    return adbRunner(command, args, options);
  };
}

function wrapSmokeCdpFactory(cdpFactory) {
  return async (opts) => {
    const session = await cdpFactory(opts);
    const originalEvaluate = session.client.evaluate.bind(session.client);
    session.client.evaluate = async (expression, evalOpts) => {
      for (const pattern of FORBIDDEN_SMOKE_EVAL_PATTERNS) {
        if (pattern.test(String(expression))) {
          throw new Error(
            `SECURITY VIOLATION: Forbidden NativeVault key/meta expression (${pattern}) in .smoke.`,
          );
        }
      }
      return originalEvaluate(expression, evalOpts);
    };
    return session;
  };
}

export function parseCliArgs(argv) {
  const options = {
    record: false,
    keepStories: false,
    dryRun: false,
    llmReview: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const eqIdx = arg.indexOf('=');
    const key = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
    const inlineVal = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

    switch (key) {
      case 'record':
        options.record = inlineVal ? inlineVal !== 'false' : true;
        break;
      case 'keep-stories':
        options.keepStories = inlineVal ? inlineVal !== 'false' : true;
        break;
      case 'dry-run':
        options.dryRun = inlineVal ? inlineVal !== 'false' : true;
        break;
      case 'no-llm-review':
        options.llmReview = false;
        break;
      case 'llm-review':
        options.llmReview = inlineVal ? inlineVal !== 'false' : true;
        break;
      case 'serial':
      case 'apk':
      case 'artifacts-dir':
      case 'label':
      case 'only': {
        const value = inlineVal ?? argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`Missing value for --${key}`);
        }
        if (inlineVal === undefined) i += 1;
        if (key === 'artifacts-dir') options.artifactsDir = value;
        else if (key === 'only') {
          options.only = value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          options[key] = value;
        }
        break;
      }
      default:
        throw new Error(`Unknown CLI flag: --${key}`);
    }
  }
  return options;
}

function installApkIfProvided({ apkPath, packageId, serial, adbRunner, dryRun }) {
  if (!apkPath || dryRun) return null;
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK not found: ${apkPath}`);
  }
  const out = String(adbRunner('adb', ['-s', serial, 'install', '-r', '-t', apkPath]) ?? '');
  if (!out.includes('Success')) {
    throw new Error(`Failed to install ${packageId} APK (${apkPath}): ${out}`);
  }
  return out.trim();
}

export async function runAndroidSuite(options = {}) {
  const suite = options.suite;
  if (suite !== 'e2e' && suite !== 'smoke') {
    throw new Error(`Invalid suite "${suite}". Expected "e2e" or "smoke".`);
  }

  const packageId = suite === 'e2e' ? E2E_PACKAGE_ID : SMOKE_PACKAGE_ID;
  const allScenarioIds = suite === 'e2e' ? E2E_SCENARIO_IDS : SMOKE_SCENARIO_IDS;
  const selectedIds =
    Array.isArray(options.only) && options.only.length > 0
      ? options.only
      : [...allScenarioIds];

  for (const id of selectedIds) {
    if (!allScenarioIds.includes(id)) {
      throw new Error(`Scenario "${id}" does not belong to suite "${suite}".`);
    }
  }

  const dryRun = Boolean(options.dryRun);
  const dryHarness = dryRun
    ? createDryRunHarness({
        suite,
        packageId,
        serial: options.serial,
        lockscreenProtected: options.lockscreenProtected,
        hasCustomProfile: options.hasCustomProfile,
        failScenario: options.failScenario,
      })
    : null;

  let adbRunner = options.adbRunner ?? dryHarness?.adbRunner ?? defaultCommandRunner;
  let cdpFactory =
    options.cdpFactory ??
    dryHarness?.cdpFactory ??
    ((cdpOpts) => driver.connectToAppWebView(cdpOpts));

  if (suite === 'smoke') {
    adbRunner = wrapSmokeAdbRunner(adbRunner);
    cdpFactory = wrapSmokeCdpFactory(cdpFactory);
  }

  const serial =
    options.serial ??
    dryHarness?.serial ??
    resolveConnectedSerial(undefined, adbRunner);

  const rootDir = path.resolve(REPO_ROOT, options.artifactsDir ?? '.');
  const runId = options.label ?? new Date().toISOString().replace(/[:.]/g, '-');
  const drySpawn = (cmd, args) => {
    adbRunner(cmd, args, { background: true });
    return { kill() {} };
  };
  const collector = artifacts.createRunArtifactCollector({
    rootDir,
    suite,
    runId,
    deviceMeta: {
      serial,
      packageId,
      dryRun,
    },
    runCommand: adbRunner,
    spawnProcess: options.spawnProcess ?? (dryRun ? drySpawn : defaultSpawnProcess),
  });

  const resolvedApk = options.apk
    ? path.resolve(REPO_ROOT, options.apk)
    : options.installDefaultApk
      ? path.resolve(REPO_ROOT, suite === 'e2e' ? DEFAULT_E2E_APK : DEFAULT_SMOKE_APK)
      : null;

  if (resolvedApk) {
    installApkIfProvided({
      apkPath: resolvedApk,
      packageId,
      serial,
      adbRunner,
      dryRun,
    });
  }

  let mockSse = null;
  let mockRemotePort = null;
  const ctx = {
    suite,
    packageId,
    serial,
    dryRun,
    record: Boolean(options.record),
    keepStories: Boolean(options.keepStories),
    lockscreenProtected: options.lockscreenProtected,
    timings: {
      backgroundHoldMs: dryRun ? 20 : 16000,
      lockscreenHoldMs: dryRun ? 20 : 32000,
      smokeBackgroundHoldMs: dryRun ? 20 : 12000,
      launcherStabilityMs: dryRun ? 320 : 400,
      ...(options.timings ?? {}),
    },
    adbRunner,
    cdpFactory,
    session: null,
    collector,
    mockSse: null,
    mockRemotePort: null,
    currentScenarioId: null,
    driver,
    artifacts,
    backRegression,
  };

  let smokeBaseline = { storyIds: [], workIds: [], characterIds: [] };
  const smokeTracker = {
    storyIds: new Set(),
    workIds: new Set(),
    characterIds: new Set(),
  };

  const scenarioResults = [];

  try {
    if (suite === 'e2e') {
      const mockFactory = options.mockSseFactory ?? (() => driver.startMockSseServer());
      mockSse = await mockFactory();
      ctx.mockSse = mockSse;
      mockRemotePort = options.mockRemotePort ?? mockSse.port;
      ctx.mockRemotePort = mockRemotePort;
      driver.setupAdbReverse({
        serial,
        remotePort: mockRemotePort,
        localPort: mockSse.port,
        runCommand: adbRunner,
      });
    }

    await launchApp(ctx, { clearData: false });
    ctx.session = await cdpFactory({
      serial,
      packageId,
      runCommand: adbRunner,
    });

    const syncMeta = await artifacts.measureClockOffset({
      runCommand: adbRunner,
      serial,
      client: ctx.session?.client ?? null,
    });
    collector.setClockSync(syncMeta);

    if (suite === 'smoke') {
      smokeBaseline = await snapshotSmokeEntities(ctx);
    }

    for (const scenarioId of selectedIds) {
      const res =
        suite === 'e2e'
          ? await runE2eScenario(ctx, scenarioId)
          : await runSmokeScenario(ctx, scenarioId, smokeTracker);
      scenarioResults.push(res);
    }
  } finally {
    if (suite === 'smoke' && !ctx.keepStories && ctx.session?.client) {
      try {
        const current = await snapshotSmokeEntities(ctx);
        const baseStories = new Set(smokeBaseline.storyIds);
        const baseWorks = new Set(smokeBaseline.workIds);
        const baseChars = new Set(smokeBaseline.characterIds);

        const toDelete = {
          storyIds: new Set([
            ...smokeTracker.storyIds,
            ...current.storyIds.filter((id) => !baseStories.has(id)),
          ]),
          workIds: new Set([
            ...smokeTracker.workIds,
            ...current.workIds.filter((id) => !baseWorks.has(id)),
          ]),
          characterIds: new Set([
            ...smokeTracker.characterIds,
            ...current.characterIds.filter((id) => !baseChars.has(id)),
          ]),
        };
        await deleteSmokeEntitiesByIds(ctx, toDelete);
      } catch {
        // Best-effort cleanup; never mask original test failures.
      }
    }

    if (ctx.session?.close) {
      await ctx.session.close().catch(() => {});
    }
    if (mockSse) {
      try {
        driver.removeAdbReverse({
          serial,
          remotePort: mockRemotePort ?? undefined,
          runCommand: adbRunner,
        });
      } catch {
        // Ignore reverse teardown error
      }
      await mockSse.close().catch(() => {});
    }
  }

  const finalized = await collector.finalizeRun();

  let llmReview = null;
  if (options.llmReview !== false) {
    const reviewInput = artifacts.buildLlmReviewInput({
      runMeta: finalized.runMeta,
      artifactsRoot: finalized.runDir,
      forbiddenStrings: options.forbiddenStrings ?? [],
      scenarios: scenarioResults.map((s) => ({
        scenarioId: s.scenarioId,
        hardOutcome: s.hardOutcome,
        assertions: s.assertions,
        artifactPaths: s.artifactPaths,
        ...(s.error ? { error: s.error } : {}),
      })),
    });

    const reviewerFn = options.reviewerFn ?? buildDefaultHardGateReviewer();
    llmReview = await artifacts.reviewRunWithLlm({
      reviewInput,
      artifactsRoot: finalized.runDir,
      reviewerFn,
      forbiddenStrings: options.forbiddenStrings ?? [],
    });
  }

  const overallHardGate = scenarioResults.some((s) => s.hardOutcome === 'FAIL')
    ? 'FAIL'
    : 'PASS';

  return {
    suite,
    packageId,
    serial,
    dryRun,
    runDir: finalized.runDir,
    runMeta: finalized.runMeta,
    timelineCount: finalized.timelineCount,
    overallHardGate,
    scenarios: scenarioResults,
    llmReview,
  };
}

export async function runSuiteCli(suite, argv = process.argv.slice(2)) {
  const cliOptions = parseCliArgs(argv);
  const result = await runAndroidSuite({
    suite,
    ...cliOptions,
  });
  const counts = result.scenarios.reduce(
    (acc, s) => {
      acc[s.hardOutcome] = (acc[s.hardOutcome] ?? 0) + 1;
      return acc;
    },
    {},
  );
  console.log(
    JSON.stringify(
      {
        suite: result.suite,
        packageId: result.packageId,
        serial: result.serial,
        dryRun: result.dryRun,
        overallHardGate: result.overallHardGate,
        llmReviewVerdict: result.llmReview?.llmReviewVerdict ?? null,
        counts,
        runDir: result.runDir,
      },
      null,
      2,
    ),
  );
  if (result.overallHardGate !== 'PASS') {
    process.exitCode = 1;
  }
  return result;
}
