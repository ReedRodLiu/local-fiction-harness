import { execFileSync } from 'node:child_process';

const DEFAULT_APP_ORIGINS = ['http://localhost', 'https://localhost'];
const LIFECYCLE_EVENT_METHODS = new Set([
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Inspector.targetCrashed',
  'Inspector.detached',
  'Target.targetDestroyed',
  'Page.frameNavigated',
  'Page.loadEventFired',
]);

function defaultRunCommand(command, args = []) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function adbArgs(serial, rest) {
  return serial ? ['-s', serial, ...rest] : rest;
}

function removeForwardBestEffort({ serial, localPort, runCommand }) {
  if (!localPort) return;
  try {
    runCommand('adb', adbArgs(serial, ['forward', '--remove', `tcp:${localPort}`]));
  } catch {
    // Ignore already-removed or disconnected forward specs.
  }
}

function normalizeOrigin(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return null;
  try {
    return new URL(urlString).origin;
  } catch {
    return null;
  }
}

async function waitForValue(check, { description, timeoutMs = 15000, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

/**
 * Discovers the active WebView DevTools abstract Unix socket for `packageId`
 * by intersecting multi-PID `pidof` output with `/proc/net/unix`.
 */
export async function discoverWebViewSocket({
  serial,
  packageId,
  runCommand = defaultRunCommand,
}) {
  if (!packageId) {
    throw new Error('packageId is required for WebView socket discovery.');
  }

  let pidOutput = '';
  try {
    pidOutput = String(
      await runCommand('adb', adbArgs(serial, ['shell', 'pidof', packageId])),
    );
  } catch {
    return null;
  }

  const pids = pidOutput
    .trim()
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token));
  if (pids.length === 0) {
    return null;
  }

  let unixOutput = '';
  try {
    unixOutput = String(
      await runCommand('adb', adbArgs(serial, ['shell', 'cat', '/proc/net/unix'])),
    );
  } catch {
    return null;
  }

  const activeSocketPids = new Set();
  for (const match of unixOutput.matchAll(/@webview_devtools_remote_(\d+)\b/g)) {
    activeSocketPids.add(match[1]);
  }

  const matchedPids = pids.filter((pid) => activeSocketPids.has(pid));
  if (matchedPids.length === 0) {
    return null;
  }

  const primaryPid = matchedPids[0];
  const socketName = `webview_devtools_remote_${primaryPid}`;
  return {
    pid: primaryPid,
    matchedPids,
    socketName,
    abstractSocket: `localabstract:${socketName}`,
  };
}

/**
 * Filters CDP targets for `type === 'page'` matching Capacitor app origins
 * and optionally verifies readiness/identity via `evaluateTarget`.
 */
export async function selectMainCapacitorTarget(
  targets,
  { appOrigins = DEFAULT_APP_ORIGINS, evaluateTarget } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return null;
  }

  const pageTargets = targets.filter(
    (target) =>
      target &&
      target.type === 'page' &&
      typeof target.webSocketDebuggerUrl === 'string' &&
      target.webSocketDebuggerUrl.length > 0,
  );
  if (pageTargets.length === 0) {
    return null;
  }

  let candidates;
  if (Array.isArray(appOrigins) && appOrigins.length > 0) {
    const normalizedOrigins = appOrigins.map((origin) => normalizeOrigin(origin) ?? origin);
    candidates = pageTargets
      .map((target) => {
        const origin = normalizeOrigin(target.url);
        const rank = origin ? normalizedOrigins.indexOf(origin) : -1;
        return { target, rank };
      })
      .filter((entry) => entry.rank !== -1)
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.target);
  } else {
    candidates = pageTargets;
  }

  if (candidates.length === 0) {
    return null;
  }

  if (!evaluateTarget) {
    return candidates[0];
  }

  for (const candidate of candidates) {
    try {
      const ok = await evaluateTarget(candidate);
      if (ok) {
        return candidate;
      }
    } catch {
      // Try next matching page target.
    }
  }
  return null;
}

/**
 * Zero-dependency WebSocket CDP client with event subscriptions, domain re-enabling,
 * console/exception/lifecycle buffering, and stale-forward-safe reconnect.
 */
export class CdpClient {
  static async connect(
    webSocketDebuggerUrl,
    { timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket, ...clientOptions } = {},
  ) {
    const socket = await CdpClient.#openSocket(webSocketDebuggerUrl, {
      timeoutMs,
      WebSocketImpl,
    });
    return new CdpClient(socket, {
      defaultTimeoutMs: timeoutMs,
      WebSocketImpl,
      ...clientOptions,
    });
  }

  static async #openSocket(webSocketDebuggerUrl, { timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
    if (typeof WebSocketImpl !== 'function') {
      throw new Error('No WebSocket implementation available in this runtime.');
    }
    const socket = new WebSocketImpl(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out connecting to WebView DevTools at ${webSocketDebuggerUrl}.`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`WebView DevTools connection failed for ${webSocketDebuggerUrl}.`));
        },
        { once: true },
      );
    });
    return socket;
  }

  constructor(socket, options = {}) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.closeListeners = new Set();
    this.enabledDomains = new Set();
    this.consoleEvents = [];
    this.exceptionEvents = [];
    this.lifecycleEvents = [];
    this.bufferedEvents = [];
    this.maxBufferedEvents = options.maxBufferedEvents ?? 500;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.pid = options.pid ?? null;
    this.localPort = options.localPort ?? null;
    this.target = options.target ?? null;
    this.#reconnectHandler = options.reconnectHandler ?? null;
    this.#closeHandler = options.closeHandler ?? null;
    this.#closedManually = false;

    if (socket) {
      this.#attachSocket(socket);
    }
  }

  #reconnectHandler;
  #closeHandler;
  #closedManually;

  #pushBounded(list, item) {
    list.push(item);
    if (list.length > this.maxBufferedEvents) {
      list.splice(0, list.length - this.maxBufferedEvents);
    }
  }

  #attachSocket(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.id !== undefined && message.id !== null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP command failed.'));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (typeof message.method === 'string') {
        const entry = {
          tsMs: Date.now(),
          method: message.method,
          params: message.params ?? {},
        };
        this.#pushBounded(this.bufferedEvents, entry);
        if (message.method === 'Runtime.consoleAPICalled') {
          this.#pushBounded(this.consoleEvents, entry);
        } else if (message.method === 'Runtime.exceptionThrown') {
          this.#pushBounded(this.exceptionEvents, entry);
        } else if (LIFECYCLE_EVENT_METHODS.has(message.method)) {
          this.#pushBounded(this.lifecycleEvents, entry);
        }

        const handlers = this.eventListeners.get(message.method);
        if (handlers) {
          for (const handler of [...handlers]) {
            handler(entry.params, entry);
          }
        }
        const wildcardHandlers = this.eventListeners.get('*');
        if (wildcardHandlers) {
          for (const handler of [...wildcardHandlers]) {
            handler(entry.params, entry);
          }
        }
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebView DevTools connection closed.'));
      }
      this.pending.clear();
      for (const listener of [...this.closeListeners]) {
        listener({ manual: this.#closedManually });
      }
    });
  }

  isConnected() {
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    return Boolean(this.socket && this.socket.readyState === openState);
  }

  onEvent(method, handler) {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, new Set());
    }
    this.eventListeners.get(method).add(handler);
    return () => this.offEvent(method, handler);
  }

  offEvent(method, handler) {
    const handlers = this.eventListeners.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.eventListeners.delete(method);
    }
  }

  onClose(handler) {
    this.closeListeners.add(handler);
    return () => {
      this.closeListeners.delete(handler);
    };
  }

  getConsoleEvents() {
    return [...this.consoleEvents];
  }

  getExceptionEvents() {
    return [...this.exceptionEvents];
  }

  getLifecycleEvents() {
    return [...this.lifecycleEvents];
  }

  getBufferedEvents() {
    return [...this.bufferedEvents];
  }

  clearEventBuffers() {
    this.consoleEvents = [];
    this.exceptionEvents = [];
    this.lifecycleEvents = [];
    this.bufferedEvents = [];
  }

  send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error(`Cannot send CDP command ${method}: socket is not open.`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for WebView DevTools response to ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async enableDomains(domains = ['Runtime', 'Page']) {
    for (const domain of domains) {
      this.enabledDomains.add(domain);
      await this.send(`${domain}.enable`);
    }
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? 'WebView evaluation failed.');
    }
    return response?.result?.value;
  }

  async reconnect() {
    if (!this.#reconnectHandler) {
      throw new Error('reconnect() requires a session created by connectToAppWebView.');
    }
    this.#closedManually = false;
    this.#closeCurrentSocketOnly();
    const next = await this.#reconnectHandler({
      previousPid: this.pid,
      previousLocalPort: this.localPort,
    });
    this.pid = next.pid;
    this.localPort = next.localPort;
    this.target = next.target;
    this.#attachSocket(next.socket);
    if (this.enabledDomains.size > 0) {
      await this.enableDomains([...this.enabledDomains]);
    }
    return {
      client: this,
      pid: this.pid,
      localPort: this.localPort,
      target: this.target,
    };
  }

  #closeCurrentSocketOnly() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebView DevTools connection closed for reconnect/shutdown.'));
    }
    this.pending.clear();
    if (this.socket) {
      const prev = this.socket;
      this.socket = null;
      try {
        prev.close();
      } catch {
        // Ignore errors closing already-closed socket.
      }
    }
  }

  async close() {
    this.#closedManually = true;
    this.#closeCurrentSocketOnly();
    if (this.#closeHandler) {
      const handler = this.#closeHandler;
      this.#closeHandler = null;
      await handler({ pid: this.pid, localPort: this.localPort });
    }
  }
}

async function openAndVerifyTarget({
  serial,
  packageId,
  runCommand,
  fetchFn,
  WebSocketImpl,
  appOrigins,
  verifyExpression,
  timeoutMs,
  pollIntervalMs,
}) {
  const discovered = await waitForValue(
    () => discoverWebViewSocket({ serial, packageId, runCommand }),
    {
      description: `${packageId} WebView DevTools socket`,
      timeoutMs,
      intervalMs: pollIntervalMs,
    },
  );

  const forwardOut = String(
    await runCommand(
      'adb',
      adbArgs(serial, ['forward', 'tcp:0', discovered.abstractSocket]),
    ),
  ).trim();
  const localPort = forwardOut;
  if (!/^\d+$/.test(localPort)) {
    throw new Error(`Unexpected adb forward output: "${forwardOut}"`);
  }

  const listUrl = `http://127.0.0.1:${localPort}/json/list`;
  let verifiedSocket = null;

  try {
    const selectedTarget = await waitForValue(
      async () => {
        const res = await fetchFn(listUrl, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        const targets = await res.json();
        return selectMainCapacitorTarget(targets, {
          appOrigins,
          evaluateTarget: async (candidate) => {
            const tempClient = await CdpClient.connect(candidate.webSocketDebuggerUrl, {
              timeoutMs: 3000,
              WebSocketImpl,
            });
            try {
              if (verifyExpression) {
                const ok = await tempClient.evaluate(verifyExpression);
                if (!ok) {
                  await tempClient.close();
                  return false;
                }
              }
              verifiedSocket = tempClient.socket;
              tempClient.socket = null;
              return true;
            } catch (error) {
              await tempClient.close();
              throw error;
            }
          },
        });
      },
      {
        description: `Capacitor WebView target (${packageId})`,
        timeoutMs,
        intervalMs: pollIntervalMs,
      },
    );

    return {
      pid: discovered.pid,
      localPort,
      target: selectedTarget,
      socket: verifiedSocket,
    };
  } catch (error) {
    if (verifiedSocket) {
      try {
        verifiedSocket.close();
      } catch {
        // Ignore cleanup close errors.
      }
    }
    removeForwardBestEffort({ serial, localPort, runCommand });
    throw error;
  }
}

/**
 * Discovers the app WebView socket, creates an `adb forward`, selects the primary
 * Capacitor target, verifies readiness, and returns a reconnect-capable session.
 */
export async function connectToAppWebView({
  serial,
  packageId,
  runCommand = defaultRunCommand,
  fetchFn = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  appOrigins = DEFAULT_APP_ORIGINS,
  verifyExpression = "document.readyState === 'complete'",
  domains = [],
  timeoutMs = 15000,
  pollIntervalMs = 100,
}) {
  let activeLocalPort = null;

  const initial = await openAndVerifyTarget({
    serial,
    packageId,
    runCommand,
    fetchFn,
    WebSocketImpl,
    appOrigins,
    verifyExpression,
    timeoutMs,
    pollIntervalMs,
  });
  activeLocalPort = initial.localPort;

  const client = new CdpClient(initial.socket, {
    WebSocketImpl,
    pid: initial.pid,
    localPort: initial.localPort,
    target: initial.target,
    reconnectHandler: async ({ previousLocalPort }) => {
      removeForwardBestEffort({
        serial,
        localPort: previousLocalPort ?? activeLocalPort,
        runCommand,
      });
      activeLocalPort = null;
      const next = await openAndVerifyTarget({
        serial,
        packageId,
        runCommand,
        fetchFn,
        WebSocketImpl,
        appOrigins,
        verifyExpression,
        timeoutMs,
        pollIntervalMs,
      });
      activeLocalPort = next.localPort;
      return next;
    },
    closeHandler: async ({ localPort }) => {
      removeForwardBestEffort({
        serial,
        localPort: localPort ?? activeLocalPort,
        runCommand,
      });
      activeLocalPort = null;
    },
  });

  if (domains.length > 0) {
    await client.enableDomains(domains);
  }

  return {
    client,
    pid: initial.pid,
    localPort: initial.localPort,
    target: initial.target,
    reconnect: () => client.reconnect(),
    close: () => client.close(),
  };
}
