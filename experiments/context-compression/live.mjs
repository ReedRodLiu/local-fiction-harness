import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GO_EXPERIMENT_SETTINGS,
  GO_CANONICAL_MODEL,
  GO_MODEL,
  GO_USER_AGENT,
  runGoExperiment,
} from './live.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readInteger(name, fallback) {
  const text = readOption(name);
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer.`);
  return Number(text);
}

function readNumber(name, fallback) {
  const text = readOption(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function assertOutsideRepository(outputDirectory) {
  const relativePath = relative(repoRoot, outputDirectory);
  if (relativePath === '' || (!isAbsolute(relativePath) && !relativePath.startsWith('..'))) {
    throw new Error('--output-dir must be outside the repository so generated synthetic output is not committed.');
  }
}

function outputMarkdown(state) {
  const lines = [
    `# OpenCode Go context compression run ${state.runId}`,
    '',
    `- Status: ${state.status}`,
    `- Model: ${state.provider.model} (${state.provider.canonicalModel})`,
    `- Turns requested per arm/repetition: ${state.settings.turns}`,
    '- Allowance is plan quota evidence. This file makes no USD claim.',
    '',
  ];
  for (const repetition of state.repetitions) {
    for (const arm of repetition.order) {
      const armState = repetition.arms[arm];
      lines.push(`## Repetition ${repetition.index + 1} / ${arm}`, '', `Status: ${armState.status}`, '');
      for (const output of armState.generatedOutputs) {
        lines.push(
          `### ${output.turnId} · ${output.routeId}`,
          '',
          `Player: ${output.user}`,
          '',
          output.assistant,
          '',
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

if (!process.argv.includes('--live')) {
  throw new Error(
    'Live mode requires the explicit --live flag. No request was sent. See experiments/context-compression/README.md.',
  );
}

const outputOption = readOption('--output-dir');
if (!outputOption) {
  throw new Error('--output-dir is required and must be outside the repository.');
}
const outputDirectory = resolve(outputOption);
assertOutsideRepository(outputDirectory);

const apiKey = process.env.LFH_OPENCODE_GO_API_KEY;
if (!apiKey?.trim()) {
  throw new Error('LFH_OPENCODE_GO_API_KEY is required in the process environment. No request was sent.');
}

const turns = readInteger('--turns', DEFAULT_GO_EXPERIMENT_SETTINGS.turns);
const repetitions = readInteger('--repeat', DEFAULT_GO_EXPERIMENT_SETTINGS.repetitions);
const orderText = readOption('--order');
const order = orderText === undefined
  ? [...DEFAULT_GO_EXPERIMENT_SETTINGS.order]
  : orderText.split(',').map((arm) => arm.trim()).filter(Boolean);
const settings = {
  ...DEFAULT_GO_EXPERIMENT_SETTINGS,
  turns,
  repetitions,
  order,
  maxRequests: readInteger('--max-requests', DEFAULT_GO_EXPERIMENT_SETTINGS.maxRequests),
  maxRetries: readInteger('--max-retries', DEFAULT_GO_EXPERIMENT_SETTINGS.maxRetries),
  maxInputTokensPerRequest: readInteger('--max-input-tokens-per-request', DEFAULT_GO_EXPERIMENT_SETTINGS.maxInputTokensPerRequest),
  maxTotalInputTokens: readInteger('--max-total-input-tokens', DEFAULT_GO_EXPERIMENT_SETTINGS.maxTotalInputTokens),
  maxOutputTokensPerRequest: readInteger('--max-output-tokens', DEFAULT_GO_EXPERIMENT_SETTINGS.maxOutputTokensPerRequest),
  maxTotalOutputTokens: readInteger('--max-total-output-tokens', DEFAULT_GO_EXPERIMENT_SETTINGS.maxTotalOutputTokens),
  maxAllowance: readNumber('--max-allowance', DEFAULT_GO_EXPERIMENT_SETTINGS.maxAllowance),
  hardStopUsagePercent: readNumber('--hard-stop-percent', DEFAULT_GO_EXPERIMENT_SETTINGS.hardStopUsagePercent),
  requestTimeoutMs: readInteger('--request-timeout-ms', DEFAULT_GO_EXPERIMENT_SETTINGS.requestTimeoutMs),
  cadenceMs: readInteger('--cadence-ms', DEFAULT_GO_EXPERIMENT_SETTINGS.cadenceMs),
};
const reasoningEffort = readOption('--reasoning-effort');
const summaryReasoningEffort = readOption('--summary-reasoning-effort');
if (reasoningEffort !== undefined) settings.reasoningEffort = reasoningEffort;
if (summaryReasoningEffort !== undefined) settings.summaryReasoningEffort = summaryReasoningEffort;

await mkdir(outputDirectory, { recursive: false });

const runId = randomUUID();
const sessionIds = Object.fromEntries(
  ['full', 'folio', 'retrievable'].map((arm) => [arm, `ses_folio_${runId}_${arm}`]),
);
let checkpointSequence = 0;

async function atomicWrite(path, content) {
  checkpointSequence += 1;
  const temporaryPath = `${path}.${process.pid}.${checkpointSequence}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
}

const statePath = resolve(outputDirectory, 'run.json');
const outputPath = resolve(outputDirectory, 'generated-output.md');
const state = await runGoExperiment({
  apiKey,
  runId,
  sessionIds,
  fetch: globalThis.fetch,
  settings,
  async onCheckpoint(nextState) {
    await Promise.all([
      atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`),
      atomicWrite(outputPath, outputMarkdown(nextState)),
    ]);
  },
});

console.log(JSON.stringify({
  status: state.status,
  outputDirectory,
  model: GO_MODEL,
  canonicalModel: GO_CANONICAL_MODEL,
  userAgent: GO_USER_AGENT,
  usagePreflight: state.usagePreflight,
  usagePostflight: state.usagePostflight,
  summary: state.summary,
  failure: state.failure,
}, null, 2));

if (state.status !== 'completed') process.exitCode = 1;
