export type TimelineSource =
  | 'host'
  | 'mock_sse'
  | 'adb'
  | 'cdp_console'
  | 'cdp_lifecycle'
  | 'logcat'
  | 'diagnostic_bundle';

export type TimelineLevel = 'info' | 'warn' | 'error';

export interface TimelineEvent {
  hostTsMs: number;
  rawDeviceTs?: string;
  source: TimelineSource;
  scenarioId: string;
  level: TimelineLevel;
  event: string;
  details?: Record<string, unknown>;
}

export interface ClockSyncMeta {
  hostMeasuredAtMs: number;
  deviceEpochMs: number;
  clockOffsetMs: number;
  roundTripMs: number;
  cdpTimeOriginMs: number | null;
}

export interface CdpEvalClient {
  evaluate(expression: string): Promise<unknown>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { allowFailure?: boolean; encoding?: 'utf8' | 'buffer' },
) => string | Buffer;

export function measureClockOffset(options: {
  runCommand?: CommandRunner;
  serial: string;
  client?: CdpEvalClient | null;
}): Promise<ClockSyncMeta>;

export function normalizeDeviceTimestampToHostMs(
  rawDeviceTs: number | string,
  clockOffsetMs?: number,
  options?: {
    referenceHostMs?: number;
    referenceYear?: number;
    timezoneOffsetMinutes?: number;
  },
): number;

export function mergeTimelineEvents(events: readonly TimelineEvent[]): TimelineEvent[];

export function parseLogcatLines(
  rawLogcat: string,
  options?: {
    pid?: number | string | null;
    clockOffsetMs?: number;
    scenarioId?: string;
    windowStartMs?: number;
    windowEndMs?: number;
    packageName?: string;
    referenceHostMs?: number;
    referenceYear?: number;
    timezoneOffsetMinutes?: number;
  },
): TimelineEvent[];
