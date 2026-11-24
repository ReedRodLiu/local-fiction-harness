import type {
  AppUpdateReleaseInfo,
  KeyValueStorage,
} from './types.ts';

export const FOLIO_ANDROID_GITEE_OWNER = 'liu-reed-rod';
export const FOLIO_ANDROID_GITEE_REPO = 'folio-android';
export const FOLIO_ANDROID_RELEASES_API_URL =
  `https://gitee.com/api/v5/repos/${FOLIO_ANDROID_GITEE_OWNER}/${FOLIO_ANDROID_GITEE_REPO}/releases?page=1&per_page=10&direction=desc`;
export const FOLIO_ANDROID_RELEASES_PAGE_URL =
  `https://gitee.com/${FOLIO_ANDROID_GITEE_OWNER}/${FOLIO_ANDROID_GITEE_REPO}/releases`;
export const APP_UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const APP_UPDATE_MAX_APK_BYTES = 150 * 1024 * 1024;
export const APP_UPDATE_PREFERENCES_STORAGE_KEY = 'lfh.appUpdate.preferences.v1';

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  normalized: string;
}

export interface GiteeReleaseAssetLike {
  name?: unknown;
  browser_download_url?: unknown;
}

export interface GiteeReleaseLike {
  id?: unknown;
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

export interface AppUpdatePreferences {
  autoCheckEnabled: boolean;
  lastCheckedAtMs?: number;
  skippedVersion?: string;
}

const SEMVER_REGEX =
  /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const SHA256_LINE_REGEX = /(?:^|[\r\n])\s*SHA-?256\s*[:：]\s*([0-9a-fA-F]{64})\b/i;

/**
 * Parses a SemVer string with optional leading `v`/`V` prefix.
 */
export function parseSemver(raw: string): ParsedSemver | null {
  const trimmed = raw.trim();
  const match = SEMVER_REGEX.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = match[4] ? match[4].split('.').filter(Boolean) : [];
  const normalizedBase = `${major}.${minor}.${patch}`;
  const normalized = prerelease.length > 0 ? `${normalizedBase}-${prerelease.join('.')}` : normalizedBase;

  return {
    major,
    minor,
    patch,
    prerelease,
    normalized,
  };
}

function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (leftNumeric && !rightNumeric) return -1;
    if (!leftNumeric && rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compares two SemVer strings. Returns 1 if `left > right`, -1 if `left < right`, 0 if equal.
 * Throws if either version string is invalid.
 */
export function compareSemver(leftRaw: string, rightRaw: string): number {
  const left = parseSemver(leftRaw);
  const right = parseSemver(rightRaw);
  if (!left || !right) {
    throw new Error(`Invalid SemVer comparison: "${leftRaw}" vs "${rightRaw}"`);
  }
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

/**
 * Returns true if `candidateVersion` is strictly newer than `currentVersion`.
 */
export function isNewerVersion(candidateVersion: string, currentVersion: string): boolean {
  const left = parseSemver(candidateVersion);
  const right = parseSemver(currentVersion);
  if (!left || !right) return false;
  return compareSemver(left.normalized, right.normalized) > 0;
}

/**
 * Extracts a 64-character lowercase SHA-256 hex digest from a release body if present.
 */
export function extractSha256FromReleaseBody(body: string): string | undefined {
  if (!body) return undefined;
  const match = SHA256_LINE_REGEX.exec(body);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Selects the preferred `.apk` asset from a Gitee release's asset list.
 * Prefers `*-release.apk`, falling back to any `.apk` with an HTTPS download URL.
 */
export function selectApkAssetFromRelease(
  assets: unknown,
): { apkName: string; apkUrl: string } | null {
  if (!Array.isArray(assets)) return null;
  const candidates: Array<{ apkName: string; apkUrl: string; priority: number }> = [];

  for (const item of assets) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as GiteeReleaseAssetLike;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const url = typeof raw.browser_download_url === 'string' ? raw.browser_download_url.trim() : '';
    if (!name || !url) continue;
    if (!/\.apk$/i.test(name)) continue;
    if (!/^https:\/\//i.test(url)) continue;

    const priority = /-release\.apk$/i.test(name) ? 0 : 1;
    candidates.push({ apkName: name, apkUrl: url, priority });
  }

  candidates.sort((a, b) => a.priority - b.priority);
  if (candidates.length === 0) return null;
  return {
    apkName: candidates[0].apkName,
    apkUrl: candidates[0].apkUrl,
  };
}

/**
 * Builds a canonical Gitee tag release page URL for browser fallback.
 */
export function buildGiteeReleasePageUrl(tagName: string): string {
  const cleanTag = tagName.trim();
  if (!cleanTag) return FOLIO_ANDROID_RELEASES_PAGE_URL;
  return `https://gitee.com/${FOLIO_ANDROID_GITEE_OWNER}/${FOLIO_ANDROID_GITEE_REPO}/releases/tag/${encodeURIComponent(cleanTag)}`;
}

/**
 * Parses and selects the highest-version non-prerelease Gitee Release with a valid APK asset.
 * Accepts either a Gitee `/releases` array or a single `/releases/latest` object.
 */
export function selectLatestStableGiteeRelease(payload: unknown): AppUpdateReleaseInfo | null {
  const items: unknown[] = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? [payload] : [];
  let best: { semver: ParsedSemver; info: AppUpdateReleaseInfo } | null = null;

  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const release = entry as GiteeReleaseLike;
    if (release.prerelease === true || release.draft === true) continue;

    const tagName = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
    const semver = parseSemver(tagName);
    if (!semver || semver.prerelease.length > 0) continue;

    const apk = selectApkAssetFromRelease(release.assets);
    if (!apk) continue;

    const body = typeof release.body === 'string' ? release.body : '';
    const title = typeof release.name === 'string' && release.name.trim() ? release.name.trim() : `Folio v${semver.normalized}`;
    const publishedAt = typeof release.created_at === 'string' && release.created_at.trim()
      ? release.created_at.trim()
      : undefined;
    const htmlUrl = typeof release.html_url === 'string' && /^https:\/\//i.test(release.html_url.trim())
      ? release.html_url.trim()
      : buildGiteeReleasePageUrl(tagName);

    const info: AppUpdateReleaseInfo = {
      version: semver.normalized,
      tagName,
      title,
      notes: body.trim(),
      publishedAt,
      releasePageUrl: htmlUrl,
      apkName: apk.apkName,
      apkUrl: apk.apkUrl,
      expectedSha256: extractSha256FromReleaseBody(body),
    };

    if (!best || compareSemver(semver.normalized, best.semver.normalized) > 0) {
      best = { semver, info };
    }
  }

  return best ? best.info : null;
}

export function readUpdatePreferences(storage?: KeyValueStorage): AppUpdatePreferences {
  if (!storage) return { autoCheckEnabled: true };
  try {
    const raw = storage.getItem(APP_UPDATE_PREFERENCES_STORAGE_KEY);
    if (!raw) return { autoCheckEnabled: true };
    const parsed = JSON.parse(raw) as Partial<AppUpdatePreferences>;
    const autoCheckEnabled = typeof parsed.autoCheckEnabled === 'boolean' ? parsed.autoCheckEnabled : true;
    const lastCheckedAtMs =
      typeof parsed.lastCheckedAtMs === 'number' && Number.isFinite(parsed.lastCheckedAtMs) && parsed.lastCheckedAtMs >= 0
        ? parsed.lastCheckedAtMs
        : undefined;
    const skippedSemver = typeof parsed.skippedVersion === 'string' ? parseSemver(parsed.skippedVersion) : null;
    return {
      autoCheckEnabled,
      lastCheckedAtMs,
      skippedVersion: skippedSemver ? skippedSemver.normalized : undefined,
    };
  } catch {
    return { autoCheckEnabled: true };
  }
}

export function writeUpdatePreferences(
  storage: KeyValueStorage | undefined,
  prefs: AppUpdatePreferences,
): AppUpdatePreferences {
  const normalizedSkipped = prefs.skippedVersion ? parseSemver(prefs.skippedVersion)?.normalized : undefined;
  const normalized: AppUpdatePreferences = {
    autoCheckEnabled: prefs.autoCheckEnabled,
    ...(typeof prefs.lastCheckedAtMs === 'number' && Number.isFinite(prefs.lastCheckedAtMs) && prefs.lastCheckedAtMs >= 0
      ? { lastCheckedAtMs: prefs.lastCheckedAtMs }
      : {}),
    ...(normalizedSkipped ? { skippedVersion: normalizedSkipped } : {}),
  };
  if (storage) {
    try {
      storage.setItem(APP_UPDATE_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Best-effort local preference persistence
    }
  }
  return normalized;
}

export function shouldRunAutoUpdateCheck(
  prefs: AppUpdatePreferences,
  nowMs: number = Date.now(),
  cooldownMs: number = APP_UPDATE_CHECK_COOLDOWN_MS,
): boolean {
  if (!prefs.autoCheckEnabled) return false;
  if (typeof prefs.lastCheckedAtMs !== 'number' || !Number.isFinite(prefs.lastCheckedAtMs)) {
    return true;
  }
  return nowMs - prefs.lastCheckedAtMs >= cooldownMs;
}

export function shouldPromptUpdateModal(
  prefs: AppUpdatePreferences,
  remoteVersion: string,
  currentVersion: string,
): boolean {
  if (!isNewerVersion(remoteVersion, currentVersion)) return false;
  if (!prefs.skippedVersion) return true;
  return isNewerVersion(remoteVersion, prefs.skippedVersion);
}

/**
 * Formats release body text for display while stripping the machine-readable SHA-256 line.
 */
export function formatReleaseNotesForDisplay(notes: string): string {
  if (!notes) return '';
  return notes
    .split(/\r?\n/)
    .filter((line) => !/^\s*SHA-?256\s*[:：]\s*[0-9a-fA-F]{64}\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
