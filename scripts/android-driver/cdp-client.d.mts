export interface DiscoveredWebViewSocket {
  pid: string;
  matchedPids: string[];
  socketName: string;
  abstractSocket: string;
}

export interface CdpTargetInfo {
  id?: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface BufferedCdpEvent {
  tsMs: number;
  method: string;
  params: Record<string, unknown>;
}

export type AdbRunCommand = (command: string, args: string[]) => string | Promise<string>;

export function discoverWebViewSocket(options: {
  serial?: string;
  packageId: string;
  runCommand?: AdbRunCommand;
}): Promise<DiscoveredWebViewSocket | null>;

export function selectMainCapacitorTarget(
  targets: CdpTargetInfo[],
  options?: {
    appOrigins?: string[];
    evaluateTarget?: (target: CdpTargetInfo) => boolean | Promise<boolean>;
  },
): Promise<CdpTargetInfo | null>;

export class CdpClient {
  pid: string | null;
  localPort: string | null;
  target: CdpTargetInfo | null;

  static connect(
    webSocketDebuggerUrl: string,
    options?: {
      timeoutMs?: number;
      WebSocketImpl?: typeof WebSocket;
    },
  ): Promise<CdpClient>;

  constructor(socket: WebSocket | null, options?: Record<string, unknown>);
  isConnected(): boolean;
  onEvent(
    method: string,
    handler: (params: Record<string, unknown>, event: BufferedCdpEvent) => void,
  ): () => void;
  offEvent(
    method: string,
    handler: (params: Record<string, unknown>, event: BufferedCdpEvent) => void,
  ): void;
  onClose(handler: (info: { manual: boolean }) => void): () => void;
  getConsoleEvents(): BufferedCdpEvent[];
  getExceptionEvents(): BufferedCdpEvent[];
  getLifecycleEvents(): BufferedCdpEvent[];
  getBufferedEvents(): BufferedCdpEvent[];
  clearEventBuffers(): void;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  enableDomains(domains?: string[]): Promise<void>;
  evaluate<T = unknown>(
    expression: string,
    options?: { awaitPromise?: boolean; returnByValue?: boolean },
  ): Promise<T>;
  reconnect(): Promise<{
    client: CdpClient;
    pid: string | null;
    localPort: string | null;
    target: CdpTargetInfo | null;
  }>;
  close(): Promise<void>;
}

export interface AppWebViewSession {
  client: CdpClient;
  pid: string;
  localPort: string;
  target: CdpTargetInfo;
  reconnect: () => Promise<{
    client: CdpClient;
    pid: string | null;
    localPort: string | null;
    target: CdpTargetInfo | null;
  }>;
  close: () => Promise<void>;
}

export function connectToAppWebView(options: {
  serial?: string;
  packageId: string;
  runCommand?: AdbRunCommand;
  fetchFn?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  appOrigins?: string[];
  verifyExpression?: string | null;
  domains?: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<AppWebViewSession>;
