import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const PACKAGE_NAME = 'io.localfiction.harness';
const MAIN_ACTIVITY = `${PACKAGE_NAME}/.MainActivity`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_STABILITY_WINDOW_MS = 400;

function buildAndroidPreviewZip() {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/android-preview.json': strToU8(JSON.stringify({
      id: 'android-preview',
      title: '安卓返回预览层',
      current_message_id: 2,
      inserted_at: '2026-11-20T08:00:00Z',
      updated_at: '2026-11-20T08:01:00Z',
      messages: [
        {
          id: 1,
          parent_id: null,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2026-11-20T08:00:00Z',
          fragments: [{ type: 'REQUEST', content: '【安卓预览】主角：测试者。' }],
        },
        {
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: 'FINISHED',
          inserted_at: '2026-11-20T08:01:00Z',
          fragments: [{ type: 'RESPONSE', content: '预览层返回栈测试。' }],
        },
      ],
    })),
  });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function evaluateLauncherEvidence(evidence, appPackage = PACKAGE_NAME) {
  const failures = [];
  const [firstFocus, secondFocus] = evidence.focusSamples;
  const focusStable =
    evidence.activityTopResumed === false &&
    typeof firstFocus === 'string' &&
    firstFocus.trim().length > 0 &&
    firstFocus === secondFocus &&
    !firstFocus.includes(appPackage);
  if (!focusStable) {
    failures.push('window or focus did not remain Launcher-stable');
  }
  if (evidence.launcherTopResumed !== true) {
    failures.push('Launcher home task is not top-resumed');
  }
  if (
    !Number.isFinite(evidence.stableAfterMs) ||
    evidence.stableAfterMs < 300
  ) {
    failures.push('Launcher evidence window was shorter than 300 ms');
  }
  if (
    typeof evidence.hierarchy !== 'string' ||
    evidence.hierarchy.trim().length === 0 ||
    evidence.hierarchy.includes(`package="${appPackage}"`) ||
    evidence.hierarchy.includes(appPackage)
  ) {
    failures.push('uiautomator hierarchy still contains app content');
  }
  if (
    !evidence.screenshotSha256 ||
    evidence.screenshotSha256 === evidence.previousAppScreenshotSha256
  ) {
    failures.push('Launcher screenshot matches the previous app screenshot');
  }
  return {
    valid: failures.length === 0,
    failures,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const [key, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

function run(command, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr;
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`);
  }
  return result.stdout;
}

export function installApkForCleanRun({
  serial,
  apkPath,
  runCommand = run,
}) {
  const existingPath = runCommand('adb', [
    '-s',
    serial,
    'shell',
    'pm',
    'path',
    PACKAGE_NAME,
  ], { allowFailure: true }).trim();
  runCommand('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'force-stop',
    PACKAGE_NAME,
  ]);
  const installOutput = runCommand('adb', [
    '-s',
    serial,
    'install',
    '-r',
    '-t',
    apkPath,
  ]).trim();
  if (!installOutput.includes('Success')) {
    throw new Error(`APK install did not report Success: ${installOutput || '(no output)'}`);
  }
  const clearOutput = runCommand('adb', [
    '-s',
    serial,
    'shell',
    'pm',
    'clear',
    PACKAGE_NAME,
  ]).trim();
  if (!clearOutput.includes('Success')) {
    throw new Error(`Package data clear did not report Success: ${clearOutput || '(no output)'}`);
  }
  const installedPath = runCommand('adb', [
    '-s',
    serial,
    'shell',
    'pm',
    'path',
    PACKAGE_NAME,
  ]).trim();
  if (!installedPath) {
    throw new Error('Installed package path is empty after install.');
  }
  return {
    packageWasInstalled: Boolean(existingPath),
    existingPath: existingPath || null,
    installOutput,
    clearOutput,
    installedPath,
  };
}

function resolveSerial(requestedSerial) {
  const output = run('adb', ['devices']);
  const devices = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
  if (requestedSerial) {
    if (!devices.includes(requestedSerial)) {
      throw new Error(`Android device ${requestedSerial} is not connected.`);
    }
    return requestedSerial;
  }
  if (devices.length !== 1) {
    throw new Error(`Expected exactly one connected Android device, found: ${devices.join(', ') || 'none'}`);
  }
  return devices[0];
}

class CdpClient {
  static async connect(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to WebView DevTools.')), 5000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebView DevTools connection failed.'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebView DevTools connection closed.'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for WebView DevTools response to ${method}.`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? 'WebView evaluation failed.');
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(check, {
  description,
  timeoutMs = 10000,
  intervalMs = 100,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function connectToWebView(serial) {
  const pid = await waitFor(() => {
    const output = run('adb', ['-s', serial, 'shell', 'pidof', PACKAGE_NAME]).trim();
    return output || null;
  }, { description: `${PACKAGE_NAME} process`, timeoutMs: 20000 });

  const localPort = run('adb', [
    '-s',
    serial,
    'forward',
    'tcp:0',
    `localabstract:webview_devtools_remote_${pid}`,
  ]).trim();
  const endpoint = `http://127.0.0.1:${localPort}`;

  try {
    return await waitFor(async () => {
      const response = await fetch(`${endpoint}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return null;
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (!page) return null;
      const client = await CdpClient.connect(page.webSocketDebuggerUrl);
      const ready = await client.evaluate(`document.readyState === 'complete'`);
      if (!ready) {
        client.close();
        return null;
      }
      return { client, localPort, pid };
    }, { description: 'loaded app WebView', timeoutMs: 30000 });
  } catch (error) {
    run('adb', ['-s', serial, 'forward', '--remove', `tcp:${localPort}`]);
    throw error;
  }
}

function createArtifactWriter(serial, artifactsDirectory, pid) {
  fs.mkdirSync(artifactsDirectory, { recursive: true });

  function write(name, contents) {
    fs.writeFileSync(path.join(artifactsDirectory, name), contents);
  }

  function captureScreenshot(name) {
    const png = run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    write(name, png);
    return {
      file: name,
      sha256: sha256(png),
      bytes: png.length,
    };
  }

  function captureActivity(name) {
    const output = run('adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
    write(name, output);
    return output;
  }

  function captureUiHierarchy(name) {
    try {
      const hierarchy = readUiHierarchy();
      write(name, hierarchy);
      return hierarchy;
    } catch (error) {
      write(name.replace(/\.xml$/, '.error.txt'), `${error.message}\n`);
      return null;
    }
  }

  function readUiHierarchy() {
    const remotePath = `/sdcard/lfh-back-regression-${Date.now()}.xml`;
    try {
      run('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', remotePath]);
      return run('adb', ['-s', serial, 'exec-out', 'cat', remotePath]);
    } finally {
      spawnSync('adb', ['-s', serial, 'shell', 'rm', '-f', remotePath], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    }
  }

  function captureLogcat(name) {
    try {
      const lines = run('adb', ['-s', serial, 'logcat', '-d', '-v', 'threadtime'])
        .split(/\r?\n/)
        .filter((line) =>
          line.includes(`${pid}`) ||
          line.includes(PACKAGE_NAME) ||
          line.includes('lfh-back-regression')
        );
      write(name, `${lines.join('\n')}\n`);
    } catch (error) {
      write(name.replace(/\.txt$/, '.error.txt'), `${error.message}\n`);
    }
  }

  return {
    write,
    captureScreenshot,
    captureActivity,
    captureUiHierarchy,
    readUiHierarchy,
    captureLogcat,
  };
}

function readActivityState(serial) {
  const output = run('adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
  return {
    topResumedActivity: output.match(/^\s*topResumedActivity=(.+)$/m)?.[1]?.trim() ?? null,
    launcherTopResumed: /topDisplayFocusedRootTask=Task\{[^}\n]*type=home/.test(output),
  };
}

function activityIsTopResumed(serial) {
  const { topResumedActivity } = readActivityState(serial);
  return Boolean(
    topResumedActivity?.includes(PACKAGE_NAME) &&
    topResumedActivity?.includes('.MainActivity')
  );
}

async function waitForTopResumed(serial, expected, description, timeoutMs = 10000) {
  return waitFor(() => {
    const topResumed = activityIsTopResumed(serial);
    return topResumed === expected ? true : null;
  }, { description, timeoutMs });
}

function readLauncherFocus(serial) {
  let output;
  try {
    output = run('adb', ['-s', serial, 'shell', 'dumpsys', 'window']);
  } catch {
    output = run('adb', ['-s', serial, 'shell', 'dumpsys', 'window', 'windows']);
  }
  const focusLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('mCurrentFocus=') || line.startsWith('mFocusedApp='));
  return focusLines.join('\n');
}

async function waitForStableLauncherEvidence(
  serial,
  artifacts,
  name,
  previousAppScreenshotSha256,
) {
  await waitForTopResumed(
    serial,
    false,
    `${name}: activity no longer top-resumed`,
    5000,
  );
  const evidence = await waitFor(async () => {
    const sampledAt = Date.now();
    const firstActivity = readActivityState(serial);
    if (
      firstActivity.topResumedActivity?.includes(PACKAGE_NAME) ||
      !firstActivity.launcherTopResumed
    ) {
      return null;
    }
    const firstFocus = readLauncherFocus(serial);
    if (!firstFocus || firstFocus.includes(PACKAGE_NAME)) return null;
    await new Promise((resolve) => setTimeout(resolve, LAUNCHER_STABILITY_WINDOW_MS));
    const secondActivity = readActivityState(serial);
    const secondFocus = readLauncherFocus(serial);
    const stableAfterMs = Date.now() - sampledAt;
    const hierarchy = artifacts.readUiHierarchy();
    const screenshot = artifacts.captureScreenshot(`${name}.png`);
    const candidate = {
      activityTopResumed: Boolean(secondActivity.topResumedActivity?.includes(PACKAGE_NAME)),
      activityTop: secondActivity.topResumedActivity,
      launcherTopResumed:
        firstActivity.launcherTopResumed && secondActivity.launcherTopResumed,
      focusSamples: [firstFocus, secondFocus],
      stableAfterMs,
      hierarchy,
      hierarchySha256: sha256(hierarchy),
      screenshotSha256: screenshot.sha256,
      screenshot,
      previousAppScreenshotSha256,
    };
    const verdict = evaluateLauncherEvidence(candidate, PACKAGE_NAME);
    if (!verdict.valid) {
      throw new Error(
        `${name}: invalid Launcher evidence ${JSON.stringify({ failures: verdict.failures, candidate })}`,
      );
    }
    return {
      ...candidate,
      ...verdict,
      hierarchyFile: `${name}.ui.xml`,
      activityFile: `${name}.activity.txt`,
      logcatFile: `${name}.logcat.txt`,
    };
  }, { description: `${name}: stable Launcher evidence`, timeoutMs: 15000 });

  artifacts.write(`${name}.ui.xml`, evidence.hierarchy);
  artifacts.captureActivity(`${name}.activity.txt`);
  artifacts.captureLogcat(`${name}.logcat.txt`);
  artifacts.write(`${name}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

async function readSnapshot(client) {
  const value = await client.evaluate(`(() => {
    const describeElement = (selector) => {
      const elements = [...document.querySelectorAll(selector)];
      const element = elements.find((candidate) => {
        const candidateStyle = getComputedStyle(candidate);
        return candidate.getClientRects().length > 0 &&
          candidateStyle.display !== 'none' &&
          candidateStyle.visibility !== 'hidden';
      }) ?? elements[0];
      if (!element) {
        return {
          connected: false,
          visible: false,
          tagName: null,
          dialogOpen: null,
          dataClosing: null,
          opacity: null,
          pointerEvents: null,
          position: null,
          zIndex: null,
          overflow: null,
          animationsBusy: null,
          unobscured: null,
          hitElement: null,
          ancestors: null,
          bounds: null,
        };
      }
      const style = getComputedStyle(element);
      let animations = [];
      try {
        animations = typeof element.getAnimations === 'function'
          ? element.getAnimations({ subtree: true })
          : [];
      } catch {
        animations = [];
      }
      const rect = element.getBoundingClientRect();
      const clamp = (value, minimum, maximum) =>
        Math.max(minimum, Math.min(value, maximum));
      const topElement = document.elementFromPoint(
        clamp(rect.left + Math.min(rect.width / 2, 100), 0, innerWidth - 1),
        clamp(rect.top + Math.min(rect.height / 2, 100), 0, innerHeight - 1),
      );
      return {
        connected: true,
        visible: element.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden',
        tagName: element.tagName,
        dialogOpen: element instanceof HTMLDialogElement ? element.open : null,
        dataClosing: element.getAttribute('data-closing'),
        opacity: Number.parseFloat(style.opacity),
        pointerEvents: style.pointerEvents,
        position: style.position,
        zIndex: style.zIndex,
        overflow: style.overflow,
        animationsBusy: animations.some((animation) =>
          animation.playState === 'running' || animation.playState === 'pending'
        ),
        unobscured: Boolean(
          topElement &&
          (topElement === element || element.contains(topElement))
        ),
        hitElement: topElement ? {
          tagName: topElement.tagName,
          testId: topElement.getAttribute('data-testid'),
          className: topElement.getAttribute('class'),
        } : null,
        ancestors: [
          element.parentElement,
          element.parentElement?.parentElement,
          element.parentElement?.parentElement?.parentElement,
          element.parentElement?.parentElement?.parentElement?.parentElement,
        ]
          .filter(Boolean)
          .map((ancestor) => {
            const ancestorStyle = getComputedStyle(ancestor);
            return {
              tagName: ancestor.tagName,
              testId: ancestor.getAttribute('data-testid'),
              className: ancestor.getAttribute('class'),
              position: ancestorStyle.position,
              zIndex: ancestorStyle.zIndex,
              overflow: ancestorStyle.overflow,
            };
          }),
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    };
    const state = history.state;
    const hasSession = Boolean(
      state &&
      typeof state === 'object' &&
      typeof state.lfhOverlaySession === 'string'
    );
    const depth = hasSession ? Number(state.lfhOverlayDepth) : 0;
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const storyMenuItems = [
      ...document.querySelectorAll('[data-testid="story-overflow-menu"] [role="menuitem"]'),
    ];
    const storyMenuItemIndex = activeElement ? storyMenuItems.indexOf(activeElement) : -1;
    return JSON.stringify({
      documentReady: document.readyState === 'complete',
      timeOrigin: performance.timeOrigin,
      sessionToken: typeof window.__lfhOverlayHistorySession === 'string'
        ? window.__lfhOverlayHistorySession
        : null,
      historyLength: history.length,
      historySession: hasSession ? state.lfhOverlaySession : null,
      overlayDepth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
      rawHistoryState: state,
      activeFocus: activeElement ? {
        tagName: activeElement.tagName,
        testId: activeElement.getAttribute('data-testid'),
        role: activeElement.getAttribute('role'),
        ariaLabel: activeElement.getAttribute('aria-label'),
        text: activeElement.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '',
        insideSettings: Boolean(activeElement.closest('[data-testid="settings-page"]')),
        insideImport: Boolean(activeElement.closest('[data-testid="import-panel"], [data-testid="deepseek-import-panel"]')),
        insideStoryMenu: Boolean(activeElement.closest('[data-testid="story-overflow-menu"]')),
        storyMenuItemIndex,
      } : null,
      diagnostics: describeElement('[data-testid="diagnostics-preview"]'),
      crashCard: describeElement('[data-testid="crash-recovery-card"]'),
      mobileLibrary: describeElement('[data-testid="mobile-library-dialog"]'),
      mobileLibrarySheet: describeElement('[data-testid="mobile-library-sheet"]'),
      settings: describeElement('[data-testid="settings-page"]'),
      wizard: describeElement('[data-testid="deepseek-setup-wizard"]'),
      importPanel: describeElement('[data-testid="deepseek-import-panel"]'),
      importPreview: describeElement('[data-testid="deepseek-preview-sheet"]'),
      storyMenu: describeElement('[data-testid="story-overflow-menu"]'),
    });
  })()`);
  return JSON.parse(value);
}

function isStableElement(
  element,
  { requireVisible = true, requireUnobscured = true } = {},
) {
  return Boolean(
    element?.connected &&
    (!requireVisible || element.visible) &&
    (!requireUnobscured || element.unobscured) &&
    element.dataClosing === null &&
    element.opacity === 1 &&
    element.animationsBusy === false
  );
}

function isStableDialog(element) {
  return isStableElement(element) && element.tagName === 'DIALOG' && element.dialogOpen === true;
}

async function waitForStableView(client, condition, description, timeoutMs = 5000) {
  return waitFor(async () => {
    const snapshot = await readSnapshot(client);
    return snapshot.documentReady && condition(snapshot) ? snapshot : null;
  }, { description, timeoutMs });
}

async function captureStableView(client, artifacts, name, condition, description) {
  let snapshot = await waitForStableView(client, condition, description);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await client.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshot = artifacts.captureScreenshot(`${name}.png`);
    const afterCapture = await readSnapshot(client);
    if (afterCapture.documentReady && condition(afterCapture)) {
      const stableSnapshot = {
        ...afterCapture,
        capturedScreenshot: screenshot,
      };
      artifacts.write(`${name}.json`, `${JSON.stringify(stableSnapshot, null, 2)}\n`);
      return stableSnapshot;
    }
    snapshot = await waitForStableView(client, condition, description);
  }
  throw new Error(`${description}: screenshot state was not stable ${JSON.stringify(snapshot)}`);
}

function assertDiagnosticsOpen(snapshot, label) {
  const failures = [];
  if (!isStableDialog(snapshot.diagnostics)) failures.push('diagnostics dialog is not stably open');
  if (!snapshot.crashCard.visible) failures.push('reassurance card is not visible');
  if (snapshot.overlayDepth !== 1) {
    failures.push(`overlay depth is ${snapshot.overlayDepth}, expected 1`);
  }
  if (failures.length > 0) {
    throw new Error(`${label}: ${failures.join('; ')} ${JSON.stringify(snapshot)}`);
  }
}

async function clickSelector(client, selector, description = selector) {
  const clicked = await client.evaluate(`(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = elements.find((candidate) => {
      const style = getComputedStyle(candidate);
      return candidate.getClientRects().length > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
    }) ?? elements[0];
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${description} is not present.`);
}

async function clickButtonByText(client, selector, text, description = text) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!(button instanceof HTMLElement)) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${description} button is not present.`);
}

async function fillTextInput(client, selector, value, description = selector) {
  const filled = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!filled) throw new Error(`${description} input is not present.`);
}

async function openDrawer(client) {
  await clickSelector(client, '[data-testid="library-drawer-trigger"]', 'library drawer trigger');
  return waitForStableView(
    client,
    (snapshot) => isStableDialog(snapshot.mobileLibrary) && isStableElement(snapshot.mobileLibrarySheet),
    'mobile library drawer entry',
  );
}

async function openSettingsFromDrawer(client) {
  await openDrawer(client);
  await clickSelector(client, '[data-testid="mobile-settings-open"]', 'mobile settings entry');
  await waitFor(
    () => client.evaluate(`!document.querySelector('[data-testid="mobile-library-dialog"]')?.open`),
    { description: 'mobile library drawer close before settings', timeoutMs: 5000 },
  );
  await waitForStableView(
    client,
    (snapshot) => isStableElement(snapshot.settings),
    'settings page entry',
  );
  return waitFor(async () => {
    const snapshot = await readSnapshot(client);
    return isStableElement(snapshot.settings) &&
      snapshot.activeFocus?.insideSettings &&
      snapshot.activeFocus.role === 'heading' &&
      snapshot.activeFocus.text === '设置'
      ? snapshot
      : null;
  }, { description: 'settings title focus', timeoutMs: 5000 });
}

async function openByokFromSettings(client) {
  const settingsFocus = await openSettingsFromDrawer(client);
  await clickSelector(
    client,
    '[data-testid="open-setup-wizard-btn"], [data-testid="change-key-btn"]',
    'BYOK setup trigger',
  );
  await waitForStableView(
    client,
    (snapshot) => isStableDialog(snapshot.wizard),
    'BYOK wizard entry',
  );
  return settingsFocus;
}

async function createSyntheticStory(client) {
  const welcomeTrigger = await client.evaluate(
    `Boolean(document.querySelector('[data-testid="welcome-script-import"]'))`,
  );
  if (welcomeTrigger) {
    await clickSelector(client, '[data-testid="welcome-script-import"]', 'welcome script import');
  } else {
    await openDrawer(client);
    await clickSelector(client, '[data-testid="mobile-library-start-script"]', 'mobile script import');
  }
  await waitForStableView(
    client,
    (snapshot) => snapshot.documentReady,
    'script import page entry',
  );
  await waitFor(
    () => client.evaluate(`Boolean(document.querySelector('[data-testid="import-panel"]'))`),
    { description: 'script import panel', timeoutMs: 10000 },
  );
  const importFocus = await waitFor(async () => {
    const snapshot = await readSnapshot(client);
    return snapshot.activeFocus?.insideImport &&
      snapshot.activeFocus.role === 'heading' &&
      snapshot.activeFocus.text === '导入自由剧本'
      ? snapshot
      : null;
  }, { description: 'script import title focus', timeoutMs: 5000 });
  await fillTextInput(
    client,
    '#import-raw-script',
    '【安卓返回回归故事】\n主角：合成测试者。\n规则：只验证本地返回键层级。',
    'synthetic script',
  );
  await clickButtonByText(
    client,
    '[data-testid="import-panel"] button',
    '暂不拆解，直接开始',
    'start without extraction',
  );
  await waitFor(
    () => client.evaluate(`!document.querySelector('[data-testid="import-panel"]')`),
    { description: 'script import panel close', timeoutMs: 10000 },
  );
  const setupWizard = await waitForStableView(
    client,
    (snapshot) => isStableDialog(snapshot.wizard),
    'first-act BYOK wizard after direct story creation',
  );
  await clickSelector(
    client,
    '[data-testid="deepseek-setup-wizard"] button[aria-label="关闭引导"]',
    'close first-act BYOK wizard',
  );
  await waitFor(
    () => client.evaluate(`!document.querySelector('[data-testid="deepseek-setup-wizard"]')`),
    { description: 'first-act BYOK wizard close', timeoutMs: 5000 },
  );
  return { importFocus, setupWizard };
}

async function launchCleanScenario(serial, artifactsDirectory, { clearData = false } = {}) {
  run('adb', ['-s', serial, 'shell', 'am', 'force-stop', PACKAGE_NAME]);
  if (clearData) {
    run('adb', ['-s', serial, 'shell', 'pm', 'clear', PACKAGE_NAME]);
  }
  run('adb', ['-s', serial, 'logcat', '-c']);
  run('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY]);
  const session = await connectToWebView(serial);
  return {
    ...session,
    serial,
    artifacts: createArtifactWriter(serial, artifactsDirectory, session.pid),
  };
}

function closeScenario(session) {
  if (!session) return;
  session.client.close();
  spawnSync('adb', ['-s', session.serial, 'forward', '--remove', `tcp:${session.localPort}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

async function waitAfterBackGuard() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serial = resolveSerial(options.serial);
  const apiLevel = run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk']).trim();
  if (apiLevel !== '36') {
    throw new Error(`Expected API 36, received API ${apiLevel}.`);
  }

  const apkPath = path.resolve(
    repoRoot,
    options.apk ?? 'android/app/build/outputs/apk/debug/app-debug.apk',
  );
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK not found: ${apkPath}. Run npm run android:build first.`);
  }

  const runName = options.label ?? new Date().toISOString().replace(/[:.]/g, '-');
  const artifactsDirectory = path.resolve(
    repoRoot,
    options['artifacts-dir'] ?? path.join('android', 'captures', `android-back-${runName}`),
  );

  console.log(`clean install ${path.basename(apkPath)} on ${serial} (API ${apiLevel})`);
  const installation = installApkForCleanRun({ serial, apkPath });
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  fs.writeFileSync(path.join(artifactsDirectory, 'run.json'), `${JSON.stringify({
    serial,
    apiLevel,
    apkPath,
    packageName: PACKAGE_NAME,
    activity: MAIN_ACTIVITY,
    installation,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  let activeSession = null;
  let failure;
  let lastSnapshot = null;
  try {
    activeSession = await launchCleanScenario(serial, artifactsDirectory);
    let { client, artifacts } = activeSession;
    const cleanBeforeCrash = await captureStableView(
      client,
      artifacts,
      '01-clean-before-crash',
      (snapshot) => !snapshot.diagnostics.dialogOpen,
      'clean app before crash',
    );
    artifacts.captureActivity('01-clean-before-crash.activity.txt');

    await client.evaluate(`window.dispatchEvent(new ErrorEvent('error', {
      error: new Error('lfh-back-regression automatic crash'),
      message: 'lfh-back-regression automatic crash'
    }))`);
    const automaticOpen = await captureStableView(
      client,
      artifacts,
      '02-automatic-diagnostics-open',
      (snapshot) =>
        isStableDialog(snapshot.diagnostics) &&
        snapshot.crashCard.visible &&
        snapshot.overlayDepth === 1,
      'automatic crash diagnostics overlay',
    );
    artifacts.captureActivity('02-automatic-diagnostics-open.activity.txt');
    assertDiagnosticsOpen(automaticOpen, 'automatic diagnostics open');

    await clickSelector(client, '[data-testid="diagnostics-reload"]', 'reload diagnostics');
    const afterReload = await waitFor(async () => {
      const snapshot = await readSnapshot(client);
      return snapshot.documentReady &&
        snapshot.timeOrigin !== automaticOpen.timeOrigin &&
        !snapshot.diagnostics.dialogOpen
        ? snapshot
        : null;
    }, { description: 'diagnostics page reload', timeoutMs: 20000 });
    artifacts.write('03-after-reload-stale-history.json', `${JSON.stringify(afterReload, null, 2)}\n`);
    const staleHistoryScreenshot = artifacts.captureScreenshot('03-after-reload-stale-history.png');
    artifacts.captureActivity('03-after-reload-stale-history.activity.txt');
    if (
      typeof afterReload.historySession !== 'string' ||
      afterReload.overlayDepth !== 1
    ) {
      throw new Error(`Reload did not preserve the expected stale overlay history: ${JSON.stringify(afterReload)}`);
    }

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const reloadLauncherEvidence = await waitForStableLauncherEvidence(
      serial,
      artifacts,
      '04-reload-one-back-launcher',
      staleHistoryScreenshot.sha256,
    );
    if (typeof afterReload.sessionToken !== 'string') {
      throw new Error(`The current Web overlay session token is not exposed: ${JSON.stringify(afterReload)}`);
    }
    if (afterReload.historySession === afterReload.sessionToken) {
      throw new Error(`Reloaded page history still matches the current session token: ${JSON.stringify(afterReload)}`);
    }
    lastSnapshot = afterReload;
    closeScenario(activeSession);
    activeSession = null;

    activeSession = await launchCleanScenario(serial, artifactsDirectory, { clearData: true });
    ({ client, artifacts } = activeSession);
    const settingsFocus = await openByokFromSettings(client);
    const byokOpen = await captureStableView(
      client,
      artifacts,
      '05-settings-byok-open',
      (snapshot) =>
        isStableElement(snapshot.settings, { requireUnobscured: false }) &&
        isStableDialog(snapshot.wizard),
      'settings and BYOK wizard entry',
    );
    artifacts.captureActivity('05-settings-byok-open.activity.txt');
    if (byokOpen.overlayDepth !== 2 || !byokOpen.wizard.dialogOpen) {
      throw new Error(`Settings to BYOK did not create two history layers: ${JSON.stringify(byokOpen)}`);
    }
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const byokClosed = await waitForStableView(
      client,
      (snapshot) =>
        !snapshot.wizard.connected &&
        isStableElement(snapshot.settings) &&
        snapshot.overlayDepth === 1,
      'BYOK wizard close while settings remains',
    );
    const byokTopResumed = await waitForTopResumed(
      serial,
      true,
      'settings remains resumed after closing BYOK',
    );
    artifacts.write('06-settings-after-byok-back.json', `${JSON.stringify({
      ...byokClosed,
      topResumed: byokTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('06-settings-after-byok-back.png');
    await waitAfterBackGuard();

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const settingsClosed = await waitForStableView(
      client,
      (snapshot) => !snapshot.settings.connected && snapshot.overlayDepth === 0,
      'settings close while app remains',
    );
    const settingsTopResumed = await waitForTopResumed(
      serial,
      true,
      'app remains resumed after closing settings',
    );
    artifacts.write('07-after-settings-back.json', `${JSON.stringify({
      ...settingsClosed,
      topResumed: settingsTopResumed,
    }, null, 2)}\n`);
    const settingsBackScreenshot = artifacts.captureScreenshot('07-after-settings-back.png');
    await waitAfterBackGuard();

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const ordinaryLauncherEvidence = await waitForStableLauncherEvidence(
      serial,
      artifacts,
      '08-ordinary-back-launcher',
      settingsBackScreenshot.sha256,
    );
    lastSnapshot = settingsClosed;
    closeScenario(activeSession);
    activeSession = null;

    activeSession = await launchCleanScenario(serial, artifactsDirectory, { clearData: true });
    ({ client, artifacts } = activeSession);
    const { importFocus: scriptImportFocus, setupWizard } = await createSyntheticStory(client);
    const libraryOpen = await openDrawer(client);
    await clickSelector(
      client,
      '[data-testid="story-menu-trigger"]',
      'story overflow menu trigger',
    );
    const storyMenuOpen = await captureStableView(
      client,
      artifacts,
      '09-story-menu-over-drawer',
      (snapshot) =>
        isStableDialog(snapshot.mobileLibrary) &&
        isStableElement(snapshot.mobileLibrarySheet) &&
        isStableElement(snapshot.storyMenu) &&
        snapshot.overlayDepth === 2,
      'story menu over library drawer',
    );
    artifacts.captureActivity('09-story-menu-over-drawer.activity.txt');
    if (storyMenuOpen.overlayDepth !== 2) {
      throw new Error(`Story menu above drawer did not create two history layers: ${JSON.stringify(storyMenuOpen)}`);
    }
    if (
      !storyMenuOpen.activeFocus?.insideStoryMenu ||
      storyMenuOpen.activeFocus.role !== 'menuitem' ||
      storyMenuOpen.activeFocus.storyMenuItemIndex !== 0
    ) {
      throw new Error(`Story menu did not focus its first item: ${JSON.stringify(storyMenuOpen.activeFocus)}`);
    }
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN']);
    const storyMenuAfterDown = await waitFor(async () => {
      const snapshot = await readSnapshot(client);
      return snapshot.activeFocus?.insideStoryMenu &&
        snapshot.activeFocus.role === 'menuitem' &&
        snapshot.activeFocus.storyMenuItemIndex === 1
        ? snapshot
        : null;
    }, { description: 'story menu ArrowDown focus', timeoutMs: 5000 });
    artifacts.write('09-story-menu-arrow-down.json', `${JSON.stringify(storyMenuAfterDown, null, 2)}\n`);
    artifacts.captureActivity('09-story-menu-arrow-down.activity.txt');
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const menuClosed = await waitForStableView(
      client,
      (snapshot) =>
        !snapshot.storyMenu.connected &&
        isStableDialog(snapshot.mobileLibrary) &&
        isStableElement(snapshot.mobileLibrarySheet) &&
        snapshot.activeFocus?.testId === 'story-menu-trigger' &&
        snapshot.overlayDepth === 1,
      'story menu close while library drawer remains',
    );
    const menuClosedTopResumed = await waitForTopResumed(
      serial,
      true,
      'drawer remains resumed after closing story menu',
    );
    artifacts.write('10-drawer-after-story-menu-back.json', `${JSON.stringify({
      ...menuClosed,
      topResumed: menuClosedTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('10-drawer-after-story-menu-back.png');
    await waitAfterBackGuard();

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const drawerClosed = await waitForStableView(
      client,
      (snapshot) =>
        !snapshot.mobileLibrary.dialogOpen &&
        snapshot.mobileLibrary.animationsBusy === false &&
        snapshot.overlayDepth === 0,
      'library drawer close while app remains',
    );
    const drawerClosedTopResumed = await waitForTopResumed(
      serial,
      true,
      'app remains resumed after closing library drawer',
    );
    artifacts.write('11-after-drawer-back.json', `${JSON.stringify({
      ...drawerClosed,
      topResumed: drawerClosedTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('11-after-drawer-back.png');
    artifacts.captureUiHierarchy('11-after-drawer-back.ui.xml');
    artifacts.captureLogcat('11-after-drawer-back.logcat.txt');
    lastSnapshot = drawerClosed;

    await openDrawer(client);
    await clickSelector(
      client,
      '[data-testid="mobile-library-start-deepseek"]',
      'mobile DeepSeek import entry',
    );
    await waitForStableView(
      client,
      (snapshot) => snapshot.importPanel.connected,
      'DeepSeek import page',
    );
    const previewZipBase64 = Buffer.from(buildAndroidPreviewZip()).toString('base64');
    await client.evaluate(`(() => {
      const input = document.querySelector('#deepseek-zip-input');
      if (!(input instanceof HTMLInputElement)) return false;
      const bytes = Uint8Array.from(atob(${JSON.stringify(previewZipBase64)}), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'android-preview.zip', { type: 'application/zip' }));
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      () => client.evaluate(`Boolean(document.querySelector('[data-testid="ds-session-item"]'))`),
      { description: 'DeepSeek preview session list', timeoutMs: 10000 },
    );
    await clickSelector(
      client,
      '[data-testid="ds-session-preview-trigger"]',
      'DeepSeek preview trigger',
    );
    const importPreviewOpen = await captureStableView(
      client,
      artifacts,
      '12-import-preview-open',
      (snapshot) =>
        isStableDialog(snapshot.importPreview) &&
        snapshot.overlayDepth === 2,
      'DeepSeek import preview over import page',
    );
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const importPreviewClosed = await waitForStableView(
      client,
      (snapshot) =>
        !snapshot.importPreview.dialogOpen &&
        !snapshot.importPreview.visible &&
        snapshot.importPanel.connected &&
        snapshot.overlayDepth === 1,
      'DeepSeek preview close while import page remains',
    );
    const importPreviewTopResumed = await waitForTopResumed(
      serial,
      true,
      'import page remains resumed after closing preview',
    );
    artifacts.write('13-import-after-preview-back.json', `${JSON.stringify({
      ...importPreviewClosed,
      topResumed: importPreviewTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('13-import-after-preview-back.png');
    lastSnapshot = importPreviewClosed;

    artifacts.write('result.json', `${JSON.stringify({
      status: 'passed',
      completedAt: new Date().toISOString(),
      cleanBeforeCrash,
      settingsFocus,
      automaticOpen,
      afterReload,
      byokOpen,
      byokClosed,
      settingsClosed,
      libraryOpen,
      storyMenuOpen,
      storyMenuAfterDown,
      menuClosed,
      scriptImportFocus,
      setupWizard,
      drawerClosed,
      importPreviewOpen,
      importPreviewClosed,
      launcher: {
        afterReloadBack: reloadLauncherEvidence,
        afterOrdinaryBack: ordinaryLauncherEvidence,
      },
      artifactsDirectory,
    }, null, 2)}\n`);
    console.log(`PASS ${artifactsDirectory}`);
  } catch (error) {
    failure = error;
    const snapshot = activeSession
      ? await readSnapshot(activeSession.client).catch(() => null)
      : lastSnapshot;
    const failureArtifacts = activeSession?.artifacts;
    failureArtifacts?.write('failure.json', `${JSON.stringify({
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
      snapshot,
    }, null, 2)}\n`);
    for (const capture of [
      () => failureArtifacts?.captureScreenshot('failure.png'),
      () => failureArtifacts?.captureActivity('failure.activity.txt'),
      () => failureArtifacts?.captureUiHierarchy('failure.ui.xml'),
      () => failureArtifacts?.captureLogcat('failure.logcat.txt'),
    ]) {
      try {
        capture();
      } catch {
        // Preserve the product failure when ADB happens to disconnect during teardown.
      }
    }
    throw error;
  } finally {
    if (activeSession) {
      activeSession.artifacts.captureLogcat('final.logcat.txt');
      closeScenario(activeSession);
    }
    if (!failure) {
      console.log(`evidence ${artifactsDirectory}`);
    } else {
      console.error(`evidence ${artifactsDirectory}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  });
}
