import type { CdpClient, DisplayMetrics, AppWebViewSession } from '../android-driver/index.mjs';
import type {
  HardAssertionRecord,
  LlmReviewInput,
  LlmReviewOutput,
  RunArtifactCollector,
  ScenarioOutcome,
} from '../android-artifacts/index.mjs';

export const E2E_PACKAGE_ID: 'io.localfiction.harness.e2e';
export const SMOKE_PACKAGE_ID: 'io.localfiction.harness.smoke';
export const RELEASE_PACKAGE_ID: 'io.localfiction.harness';

export const DEFAULT_E2E_APK: string;
export const DEFAULT_SMOKE_APK: string;

export const TIMEOUTS: Readonly<{
  domStableMs: number;
  wizardVerifyMs: number;
  keyboardPopupMs: number;
  keyboardOrLauncherMs: number;
  postBackgroundSettleMs: number;
  liveApiTurnMs: number;
  liveApiReasoningOrSearchMs: number;
  researchBalanceMs: number;
}>;

export const E2E_SCENARIO_IDS: readonly string[];
export const SMOKE_SCENARIO_IDS: readonly string[];
export const TIMED_OR_GESTURE_SCENARIOS: Set<string>;

export type AdbRunner = (
  command: string,
  args: string[],
  options?: { allowFailure?: boolean; encoding?: 'utf8' | 'buffer'; background?: boolean },
) => string | Buffer | Promise<string | Buffer>;

export interface ScenarioExecutionResult {
  scenarioId: string;
  hardOutcome: ScenarioOutcome;
  assertions: HardAssertionRecord[];
  artifactPaths: string[];
  error: string | null;
}

export interface SuiteRunContext {
  suite: 'e2e' | 'smoke';
  packageId: string;
  serial: string;
  dryRun: boolean;
  record: boolean;
  keepStories: boolean;
  lockscreenProtected?: boolean;
  timings: Record<string, number>;
  adbRunner: AdbRunner;
  cdpFactory: (opts: { serial: string; packageId: string; runCommand: AdbRunner }) => Promise<AppWebViewSession>;
  uiDriver: Record<string, (...args: any[]) => Promise<any>> | null;
  session: AppWebViewSession | null;
  collector: RunArtifactCollector;
  mockSse?: import('../android-driver/index.mjs').MockSseServer | null;
  mockRemotePort?: number | null;
  currentScenarioId: string | null;
  driver: typeof import('../android-driver/index.mjs');
  artifacts: typeof import('../android-artifacts/index.mjs');
  backRegression: typeof import('../android-back-regression.mjs');
}

export function sha256Hex(bufferOrText: Buffer | string): string;
export function sleep(ms: number): Promise<void>;
export function defaultCommandRunner(
  command: string,
  args?: string[],
  options?: { allowFailure?: boolean; encoding?: 'utf8' | 'buffer' },
): string | Buffer;
export function defaultSpawnProcess(command: string, args?: string[]): { kill?: (signal?: string) => void };
export function adbArgs(serial: string | undefined, rest: string[]): string[];
export function runAdb(
  ctx: SuiteRunContext,
  rest: string[],
  options?: { allowFailure?: boolean; encoding?: 'utf8' | 'buffer' },
): Promise<string | Buffer>;
export function waitForCondition<T>(
  check: () => Promise<T | null | false | undefined> | T | null | false | undefined,
  options: { description: string; timeoutMs?: number; intervalMs?: number },
): Promise<T>;
export function resolveConnectedSerial(requestedSerial?: string, adbRunner?: AdbRunner): string;
export function readActivityState(ctx: SuiteRunContext): Promise<{
  raw: string;
  topResumedActivity: string | null;
  launcherTopResumed: boolean;
  isPackageTopResumed: boolean;
}>;
export function waitForPackageTopResumed(
  ctx: SuiteRunContext,
  expected?: boolean,
  description?: string,
  timeoutMs?: number,
): Promise<{
  raw: string;
  topResumedActivity: string | null;
  launcherTopResumed: boolean;
  isPackageTopResumed: boolean;
}>;
export function readWindowFocus(ctx: SuiteRunContext): Promise<string>;
export function readUiHierarchy(ctx: SuiteRunContext): Promise<string>;
export function checkLockscreenProtected(ctx: SuiteRunContext): Promise<{ protected: boolean; reason: string }>;
export function launchApp(ctx: SuiteRunContext, options?: { clearData?: boolean; stopFirst?: boolean }): Promise<void>;
export function pressKeyevent(ctx: SuiteRunContext, keycode: string): Promise<void>;
export function injectSwipe(
  ctx: SuiteRunContext,
  coords: { x1: number; y1: number; x2: number; y2: number; durationMs?: number },
): Promise<void>;
export function injectTap(ctx: SuiteRunContext, point: { x: number; y: number }): Promise<void>;
export function readDisplayMetrics(ctx: SuiteRunContext): Promise<DisplayMetrics>;
export function cdpEvaluate<T = unknown>(ctx: SuiteRunContext, expr: string): Promise<T>;
export function cdpClickSelector(ctx: SuiteRunContext, selector: string, description?: string): Promise<boolean>;
export function cdpFillInput(ctx: SuiteRunContext, selector: string, value: string, description?: string): Promise<boolean>;
export function cdpReadSnapshot(ctx: SuiteRunContext): Promise<Record<string, unknown>>;
export function cdpQueryElementMetrics(
  ctx: SuiteRunContext,
  selector: string,
): Promise<{
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  unobscured: boolean;
  visualViewport: { offsetLeft: number; offsetTop: number; scale: number };
  dpr: number;
} | null>;
export function collectScenarioLogsAndBundle(
  ctx: SuiteRunContext,
  scenarioId: string,
  window: { windowStartMs: number; windowEndMs: number },
): Promise<void>;
export function assertSafeCaptureAllowed(ctx: SuiteRunContext): Promise<void>;
export function safeCaptureStep(
  ctx: SuiteRunContext,
  scenarioId: string,
  stepName: string,
  options?: Record<string, unknown>,
): Promise<{ png?: string; dom?: string; ui?: string; activity?: string }>;
export function executeScenarioWithGuard(
  ctx: SuiteRunContext,
  scenarioId: string,
  fn: (helpers: {
    addAssertion: (record: HardAssertionRecord) => HardAssertionRecord;
    assertions: HardAssertionRecord[];
    startedAtMs: number;
  }) => Promise<{ hardOutcome?: ScenarioOutcome } | void>,
): Promise<ScenarioExecutionResult>;
export function buildDefaultHardGateReviewer(): (
  reviewInput: LlmReviewInput,
) => Promise<LlmReviewOutput>;
