import fs from 'node:fs';
import path from 'node:path';
import { scanForPrivacyLeaks } from './collector.mjs';

const TEXT_ARTIFACT_EXTENSIONS = new Set(['.txt', '.json', '.jsonl', '.xml']);
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

function isWithinRoot(resolvedRoot, resolvedCandidate) {
  return (
    resolvedCandidate !== resolvedRoot &&
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function formatLeakError(leaks, sourceLabel) {
  const details = leaks
    .slice(0, 5)
    .map((leak) => `[${leak.rule}] ${leak.path}: ${leak.reason}`)
    .join('; ');
  return new Error(
    `Privacy leak detected in ${sourceLabel} (${leaks.length} finding(s)): ${details}`,
  );
}

function scanReferencedTextArtifacts({ scenarios, artifactsRoot, forbiddenStrings }) {
  const resolvedRoot = path.resolve(artifactsRoot);
  const visitedPaths = new Set();

  function scanRelativeFile(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      return;
    }
    const ext = path.extname(relPath).toLowerCase();
    if (!TEXT_ARTIFACT_EXTENSIONS.has(ext)) {
      return;
    }
    const resolvedFile = path.resolve(resolvedRoot, relPath);
    if (!isWithinRoot(resolvedRoot, resolvedFile) || visitedPaths.has(resolvedFile)) {
      return;
    }
    visitedPaths.add(resolvedFile);
    if (!fs.existsSync(resolvedFile)) {
      return;
    }
    const stat = fs.statSync(resolvedFile);
    if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
      return;
    }
    const rawText = fs.readFileSync(resolvedFile, 'utf8');
    const scan = scanForPrivacyLeaks(rawText, { forbiddenStrings });
    if (!scan.clean) {
      throw formatLeakError(scan.leaks, `artifact "${relPath}"`);
    }
  }

  // Always scan root timeline.jsonl and run.json first
  scanRelativeFile('timeline.jsonl');
  scanRelativeFile('run.json');

  for (const scenario of scenarios) {
    const candidateRelPaths = new Set(
      Array.isArray(scenario.artifactPaths) ? scenario.artifactPaths : [],
    );

    if (scenario.scenarioId) {
      const scenarioRelDir = path.join('scenarios', String(scenario.scenarioId));
      for (const defaultName of [
        'assertions.json',
        'logcat.txt',
        'console.jsonl',
        'diagnostic-bundle.json',
        'failure.dom.json',
        'failure.ui.xml',
        'failure.activity.txt',
      ]) {
        candidateRelPaths.add(path.join(scenarioRelDir, defaultName));
      }
    }

    for (const relPath of candidateRelPaths) {
      scanRelativeFile(relPath);
    }
  }
}

function readTimelineEventsByScenario(artifactsRoot) {
  const timelinePath = path.join(artifactsRoot, 'timeline.jsonl');
  if (!fs.existsSync(timelinePath)) {
    return new Map();
  }
  const byScenario = new Map();
  const raw = fs.readFileSync(timelinePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      const id = String(evt?.scenarioId ?? '');
      if (!id) continue;
      if (!byScenario.has(id)) {
        byScenario.set(id, []);
      }
      byScenario.get(id).push(evt);
    } catch {
      // Ignore malformed lines; privacy scan still reads raw text.
    }
  }
  return byScenario;
}

export function buildLlmReviewInput({
  runMeta,
  scenarios,
  artifactsRoot,
  forbiddenStrings = [],
}) {
  if (!artifactsRoot) {
    throw new Error('buildLlmReviewInput requires artifactsRoot.');
  }
  if (!Array.isArray(scenarios)) {
    throw new Error('buildLlmReviewInput requires a scenarios array.');
  }

  const meta = runMeta ?? {};
  const suite = meta.suite === 'smoke' ? 'smoke' : 'e2e';
  const runId = String(meta.runId ?? '');
  const packageId = String(
    meta.packageId ??
      meta.deviceMeta?.packageId ??
      (suite === 'smoke' ? 'io.localfiction.harness.smoke' : 'io.localfiction.harness.e2e'),
  );
  const device = {
    serial: String(meta.deviceMeta?.serial ?? 'unknown'),
    apiLevel: meta.deviceMeta?.apiLevel ?? null,
    displaySizePx: meta.deviceMeta?.displaySizePx ?? null,
    clockOffsetMs: Number(meta.clockSync?.clockOffsetMs ?? 0),
  };

  const timelineByScenario = readTimelineEventsByScenario(artifactsRoot);

  const reviewInput = {
    schemaVersion: 1,
    runId,
    suite,
    packageId,
    device,
    generatedAt: new Date().toISOString(),
    runMeta: meta,
    scenarios: scenarios.map((scenario) => {
      const scenarioId = String(scenario.scenarioId);
      const artifactPaths = Array.isArray(scenario.artifactPaths) ? scenario.artifactPaths : [];
      const screenshotPaths = Array.isArray(scenario.screenshotPaths)
        ? scenario.screenshotPaths
        : artifactPaths.filter((p) => typeof p === 'string' && p.endsWith('.png'));
      const logcatRel = `scenarios/${scenarioId}/logcat.txt`;
      const bundleRel = `scenarios/${scenarioId}/diagnostic-bundle.json`;
      const videoRel = `scenarios/${scenarioId}/screenrecord.mp4`;

      const logcatExcerptPath =
        scenario.logcatExcerptPath ??
        artifactPaths.find((p) => p === logcatRel || p.endsWith('/logcat.txt')) ??
        (fs.existsSync(path.join(artifactsRoot, logcatRel)) ? logcatRel : undefined);
      const diagnosticBundlePath =
        scenario.diagnosticBundlePath !== undefined
          ? scenario.diagnosticBundlePath
          : (artifactPaths.find((p) => p === bundleRel || p.endsWith('/diagnostic-bundle.json')) ??
            (fs.existsSync(path.join(artifactsRoot, bundleRel)) ? bundleRel : null));
      const videoPath =
        scenario.videoPath !== undefined
          ? scenario.videoPath
          : (artifactPaths.find((p) => p === videoRel || p.endsWith('.mp4')) ??
            (fs.existsSync(path.join(artifactsRoot, videoRel)) ? videoRel : null));
      const timelineSlice = Array.isArray(scenario.timelineSlice)
        ? scenario.timelineSlice
        : (timelineByScenario.get(scenarioId) ?? []);

      return {
        ...scenario,
        scenarioId,
        hardOutcome: scenario.hardOutcome,
        assertions: Array.isArray(scenario.assertions) ? scenario.assertions : [],
        artifactPaths,
        timelineSlice,
        screenshotPaths,
        ...(logcatExcerptPath ? { logcatExcerptPath } : {}),
        diagnosticBundlePath,
        videoPath,
      };
    }),
  };

  scanReferencedTextArtifacts({
    scenarios: reviewInput.scenarios,
    artifactsRoot,
    forbiddenStrings,
  });

  const inputScan = scanForPrivacyLeaks(reviewInput, { forbiddenStrings });
  if (!inputScan.clean) {
    throw formatLeakError(inputScan.leaks, 'llm-review-input');
  }

  return reviewInput;
}

const VALID_OVERALL_GATES = new Set(['PASS', 'FAIL']);
const VALID_VERDICTS = new Set(['CONFIRMED_PASS', 'CONFIRMED_FAIL', 'NEEDS_HUMAN_REVIEW']);

export function validateLlmReviewOutput(output, { reviewInput, artifactsRoot }) {
  if (!output || typeof output !== 'object') {
    throw new Error('LLM review output must be a non-null object.');
  }
  if (!reviewInput || !Array.isArray(reviewInput.scenarios)) {
    throw new Error('validateLlmReviewOutput requires reviewInput with scenarios.');
  }
  if (!artifactsRoot) {
    throw new Error('validateLlmReviewOutput requires artifactsRoot.');
  }
  if (typeof output.runId !== 'string' || output.runId !== reviewInput.runId) {
    throw new Error(
      `LLM review output runId mismatch: expected "${reviewInput.runId}", got "${output.runId}".`,
    );
  }
  if (!VALID_OVERALL_GATES.has(output.overallHardGate)) {
    throw new Error(`Invalid overallHardGate "${output.overallHardGate}".`);
  }
  if (!VALID_VERDICTS.has(output.llmReviewVerdict)) {
    throw new Error(`Invalid llmReviewVerdict "${output.llmReviewVerdict}".`);
  }
  if (!Array.isArray(output.scenarioReviews)) {
    throw new Error('LLM review output must include a scenarioReviews array.');
  }

  const inputByScenario = new Map(
    reviewInput.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const seenScenarios = new Set();
  const hasHardFail = reviewInput.scenarios.some((scenario) => scenario.hardOutcome === 'FAIL');

  if (hasHardFail) {
    if (output.overallHardGate !== 'FAIL') {
      throw new Error(
        'Hard Gate violation: overallHardGate must be "FAIL" when any scenario has hardOutcome === "FAIL".',
      );
    }
    if (output.llmReviewVerdict !== 'CONFIRMED_FAIL') {
      throw new Error(
        'Hard Gate violation: llmReviewVerdict must be "CONFIRMED_FAIL" when any scenario has hardOutcome === "FAIL".',
      );
    }
  } else {
    if (output.overallHardGate !== 'PASS') {
      throw new Error(
        'Hard Gate violation: overallHardGate must be "PASS" when no scenario has hardOutcome === "FAIL".',
      );
    }
    if (output.llmReviewVerdict === 'CONFIRMED_FAIL') {
      throw new Error(
        'Hard Gate violation: llmReviewVerdict cannot be "CONFIRMED_FAIL" when no scenario failed.',
      );
    }
  }

  const resolvedRoot = path.resolve(artifactsRoot);
  let hasVisualWarning = false;

  for (const review of output.scenarioReviews) {
    if (!review || typeof review !== 'object') {
      throw new Error('Each scenarioReview entry must be an object.');
    }
    const scenarioId = String(review.scenarioId ?? '');
    const inputScenario = inputByScenario.get(scenarioId);
    if (!inputScenario) {
      throw new Error(`Unknown scenarioId "${scenarioId}" in scenarioReviews.`);
    }
    if (seenScenarios.has(scenarioId)) {
      throw new Error(`Duplicate scenarioReview for "${scenarioId}".`);
    }
    seenScenarios.add(scenarioId);

    const outcome = String(inputScenario.hardOutcome);
    if (typeof review.hardOutcome !== 'string' || review.hardOutcome !== outcome) {
      throw new Error(
        `Scenario "${scenarioId}" hardOutcome mismatch: expected "${outcome}", got "${review.hardOutcome}".`,
      );
    }
    if (outcome === 'FAIL') {
      if (review.reviewStatus !== 'FAIL_ATTRIBUTED') {
        throw new Error(
          `Hard Gate violation: FAIL scenario "${scenarioId}" must have reviewStatus "FAIL_ATTRIBUTED", got "${review.reviewStatus}".`,
        );
      }
    } else if (outcome === 'PASS') {
      if (
        review.reviewStatus !== 'CONFIRMED_PASS' &&
        review.reviewStatus !== 'VISUAL_WARNING_NEEDS_REVIEW'
      ) {
        throw new Error(
          `Downgrade-only violation: PASS scenario "${scenarioId}" must have reviewStatus "CONFIRMED_PASS" or "VISUAL_WARNING_NEEDS_REVIEW", got "${review.reviewStatus}".`,
        );
      }
      if (review.reviewStatus === 'VISUAL_WARNING_NEEDS_REVIEW') {
        hasVisualWarning = true;
      }
    } else if (outcome.startsWith('SKIPPED_')) {
      if (review.reviewStatus !== 'SKIPPED_ACKNOWLEDGED') {
        throw new Error(
          `Skipped-scenario violation: "${scenarioId}" (${outcome}) must have reviewStatus "SKIPPED_ACKNOWLEDGED", got "${review.reviewStatus}".`,
        );
      }
    } else {
      throw new Error(`Unsupported hardOutcome "${outcome}" for scenario "${scenarioId}".`);
    }

    if (!Array.isArray(review.evidenceCitations) || review.evidenceCitations.length === 0) {
      throw new Error(
        `Anti-hallucination violation: scenario "${scenarioId}" must include at least one evidenceCitation.`,
      );
    }

    for (const citation of review.evidenceCitations) {
      const artifactPath = citation?.artifactPath;
      if (typeof artifactPath !== 'string' || !artifactPath.trim()) {
        throw new Error(
          `Anti-hallucination violation: scenario "${scenarioId}" has citation with empty artifactPath.`,
        );
      }
      const resolvedArtifact = path.resolve(resolvedRoot, artifactPath);
      if (
        !isWithinRoot(resolvedRoot, resolvedArtifact) ||
        !fs.existsSync(resolvedArtifact) ||
        !fs.statSync(resolvedArtifact).isFile()
      ) {
        throw new Error(
          `Anti-hallucination violation: cited artifactPath "${artifactPath}" for scenario "${scenarioId}" does not exist under artifactsRoot.`,
        );
      }
    }
  }

  for (const scenarioId of inputByScenario.keys()) {
    if (!seenScenarios.has(scenarioId)) {
      throw new Error(`Missing scenarioReview for "${scenarioId}".`);
    }
  }

  if (!hasHardFail && hasVisualWarning && output.llmReviewVerdict !== 'NEEDS_HUMAN_REVIEW') {
    throw new Error(
      'Downgrade-only violation: llmReviewVerdict must be "NEEDS_HUMAN_REVIEW" when any PASS scenario is flagged VISUAL_WARNING_NEEDS_REVIEW.',
    );
  }

  return output;
}

export async function reviewRunWithLlm({
  reviewInput,
  artifactsRoot,
  reviewerFn,
  forbiddenStrings = [],
}) {
  if (!artifactsRoot) {
    throw new Error('reviewRunWithLlm requires artifactsRoot.');
  }
  if (typeof reviewerFn !== 'function') {
    throw new Error('reviewRunWithLlm requires a reviewerFn function.');
  }

  const inputScan = scanForPrivacyLeaks(reviewInput, { forbiddenStrings });
  if (!inputScan.clean) {
    throw formatLeakError(inputScan.leaks, 'llm-review-input');
  }

  fs.mkdirSync(artifactsRoot, { recursive: true });
  const inputPath = path.join(artifactsRoot, 'llm-review-input.json');
  fs.writeFileSync(inputPath, `${JSON.stringify(reviewInput, null, 2)}\n`, 'utf8');

  const rawOutput = await reviewerFn(reviewInput);
  const validated = validateLlmReviewOutput(rawOutput, { reviewInput, artifactsRoot });

  const outputPath = path.join(artifactsRoot, 'llm-review-output.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');

  return validated;
}
