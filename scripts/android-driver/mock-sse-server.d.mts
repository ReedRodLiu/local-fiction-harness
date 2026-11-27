import type { AdbRunCommand } from './cdp-client.d.mts';

export interface MockSseChunk {
  content?: string;
  reasoning_content?: string;
  finish_reason?: string | null;
  usage?: Record<string, unknown>;
  delayMs?: number;
  raw?: string;
}

export interface RecordedMockRequest {
  tsMs: number;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  attempt: number | null;
}

export interface MockSseScenarioRule {
  match?: (req: RecordedMockRequest) => boolean;
  onRequest?: (req: RecordedMockRequest) => void;
  initialDelayMs?: number;
  chunkDelayMs?: number;
  abortAfterChunk?: number;
  hangAfterChunkMs?: number;
  includeDone?: boolean;
  httpError?: {
    status?: number;
    message?: string;
    type?: string;
    code?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  };
  halfRefusal?:
    | boolean
    | {
        prefix?: string;
        refusal?: string;
        summary?: string;
      };
  chunks?: Array<string | MockSseChunk>;
  text?: string;
  usage?: Record<string, unknown>;
  nonStreamingResponse?: unknown;
}

export interface MockSseServer {
  port: number;
  host: string;
  baseUrl: string;
  enqueueScenario(rule: MockSseScenarioRule): void;
  enqueueScenarios(list: MockSseScenarioRule[]): void;
  addRule(rule: MockSseScenarioRule): void;
  setDefaultScenario(rule: MockSseScenarioRule): void;
  setModels(nextModels: Array<{ id: string; object?: string; owned_by?: string }>): void;
  setBalance(nextBalance: {
    is_available: boolean;
    balance_infos: Array<{
      currency: string;
      total_balance: string;
      topped_up_balance?: string;
      granted_balance?: string;
    }>;
  }): void;
  getRecordedRequests(): RecordedMockRequest[];
  clearRecordedRequests(): void;
  reset(): void;
  close(): Promise<void>;
}

export function startMockSseServer(options?: {
  port?: number;
  host?: string;
  models?: Array<{ id: string; object?: string; owned_by?: string }>;
  balance?: {
    is_available: boolean;
    balance_infos: Array<{
      currency: string;
      total_balance: string;
      topped_up_balance?: string;
      granted_balance?: string;
    }>;
  };
}): Promise<MockSseServer>;

export function setupAdbReverse(options: {
  serial?: string;
  remotePort: number;
  localPort: number;
  runCommand?: AdbRunCommand;
}): { remotePort: number; localPort: number; spec: string };

export function removeAdbReverse(options?: {
  serial?: string;
  remotePort?: number;
  runCommand?: AdbRunCommand;
}): void;
