import type { HardAssertionRecord, ScenarioOutcome } from './collector.mjs';

export interface LlmReviewScenarioInput {
  scenarioId: string;
  hardOutcome: ScenarioOutcome;
  assertions: readonly HardAssertionRecord[];
  artifactPaths: readonly string[];
  timelineSlice: unknown[];
  screenshotPaths: string[];
  logcatExcerptPath?: string;
  diagnosticBundlePath: string | null;
  videoPath: string | null;
  [key: string]: unknown;
}

export interface LlmReviewDeviceInfo {
  serial: string;
  apiLevel: number | string | null;
  displaySizePx: string | Record<string, unknown> | null;
  clockOffsetMs: number;
}

export interface LlmReviewInput {
  schemaVersion: number;
  runId: string;
  suite: 'e2e' | 'smoke' | string;
  packageId: string;
  device: LlmReviewDeviceInfo;
  generatedAt: string;
  runMeta: Record<string, unknown>;
  scenarios: LlmReviewScenarioInput[];
}

export type ScenarioReviewStatus =
  | 'CONFIRMED_PASS'
  | 'FAIL_ATTRIBUTED'
  | 'VISUAL_WARNING_NEEDS_REVIEW'
  | 'SKIPPED_ACKNOWLEDGED';

export interface EvidenceCitation {
  artifactPath: string;
  hostTsMs?: number | null;
  observation: string;
}

export interface ScenarioReview {
  scenarioId: string;
  hardOutcome: ScenarioOutcome;
  reviewStatus: ScenarioReviewStatus;
  summary: string;
  suspectedComponent?: string | null;
  reproSteps?: string[];
  visualFindings?: string[];
  evidenceCitations: EvidenceCitation[];
}

export interface LlmReviewOutput {
  runId: string;
  overallHardGate: 'PASS' | 'FAIL';
  llmReviewVerdict: 'CONFIRMED_PASS' | 'CONFIRMED_FAIL' | 'NEEDS_HUMAN_REVIEW';
  scenarioReviews: ScenarioReview[];
}

export function buildLlmReviewInput(options: {
  runMeta: Record<string, unknown>;
  scenarios: ReadonlyArray<{
    scenarioId: string;
    hardOutcome: ScenarioOutcome;
    assertions?: readonly HardAssertionRecord[];
    artifactPaths?: readonly string[];
    [key: string]: unknown;
  }>;
  artifactsRoot: string;
  forbiddenStrings?: readonly string[];
}): LlmReviewInput;

export function validateLlmReviewOutput(
  output: LlmReviewOutput,
  options: {
    reviewInput: LlmReviewInput;
    artifactsRoot: string;
  },
): LlmReviewOutput;

export function reviewRunWithLlm(options: {
  reviewInput: LlmReviewInput;
  artifactsRoot: string;
  reviewerFn: (reviewInput: LlmReviewInput) => Promise<LlmReviewOutput> | LlmReviewOutput;
  forbiddenStrings?: readonly string[];
}): Promise<LlmReviewOutput>;
