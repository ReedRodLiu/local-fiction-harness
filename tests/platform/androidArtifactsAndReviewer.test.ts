import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  measureClockOffset,
  mergeTimelineEvents,
  normalizeDeviceTimestampToHostMs,
  parseLogcatLines,
} from '../../scripts/android-artifacts/timeline.mjs';
import {
  createRunArtifactCollector,
  extractDiagnosticBundleViaCdp,
  scanForPrivacyLeaks,
} from '../../scripts/android-artifacts/collector.mjs';
import {
  buildLlmReviewInput,
  reviewRunWithLlm,
  validateLlmReviewOutput,
} from '../../scripts/android-artifacts/index.mjs';

const tempDirs: string[] = [];

function createTempDir(prefix = 'lfh-artifacts-') {
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

describe('android-artifacts timeline', () => {
  it('measures clockOffsetMs from adb device epoch and optional CDP timeOrigin', async () => {
    const originalNow = Date.now;
    let tick = 0;
    Date.now = () => {
      tick += 1;
      return tick === 1 ? 1_764_224_400_000 : 1_764_224_400_040;
    };

    try {
      const commands: Array<{ cmd: string; args: string[] }> = [];
      const syncMeta = await measureClockOffset({
        serial: 'DEVICE-01',
        runCommand: (cmd: string, args: string[]) => {
          commands.push({ cmd, args });
          return '1764224395020\n';
        },
        client: {
          evaluate: async (expr: string) => {
            expect(expr).toContain('performance.timeOrigin');
            return 1_764_224_390_000;
          },
        },
      });

      expect(commands).toEqual([
        { cmd: 'adb', args: ['-s', 'DEVICE-01', 'shell', 'date', '+%s%3N'] },
      ]);
      expect(syncMeta).toEqual({
        hostMeasuredAtMs: 1_764_224_400_020,
        deviceEpochMs: 1_764_224_395_020,
        clockOffsetMs: 5_000,
        roundTripMs: 40,
        cdpTimeOriginMs: 1_764_224_390_000,
      });

      expect(normalizeDeviceTimestampToHostMs(1_764_224_395_020, syncMeta.clockOffsetMs)).toBe(
        1_764_224_400_020,
      );
      expect(
        normalizeDeviceTimestampToHostMs('11-27 06:20:00.500', 5_000, {
          referenceYear: 2025,
          timezoneOffsetMinutes: 0,
        }),
      ).toBe(Date.UTC(2025, 10, 27, 6, 20, 0, 500) + 5_000);
    } finally {
      Date.now = originalNow;
    }
  });

  it('parses logcat threadtime lines by PID/tags/window and merges all 7 timeline sources stably', () => {
    const baseMs = Date.UTC(2025, 10, 27, 6, 20, 0, 0);
    const clockOffsetMs = 2_000;
    const rawLogcat = [
      '--------- beginning of main',
      '11-27 06:19:50.000  4321  4321 I SseStreamClient: before window',
      '11-27 06:20:01.000  9999  9999 I UnrelatedTag: noise from another app',
      '11-27 06:20:01.100  4321  4350 D SseStreamClient: chunk received bytes=128',
      '11-27 06:20:02.000  1000  1020 W ActivityTaskManager: Top resumed changed',
      '11-27 06:20:03.000  4321  4355 E SseForegroundService: keepalive aborted',
      '11-27 06:20:04.000  7777  7780 W chromium: [CONSOLE] WebView warning',
      '11-27 06:20:20.000  4321  4321 I SseStreamClient: after window',
    ].join('\n');

    const logcatEvents = parseLogcatLines(rawLogcat, {
      pid: 4321,
      clockOffsetMs,
      scenarioId: 'E2E-06',
      windowStartMs: baseMs,
      windowEndMs: baseMs + 10_000,
      referenceYear: 2025,
      timezoneOffsetMinutes: 0,
    });

    expect(logcatEvents).toHaveLength(4);
    expect(logcatEvents.map((e) => e.level)).toEqual(['info', 'warn', 'error', 'warn']);
    expect(logcatEvents.map((e) => e.hostTsMs)).toEqual([
      baseMs + 3_100,
      baseMs + 4_000,
      baseMs + 5_000,
      baseMs + 6_000,
    ]);

    const merged = mergeTimelineEvents([
      {
        hostTsMs: baseMs + 6_500,
        source: 'diagnostic_bundle',
        scenarioId: 'E2E-06',
        level: 'info',
        event: 'stream_aborted',
      },
      ...logcatEvents,
      {
        hostTsMs: baseMs + 1_000,
        source: 'host',
        scenarioId: 'E2E-06',
        level: 'info',
        event: 'scenario_start',
      },
      {
        hostTsMs: baseMs + 3_100,
        source: 'cdp_console',
        scenarioId: 'E2E-06',
        level: 'info',
        event: 'console.info',
      },
      {
        hostTsMs: baseMs + 2_500,
        source: 'mock_sse',
        scenarioId: 'E2E-06',
        level: 'info',
        event: 'sse_chunk_sent',
      },
      {
        hostTsMs: baseMs + 3_500,
        source: 'adb',
        scenarioId: 'E2E-06',
        level: 'info',
        event: 'KEYCODE_HOME',
      },
      {
        hostTsMs: baseMs + 4_500,
        source: 'cdp_lifecycle',
        scenarioId: 'E2E-06',
        level: 'warn',
        event: 'Target.detachedFromTarget',
      },
    ]);

    expect(merged.map((e) => e.source)).toEqual([
      'host',
      'mock_sse',
      'logcat',
      'cdp_console',
      'adb',
      'logcat',
      'cdp_lifecycle',
      'logcat',
      'logcat',
      'diagnostic_bundle',
    ]);
    expect(merged.map((e) => e.hostTsMs)).toEqual([
      baseMs + 1_000,
      baseMs + 2_500,
      baseMs + 3_100,
      baseMs + 3_100,
      baseMs + 3_500,
      baseMs + 4_000,
      baseMs + 4_500,
      baseMs + 5_000,
      baseMs + 6_000,
      baseMs + 6_500,
    ]);
  });
});

describe('android-artifacts collector', () => {
  it('writes standardized directory layout, deletes screenrecord MP4 on PASS, and pulls/retains MP4 on FAIL', async () => {
    const rootDir = createTempDir();
    const adbCalls: string[] = [];
    const runCommand = (cmd: string, args: string[]) => {
      adbCalls.push(`${cmd} ${args.join(' ')}`);
      if (args.includes('pull')) {
        const localDest = args[args.length - 1];
        fs.mkdirSync(path.dirname(localDest), { recursive: true });
        fs.writeFileSync(localDest, Buffer.from('fake-mp4-bytes'));
        return '1 file pulled.';
      }
      if (args.includes('screencap')) {
        return Buffer.from('fake-png-bytes');
      }
      if (args.includes('dumpsys')) {
        return 'topResumedActivity=ActivityRecord{io.localfiction.harness.e2e/.MainActivity}';
      }
      return '';
    };

    const collector = createRunArtifactCollector({
      rootDir,
      suite: 'e2e',
      runId: 'run-001',
      deviceMeta: {
        serial: 'DEVICE-01',
        model: 'Pixel_9',
        androidVersion: '16',
        packageId: 'io.localfiction.harness.e2e',
      },
      runCommand,
    });

    const baseMs = Date.UTC(2025, 10, 27, 6, 20, 0, 0);
    collector.setClockSync({
      hostMeasuredAtMs: baseMs,
      deviceEpochMs: baseMs - 1000,
      clockOffsetMs: 1000,
      roundTripMs: 10,
      cdpTimeOriginMs: baseMs - 2000,
    });

    await collector.startScenario('E2E-03', { record: true, serial: 'DEVICE-01' });
    await collector.captureStep('E2E-03', 'drawer-open', {
      serial: 'DEVICE-01',
      domSnapshot: { url: 'http://localhost/', readyState: 'complete' },
      uiXml: '<hierarchy><node text="Story" /></hierarchy>',
    });
    collector.writeLogcat(
      'E2E-03',
      '11-27 06:20:01.000  4321  4321 I SseStreamClient: drawer stable\n',
      { pid: 4321, clockOffsetMs: 1000, referenceYear: 2025, timezoneOffsetMinutes: 0 },
    );
    collector.writeConsoleEvents('E2E-03', [
      { hostTsMs: baseMs + 1500, level: 'info', event: 'console.log', details: { text: 'ok' } },
    ]);
    collector.writeDiagnosticBundle('E2E-03', {
      schemaVersion: 2,
      generatedAt: new Date(baseMs + 3000).toISOString(),
      platform: 'android',
      windowMinutes: 60,
      trigger: 'settings_manual',
      appEnv: {
        platform: 'android',
        appVersion: '0.5.0-beta.1',
        viewport: '412x915',
        activeView: 'stage',
        storyCount: 1,
      },
      endpointProfile: {
        presetId: 'deepseek-official',
        endpointKind: 'official',
        hostLabel: 'api.deepseek.com',
        model: 'deepseek-chat',
      },
      importRadars: [],
      events: [
        {
          tsOffsetSec: -1,
          level: 'info',
          category: 'llm',
          action: 'stream_done',
        },
      ],
    });
    await collector.finishScenario('E2E-03', {
      hardOutcome: 'PASS',
      assertions: [
        {
          id: 'drawer-swipe',
          kind: 'dom',
          passed: true,
          expected: 'open',
          actual: 'open',
          artifactPath: 'scenarios/E2E-03/steps/drawer-open.png',
        },
      ],
    });

    await collector.startScenario('E2E-06', { timedOrGesture: true, serial: 'DEVICE-01' });
    await collector.captureFailure('E2E-06', {
      serial: 'DEVICE-01',
      domSnapshot: { url: 'http://localhost/', error: 'aborted' },
      uiXml: '<hierarchy><node text="Error" /></hierarchy>',
    });
    await collector.finishScenario('E2E-06', {
      hardOutcome: 'FAIL',
      assertions: [
        {
          id: 'keepalive-survival',
          kind: 'system_state',
          passed: false,
          expected: 'stream_done',
          actual: 'CONNECTION_ABORTED',
          artifactPath: 'scenarios/E2E-06/failure.png',
        },
      ],
    });

    const summary = await collector.finalizeRun();

    const expectedRunDir = path.join(rootDir, 'android', 'captures', 'e2e-run-001');
    expect(summary.runDir).toBe(expectedRunDir);
    expect(fs.existsSync(path.join(expectedRunDir, 'run.json'))).toBe(true);
    expect(fs.existsSync(path.join(expectedRunDir, 'timeline.jsonl'))).toBe(true);

    // E2E-03 (PASS): artifacts present, screenrecord.mp4 deleted / not retained
    const e2e03Dir = path.join(expectedRunDir, 'scenarios', 'E2E-03');
    expect(fs.existsSync(path.join(e2e03Dir, 'assertions.json'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'logcat.txt'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'console.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'diagnostic-bundle.json'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'steps', 'drawer-open.png'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'steps', 'drawer-open.dom.json'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'steps', 'drawer-open.ui.xml'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'steps', 'drawer-open.activity.txt'))).toBe(true);
    expect(fs.existsSync(path.join(e2e03Dir, 'screenrecord.mp4'))).toBe(false);

    // E2E-06 (FAIL): failure.* and screenrecord.mp4 pulled & retained
    const e2e06Dir = path.join(expectedRunDir, 'scenarios', 'E2E-06');
    expect(fs.existsSync(path.join(e2e06Dir, 'failure.png'))).toBe(true);
    expect(fs.existsSync(path.join(e2e06Dir, 'failure.dom.json'))).toBe(true);
    expect(fs.existsSync(path.join(e2e06Dir, 'failure.ui.xml'))).toBe(true);
    expect(fs.existsSync(path.join(e2e06Dir, 'failure.activity.txt'))).toBe(true);
    expect(fs.existsSync(path.join(e2e06Dir, 'screenrecord.mp4'))).toBe(true);

    const timelineLines = fs
      .readFileSync(path.join(expectedRunDir, 'timeline.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(timelineLines.length).toBeGreaterThanOrEqual(3);
    expect(adbCalls.some((c) => c.includes('pull') && c.includes('E2E-06'))).toBe(true);
    expect(adbCalls.some((c) => c.includes('pull') && c.includes('E2E-03'))).toBe(false);
  });

  it('extracts DiagnosticBundle via CDP from [data-testid="diagnostics-json"] without clicking diagnostics-export', async () => {
    const sampleBundle = {
      schemaVersion: 2,
      generatedAt: '2026-11-27T06:20:35.000Z',
      platform: 'android',
      windowMinutes: 60,
      trigger: 'settings_manual',
      appEnv: {
        platform: 'android',
        appVersion: '0.5.0-beta.1',
        viewport: '412x915',
        activeView: 'settings',
        storyCount: 2,
      },
      endpointProfile: {
        presetId: 'deepseek-official',
        endpointKind: 'official',
        hostLabel: 'api.deepseek.com',
        model: 'deepseek-chat',
      },
      importRadars: [],
      events: [{ tsOffsetSec: -5, level: 'info', category: 'llm', action: 'stream_done' }],
    };

    const evaluatedExpressions: string[] = [];
    const client = {
      evaluate: async (expression: string) => {
        evaluatedExpressions.push(expression);
        expect(expression).not.toMatch(/diagnostics-export[^]*?\.click\s*\(/);
        return {
          jsonText: JSON.stringify(sampleBundle),
          storageText: JSON.stringify({
            events: [{ ts: 1_764_224_430_000, level: 'info', category: 'llm', action: 'stream_done' }],
            radars: [],
          }),
        };
      },
    };

    const extracted = await extractDiagnosticBundleViaCdp(client);
    expect(extracted).toEqual(sampleBundle);
    expect(evaluatedExpressions.some((expr) => expr.includes('diagnostics-json'))).toBe(true);
    expect(evaluatedExpressions.some((expr) => expr.includes('lfh.diagnostics.v2'))).toBe(true);

    const missing = await extractDiagnosticBundleViaCdp({
      evaluate: async () => ({ jsonText: null, storageText: null }),
    });
    expect(missing).toBeNull();
  });

  it('detects privacy leaks for sk- keys, Bearer tokens, apiKey fields, wizard markers, and forbiddenStrings', () => {
    const cleanResult = scanForPrivacyLeaks({
      scenarioId: 'SMK-01',
      endpointProfile: { hostLabel: 'api.deepseek.com', apiKey: '' },
      note: 'Normal stream_done event',
    });
    expect(cleanResult.clean).toBe(true);
    expect(cleanResult.leaks).toEqual([]);

    const leakyResult = scanForPrivacyLeaks(
      {
        rawText: 'Authorization: Bearer secret-jwt-token-999 and sk-canary-12345678',
        nested: { apiKey: 'my-secret-value' },
        dom: { testIds: ['deepseek-setup-wizard', 'provider-api-key'] },
        storyExcerpt: 'canary-plot-secret-phrase',
      },
      { forbiddenStrings: ['canary-plot-secret-phrase'] },
    );
    expect(leakyResult.clean).toBe(false);
    const rules = leakyResult.leaks.map((l) => l.rule);
    expect(rules).toContain('sk_key');
    expect(rules).toContain('bearer_token');
    expect(rules).toContain('sensitive_key_field');
    expect(rules).toContain('smoke_key_wizard_marker');
    expect(rules).toContain('forbidden_string');
  });
});

describe('android-artifacts llm-reviewer', () => {
  function setupCaptureFixture() {
    const rootDir = createTempDir();
    const artifactsRoot = path.join(rootDir, 'android', 'captures', 'e2e-run-llm');
    fs.mkdirSync(path.join(artifactsRoot, 'scenarios', 'E2E-01', 'steps'), { recursive: true });
    fs.mkdirSync(path.join(artifactsRoot, 'scenarios', 'E2E-06'), { recursive: true });
    fs.mkdirSync(path.join(artifactsRoot, 'scenarios', 'E2E-07'), { recursive: true });

    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-01', 'steps', 'done.png'),
      Buffer.from('png'),
    );
    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-01', 'assertions.json'),
      JSON.stringify({ scenarioId: 'E2E-01', hardOutcome: 'PASS', assertions: [] }),
    );
    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-06', 'failure.png'),
      Buffer.from('png'),
    );
    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-06', 'assertions.json'),
      JSON.stringify({ scenarioId: 'E2E-06', hardOutcome: 'FAIL', assertions: [] }),
    );
    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-07', 'assertions.json'),
      JSON.stringify({
        scenarioId: 'E2E-07',
        hardOutcome: 'SKIPPED_LOCKSCREEN_PROTECTED',
        assertions: [],
      }),
    );

    const runMeta = { suite: 'e2e', runId: 'run-llm' };
    return { rootDir, artifactsRoot, runMeta };
  }

  it('throws in buildLlmReviewInput if a canary secret leaks into review input or disk artifacts', () => {
    const { artifactsRoot, runMeta } = setupCaptureFixture();
    fs.writeFileSync(
      path.join(artifactsRoot, 'scenarios', 'E2E-01', 'logcat.txt'),
      '11-27 06:20:01.000 100 100 E SseStreamClient: Authorization: Bearer canary-leak-token-777\n',
    );

    expect(() =>
      buildLlmReviewInput({
        runMeta,
        artifactsRoot,
        scenarios: [
          {
            scenarioId: 'E2E-01',
            hardOutcome: 'PASS',
            assertions: [],
            artifactPaths: ['scenarios/E2E-01/steps/done.png', 'scenarios/E2E-01/logcat.txt'],
          },
        ],
      }),
    ).toThrow(/privacy leak/i);

    expect(() =>
      buildLlmReviewInput({
        runMeta,
        artifactsRoot,
        forbiddenStrings: ['my-secret-canary'],
        scenarios: [
          {
            scenarioId: 'E2E-01',
            hardOutcome: 'PASS',
            assertions: [],
            artifactPaths: ['scenarios/E2E-01/steps/done.png'],
            note: 'leaked my-secret-canary here',
          },
        ],
      }),
    ).toThrow(/privacy leak/i);
  });

  it('enforces Hard Gate (never Fail-to-Pass), visual warning downgrade, SKIPPED_* preservation, and real artifactPath citations', async () => {
    const { artifactsRoot, runMeta } = setupCaptureFixture();
    const scenarios = [
      {
        scenarioId: 'E2E-01',
        hardOutcome: 'PASS' as const,
        assertions: [],
        artifactPaths: ['scenarios/E2E-01/steps/done.png'],
      },
      {
        scenarioId: 'E2E-06',
        hardOutcome: 'FAIL' as const,
        assertions: [],
        artifactPaths: ['scenarios/E2E-06/failure.png'],
      },
      {
        scenarioId: 'E2E-07',
        hardOutcome: 'SKIPPED_LOCKSCREEN_PROTECTED' as const,
        assertions: [],
        artifactPaths: ['scenarios/E2E-07/assertions.json'],
      },
    ];

    const reviewInput = buildLlmReviewInput({ runMeta, scenarios, artifactsRoot });

    // Rejects Fail-to-Pass flip
    expect(() =>
      validateLlmReviewOutput(
        {
          overallHardGate: 'PASS',
          llmReviewVerdict: 'CONFIRMED_PASS',
          scenarioReviews: [
            {
              scenarioId: 'E2E-01',
              reviewStatus: 'CONFIRMED_PASS',
              summary: 'ok',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-01/steps/done.png', observation: 'ok' }],
            },
            {
              scenarioId: 'E2E-06',
              reviewStatus: 'CONFIRMED_PASS',
              summary: 'looks fine visually',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-06/failure.png', observation: 'ok' }],
            },
            {
              scenarioId: 'E2E-07',
              reviewStatus: 'SKIPPED_ACKNOWLEDGED',
              summary: 'skipped',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-07/assertions.json', observation: 'skipped' }],
            },
          ],
        },
        { reviewInput, artifactsRoot },
      ),
    ).toThrow(/Hard Gate/i);

    // Rejects hallucinated non-existent artifactPath
    expect(() =>
      validateLlmReviewOutput(
        {
          overallHardGate: 'FAIL',
          llmReviewVerdict: 'CONFIRMED_FAIL',
          scenarioReviews: [
            {
              scenarioId: 'E2E-01',
              reviewStatus: 'CONFIRMED_PASS',
              summary: 'ok',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-01/steps/nonexistent.png', observation: 'hallucinated' }],
            },
            {
              scenarioId: 'E2E-06',
              reviewStatus: 'FAIL_ATTRIBUTED',
              summary: 'aborted',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-06/failure.png', observation: 'error' }],
            },
            {
              scenarioId: 'E2E-07',
              reviewStatus: 'SKIPPED_ACKNOWLEDGED',
              summary: 'skipped',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-07/assertions.json', observation: 'skipped' }],
            },
          ],
        },
        { reviewInput, artifactsRoot },
      ),
    ).toThrow(/artifactPath/i);

    // Valid FAIL attribution writes llm-review-input.json and llm-review-output.json
    const validatedFail = await reviewRunWithLlm({
      reviewInput,
      artifactsRoot,
      reviewerFn: async () => ({
        overallHardGate: 'FAIL',
        llmReviewVerdict: 'CONFIRMED_FAIL',
        scenarioReviews: [
          {
            scenarioId: 'E2E-01',
            reviewStatus: 'CONFIRMED_PASS',
            summary: 'ok',
            evidenceCitations: [{ artifactPath: 'scenarios/E2E-01/steps/done.png', observation: 'ok' }],
          },
          {
            scenarioId: 'E2E-06',
            reviewStatus: 'FAIL_ATTRIBUTED',
            summary: 'Native SSE stream aborted after screen-off',
            evidenceCitations: [{ artifactPath: 'scenarios/E2E-06/failure.png', observation: 'banner visible' }],
          },
          {
            scenarioId: 'E2E-07',
            reviewStatus: 'SKIPPED_ACKNOWLEDGED',
            summary: 'Lockscreen PIN active',
            evidenceCitations: [{ artifactPath: 'scenarios/E2E-07/assertions.json', observation: 'skipped' }],
          },
        ],
      }),
    });
    expect(validatedFail.llmReviewVerdict).toBe('CONFIRMED_FAIL');
    expect(fs.existsSync(path.join(artifactsRoot, 'llm-review-input.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactsRoot, 'llm-review-output.json'))).toBe(true);

    // Downgrade-only visual warning on all-PASS + SKIPPED run forces NEEDS_HUMAN_REVIEW & rejects SKIPPED counted as pass
    const passReviewInput = buildLlmReviewInput({
      runMeta,
      artifactsRoot,
      scenarios: [scenarios[0], scenarios[2]],
    });
    expect(() =>
      validateLlmReviewOutput(
        {
          overallHardGate: 'PASS',
          llmReviewVerdict: 'CONFIRMED_PASS',
          scenarioReviews: [
            {
              scenarioId: 'E2E-01',
              reviewStatus: 'VISUAL_WARNING_NEEDS_REVIEW',
              summary: 'Bottom button clipped near nav bar',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-01/steps/done.png', observation: 'clipped' }],
            },
            {
              scenarioId: 'E2E-07',
              reviewStatus: 'CONFIRMED_PASS',
              summary: 'trying to count skip as pass',
              evidenceCitations: [{ artifactPath: 'scenarios/E2E-07/assertions.json', observation: 'skipped' }],
            },
          ],
        },
        { reviewInput: passReviewInput, artifactsRoot },
      ),
    ).toThrow();

    const downgraded = validateLlmReviewOutput(
      {
        overallHardGate: 'PASS',
        llmReviewVerdict: 'NEEDS_HUMAN_REVIEW',
        scenarioReviews: [
          {
            scenarioId: 'E2E-01',
            reviewStatus: 'VISUAL_WARNING_NEEDS_REVIEW',
            summary: 'Bottom button clipped near nav bar',
            evidenceCitations: [{ artifactPath: 'scenarios/E2E-01/steps/done.png', observation: 'clipped' }],
          },
          {
            scenarioId: 'E2E-07',
            reviewStatus: 'SKIPPED_ACKNOWLEDGED',
            summary: 'Skipped due to PIN',
            evidenceCitations: [{ artifactPath: 'scenarios/E2E-07/assertions.json', observation: 'skipped' }],
          },
        ],
      },
      { reviewInput: passReviewInput, artifactsRoot },
    );
    expect(downgraded.llmReviewVerdict).toBe('NEEDS_HUMAN_REVIEW');
  });
});
