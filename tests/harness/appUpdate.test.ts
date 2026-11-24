import { describe, expect, it } from 'vitest';
import {
  APP_UPDATE_CHECK_COOLDOWN_MS,
  compareSemver,
  extractSha256FromReleaseBody,
  formatReleaseNotesForDisplay,
  isNewerVersion,
  parseSemver,
  readUpdatePreferences,
  selectApkAssetFromRelease,
  selectLatestStableGiteeRelease,
  shouldPromptUpdateModal,
  shouldRunAutoUpdateCheck,
  writeUpdatePreferences,
  type KeyValueStorage,
} from '../../src/harness/index.ts';

function createMemoryKv(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}

describe('appUpdate pure harness helpers', () => {
  it('parses and compares SemVer strings with optional leading v', () => {
    expect(parseSemver('v0.3.0')).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
      prerelease: [],
      normalized: '0.3.0',
    });
    expect(parseSemver('V1.2.3-beta.2+build9')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', '2'],
      normalized: '1.2.3-beta.2',
    });
    expect(parseSemver('invalid')).toBeNull();

    expect(compareSemver('v0.3.1', '0.3.0')).toBe(1);
    expect(compareSemver('0.3.0', 'v0.3.0')).toBe(0);
    expect(compareSemver('0.3.0-rc.1', '0.3.0')).toBe(-1);
    expect(isNewerVersion('v0.4.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('v0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('v0.2.9', '0.3.0')).toBe(false);
  });

  it('extracts SHA-256 checksums and strips machine-readable SHA line for display', () => {
    const hash = '8F725A6A88AAB07E48DAAE0534B5228DE896679E070CEBC7FB6AF24B3D2CE1DD';
    const body = [
      'Folio Android V0.3.1 正式签名安装包。',
      '',
      `SHA-256: ${hash}`,
      '',
      '修复若干问题。',
    ].join('\n');

    expect(extractSha256FromReleaseBody(body)).toBe(hash.toLowerCase());
    expect(extractSha256FromReleaseBody('无哈希校验信息')).toBeUndefined();
    expect(formatReleaseNotesForDisplay(body)).toBe(
      'Folio Android V0.3.1 正式签名安装包。\n\n修复若干问题。',
    );
  });

  it('prefers -release.apk assets with HTTPS URLs and ignores non-APK or HTTP assets', () => {
    const selected = selectApkAssetFromRelease([
      {
        name: 'Folio-v0.3.1-debug.apk',
        browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-debug.apk',
      },
      {
        name: 'v0.3.1.zip',
        browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/archive/refs/tags/v0.3.1.zip',
      },
      {
        name: 'Folio-v0.3.1-release.apk',
        browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-release.apk',
      },
    ]);

    expect(selected).toEqual({
      apkName: 'Folio-v0.3.1-release.apk',
      apkUrl: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-release.apk',
    });

    expect(
      selectApkAssetFromRelease([
        {
          name: 'Folio-v0.3.1-release.apk',
          browser_download_url: 'http://insecure.example.com/app.apk',
        },
      ]),
    ).toBeNull();
  });

  it('filters out prereleases/drafts and picks the highest stable release', () => {
    const hash = '8f725a6a88aab07e48daae0534b5228de896679e070cebc7fb6af24b3d2ce1dd';
    const picked = selectLatestStableGiteeRelease([
      {
        tag_name: 'v0.4.0-beta.1',
        prerelease: true,
        name: 'Beta',
        body: 'preview',
        assets: [
          {
            name: 'Folio-v0.4.0-beta.1-release.apk',
            browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.4.0-beta.1/Folio.apk',
          },
        ],
      },
      {
        tag_name: 'v0.3.0',
        prerelease: false,
        name: 'Folio V0.3.0',
        body: 'older',
        assets: [
          {
            name: 'Folio-v0.3.0-release.apk',
            browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.0/Folio-v0.3.0-release.apk',
          },
        ],
      },
      {
        tag_name: 'v0.3.1',
        prerelease: false,
        name: 'Folio V0.3.1',
        body: `更新内容\nSHA-256: ${hash}`,
        created_at: '2026-11-25T10:00:00+08:00',
        assets: [
          {
            name: 'Folio-v0.3.1-release.apk',
            browser_download_url: 'https://gitee.com/liu-reed-rod/folio-android/releases/download/v0.3.1/Folio-v0.3.1-release.apk',
          },
        ],
      },
    ]);

    expect(picked).not.toBeNull();
    expect(picked?.version).toBe('0.3.1');
    expect(picked?.expectedSha256).toBe(hash);
    expect(picked?.releasePageUrl).toBe(
      'https://gitee.com/liu-reed-rod/folio-android/releases/tag/v0.3.1',
    );
  });

  it('enforces 24h auto-check cooldown, toggle, and skipped-version prompt gating', () => {
    const kv = createMemoryKv();
    const initial = readUpdatePreferences(kv);
    expect(initial.autoCheckEnabled).toBe(true);
    expect(shouldRunAutoUpdateCheck(initial, 10_000)).toBe(true);

    const saved = writeUpdatePreferences(kv, {
      autoCheckEnabled: true,
      lastCheckedAtMs: 1_000_000,
      skippedVersion: 'v0.3.1',
    });

    expect(shouldRunAutoUpdateCheck(saved, 1_000_000 + APP_UPDATE_CHECK_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldRunAutoUpdateCheck(saved, 1_000_000 + APP_UPDATE_CHECK_COOLDOWN_MS)).toBe(true);

    expect(shouldPromptUpdateModal(saved, '0.3.1', '0.3.0')).toBe(false);
    expect(shouldPromptUpdateModal(saved, '0.3.2', '0.3.0')).toBe(true);

    const disabled = writeUpdatePreferences(kv, { ...saved, autoCheckEnabled: false });
    expect(shouldRunAutoUpdateCheck(disabled, 999_999_999_999)).toBe(false);
  });
});
