import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  adbArgs,
  defaultRunCommand,
  readDeviceUiHierarchy,
} from '../android-driver/cdp-client.mjs';
import { mergeTimelineEvents, parseLogcatLines } from './timeline.mjs';

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonlFile(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
  fs.writeFileSync(filePath, body, 'utf8');
}

function safeFileSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function createRunArtifactCollector({
  rootDir,
  suite,
  runId,
  deviceMeta = {},
  runCommand,
  spawnProcess,
} = {}) {
  if (!rootDir) {
    throw new Error('createRunArtifactCollector requires rootDir.');
  }
  if (!suite) {
    throw new Error('createRunArtifactCollector requires suite.');
  }
  if (!runId) {
    throw new Error('createRunArtifactCollector requires runId.');
  }

  const customRunCommandProvided = typeof runCommand === 'function';
  const execCmd = customRunCommandProvided ? runCommand : defaultRunCommand;
  const runDir = path.join(rootDir, 'android', 'captures', `${suite}-${runId}`);
  const scenariosDir = path.join(runDir, 'scenarios');
  fs.mkdirSync(scenariosDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const timelineEvents = [];
  const scenarioStates = new Map();
  let clockSync = null;

  function ensureScenarioState(scenarioId) {
    const existing = scenarioStates.get(scenarioId);
    if (existing) {
      return existing;
    }
    const dir = path.join(scenariosDir, scenarioId);
    const stepsDir = path.join(dir, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const state = {
      scenarioId,
      dir,
      stepsDir,
      startedAtMs: Date.now(),
      finishedAtMs: null,
      hardOutcome: null,
      assertions: [],
      artifacts: [],
      screenrecord: null,
    };
    scenarioStates.set(scenarioId, state);
    return state;
  }

  function buildRunMeta(finishedAt = null) {
    return {
      schemaVersion: 1,
      suite,
      runId,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      deviceMeta,
      clockSync,
      scenarios: Array.from(scenarioStates.values()).map((state) => ({
        scenarioId: state.scenarioId,
        hardOutcome: state.hardOutcome,
        startedAtMs: state.startedAtMs,
        finishedAtMs: state.finishedAtMs,
        assertionCount: state.assertions.length,
        artifacts: [...state.artifacts],
        screenrecordKept: Boolean(state.screenrecord?.kept),
      })),
    };
  }

  function persistRunJson(finishedAt = null) {
    writeJsonFile(path.join(runDir, 'run.json'), buildRunMeta(finishedAt));
  }

  function registerArtifact(state, absPath) {
    const relPath = path.relative(runDir, absPath).split(path.sep).join('/');
    if (!state.artifacts.includes(relPath)) {
      state.artifacts.push(relPath);
    }
    return relPath;
  }

  persistRunJson();

  return {
    runDir,
    scenariosDir,

    getScenarioDir(scenarioId) {
      return ensureScenarioState(scenarioId).dir;
    },

    setClockSync(syncMeta) {
      clockSync = syncMeta ?? null;
      persistRunJson();
    },

    recordEvent(event) {
      timelineEvents.push(event);
    },

    recordEvents(events) {
      if (Array.isArray(events)) {
        timelineEvents.push(...events);
      }
    },

    async startScenario(scenarioId, options = {}) {
      const state = ensureScenarioState(scenarioId);
      state.startedAtMs = options.startedAtMs ?? Date.now();
      const shouldRecord = Boolean(options.record || options.timedOrGesture);
      const serial = options.serial ?? deviceMeta?.serial;

      if (shouldRecord && serial) {
        const maxDurationSec = options.maxRecordSec ?? 90;
        const remoteMp4Path = `/sdcard/lfh-${safeFileSegment(suite)}-${safeFileSegment(runId)}-${safeFileSegment(scenarioId)}.mp4`;
        const localMp4Path = path.join(state.dir, 'screenrecord.mp4');
        const args = adbArgs(serial, [
          'shell',
          'screenrecord',
          '--time-limit',
          String(maxDurationSec),
          remoteMp4Path,
        ]);

        let child = null;
        if (typeof spawnProcess === 'function') {
          child = spawnProcess('adb', args);
        } else if (customRunCommandProvided) {
          execCmd('adb', args, { background: true });
        } else {
          child = spawn('adb', args, { stdio: 'ignore' });
        }

        state.screenrecord = {
          serial,
          remoteMp4Path,
          localMp4Path,
          child,
          kept: false,
        };
      }

      persistRunJson();
      return state.dir;
    },

    async captureStep(scenarioId, stepName, options = {}) {
      const state = ensureScenarioState(scenarioId);
      const serial = options.serial ?? deviceMeta?.serial;
      const isFailure = Boolean(options.isFailure);
      const baseDir = isFailure ? state.dir : state.stepsDir;
      const prefix = isFailure ? 'failure' : safeFileSegment(stepName);
      const captured = {};

      if (options.screenshotPng !== undefined || (options.includePng !== false && serial)) {
        const pngBytes =
          options.screenshotPng !== undefined
            ? options.screenshotPng
            : execCmd('adb', adbArgs(serial, ['exec-out', 'screencap', '-p']), {
                encoding: 'buffer',
              });
        if (pngBytes !== null && pngBytes !== undefined) {
          const pngPath = path.join(baseDir, `${prefix}.png`);
          fs.writeFileSync(pngPath, pngBytes);
          captured.png = registerArtifact(state, pngPath);
        }
      }

      let domPayload = options.domSnapshot;
      if (domPayload === undefined && options.includeDom !== false && options.client?.evaluate) {
        domPayload = await options.client.evaluate(`(() => ({
          url: location.href,
          readyState: document.readyState,
          title: document.title,
          visualViewport: window.visualViewport
            ? { width: window.visualViewport.width, height: window.visualViewport.height, offsetTop: window.visualViewport.offsetTop }
            : null,
          testIds: Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
        }))()`);
      }
      if (domPayload !== undefined && domPayload !== null) {
        const domPath = path.join(baseDir, `${prefix}.dom.json`);
        writeJsonFile(domPath, domPayload);
        captured.dom = registerArtifact(state, domPath);
      }

      let uiXml = options.uiXml;
      if (uiXml === undefined && options.includeUi !== false && serial) {
        try {
          uiXml = await readDeviceUiHierarchy(execCmd, serial);
        } catch {
          uiXml = '';
        }
      }
      if (typeof uiXml === 'string' && uiXml.length > 0) {
        const uiPath = path.join(baseDir, `${prefix}.ui.xml`);
        fs.writeFileSync(uiPath, uiXml.endsWith('\n') ? uiXml : `${uiXml}\n`, 'utf8');
        captured.ui = registerArtifact(state, uiPath);
      }

      let activityText = options.activityDump;
      if (activityText === undefined && options.includeActivity !== false && serial) {
        activityText = String(
          execCmd('adb', adbArgs(serial, ['shell', 'dumpsys', 'activity', 'activities'])) ?? '',
        );
      }
      if (typeof activityText === 'string' && activityText.length > 0) {
        const activityPath = path.join(baseDir, `${prefix}.activity.txt`);
        fs.writeFileSync(
          activityPath,
          activityText.endsWith('\n') ? activityText : `${activityText}\n`,
          'utf8',
        );
        captured.activity = registerArtifact(state, activityPath);
      }

      return captured;
    },

    async captureFailure(scenarioId, options = {}) {
      return this.captureStep(scenarioId, 'failure', { ...options, isFailure: true });
    },

    writeAssertions(scenarioId, payload) {
      const state = ensureScenarioState(scenarioId);
      const hardOutcome = payload.hardOutcome ?? state.hardOutcome ?? 'PASS';
      const assertions = Array.isArray(payload.assertions) ? payload.assertions : [];
      state.hardOutcome = hardOutcome;
      state.assertions = assertions;
      const assertionsPath = path.join(state.dir, 'assertions.json');
      writeJsonFile(assertionsPath, {
        scenarioId,
        hardOutcome,
        startedAtMs: payload.startedAtMs ?? state.startedAtMs,
        finishedAtMs: payload.finishedAtMs ?? state.finishedAtMs,
        ...(payload.error ? { error: String(payload.error) } : {}),
        assertions,
      });
      return registerArtifact(state, assertionsPath);
    },

    writeLogcat(scenarioId, rawLogcat, parseOptions = {}) {
      const state = ensureScenarioState(scenarioId);
      const events = parseLogcatLines(rawLogcat, {
        clockOffsetMs: clockSync?.clockOffsetMs ?? 0,
        ...parseOptions,
        scenarioId,
      });
      timelineEvents.push(...events);
      const lines = events
        .map((event) => event.details?.rawLine)
        .filter((line) => typeof line === 'string');
      const logcatPath = path.join(state.dir, 'logcat.txt');
      fs.writeFileSync(logcatPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
      return registerArtifact(state, logcatPath);
    },

    writeConsoleEvents(scenarioId, consoleEvents = []) {
      const state = ensureScenarioState(scenarioId);
      const normalized = consoleEvents.map((item) =>
        sanitizeBundleValue({
          hostTsMs: item.hostTsMs ?? Date.now(),
          ...(item.rawDeviceTs !== undefined ? { rawDeviceTs: String(item.rawDeviceTs) } : {}),
          source: item.source === 'cdp_lifecycle' ? 'cdp_lifecycle' : 'cdp_console',
          scenarioId,
          level: item.level ?? 'info',
          event: item.event ?? 'console',
          ...(item.details ? { details: item.details } : {}),
        }),
      );
      timelineEvents.push(...normalized);
      const consolePath = path.join(state.dir, 'console.jsonl');
      writeJsonlFile(consolePath, normalized);
      return registerArtifact(state, consolePath);
    },

    writeDiagnosticBundle(scenarioId, bundle, options = {}) {
      const state = ensureScenarioState(scenarioId);
      const bundlePath = path.join(state.dir, 'diagnostic-bundle.json');
      writeJsonFile(bundlePath, bundle);
      if (bundle && Array.isArray(bundle.events)) {
        const generatedAtMs = Date.parse(bundle.generatedAt ?? '');
        const baseHostMs = Number.isFinite(generatedAtMs)
          ? generatedAtMs + (options.clockOffsetMs ?? clockSync?.clockOffsetMs ?? 0)
          : Date.now();
        for (const evt of bundle.events) {
          const offsetMs = typeof evt.tsOffsetSec === 'number' ? evt.tsOffsetSec * 1000 : 0;
          timelineEvents.push({
            hostTsMs: Math.round(baseHostMs + offsetMs),
            source: 'diagnostic_bundle',
            scenarioId,
            level: evt.level === 'error' || evt.level === 'warn' ? evt.level : 'info',
            event: String(evt.action ?? 'diagnostic_event'),
            details: {
              category: evt.category,
              ...(evt.statusCode !== undefined ? { statusCode: evt.statusCode } : {}),
              ...(evt.errorCode !== undefined ? { errorCode: evt.errorCode } : {}),
              ...(evt.sanitizedReason ? { sanitizedReason: evt.sanitizedReason } : {}),
            },
          });
        }
      }
      return registerArtifact(state, bundlePath);
    },

    async finishScenario(scenarioId, options = {}) {
      const state = ensureScenarioState(scenarioId);
      state.finishedAtMs = options.finishedAtMs ?? Date.now();
      const hardOutcome = options.hardOutcome ?? state.hardOutcome ?? 'PASS';
      state.hardOutcome = hardOutcome;

      this.writeAssertions(scenarioId, {
        hardOutcome,
        assertions: options.assertions ?? state.assertions,
        startedAtMs: state.startedAtMs,
        finishedAtMs: state.finishedAtMs,
        error: options.error,
      });

      if (state.screenrecord) {
        const { serial, remoteMp4Path, localMp4Path, child } = state.screenrecord;
        if (child && typeof child.kill === 'function') {
          try {
            child.kill('SIGINT');
          } catch {
            // Process may have exited cleanly
          }
        }
        try {
          execCmd('adb', adbArgs(serial, ['shell', 'pkill', '-l', '2', 'screenrecord']), {
            allowFailure: true,
          });
        } catch {
          // Ignore when screenrecord already stopped
        }

        if (hardOutcome === 'FAIL') {
          execCmd('adb', adbArgs(serial, ['pull', remoteMp4Path, localMp4Path]));
          if (fs.existsSync(localMp4Path)) {
            state.screenrecord.kept = true;
            registerArtifact(state, localMp4Path);
          }
        } else {
          if (fs.existsSync(localMp4Path)) {
            fs.rmSync(localMp4Path, { force: true });
          }
          state.screenrecord.kept = false;
        }

        try {
          execCmd('adb', adbArgs(serial, ['shell', 'rm', '-f', remoteMp4Path]), {
            allowFailure: true,
          });
        } catch {
          // Ignore cleanup error on device
        }
      }

      persistRunJson();
      return state;
    },

    async finalizeRun(options = {}) {
      const finishedAt = options.finishedAt ?? new Date().toISOString();
      const merged = mergeTimelineEvents(timelineEvents);
      const timelinePath = path.join(runDir, 'timeline.jsonl');
      writeJsonlFile(timelinePath, merged);
      const runMeta = buildRunMeta(finishedAt);
      writeJsonFile(path.join(runDir, 'run.json'), runMeta);
      return {
        runDir,
        runMeta,
        timelineCount: merged.length,
      };
    },
  };
}

const SENSITIVE_KEY_NAME_REGEX =
  /^(api[-_]?key|secret[-_]?key|access[-_]?token|auth[-_]?token|authorization|deepseek[-_]?key|provider[-_]?key)$/i;
const REDACTION_PLACEHOLDER_REGEX = /^(?:\[REDACTED(?:_KEY)?\]|<redacted>|\*{3,}|null|undefined)$/i;
const SK_KEY_REGEX = /\bsk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{6,}/;
const BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i;
const INLINE_API_KEY_REGEX =
  /(?:"api[_-]?key"|'api[_-]?key'|\bapi[_-]?key)\s*[:=]\s*['"]?(?!\[REDACTED|<redacted>|\*{3,}|null\b|undefined\b)[A-Za-z0-9._-]{4,}/i;
const SMOKE_WIZARD_MARKERS = ['deepseek-setup-wizard', '#byok-api-key', 'provider-preset-'];

export function scanForPrivacyLeaks(
  payload,
  { forbiddenStrings = [], allowWizardMarkers = false } = {},
) {
  const leaks = [];
  const normalizedForbidden = Array.isArray(forbiddenStrings)
    ? forbiddenStrings.filter((item) => typeof item === 'string' && item.length > 0)
    : [];

  function recordLeak(currentPath, rule, reason) {
    leaks.push({ path: currentPath, rule, reason });
  }

  function scanString(value, currentPath) {
    if (SK_KEY_REGEX.test(value)) {
      recordLeak(currentPath, 'sk_key', 'Detected sk-* API key pattern');
    }
    if (BEARER_TOKEN_REGEX.test(value)) {
      recordLeak(currentPath, 'bearer_token', 'Detected Bearer authorization token');
    }
    if (INLINE_API_KEY_REGEX.test(value)) {
      recordLeak(currentPath, 'sensitive_key_field', 'Detected inline non-empty apiKey value');
    }
    if (!allowWizardMarkers) {
      for (const marker of SMOKE_WIZARD_MARKERS) {
        if (value.includes(marker)) {
          recordLeak(
            currentPath,
            'smoke_key_wizard_marker',
            `Detected forbidden key-entry UI marker (${marker})`,
          );
        }
      }
    }
    for (const forbidden of normalizedForbidden) {
      if (value.includes(forbidden)) {
        recordLeak(currentPath, 'forbidden_string', 'Detected forbidden canary/secret string');
      }
    }
  }

  function walk(node, currentPath, visited) {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node === 'string') {
      scanString(node, currentPath);
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${currentPath}[${i}]`, visited);
      }
      return;
    }

    for (const [key, val] of Object.entries(node)) {
      const nextPath = `${currentPath}.${key}`;
      if (
        SENSITIVE_KEY_NAME_REGEX.test(key) &&
        typeof val === 'string' &&
        val.trim().length > 0 &&
        !REDACTION_PLACEHOLDER_REGEX.test(val.trim())
      ) {
        recordLeak(nextPath, 'sensitive_key_field', `Non-empty sensitive field "${key}"`);
      }
      walk(val, nextPath, visited);
    }
  }

  walk(payload, '$', new Set());
  return {
    clean: leaks.length === 0,
    leaks,
  };
}

function scrubDiagnosticString(text) {
  return text
    .replace(/\bsk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{6,}/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED_KEY]')
    .replace(
      /((?:"api[_-]?key"|'api[_-]?key'|\bapi[_-]?key)\s*[:=]\s*['"]?)(?!\[REDACTED|<redacted>|\*{3,}|null\b|undefined\b)[A-Za-z0-9._-]{4,}/gi,
      '$1[REDACTED_KEY]',
    );
}

function sanitizeBundleValue(node) {
  if (typeof node === 'string') {
    return scrubDiagnosticString(node);
  }
  if (Array.isArray(node)) {
    return node.map(sanitizeBundleValue);
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEY_NAME_REGEX.test(k) && typeof v === 'string' && v.trim().length > 0) {
        out[k] = '[REDACTED_KEY]';
      } else {
        out[k] = sanitizeBundleValue(v);
      }
    }
    return out;
  }
  return node;
}

export async function extractDiagnosticBundleViaCdp(client) {
  if (!client || typeof client.evaluate !== 'function') {
    throw new Error('extractDiagnosticBundleViaCdp requires a CDP client with evaluate().');
  }

  // Read rendered diagnostics-json directly and check localStorage['lfh.diagnostics.v2'].
  // Never clicks the system share/export trigger button.
  const result = await client.evaluate(`(async () => {
    let jsonEl = document.querySelector('[data-testid="diagnostics-json"]');
    if (!jsonEl) {
      const openBtn = document.querySelector('[data-testid="open-diagnostics"]');
      if (openBtn && typeof openBtn.click === 'function') {
        openBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        jsonEl = document.querySelector('[data-testid="diagnostics-json"]');
      }
    }
    const detailsEl = document.querySelector('[data-testid="diagnostics-raw-details"]');
    if (detailsEl && !detailsEl.open) {
      detailsEl.open = true;
    }
    const jsonText = jsonEl ? jsonEl.textContent : null;
    const storageText =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('lfh.diagnostics.v2')
        : null;
    return { jsonText, storageText };
  })()`);

  if (!result || typeof result !== 'object') {
    return null;
  }

  let parsedBundle = null;
  if (typeof result.jsonText === 'string' && result.jsonText.trim().length > 0) {
    try {
      parsedBundle = JSON.parse(result.jsonText);
    } catch {
      return null;
    }
  }

  if (!parsedBundle || typeof parsedBundle !== 'object') {
    return null;
  }

  if (typeof result.storageText === 'string' && result.storageText.trim().length > 0) {
    try {
      const persisted = JSON.parse(result.storageText);
      if (
        persisted &&
        typeof persisted === 'object' &&
        Array.isArray(persisted.events) &&
        (!Array.isArray(parsedBundle.events) || parsedBundle.events.length === 0) &&
        persisted.events.length > 0
      ) {
        const genMs = Date.parse(parsedBundle.generatedAt ?? '');
        const baseMs = Number.isFinite(genMs) ? genMs : Date.now();
        parsedBundle.events = persisted.events.map(({ ts, ...rest }) => ({
          ...rest,
          tsOffsetSec: typeof ts === 'number' ? Math.round((ts - baseMs) / 1000) : 0,
        }));
      }
    } catch {
      // Ignore malformed localStorage diagnostics entry when DOM bundle is valid
    }
  }

  return sanitizeBundleValue(parsedBundle);
}
