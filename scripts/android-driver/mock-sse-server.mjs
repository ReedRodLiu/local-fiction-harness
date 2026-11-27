import http from 'node:http';
import { execFileSync } from 'node:child_process';

const DEFAULT_MODELS = [
  { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
];

const DEFAULT_BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '88.80',
      topped_up_balance: '80.00',
      granted_balance: '8.80',
    },
  ],
};

const DEFAULT_HALF_REFUSAL_PREFIX =
  '雨声压低了屋檐，她把杯子推到你面前，目光停了一瞬。';
const DEFAULT_HALF_REFUSAL_BODY = '抱歉，我不能继续写更具体的内容。';
const DEFAULT_HALF_REFUSAL_SUMMARY =
  '\n\n```lfh-summary\n对话继续推进，气氛变得紧张。\n```';

function defaultRunCommand(command, args = []) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function adbArgs(serial, rest) {
  return serial ? ['-s', serial, ...rest] : rest;
}

function writeChunk(res, text) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      resolve(false);
      return;
    }
    res.write(text, 'utf8', (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders,
  });
  res.end(body);
}

function normalizeChunks(rule) {
  if (rule.halfRefusal) {
    const cfg = typeof rule.halfRefusal === 'object' ? rule.halfRefusal : {};
    const prefix = cfg.prefix ?? DEFAULT_HALF_REFUSAL_PREFIX;
    const refusal = cfg.refusal ?? DEFAULT_HALF_REFUSAL_BODY;
    const summary = cfg.summary ?? DEFAULT_HALF_REFUSAL_SUMMARY;
    return [
      { content: prefix },
      { content: `${refusal}${summary}`, finish_reason: 'stop' },
    ];
  }
  if (Array.isArray(rule.chunks) && rule.chunks.length > 0) {
    return rule.chunks.map((chunk) =>
      typeof chunk === 'string' ? { content: chunk } : { ...chunk },
    );
  }
  if (typeof rule.text === 'string') {
    return [{ content: rule.text, finish_reason: 'stop' }];
  }
  return [{ content: '模拟流式响应正常完成。', finish_reason: 'stop' }];
}

/**
 * Starts a controllable local Mock SSE & OpenAI-compatible HTTP server for Android `.e2e` testing
 * over `adb reverse`. Supports slow-drip chunks, deterministic TCP resets, timeouts,
 * reasoning_content + content chunks, half-refusal fixtures, and V0.5 `/models` & `/user/balance`.
 */
export async function startMockSseServer({
  port = 0,
  host = '127.0.0.1',
  models = DEFAULT_MODELS,
  balance = DEFAULT_BALANCE,
} = {}) {
  let currentModels = structuredClone(models);
  let currentBalance = structuredClone(balance);
  let defaultScenario = {};
  const scenarioQueue = [];
  const rules = [];
  const recordedRequests = [];
  const activeSockets = new Set();
  const activeTimers = new Set();
  let chatAttemptCounter = 0;

  function sleepAbortable(ms, isClosed) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      if (isClosed()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        resolve();
      }, ms);
      activeTimers.add(timer);
    });
  }

  function resolveScenario(reqRecord) {
    for (let i = 0; i < scenarioQueue.length; i += 1) {
      const candidate = scenarioQueue[i];
      if (!candidate.match || candidate.match(reqRecord)) {
        scenarioQueue.splice(i, 1);
        return typeof candidate.rule === 'function'
          ? candidate.rule(reqRecord)
          : candidate;
      }
    }
    for (const rule of rules) {
      if (!rule.match || rule.match(reqRecord)) {
        return typeof rule === 'function' ? rule(reqRecord) : rule;
      }
    }
    return typeof defaultScenario === 'function'
      ? defaultScenario(reqRecord)
      : defaultScenario;
  }

  const server = http.createServer(async (req, res) => {
    const socket = req.socket;
    activeSockets.add(socket);
    let closed = false;
    socket.on('close', () => {
      closed = true;
      activeSockets.delete(socket);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${host}`);
    const body = req.method === 'POST' ? await readRequestBody(req) : null;

    const reqRecord = {
      tsMs: Date.now(),
      method: req.method || 'GET',
      path: url.pathname,
      headers: { ...req.headers },
      body,
      attempt:
        url.pathname === '/v1/chat/completions' ||
        url.pathname === '/chat/completions' ||
        url.pathname === '/beta/chat/completions'
          ? ++chatAttemptCounter
          : null,
    };
    recordedRequests.push(reqRecord);

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, { object: 'list', data: currentModels });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/user/balance') {
      sendJson(res, 200, currentBalance);
      return;
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/chat/completions' ||
        url.pathname === '/chat/completions' ||
        url.pathname === '/beta/chat/completions')
    ) {
      const rule = resolveScenario(reqRecord) ?? {};
      rule.onRequest?.(reqRecord);

      if (rule.initialDelayMs > 0) {
        await sleepAbortable(rule.initialDelayMs, () => closed);
        if (closed) return;
      }

      if (rule.httpError) {
        const status = rule.httpError.status ?? 500;
        const payload = rule.httpError.body ?? {
          error: {
            message: rule.httpError.message ?? `Mock HTTP error ${status}`,
            type: rule.httpError.type ?? 'mock_http_error',
            code: rule.httpError.code ?? null,
          },
        };
        sendJson(res, status, payload, rule.httpError.headers ?? {});
        return;
      }

      const chunks = normalizeChunks(rule);
      const model = (body && typeof body === 'object' && body.model) || 'deepseek-chat';
      const completionId = `mockcmpl-${reqRecord.attempt}`;
      const created = Math.floor(Date.now() / 1000);
      const isStreaming = !(body && typeof body === 'object' && body.stream === false);

      if (!isStreaming) {
        if (rule.abortAfterChunk === 0) {
          socket.destroy();
          return;
        }
        if (rule.nonStreamingResponse) {
          sendJson(res, 200, rule.nonStreamingResponse);
          return;
        }
        let content = '';
        let reasoningContent = '';
        let finishReason = 'stop';
        for (const chunk of chunks) {
          if (typeof chunk.content === 'string') content += chunk.content;
          if (typeof chunk.reasoning_content === 'string') reasoningContent += chunk.reasoning_content;
          if (chunk.finish_reason) finishReason = chunk.finish_reason;
        }
        sendJson(res, 200, {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: rule.usage ?? {
            prompt_tokens: 100,
            completion_tokens: Math.max(1, content.length),
            total_tokens: 100 + Math.max(1, content.length),
          },
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.flushHeaders?.();

      if (rule.abortAfterChunk === 0) {
        socket.destroy();
        return;
      }

      for (let i = 0; i < chunks.length; i += 1) {
        if (closed || socket.destroyed) return;
        const chunk = chunks[i];
        const delayMs = chunk.delayMs ?? rule.chunkDelayMs ?? 0;
        if (delayMs > 0) {
          await sleepAbortable(delayMs, () => closed || socket.destroyed);
          if (closed || socket.destroyed) return;
        }

        const line = chunk.raw
          ? chunk.raw
          : `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(chunk.reasoning_content !== undefined
                      ? { reasoning_content: chunk.reasoning_content }
                      : {}),
                    ...(chunk.content !== undefined ? { content: chunk.content } : {}),
                  },
                  finish_reason: chunk.finish_reason ?? null,
                },
              ],
              ...(chunk.usage ? { usage: chunk.usage } : {}),
            })}\n\n`;

        await writeChunk(res, line);

        if (rule.abortAfterChunk === i + 1) {
          await sleepAbortable(10, () => closed || socket.destroyed);
          if (!socket.destroyed) {
            socket.resetAndDestroy?.();
            if (!socket.destroyed) {
              socket.destroy();
            }
          }
          return;
        }
      }

      if (typeof rule.hangAfterChunkMs === 'number' && rule.hangAfterChunkMs > 0) {
        await sleepAbortable(rule.hangAfterChunkMs, () => closed || socket.destroyed);
        if (!closed && !socket.destroyed) {
          socket.destroy();
        }
        return;
      }

      if (rule.includeDone !== false && !closed && !socket.destroyed) {
        await writeChunk(res, 'data: [DONE]\n\n');
      }
      if (!closed && !res.writableEnded) {
        res.end();
      }
      return;
    }

    sendJson(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Mock SSE server.');
  }

  return {
    port: address.port,
    host,
    baseUrl: `http://${host}:${address.port}`,
    enqueueScenario(rule) {
      scenarioQueue.push(rule);
    },
    enqueueScenarios(list) {
      scenarioQueue.push(...list);
    },
    addRule(rule) {
      rules.push(rule);
    },
    setDefaultScenario(rule) {
      defaultScenario = rule ?? {};
    },
    setModels(nextModels) {
      currentModels = structuredClone(nextModels);
    },
    setBalance(nextBalance) {
      currentBalance = structuredClone(nextBalance);
    },
    getRecordedRequests() {
      return recordedRequests.map((entry) => ({ ...entry }));
    },
    clearRecordedRequests() {
      recordedRequests.length = 0;
      chatAttemptCounter = 0;
    },
    reset() {
      scenarioQueue.length = 0;
      rules.length = 0;
      defaultScenario = {};
      recordedRequests.length = 0;
      chatAttemptCounter = 0;
      currentModels = structuredClone(models);
      currentBalance = structuredClone(balance);
    },
    async close() {
      for (const timer of activeTimers) {
        clearTimeout(timer);
      }
      activeTimers.clear();
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Exposes a host-side Mock SSE server port into the Android device loopback (`127.0.0.1:<remotePort>`)
 * via `adb reverse`.
 */
export function setupAdbReverse({
  serial,
  remotePort,
  localPort,
  runCommand = defaultRunCommand,
}) {
  if (!Number.isInteger(remotePort) || remotePort <= 0) {
    throw new Error(`remotePort must be a positive integer, got: ${remotePort}`);
  }
  if (!Number.isInteger(localPort) || localPort <= 0) {
    throw new Error(`localPort must be a positive integer, got: ${localPort}`);
  }
  const spec = `tcp:${remotePort}`;
  runCommand('adb', adbArgs(serial, ['reverse', spec, `tcp:${localPort}`]));
  return { remotePort, localPort, spec };
}

/**
 * Removes a previously configured `adb reverse` mapping (or all mappings when `remotePort` is omitted).
 */
export function removeAdbReverse({
  serial,
  remotePort,
  runCommand = defaultRunCommand,
} = {}) {
  const args = remotePort
    ? ['reverse', '--remove', `tcp:${remotePort}`]
    : ['reverse', '--remove-all'];
  runCommand('adb', adbArgs(serial, args));
}
