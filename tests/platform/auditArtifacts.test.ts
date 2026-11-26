import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  auditApkArchive,
  auditManifestXml,
  auditTextAssets,
  extractEnvSecretValues,
} from '../../scripts/audit-artifacts.mjs';
import {
  extractAndroidVersionName,
  verifyVersionSync,
} from '../../scripts/check-version-sync.mjs';

describe('Offline artifact & minimal-permission audit', () => {
  it('extracts only secret/key/token/password values from .env.local content', () => {
    const secrets = extractEnvSecretValues(
      [
        '# comment',
        'VITE_TEST_API_KEY=sk-test-secret-123456',
        'VITE_TEST_BASE_URL=https://api.deepseek.com',
        'VITE_TEST_MODEL=deepseek-chat',
        'EMPTY_KEY=',
      ].join('\n'),
    );
    expect(secrets).toEqual(['sk-test-secret-123456']);
  });

  it('allows minimal INTERNET, REQUEST_INSTALL_PACKAGES, and SSE foreground-service keepalive permissions and rejects extra permissions or allowBackup=true', () => {
    const cleanManifest = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application android:allowBackup="false"></application>
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
        <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
        <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
        <uses-permission android:name="android.permission.WAKE_LOCK" />
        <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
      </manifest>
    `;
    expect(() => auditManifestXml(cleanManifest)).not.toThrow();

    const unsafeManifest = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application android:allowBackup="true"></application>
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
      </manifest>
    `;
    expect(() => auditManifestXml(unsafeManifest)).toThrow(/allowBackup/);
    expect(() =>
      auditManifestXml(unsafeManifest.replace('allowBackup="true"', 'allowBackup="false"')),
    ).toThrow(/READ_EXTERNAL_STORAGE/);
  });

  it('rejects a manifest that leaves application backup enabled by default', () => {
    expect(() => auditManifestXml('<manifest><application /></manifest>')).toThrow(/allowBackup/);
  });

  it('rejects leaked .env.local secrets or dev-proxy markers in built assets', () => {
    expect(() =>
      auditTextAssets(
        [{ path: 'assets/index.js', content: 'console.log("clean production app");' }],
        ['sk-test-secret-123456'],
      ),
    ).not.toThrow();

    expect(() =>
      auditTextAssets(
        [{ path: 'assets/index.js', content: 'const k="sk-test-secret-123456";' }],
        ['sk-test-secret-123456'],
      ),
    ).toThrow(/secret/i);

    expect(() =>
      auditTextAssets(
        [{ path: 'assets/index.js', content: 'fetch("/__dev_test_config")' }],
        [],
      ),
    ).toThrow(/__dev_test_config/);
  });

  it('validates APK archive size, CapacitorHttp=false, and rejects forbidden runtime binaries', () => {
    const cleanApk = zipSync({
      'AndroidManifest.xml': strToU8('binary-manifest'),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/public/assets/app.js': strToU8('console.log("ok");'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
    });
    expect(() => auditApkArchive(cleanApk, ['sk-test-secret-123456'])).not.toThrow();

    const bloatedNodeApk = zipSync({
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
      'lib/arm64-v8a/libnode.so': strToU8('elf'),
    });
    expect(() => auditApkArchive(bloatedNodeApk, [])).toThrow(/libnode\.so/);

    const shellApk = zipSync({
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
      'assets/bin/sh': strToU8('#!/bin/sh'),
    });
    expect(() => auditApkArchive(shellApk, [])).toThrow(/bin\/sh/);
  });

  it('extracts Android versionName and verifies package.json <-> build.gradle version sync', () => {
    expect(extractAndroidVersionName('versionCode 3\nversionName "0.3.0"\n')).toBe('0.3.0');
    expect(extractAndroidVersionName("versionName '1.2.3'")).toBe('1.2.3');
    const sync = verifyVersionSync(process.cwd());
    expect(sync.packageVersion).toBe(sync.androidVersionName);
  });
});
