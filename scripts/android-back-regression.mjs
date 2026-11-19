import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'io.localfiction.harness';
const MAIN_ACTIVITY = `${PACKAGE_NAME}/.MainActivity`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function run(command, args, { encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr;
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`);
  }
  return result.stdout;
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
  }

  function captureActivity(name) {
    write(name, run('adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']));
  }

  function captureUiHierarchy(name) {
    const remotePath = `/sdcard/lfh-back-regression-${Date.now()}.xml`;
    try {
      run('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', remotePath]);
      write(name, run('adb', ['-s', serial, 'exec-out', 'cat', remotePath]));
    } catch (error) {
      write(name.replace(/\.xml$/, '.error.txt'), `${error.message}\n`);
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
    captureLogcat,
  };
}

function activityIsTopResumed(serial) {
  const output = run('adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
  return output
    .split(/\r?\n/)
    .some((line) =>
      line.includes('topResumedActivity=') &&
      line.includes(PACKAGE_NAME) &&
      line.includes('.MainActivity')
    );
}

async function waitForTopResumed(serial, expected, description, timeoutMs = 10000) {
  return waitFor(() => {
    const topResumed = activityIsTopResumed(serial);
    return topResumed === expected ? true : null;
  }, { description, timeoutMs });
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
      diagnostics: describeElement('[data-testid="diagnostics-preview"]'),
      crashCard: describeElement('[data-testid="crash-recovery-card"]'),
      mobileLibrary: describeElement('[data-testid="mobile-library-dialog"]'),
      mobileLibrarySheet: describeElement('[data-testid="mobile-library-sheet"]'),
      settings: describeElement('[data-testid="settings-page"]'),
      wizard: describeElement('[data-testid="deepseek-setup-wizard"]'),
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
    artifacts.captureScreenshot(`${name}.png`);
    const afterCapture = await readSnapshot(client);
    if (afterCapture.documentReady && condition(afterCapture)) {
      artifacts.write(`${name}.json`, `${JSON.stringify(afterCapture, null, 2)}\n`);
      return afterCapture;
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
  return waitForStableView(
    client,
    (snapshot) => isStableElement(snapshot.settings),
    'settings page entry',
  );
}

async function openByokFromSettings(client) {
  await openSettingsFromDrawer(client);
  await clickSelector(
    client,
    '[data-testid="open-setup-wizard-btn"], [data-testid="change-key-btn"]',
    'BYOK setup trigger',
  );
  return waitForStableView(
    client,
    (snapshot) => isStableDialog(snapshot.wizard),
    'BYOK wizard entry',
  );
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
}

async function launchCleanScenario(serial, artifactsDirectory) {
  run('adb', ['-s', serial, 'shell', 'am', 'force-stop', PACKAGE_NAME]);
  run('adb', ['-s', serial, 'shell', 'pm', 'clear', PACKAGE_NAME]);
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
  run('adb', ['-s', serial, 'shell', 'am', 'force-stop', PACKAGE_NAME]);
  run('adb', ['-s', serial, 'shell', 'pm', 'clear', PACKAGE_NAME]);
  run('adb', ['-s', serial, 'install', '-r', '-t', apkPath]);
  run('adb', ['-s', serial, 'shell', 'pm', 'clear', PACKAGE_NAME]);
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  fs.writeFileSync(path.join(artifactsDirectory, 'run.json'), `${JSON.stringify({
    serial,
    apiLevel,
    apkPath,
    packageName: PACKAGE_NAME,
    activity: MAIN_ACTIVITY,
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
    artifacts.captureScreenshot('03-after-reload-stale-history.png');
    artifacts.captureActivity('03-after-reload-stale-history.activity.txt');
    if (
      typeof afterReload.historySession !== 'string' ||
      afterReload.overlayDepth !== 1
    ) {
      throw new Error(`Reload did not preserve the expected stale overlay history: ${JSON.stringify(afterReload)}`);
    }

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await waitForTopResumed(
      serial,
      false,
      'one KEYCODE_BACK after diagnostics reload to reach Launcher',
      5000,
    );
    artifacts.captureScreenshot('04-reload-one-back-launcher.png');
    artifacts.captureActivity('04-reload-one-back-launcher.activity.txt');
    artifacts.captureLogcat('04-reload-one-back-launcher.logcat.txt');
    if (typeof afterReload.sessionToken !== 'string') {
      throw new Error(`The current Web overlay session token is not exposed: ${JSON.stringify(afterReload)}`);
    }
    if (afterReload.historySession === afterReload.sessionToken) {
      throw new Error(`Reloaded page history still matches the current session token: ${JSON.stringify(afterReload)}`);
    }
    lastSnapshot = afterReload;
    closeScenario(activeSession);
    activeSession = null;

    activeSession = await launchCleanScenario(serial, artifactsDirectory);
    ({ client, artifacts } = activeSession);
    await openByokFromSettings(client);
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
    artifacts.captureScreenshot('07-after-settings-back.png');
    await waitAfterBackGuard();

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await waitForTopResumed(
      serial,
      false,
      'ordinary page back after all overlays to reach Launcher',
    );
    artifacts.captureScreenshot('08-ordinary-back-launcher.png');
    artifacts.captureActivity('08-ordinary-back-launcher.activity.txt');
    artifacts.captureLogcat('08-ordinary-back-launcher.logcat.txt');
    lastSnapshot = settingsClosed;
    closeScenario(activeSession);
    activeSession = null;

    activeSession = await launchCleanScenario(serial, artifactsDirectory);
    ({ client, artifacts } = activeSession);
    await createSyntheticStory(client);
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
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const menuClosed = await waitForStableView(
      client,
      (snapshot) =>
        !snapshot.storyMenu.connected &&
        isStableDialog(snapshot.mobileLibrary) &&
        isStableElement(snapshot.mobileLibrarySheet) &&
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

    artifacts.write('result.json', `${JSON.stringify({
      status: 'passed',
      completedAt: new Date().toISOString(),
      cleanBeforeCrash,
      automaticOpen,
      afterReload,
      byokOpen,
      byokClosed,
      settingsClosed,
      libraryOpen,
      storyMenuOpen,
      menuClosed,
      drawerClosed,
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

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
