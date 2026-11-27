import http from 'node:http';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CdpClient,
  OS_EDGE_GUARD_CSS_PX,
  adbArgs,
  computeSafeSwipeBounds,
  connectToAppWebView,
  defaultRunCommand,
  discoverWebViewSocket,
  parseDisplayMetrics,
  readDeviceUiHierarchy,
  removeAdbReverse,
  resolveDomTapPoint,
  resolveOsEdgeBackSwipe,
  resolvePercentageSwipe,
  selectMainCapacitorTarget,
  setupAdbReverse,
  startMockSseServer,
} from '../../scripts/android-driver/index.mjs';

const PIXEL_PORTRAIT_DUMPSYS = `
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=0 stacks=1
    init=1080x2400 420dpi mMinSize=1080x2400 cur=1080x2400 app=1080x2268 rng=1080x1008-2268x2196
    mCurrentDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, real 1080 x 2400, app 1080 x 2268, density 420 (422.03 x 422.03) dpi, rotation 0 (ROTATION_0)}
    mDisplayFrames=DisplayFrames w=1080 h=2400 r=0
    mDisplayCutout=DisplayCutout{insets=Rect(0, 118 - 0, 0) waterfall=Insets{left=0, top=0, right=0, bottom=0} boundingRect={Bounds=[Rect(486, 0 - 594, 118)]}}
    InsetsState
      InsetsSource id=e650000 type=statusBars frame=[0,0][1080,118] visible=true flags=[]
      InsetsSource id=c8e0001 type=navigationBars frame=[0,2337][1080,2400] visible=true flags=[]
      InsetsSource id=c8e0005 type=systemGestures frame=[0,0][84,2400] visible=true flags=[]
      InsetsSource id=c8e0006 type=systemGestures frame=[996,0][1080,2400] visible=true flags=[]
      InsetsSource id=c8e0007 type=mandatorySystemGestures frame=[0,0][1080,118] visible=true flags=[]
      InsetsSource id=c8e0008 type=mandatorySystemGestures frame=[0,2316][1080,2400] visible=true flags=[]
      InsetsSource id=3 type=displayCutout frame=[0,0][1080,118] visible=true flags=[]
      InsetsSource id=14 type=ime frame=[0,0][0,0] visible=false flags=[]
`;

const LANDSCAPE_ROTATED_DUMPSYS = `
  Display: mDisplayId=0
    cur=2400x1080 app=2268x1080
    mCurrentDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, real 2400 x 1080, rotation 1 (ROTATION_90)}
    mDisplayCutout=DisplayCutout{insets=Rect(118, 0 - 0, 0) boundingRect={Bounds=[Rect(0, 486 - 118, 594)]}}
    InsetsState
      InsetsSource id=e650000 type=statusBars frame=[0,0][2400,72] visible=true
      InsetsSource id=c8e0001 type=navigationBars frame=[0,1017][2400,1080] visible=true
      InsetsSource id=c8e0005 type=systemGestures frame=[0,0][84,1080] visible=true
      InsetsSource id=c8e0006 type=systemGestures frame=[2316,0][2400,1080] visible=true
      InsetsSource id=14 type=ime frame=[0,0][0,0] visible=false
`;

const COMPACT_IME_OPEN_DUMPSYS = `
  Display: mDisplayId=0
    mDisplayFrames=DisplayFrames w=720 h=1280 r=0
    InsetsState
      InsetsSource type=ITYPE_STATUS_BAR frame=[0,0][720,48] visible=true
      InsetsSource type=ITYPE_NAVIGATION_BAR frame=[0,1184][720,1280] visible=true
      InsetsSource type=ITYPE_IME frame=[0,760][720,1280] visible=true
`;

describe('Android driver coordinate math', () => {
  it('parses portrait, rotated landscape, cutout, and IME insets from dumpsys window displays', () => {
    const portrait = parseDisplayMetrics(PIXEL_PORTRAIT_DUMPSYS);
    expect(portrait.displayW).toBe(1080);
    expect(portrait.displayH).toBe(2400);
    expect(portrait.rotation).toBe(0);
    expect(portrait.densityDpi).toBe(420);
    expect(portrait.safeInsetsPx).toEqual({ top: 118, bottom: 63, left: 0, right: 0 });
    expect(portrait.systemGestureEdgePx).toEqual({ left: 84, right: 84, top: 0, bottom: 0 });

    const landscape = parseDisplayMetrics(
      LANDSCAPE_ROTATED_DUMPSYS,
      'Physical size: 1080x2400',
      'Physical density: 420',
    );
    expect(landscape.displayW).toBe(2400);
    expect(landscape.displayH).toBe(1080);
    expect(landscape.rotation).toBe(90);
    expect(landscape.densityDpi).toBe(420);
    expect(landscape.safeInsetsPx).toEqual({ top: 72, bottom: 63, left: 118, right: 0 });

    const compactIme = parseDisplayMetrics(
      COMPACT_IME_OPEN_DUMPSYS,
      'Physical size: 720x1280',
      'Physical density: 320',
    );
    expect(compactIme.displayW).toBe(720);
    expect(compactIme.displayH).toBe(1280);
    expect(compactIme.densityDpi).toBe(320);
    expect(compactIme.insets.ime).toEqual({ left: 0, top: 760, right: 720, bottom: 1280 });
    expect(compactIme.safeInsetsPx.bottom).toBe(520);
  });

  it('guarantees in-app swipe bounds clear OS_EDGE_GUARD_PX (32 CSS px) and system gesture insets', () => {
    expect(OS_EDGE_GUARD_CSS_PX).toBe(32);

    const display = parseDisplayMetrics(PIXEL_PORTRAIT_DUMPSYS);
    const dpr = 2.625;
    const webViewBounds = { left: 0, top: 0, right: 1080, bottom: 2400 };
    const safeBounds = computeSafeSwipeBounds({
      display,
      webViewBounds,
      dpr,
      safeAreaCss: { top: 45, bottom: 24, left: 0, right: 0 },
    });

    // 32 CSS px * 2.625 = 84px, plus safety margin must strictly clear 32 CSS px and 84px edge
    expect((safeBounds.safeLeftPx - webViewBounds.left) / dpr).toBeGreaterThan(32);
    expect(safeBounds.safeLeftPx).toBeGreaterThan(display.systemGestureEdgePx.left);
    expect((webViewBounds.right - safeBounds.safeRightPx) / dpr).toBeGreaterThan(32);
    expect(safeBounds.safeRightPx).toBeLessThan(display.displayW - display.systemGestureEdgePx.right);
    expect(safeBounds.safeTopPx).toBeGreaterThanOrEqual(118);
    expect(safeBounds.safeBottomPx).toBeLessThanOrEqual(2337);

    const swipe = resolvePercentageSwipe({
      bounds: safeBounds,
      fromPct: { x: 0.14, y: 0.5 },
      toPct: { x: 0.86, y: 0.5 },
    });
    expect(swipe.x1).toBeGreaterThanOrEqual(safeBounds.safeLeftPx);
    expect(swipe.x2).toBeLessThanOrEqual(safeBounds.safeRightPx);
    expect(swipe.y1).toBe(swipe.y2);
    expect(swipe.y1).toBeGreaterThanOrEqual(safeBounds.safeTopPx);
    expect(swipe.y1).toBeLessThanOrEqual(safeBounds.safeBottomPx);
  });

  it('generates OS edge back swipe inside left system gesture zone', () => {
    const display = parseDisplayMetrics(PIXEL_PORTRAIT_DUMPSYS);
    const edgeSwipe = resolveOsEdgeBackSwipe({
      display,
      systemGestureLeftPx: display.systemGestureEdgePx.left,
    });

    expect(edgeSwipe.x1).toBeGreaterThan(0);
    expect(edgeSwipe.x1).toBeLessThanOrEqual(Math.max(4, display.systemGestureEdgePx.left / 2));
    expect(edgeSwipe.x1).toBeLessThan(display.systemGestureEdgePx.left);
    expect(edgeSwipe.x2).toBeGreaterThan(display.systemGestureEdgePx.left);
    expect(edgeSwipe.y1).toBeGreaterThanOrEqual(display.safeInsetsPx.top);
    expect(edgeSwipe.y1).toBeLessThanOrEqual(display.displayH - display.safeInsetsPx.bottom);
  });

  it('computes DOM tap points and rejects off-screen or bar/IME-occluded elements', () => {
    const dpr = 2.625;
    const display = parseDisplayMetrics(PIXEL_PORTRAIT_DUMPSYS);
    const webViewBounds = { left: 0, top: 0, right: 1080, bottom: 2400 };
    const safeBounds = computeSafeSwipeBounds({ display, webViewBounds, dpr });

    const validTap = resolveDomTapPoint({
      rect: { left: 100, top: 200, width: 200, height: 48 },
      visualViewport: { offsetLeft: 0, offsetTop: 0 },
      dpr,
      webViewBounds,
      display,
      safeBounds,
    });
    expect(validTap).toEqual({
      x: Math.round((100 + 100) * dpr),
      y: Math.round((200 + 24) * dpr),
    });

    // Status-bar occluded element (top=4, height=32 -> center y=20 CSS px = 52.5px < 118px)
    expect(() =>
      resolveDomTapPoint({
        rect: { left: 100, top: 4, width: 120, height: 32 },
        visualViewport: { offsetLeft: 0, offsetTop: 0 },
        dpr,
        webViewBounds,
        display,
        safeBounds,
      }),
    ).toThrow(/occluded|status|safe/i);

    // IME-occluded element on compact screen
    const compactIme = parseDisplayMetrics(COMPACT_IME_OPEN_DUMPSYS);
    expect(() =>
      resolveDomTapPoint({
        rect: { left: 40, top: 420, width: 200, height: 48 },
        visualViewport: { offsetLeft: 0, offsetTop: 0 },
        dpr: 2,
        webViewBounds: { left: 0, top: 0, right: 720, bottom: 1280 },
        display: compactIme,
      }),
    ).toThrow(/occluded|ime|safe/i);

    // Off-screen element
    expect(() =>
      resolveDomTapPoint({
        rect: { left: 500, top: 100, width: 100, height: 40 },
        visualViewport: { offsetLeft: 0, offsetTop: 0 },
        dpr,
        webViewBounds,
        display,
      }),
    ).toThrow(/outside|bounds|screen/i);
  });
});

interface MiniCdpServer {
  port: number;
  connections: Array<{
    sendJson: (payload: unknown) => void;
    close: () => void;
  }>;
  setTargets: (targets: Array<Record<string, unknown>>) => void;
  close: () => Promise<void>;
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer: Buffer): { frames: Array<{ opcode: number; text: string }>; rest: Buffer } {
  const frames: Array<{ opcode: number; text: string }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + length > buffer.length) break;
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLen;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function startMiniCdpServer(
  onMessage: (msg: { id: number; method: string; params?: Record<string, unknown> }, send: (p: unknown) => void) => void,
): Promise<MiniCdpServer> {
  let targets: Array<Record<string, unknown>> = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const connections: MiniCdpServer['connections'] = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    const sendJson = (payload: unknown) => {
      if (!socket.destroyed) {
        socket.write(encodeWsTextFrame(JSON.stringify(payload)));
      }
    };
    const conn = {
      sendJson,
      close: () => socket.destroy(),
    };
    connections.push(conn);

    let pendingBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pendingBuf = Buffer.concat([pendingBuf, chunk]);
      const { frames, rest } = decodeWsFrames(pendingBuf);
      pendingBuf = Buffer.from(rest);
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x1) {
          const msg = JSON.parse(frame.text);
          onMessage(msg, sendJson);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mini CDP server');
  }
  return {
    port: address.port,
    connections,
    setTargets: (next) => {
      targets = next;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Android WebView CDP discovery and reconnect', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('discovers WebView socket by intersecting multi-PID pidof with /proc/net/unix', async () => {
    const adbCalls: string[] = [];
    const runCommand = (_cmd: string, args: string[]) => {
      const line = args.join(' ');
      adbCalls.push(line);
      if (line.includes('pidof io.localfiction.harness.e2e')) {
        // Multi-PID output: sandboxed helper PID 4100 + main app PID 4215
        return '4100 4215\n';
      }
      if (line.includes('cat /proc/net/unix')) {
        return [
          '0000000000000000: 00000002 00000000 00010000 0001 01 111 @webview_devtools_remote_9999',
          '0000000000000000: 00000002 00000000 00010000 0001 01 222 @webview_devtools_remote_4215',
        ].join('\n');
      }
      return '';
    };

    const socket = await discoverWebViewSocket({
      serial: 'emulator-5554',
      packageId: 'io.localfiction.harness.e2e',
      runCommand,
    });

    expect(socket).toEqual({
      pid: '4215',
      matchedPids: ['4215'],
      socketName: 'webview_devtools_remote_4215',
      abstractSocket: 'localabstract:webview_devtools_remote_4215',
    });
    expect(adbCalls.some((c) => c.includes('pidof io.localfiction.harness.e2e'))).toBe(true);
    expect(adbCalls.some((c) => c.includes('cat /proc/net/unix'))).toBe(true);
  });

  it('returns null when pidof and /proc/net/unix do not intersect', async () => {
    const socket = await discoverWebViewSocket({
      serial: 'emulator-5554',
      packageId: 'io.localfiction.harness.e2e',
      runCommand: (_cmd: string, args: string[]) => {
        const line = args.join(' ');
        if (line.includes('pidof')) return '4100 4215';
        if (line.includes('/proc/net/unix')) return '@webview_devtools_remote_8888\n';
        return '';
      },
    });
    expect(socket).toBeNull();
  });

  it('selects primary Capacitor origin page target and verifies readiness/identity', async () => {
    const targets = [
      { type: 'service_worker', url: 'http://localhost/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/sw' },
      { type: 'page', url: 'https://accounts.example.com/login', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/ext' },
      { type: 'page', url: 'https://localhost/preview', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/preview' },
      { type: 'page', url: 'http://localhost/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/main' },
    ];

    const selected = await selectMainCapacitorTarget(targets, {
      appOrigins: ['http://localhost', 'https://localhost'],
      evaluateTarget: async (target) => target.url.endsWith('/index.html'),
    });

    expect(selected?.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/main');

    const rejected = await selectMainCapacitorTarget(
      [{ type: 'page', url: 'https://untrusted.example/page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' }],
      { appOrigins: ['http://localhost', 'https://localhost'] },
    );
    expect(rejected).toBeNull();
  });

  it('subscribes to CDP events, buffers console/exception events, and cleans stale adb forward on reconnect', async () => {
    const enabledMethods: string[] = [];
    const server1 = await startMiniCdpServer((msg, send) => {
      if (msg.method === 'Runtime.enable' || msg.method === 'Page.enable') {
        enabledMethods.push(`s1:${msg.method}`);
        send({ id: msg.id, result: {} });
        return;
      }
      if (msg.method === 'Runtime.evaluate') {
        send({ id: msg.id, result: { result: { value: true } } });
      }
    });
    cleanups.push(() => server1.close());

    const server2 = await startMiniCdpServer((msg, send) => {
      if (msg.method === 'Runtime.enable' || msg.method === 'Page.enable') {
        enabledMethods.push(`s2:${msg.method}`);
        send({ id: msg.id, result: {} });
        return;
      }
      if (msg.method === 'Runtime.evaluate') {
        send({ id: msg.id, result: { result: { value: true } } });
      }
    });
    cleanups.push(() => server2.close());

    server1.setTargets([
      {
        id: 'main-1',
        type: 'page',
        url: 'http://localhost/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server1.port}/devtools/page/main-1`,
      },
    ]);
    server2.setTargets([
      {
        id: 'main-2',
        type: 'page',
        url: 'http://localhost/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server2.port}/devtools/page/main-2`,
      },
    ]);

    let connectionRound = 1;
    const adbCommands: string[] = [];
    const runCommand = (_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      adbCommands.push(joined);
      if (joined.includes('pidof')) {
        return connectionRound === 1 ? '5001' : '5002';
      }
      if (joined.includes('/proc/net/unix')) {
        return connectionRound === 1
          ? '@webview_devtools_remote_5001\n'
          : '@webview_devtools_remote_5002\n';
      }
      if (joined.includes('forward tcp:0 localabstract:webview_devtools_remote_5001')) {
        return `${server1.port}\n`;
      }
      if (joined.includes('forward tcp:0 localabstract:webview_devtools_remote_5002')) {
        return `${server2.port}\n`;
      }
      return '';
    };

    const session = await connectToAppWebView({
      serial: 'emulator-5554',
      packageId: 'io.localfiction.harness.e2e',
      runCommand,
      verifyExpression: `document.readyState === 'complete'`,
    });
    cleanups.push(() => session.close());

    expect(session.pid).toBe('5001');
    expect(session.localPort).toBe(String(server1.port));
    await session.client.enableDomains(['Runtime', 'Page']);
    expect(enabledMethods).toEqual(['s1:Runtime.enable', 's1:Page.enable']);

    const seenEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    const off = session.client.onEvent('Runtime.consoleAPICalled', (params) => {
      seenEvents.push({ method: 'Runtime.consoleAPICalled', params });
    });

    server1.connections[0].sendJson({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'hello-cdp' }] },
    });
    server1.connections[0].sendJson({
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { text: 'boom' } },
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(seenEvents).toHaveLength(1);
    expect(session.client.getConsoleEvents()).toHaveLength(1);
    expect(session.client.getExceptionEvents()).toHaveLength(1);

    // Simulate process restart / disconnect on server1, then reconnect on server2
    connectionRound = 2;
    server1.connections[0].close();
    await new Promise((r) => setTimeout(r, 30));

    const reconnected = await session.client.reconnect();
    expect(reconnected.pid).toBe('5002');
    expect(reconnected.localPort).toBe(String(server2.port));
    expect(adbCommands).toContain(`-s emulator-5554 forward --remove tcp:${server1.port}`);
    expect(enabledMethods).toContain('s2:Runtime.enable');
    expect(enabledMethods).toContain('s2:Page.enable');

    // Event listener preserved across reconnect; off() detaches cleanly
    server2.connections[0].sendJson({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'after-reconnect' }] },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(seenEvents).toHaveLength(2);

    off();
    server2.connections[0].sendJson({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'ignored' }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(seenEvents).toHaveLength(2);

    await session.close();
    expect(adbCommands).toContain(`-s emulator-5554 forward --remove tcp:${server2.port}`);
    expect(CdpClient).toBeDefined();
  });

  it('detaches message/close/error listeners via detachSocket() and exports shared ADB helpers', async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const mockSocket = {
      readyState: 1,
      addEventListener(type: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (...args: unknown[]) => void) {
        listeners.get(type)?.delete(fn);
      },
      send() {},
      close() {},
    };

    const client = new CdpClient(mockSocket as unknown as WebSocket);
    expect(listeners.get('message')?.size).toBe(1);
    expect(listeners.get('close')?.size).toBe(1);
    expect(listeners.get('error')?.size).toBe(1);

    const detached = client.detachSocket();
    expect(detached).toBe(mockSocket);
    expect(listeners.get('message')?.size).toBe(0);
    expect(listeners.get('close')?.size).toBe(0);
    expect(listeners.get('error')?.size).toBe(0);

    expect(adbArgs('SER123', ['shell', 'ls'])).toEqual(['-s', 'SER123', 'shell', 'ls']);
    expect(adbArgs(undefined, ['devices'])).toEqual(['devices']);
    expect(typeof defaultRunCommand).toBe('function');

    const adbUiCalls: string[] = [];
    const uiXml = await readDeviceUiHierarchy((_cmd: string, args: string[]) => {
      adbUiCalls.push(args.join(' '));
      if (args.includes('cat')) return '<hierarchy><node text="OK" /></hierarchy>';
      return '';
    }, 'SER123');
    expect(uiXml).toContain('<hierarchy>');
    expect(adbUiCalls.some((c) => c.includes('-s SER123 shell uiautomator dump'))).toBe(true);
    expect(adbUiCalls.some((c) => c.includes('-s SER123 shell rm -f'))).toBe(true);
  });
});

async function readSseText(response: Response): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      events.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
    }
  }
  return events;
}

describe('Mock SSE server and adb reverse helpers', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('serves /v1/models, /models, /user/balance, and non-streaming chat completions', async () => {
    const mock = await startMockSseServer();
    cleanups.push(() => mock.close());

    const modelsV1 = await fetch(`${mock.baseUrl}/v1/models`).then((r) => r.json());
    const modelsRoot = await fetch(`${mock.baseUrl}/models`).then((r) => r.json());
    expect(modelsV1.data.map((m: { id: string }) => m.id)).toContain('deepseek-chat');
    expect(modelsRoot.data.map((m: { id: string }) => m.id)).toContain('deepseek-reasoner');

    const balance = await fetch(`${mock.baseUrl}/user/balance`).then((r) => r.json());
    expect(balance.is_available).toBe(true);
    expect(balance.balance_infos[0]).toMatchObject({ currency: 'CNY', total_balance: expect.any(String) });

    mock.enqueueScenario({
      chunks: [
        { reasoning_content: '先想一步。' },
        { content: '非流式正文回复。', finish_reason: 'stop' },
      ],
    });
    const nonStream = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    }).then((r) => r.json());

    expect(nonStream.choices[0].message.reasoning_content).toBe('先想一步。');
    expect(nonStream.choices[0].message.content).toBe('非流式正文回复。');
    expect(mock.getRecordedRequests()).toHaveLength(4);
    mock.reset();
    expect(mock.getRecordedRequests()).toHaveLength(0);
  });

  it('streams reasoning_content + content and enforces slow-drip chunkDelayMs timing', async () => {
    const mock = await startMockSseServer();
    cleanups.push(() => mock.close());

    mock.enqueueScenario({
      chunkDelayMs: 55,
      chunks: [
        { reasoning_content: '推理片段一。' },
        { content: '正文片段一，' },
        { content: '正文片段二。', finish_reason: 'stop' },
      ],
    });

    const start = Date.now();
    const res = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await readSseText(res);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(events[0]).toContain('"reasoning_content":"推理片段一。"');
    expect(events[1]).toContain('"content":"正文片段一，"');
    expect(events[2]).toContain('"content":"正文片段二。"');
    expect(events[events.length - 1]).toBe('data: [DONE]');
  });

  it('injects real socket TCP reset on abortAfterChunk and triggers timeout via hangAfterChunkMs', async () => {
    const mock = await startMockSseServer();
    cleanups.push(() => mock.close());

    mock.enqueueScenario({
      abortAfterChunk: 2,
      chunkDelayMs: 10,
      chunks: [
        { content: '第一段' },
        { content: '第二段' },
        { content: '永不到达的第三段', finish_reason: 'stop' },
      ],
    });

    const res = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'abort' }] }),
    });
    const receivedChunks: string[] = [];
    let streamError: unknown = null;
    try {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      streamError = err;
    }

    const joined = receivedChunks.join('');
    expect(joined).toContain('第一段');
    expect(joined).toContain('第二段');
    expect(joined).not.toContain('永不到达的第三段');
    expect(joined).not.toContain('[DONE]');
    expect(streamError).toBeTruthy();

    // hangAfterChunkMs keeps connection open past client timeout
    mock.enqueueScenario({
      hangAfterChunkMs: 1000,
      chunks: [{ content: '挂起前首包' }],
    });
    await expect(
      fetch(`${mock.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(80),
        body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hang' }] }),
      }).then((r) => readSseText(r)),
    ).rejects.toThrow();

    // httpError support
    mock.enqueueScenario({
      httpError: { status: 429, message: 'Rate limited by mock' },
    });
    const errRes = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: '429' }] }),
    });
    expect(errRes.status).toBe(429);
    const errBody = await errRes.json();
    expect(errBody.error.message).toBe('Rate limited by mock');
  });

  it('serves half-refusal fixture followed by clean recovery on retry via /beta/chat/completions', async () => {
    const mock = await startMockSseServer();
    cleanups.push(() => mock.close());

    mock.enqueueScenarios([
      { halfRefusal: true },
      { chunks: [{ content: '续写成功：门轴轻响，她把灯拨亮了些。', finish_reason: 'stop' }] },
    ]);

    const firstEvents = await fetch(`${mock.baseUrl}/beta/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'turn1' }] }),
    }).then((r) => readSseText(r));

    const firstJoined = firstEvents.join('\n');
    expect(firstJoined).toContain('抱歉，我不能继续写更具体的内容');

    const retryEvents = await fetch(`${mock.baseUrl}/beta/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        messages: [
          { role: 'user', content: 'turn1' },
          { role: 'assistant', content: '门轴', prefix: true },
        ],
      }),
    }).then((r) => readSseText(r));

    expect(retryEvents.join('\n')).toContain('续写成功：门轴轻响');
    expect(mock.getRecordedRequests()).toHaveLength(2);
    expect(mock.getRecordedRequests()[1].path).toBe('/beta/chat/completions');
  });

  it('invokes adb reverse setup and removal helpers', () => {
    const calls: string[] = [];
    const runCommand = (_cmd: string, args: string[]) => {
      calls.push(args.join(' '));
      return '';
    };

    const rev = setupAdbReverse({
      serial: 'emulator-5554',
      remotePort: 18080,
      localPort: 45123,
      runCommand,
    });
    expect(rev).toEqual({ remotePort: 18080, localPort: 45123, spec: 'tcp:18080' });
    removeAdbReverse({ serial: 'emulator-5554', remotePort: 18080, runCommand });

    expect(calls).toEqual([
      '-s emulator-5554 reverse tcp:18080 tcp:45123',
      '-s emulator-5554 reverse --remove tcp:18080',
    ]);
  });
});
