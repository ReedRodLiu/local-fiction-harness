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

async function readSnapshot(client) {
  const value = await client.evaluate(`(() => {
    const dialog = document.querySelector('[data-testid="diagnostics-preview"]');
    const card = document.querySelector('[data-testid="crash-recovery-card"]');
    const state = history.state;
    const hasSession = Boolean(
      state &&
      typeof state === 'object' &&
      typeof state.lfhOverlaySession === 'string'
    );
    const depth = hasSession ? Number(state.lfhOverlayDepth) : 0;
    return JSON.stringify({
      dialogConnected: Boolean(dialog),
      dialogOpen: Boolean(dialog?.open),
      cardVisible: Boolean(card && card.getClientRects().length),
      historyLength: history.length,
      overlayDepth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
      rawHistoryState: state,
    });
  })()`);
  return JSON.parse(value);
}

async function clickCrashDiagnosticsTrigger(client) {
  const bounds = await client.evaluate(`(() => {
    const button = document.querySelector('[data-testid="crash-open-diagnostics"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!bounds) throw new Error('Crash diagnostics trigger is not present.');
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: bounds.x,
    y: bounds.y,
    button: 'left',
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: bounds.x,
    y: bounds.y,
    button: 'left',
    clickCount: 1,
  });
}

function assertOverlayState(snapshot, label) {
  const failures = [];
  if (!snapshot.dialogOpen) failures.push('diagnostics dialog is not open');
  if (!snapshot.cardVisible) failures.push('reassurance card is not visible');
  if (snapshot.overlayDepth !== 1) {
    failures.push(`overlay depth is ${snapshot.overlayDepth}, expected 1`);
  }
  if (failures.length > 0) {
    throw new Error(`${label}: ${failures.join('; ')} ${JSON.stringify(snapshot)}`);
  }
}

function assertClosedState(snapshot, topResumed, label) {
  const failures = [];
  if (snapshot.dialogOpen) failures.push('diagnostics dialog is still open');
  if (!snapshot.cardVisible) failures.push('reassurance card was not retained');
  if (snapshot.overlayDepth !== 0) {
    failures.push(`overlay depth is ${snapshot.overlayDepth}, expected 0`);
  }
  if (!topResumed) failures.push(`${MAIN_ACTIVITY} is no longer topResumed`);
  if (failures.length > 0) {
    throw new Error(`${label}: ${failures.join('; ')} ${JSON.stringify(snapshot)}`);
  }
}

async function waitForClosedOverlay(client) {
  try {
    await waitFor(async () => {
      const snapshot = await readSnapshot(client);
      return !snapshot.dialogOpen && snapshot.overlayDepth === 0 ? snapshot : null;
    }, { description: 'diagnostics overlay to close', timeoutMs: 5000 });
  } catch (error) {
    const snapshot = await readSnapshot(client);
    throw new Error(`${error.message}. Current state: ${JSON.stringify(snapshot)}`);
  }
  return readSnapshot(client);
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
  run('adb', ['-s', serial, 'logcat', '-c']);
  run('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY]);

  const { client, localPort, pid } = await connectToWebView(serial);
  const artifacts = createArtifactWriter(serial, artifactsDirectory, pid);
  artifacts.write('run.json', `${JSON.stringify({
    serial,
    apiLevel,
    apkPath,
    packageName: PACKAGE_NAME,
    activity: MAIN_ACTIVITY,
    pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  let failure;
  try {
    artifacts.captureScreenshot('01-clean-before-error.png');
    artifacts.captureActivity('01-clean-before-error.activity.txt');

    await client.evaluate(`window.dispatchEvent(new ErrorEvent('error', {
      error: new Error('lfh-back-regression automatic crash'),
      message: 'lfh-back-regression automatic crash'
    }))`);
    await waitFor(async () => {
      const snapshot = await readSnapshot(client);
      return snapshot.dialogOpen && snapshot.overlayDepth === 1 ? snapshot : null;
    }, { description: 'automatic crash diagnostics overlay', timeoutMs: 10000 });

    const automaticOpen = await readSnapshot(client);
    artifacts.write('02-automatic-open.json', `${JSON.stringify(automaticOpen, null, 2)}\n`);
    artifacts.captureScreenshot('02-automatic-open.png');
    artifacts.captureActivity('02-automatic-open.activity.txt');
    assertOverlayState(automaticOpen, 'automatic diagnostics open');

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (!activityIsTopResumed(serial)) {
      throw new Error(
        `automatic diagnostics back: ${MAIN_ACTIVITY} returned to Launcher while the overlay was open`,
      );
    }
    const automaticClosed = await waitForClosedOverlay(client);
    const automaticTopResumed = activityIsTopResumed(serial);
    artifacts.write('03-automatic-closed.json', `${JSON.stringify({
      ...automaticClosed,
      topResumed: automaticTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('03-automatic-closed.png');
    artifacts.captureActivity('03-automatic-closed.activity.txt');
    artifacts.captureUiHierarchy('03-automatic-closed.ui.xml');
    artifacts.captureLogcat('03-automatic-closed.logcat.txt');
    assertClosedState(automaticClosed, automaticTopResumed, 'automatic diagnostics closed');

    await waitFor(() => {
      return client.evaluate(`Boolean(document.querySelector('[data-testid="crash-open-diagnostics"]'))`);
    }, { description: 'manual diagnostics trigger after automatic close' });
    await clickCrashDiagnosticsTrigger(client);
    await waitFor(async () => {
      const snapshot = await readSnapshot(client);
      return snapshot.dialogOpen && snapshot.overlayDepth === 1 ? snapshot : null;
    }, { description: 'manually reopened diagnostics overlay', timeoutMs: 10000 });
    const manualOpen = await readSnapshot(client);
    artifacts.write('04-manual-open.json', `${JSON.stringify(manualOpen, null, 2)}\n`);
    artifacts.captureScreenshot('04-manual-open.png');
    artifacts.captureActivity('04-manual-open.activity.txt');
    assertOverlayState(manualOpen, 'manual diagnostics open');

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    const manualClosed = await waitForClosedOverlay(client);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const manualTopResumed = activityIsTopResumed(serial);
    artifacts.write('05-manual-double-back-closed.json', `${JSON.stringify({
      ...manualClosed,
      topResumed: manualTopResumed,
    }, null, 2)}\n`);
    artifacts.captureScreenshot('05-manual-double-back-closed.png');
    artifacts.captureActivity('05-manual-double-back-closed.activity.txt');
    artifacts.captureUiHierarchy('05-manual-double-back-closed.ui.xml');
    artifacts.captureLogcat('05-manual-double-back-closed.logcat.txt');
    assertClosedState(manualClosed, manualTopResumed, 'manual diagnostics closed after rapid double back');

    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await waitFor(() => {
      try {
        return !activityIsTopResumed(serial);
      } catch {
        return false;
      }
    }, {
      description: 'ordinary back to leave the activity',
      timeoutMs: 10000,
    });
    artifacts.captureScreenshot('06-ordinary-back-exit.png');
    artifacts.captureActivity('06-ordinary-back-exit.activity.txt');
    artifacts.captureLogcat('06-ordinary-back-exit.logcat.txt');
    artifacts.write('result.json', `${JSON.stringify({
      status: 'passed',
      completedAt: new Date().toISOString(),
      automaticOpen,
      automaticClosed,
      manualOpen,
      manualClosed,
      artifactsDirectory,
    }, null, 2)}\n`);
    console.log(`PASS ${artifactsDirectory}`);
  } catch (error) {
    failure = error;
    const snapshot = await readSnapshot(client).catch(() => null);
    artifacts.write('failure.json', `${JSON.stringify({
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
      snapshot,
    }, null, 2)}\n`);
    for (const capture of [
      () => artifacts.captureScreenshot('failure.png'),
      () => artifacts.captureActivity('failure.activity.txt'),
      () => artifacts.captureUiHierarchy('failure.ui.xml'),
      () => artifacts.captureLogcat('failure.logcat.txt'),
    ]) {
      try {
        capture();
      } catch {
        // Preserve the product failure when ADB happens to disconnect during teardown.
      }
    }
    throw error;
  } finally {
    client.close();
    spawnSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${localPort}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    artifacts.captureLogcat('final.logcat.txt');
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
