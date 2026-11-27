import type { CdpEvalClient, ClockSyncMeta, CommandRunner, TimelineEvent, TimelineLevel } from './timeline.mjs';

export type ScenarioOutcome =
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED_LOCKSCREEN_PROTECTED'
  | 'SKIPPED_NO_CUSTOM_PROFILE';

export interface HardAssertionRecord {
  id: string;
  kind: 'dom' | 'storage' | 'system_state' | 'privacy_guard';
  passed: boolean;
  expected: string;
  actual: string;
  artifactPath?: string;
}

export interface DiagnosticBundleLike {
  schemaVersion: number;
  generatedAt: string;
  platform: 'web' | 'android' | string;
  windowMinutes: number;
  trigger: string;
  appEnv: Record<string, unknown>;
  endpointProfile: Record<string, unknown>;
  importRadars: unknown[];
  events: Array<{
    tsOffsetSec?: number;
    level?: string;
    category?: string;
    action?: string;
    statusCode?: number;
    errorCode?: string;
    sanitizedReason?: string;
    [key: string]: unknown;
  }>;
  userNote?: string;
  activeStorySkeleton?: Record<string, unknown>;
  workspaceSkeleton?: Record<string, unknown>;
}

export interface RunArtifactCollector {
  readonly runDir: string;
  readonly scenariosDir: string;
  getScenarioDir(scenarioId: string): string;
  setClockSync(syncMeta: ClockSyncMeta | null): void;
  recordEvent(event: TimelineEvent): void;
  recordEvents(events: readonly TimelineEvent[]): void;
  startScenario(
    scenarioId: string,
    options?: {
      record?: boolean;
      timedOrGesture?: boolean;
      maxRecordSec?: number;
      serial?: string;
      startedAtMs?: number;
    },
  ): Promise<string>;
  captureStep(
    scenarioId: string,
    stepName: string,
    options?: {
      serial?: string;
      client?: CdpEvalClient | null;
      screenshotPng?: Buffer;
      domSnapshot?: Record<string, unknown> | null;
      uiXml?: string;
      activityDump?: string;
      includePng?: boolean;
      includeDom?: boolean;
      includeUi?: boolean;
      includeActivity?: boolean;
      isFailure?: boolean;
    },
  ): Promise<{ png?: string; dom?: string; ui?: string; activity?: string }>;
  captureFailure(
    scenarioId: string,
    options?: {
      serial?: string;
      client?: CdpEvalClient | null;
      screenshotPng?: Buffer;
      domSnapshot?: Record<string, unknown> | null;
      uiXml?: string;
      activityDump?: string;
      includePng?: boolean;
      includeDom?: boolean;
      includeUi?: boolean;
      includeActivity?: boolean;
    },
  ): Promise<{ png?: string; dom?: string; ui?: string; activity?: string }>;
  writeAssertions(
    scenarioId: string,
    payload: {
      hardOutcome?: ScenarioOutcome;
      assertions: readonly HardAssertionRecord[];
      startedAtMs?: number;
      finishedAtMs?: number;
      error?: string;
    },
  ): string;
  writeLogcat(
    scenarioId: string,
    rawLogcat: string,
    parseOptions?: {
      pid?: number | string | null;
      clockOffsetMs?: number;
      windowStartMs?: number;
      windowEndMs?: number;
      packageName?: string;
      referenceHostMs?: number;
      referenceYear?: number;
      timezoneOffsetMinutes?: number;
    },
  ): string;
  writeConsoleEvents(
    scenarioId: string,
    consoleEvents: ReadonlyArray<{
      hostTsMs?: number;
      rawDeviceTs?: string;
      source?: 'cdp_console' | 'cdp_lifecycle';
      level?: TimelineLevel;
      event?: string;
      details?: Record<string, unknown>;
    }>,
  ): string;
  writeDiagnosticBundle(
    scenarioId: string,
    bundle: DiagnosticBundleLike,
    options?: { clockOffsetMs?: number },
  ): string;
  finishScenario(
    scenarioId: string,
    options?: {
      hardOutcome: ScenarioOutcome;
      assertions?: readonly HardAssertionRecord[];
      finishedAtMs?: number;
      error?: string;
    },
  ): Promise<unknown>;
  finalizeRun(options?: { finishedAt?: string }): Promise<{
    runDir: string;
    runMeta: Record<string, unknown>;
    timelineCount: number;
  }>;
}

export function createRunArtifactCollector(options: {
  rootDir: string;
  suite: string;
  runId: string;
  deviceMeta?: Record<string, unknown> & { serial?: string };
  runCommand?: CommandRunner;
  spawnProcess?: (command: string, args: string[]) => { kill?: (signal?: string) => void };
}): RunArtifactCollector;

export interface PrivacyLeakFinding {
  path: string;
  rule: string;
  reason: string;
}

export interface PrivacyScanResult {
  clean: boolean;
  leaks: PrivacyLeakFinding[];
}

export function scanForPrivacyLeaks(
  payload: unknown,
  options?: {
    forbiddenStrings?: readonly string[];
    allowWizardMarkers?: boolean;
  },
): PrivacyScanResult;

export function extractDiagnosticBundleViaCdp(
  client: CdpEvalClient,
): Promise<DiagnosticBundleLike | null>;
