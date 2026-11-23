import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineSmoke } from './experiment.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--real')) {
  throw new Error(
    'Official DeepSeek mode remains disabled until an authorized test credential and completed funded-run preflight are available. No request was sent.',
  );
}

const seedText = readOption('--seed');
const seed = seedText === undefined ? 20261123 : Number(seedText);
if (!Number.isSafeInteger(seed) || seed < 0) {
  throw new Error('--seed must be a non-negative safe integer.');
}

const nowText = readOption('--now');
const nowMs = nowText === undefined ? Date.now() : Date.parse(nowText);
if (!Number.isFinite(nowMs)) {
  throw new Error('--now must be an ISO date string.');
}

const report = await runOfflineSmoke({ seed, now: () => nowMs });
if (
  !report.branchIsolation.passed ||
  !report.branchLifecycle.reopenedAfterRestart ||
  !report.branchLifecycle.editedSiblingIsolated ||
  !report.routeReturns.aToBToA.passed ||
  !report.routeReturns.aToBToC.passed ||
  !report.folioSummaryPolicy.passed
) {
  throw new Error('Offline branch isolation or lifecycle verification failed.');
}

const outputOption = readOption('--output');
if (outputOption) {
  const outputPath = resolve(repoRoot, outputOption);
  const evidenceRoot = resolve(here, 'evidence');
  const relativeOutput = relative(evidenceRoot, outputPath);
  if (isAbsolute(relativeOutput) || relativeOutput.startsWith('..')) {
    throw new Error('--output must stay inside experiments/context-compression/evidence.');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  schemaVersion: report.schemaVersion,
  mode: report.mode,
  generatedAt: report.generatedAt,
  providerRuns: report.providerRuns,
  credentialStatus: report.credentialStatus,
  branchIsolation: report.branchIsolation,
  branchLifecycle: report.branchLifecycle,
  routeReturns: report.routeReturns,
  folioSummaryPolicy: report.folioSummaryPolicy,
  officialPreflight: report.officialPreflight,
  groups: Object.fromEntries(Object.entries(report.groups).map(([arm, summary]) => [arm, {
    records: summary.records,
    effectiveTurns: summary.effectiveTurns,
    completedTurns: summary.completedTurnIds.length,
    outboundRequestCount: summary.outboundRequestCount,
    localRetrievalCount: summary.localRetrievalCount,
    missingUsageRecords: summary.missingUsageRecords,
    visibleOutputCharCount: summary.visibleOutputCharCount,
    completionRate: summary.completionRate,
    firstContentLatencyMsP50: summary.firstContentLatencyMsP50,
    firstContentLatencyMsP95: summary.firstContentLatencyMsP95,
    latencySampleCount: summary.latencySampleCount,
  }])),
  comparisons: report.comparisons,
}, null, 2));
