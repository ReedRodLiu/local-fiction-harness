import { adbArgs, defaultRunCommand } from '../android-driver/cdp-client.mjs';

function parseThreadtimeToMs(rawDeviceTs, options = {}) {
  const match = rawDeviceTs
    .trim()
    .match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  const seconds = Number(match[5]);
  const millis = Number(match[6]);

  const refDate =
    typeof options.referenceHostMs === 'number'
      ? new Date(options.referenceHostMs)
      : new Date();
  const referenceYear =
    typeof options.referenceYear === 'number'
      ? options.referenceYear
      : refDate.getUTCFullYear();

  const tzOffsetMin =
    typeof options.timezoneOffsetMinutes === 'number'
      ? options.timezoneOffsetMinutes
      : -new Date().getTimezoneOffset();

  const utcWallMs = Date.UTC(
    referenceYear,
    month - 1,
    day,
    hours,
    minutes,
    seconds,
    millis,
  );
  return utcWallMs - tzOffsetMin * 60_000;
}

export async function measureClockOffset({
  runCommand = defaultRunCommand,
  serial,
  client,
}) {
  if (!serial) {
    throw new Error('measureClockOffset requires a device serial.');
  }

  const hostBeforeMs = Date.now();
  const rawDeviceOut = String(
    runCommand('adb', adbArgs(serial, ['shell', 'date', '+%s%3N'])) ?? '',
  ).trim();
  const hostAfterMs = Date.now();

  let deviceEpochMs;
  if (/^\d{13,}$/.test(rawDeviceOut)) {
    deviceEpochMs = Number(rawDeviceOut);
  } else if (/^\d{10}$/.test(rawDeviceOut)) {
    deviceEpochMs = Number(rawDeviceOut) * 1000;
  } else if (/^\d{10}%3N$/.test(rawDeviceOut)) {
    deviceEpochMs = Number(rawDeviceOut.slice(0, 10)) * 1000;
  } else {
    throw new Error(`Unable to parse device epoch from adb date output: "${rawDeviceOut}"`);
  }

  const hostMidMs = Math.round((hostBeforeMs + hostAfterMs) / 2);
  const clockOffsetMs = hostMidMs - deviceEpochMs;
  const roundTripMs = Math.max(0, hostAfterMs - hostBeforeMs);

  let cdpTimeOriginMs = null;
  if (client && typeof client.evaluate === 'function') {
    const evaluated = await client.evaluate('performance.timeOrigin');
    if (typeof evaluated === 'number' && Number.isFinite(evaluated)) {
      cdpTimeOriginMs = evaluated;
    }
  }

  return {
    hostMeasuredAtMs: hostMidMs,
    deviceEpochMs,
    clockOffsetMs,
    roundTripMs,
    cdpTimeOriginMs,
  };
}

export function normalizeDeviceTimestampToHostMs(
  rawDeviceTs,
  clockOffsetMs = 0,
  options = {},
) {
  if (!Number.isFinite(clockOffsetMs)) {
    throw new Error(`clockOffsetMs must be a finite number, got: ${clockOffsetMs}`);
  }

  let deviceMs;
  if (typeof rawDeviceTs === 'number') {
    if (!Number.isFinite(rawDeviceTs)) {
      throw new Error(`Invalid numeric device timestamp: ${rawDeviceTs}`);
    }
    deviceMs = rawDeviceTs < 1e11 && rawDeviceTs > 1e8 ? rawDeviceTs * 1000 : rawDeviceTs;
  } else if (typeof rawDeviceTs === 'string') {
    const trimmed = rawDeviceTs.trim();
    if (/^\d{10,}$/.test(trimmed)) {
      const parsedNum = Number(trimmed);
      deviceMs = parsedNum < 1e11 ? parsedNum * 1000 : parsedNum;
    } else {
      const threadtimeMs = parseThreadtimeToMs(trimmed, options);
      if (threadtimeMs !== null) {
        deviceMs = threadtimeMs;
      } else {
        const parsedIso = Date.parse(trimmed);
        if (Number.isNaN(parsedIso)) {
          throw new Error(`Unable to parse device timestamp: "${rawDeviceTs}"`);
        }
        deviceMs = parsedIso;
      }
    }
  } else {
    throw new Error(`Unsupported device timestamp type: ${typeof rawDeviceTs}`);
  }

  return Math.round(deviceMs + clockOffsetMs);
}

const VALID_TIMELINE_SOURCES = new Set([
  'host',
  'mock_sse',
  'adb',
  'cdp_console',
  'cdp_lifecycle',
  'logcat',
  'diagnostic_bundle',
]);

const VALID_TIMELINE_LEVELS = new Set(['info', 'warn', 'error']);

const RELEVANT_LOGCAT_TAGS = [
  'ssestreamclient',
  'sseforegroundservice',
  'activitytaskmanager',
  'chromium',
];

const THREADTIME_REGEX =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+?)\s*:\s*(.*)$/;

function mapLogcatLevel(logLevel) {
  if (logLevel === 'E' || logLevel === 'F' || logLevel === 'A') {
    return 'error';
  }
  if (logLevel === 'W') {
    return 'warn';
  }
  return 'info';
}

export function mergeTimelineEvents(events) {
  if (!Array.isArray(events)) {
    throw new Error('mergeTimelineEvents expects an array of events.');
  }

  return events
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid timeline event at index ${index}.`);
      }
      if (!Number.isFinite(item.hostTsMs)) {
        throw new Error(`Timeline event at index ${index} is missing finite hostTsMs.`);
      }
      if (!VALID_TIMELINE_SOURCES.has(item.source)) {
        throw new Error(`Unsupported timeline source "${item.source}" at index ${index}.`);
      }
      const level = VALID_TIMELINE_LEVELS.has(item.level) ? item.level : 'info';
      return {
        index,
        normalized: {
          hostTsMs: item.hostTsMs,
          ...(item.rawDeviceTs !== undefined ? { rawDeviceTs: String(item.rawDeviceTs) } : {}),
          source: item.source,
          scenarioId: String(item.scenarioId ?? 'GLOBAL'),
          level,
          event: String(item.event ?? ''),
          ...(item.details && typeof item.details === 'object' ? { details: item.details } : {}),
        },
      };
    })
    .sort((a, b) => a.normalized.hostTsMs - b.normalized.hostTsMs || a.index - b.index)
    .map((entry) => entry.normalized);
}

export function parseLogcatLines(
  rawLogcat,
  {
    pid,
    clockOffsetMs = 0,
    scenarioId = 'GLOBAL',
    windowStartMs,
    windowEndMs,
    packageName,
    referenceHostMs,
    referenceYear,
    timezoneOffsetMinutes,
  } = {},
) {
  if (typeof rawLogcat !== 'string' || !rawLogcat.trim()) {
    return [];
  }

  const pidText = pid !== undefined && pid !== null ? String(pid).trim() : '';
  const pkgLower = typeof packageName === 'string' && packageName.trim()
    ? packageName.trim().toLowerCase()
    : '';
  const events = [];

  for (const rawLine of rawLogcat.split(/\r?\n/)) {
    const match = rawLine.match(THREADTIME_REGEX);
    if (!match) {
      continue;
    }

    const [, rawDeviceTs, linePid, lineTid, logLevel, tag, message] = match;
    const tagLower = tag.trim().toLowerCase();
    const messageLower = message.toLowerCase();

    const pidMatches = Boolean(pidText) && linePid === pidText;
    const tagMatches = RELEVANT_LOGCAT_TAGS.some(
      (relevant) => tagLower.includes(relevant) || messageLower.includes(relevant),
    );
    const packageMatches =
      Boolean(pkgLower) && (tagLower.includes(pkgLower) || messageLower.includes(pkgLower));

    if (!pidMatches && !tagMatches && !packageMatches) {
      continue;
    }

    const hostTsMs = normalizeDeviceTimestampToHostMs(rawDeviceTs, clockOffsetMs, {
      referenceHostMs,
      referenceYear,
      timezoneOffsetMinutes,
    });

    if (typeof windowStartMs === 'number' && hostTsMs < windowStartMs) {
      continue;
    }
    if (typeof windowEndMs === 'number' && hostTsMs > windowEndMs) {
      continue;
    }

    events.push({
      hostTsMs,
      rawDeviceTs,
      source: 'logcat',
      scenarioId,
      level: mapLogcatLevel(logLevel),
      event: tag.trim(),
      details: {
        pid: Number(linePid),
        tid: Number(lineTid),
        logLevel,
        tag: tag.trim(),
        message,
        rawLine,
      },
    });
  }

  return events;
}
