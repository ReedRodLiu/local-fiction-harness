import type { AppWebViewSession, MockSseServer } from '../android-driver/index.mjs';
import type { LlmReviewInput, LlmReviewOutput } from '../android-artifacts/index.mjs';
import type { AdbRunner, ScenarioExecutionResult } from './common.d.mts';

export interface ParsedRunnerCliOptions {
  serial?: string;
  apk?: string;
  record: boolean;
  keepStories: boolean;
  dryRun: boolean;
  only?: string[];
  artifactsDir?: string;
  label?: string;
}

export interface RunAndroidSuiteOptions {
  suite: 'e2e' | 'smoke';
  serial?: string;
  apk?: string;
  installDefaultApk?: boolean;
  record?: boolean;
  keepStories?: boolean;
  dryRun?: boolean;
  only?: string[];
  artifactsDir?: string;
  label?: string;
  lockscreenProtected?: boolean;
  hasCustomProfile?: boolean;
  failScenario?: string;
  timings?: Record<string, number>;
  forbiddenStrings?: string[];
  mockRemotePort?: number;
  adbRunner?: AdbRunner;
  cdpFactory?: (opts: {
    serial: string;
    packageId: string;
    runCommand: AdbRunner;
  }) => Promise<AppWebViewSession>;
  uiDriver?: Record<string, (...args: any[]) => Promise<any>> | null;
  reviewerFn?: (reviewInput: LlmReviewInput) => Promise<LlmReviewOutput> | LlmReviewOutput;
  mockSseFactory?: () => Promise<MockSseServer>;
  spawnProcess?: (command: string, args: string[]) => { kill?: (signal?: string) => void };
}

export interface RunAndroidSuiteResult {
  suite: 'e2e' | 'smoke';
  packageId: string;
  serial: string;
  dryRun: boolean;
  runDir: string;
  runMeta: Record<string, unknown>;
  timelineCount: number;
  overallHardGate: 'PASS' | 'FAIL';
  scenarios: ScenarioExecutionResult[];
  llmReview: LlmReviewOutput;
}

export function parseCliArgs(argv: string[]): ParsedRunnerCliOptions;
export function runAndroidSuite(options: RunAndroidSuiteOptions): Promise<RunAndroidSuiteResult>;
export function runSuiteCli(
  suite: 'e2e' | 'smoke',
  argv?: string[],
): Promise<RunAndroidSuiteResult>;
