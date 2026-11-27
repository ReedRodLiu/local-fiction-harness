import type { HardAssertionRecord, ScenarioOutcome } from './collector.mjs';

export interface LlmReviewScenarioInput {
  scenarioId: string;
  hardOutcome: ScenarioOutcome;
  assertions: readonly HardAssertionRecord[];
  artifactPaths: readonly string[];
  [key: string]: unknown;
}

export interface LlmReviewInput {
  schemaVersion: number;
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
  observation: string;
}

export interface ScenarioReview {
  scenarioId: string;
  reviewStatus: ScenarioReviewStatus;
  summary: string;
  evidenceCitations: EvidenceCitation[];
}

export interface LlmReviewOutput {
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
