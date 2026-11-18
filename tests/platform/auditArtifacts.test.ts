import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  auditApkArchive,
  auditManifestXml,
  auditTextAssets,
  extractEnvSecretValues,
} from '../../scripts/audit-artifacts.mjs';

describe('Offline artifact & minimal-permission audit', () => {
  it('extracts non-trivial secret values from .env.local content', () => {
    const secrets = extractEnvSecretValues(
      [
        '# comment',
        'VITE_TEST_API_KEY=sk-test-secret-123456',
        'VITE_TEST_BASE_URL=https://internal.example.com/v1',
        'VITE_TEST_MODEL=gpt',
        'EMPTY_VAR=',
      ].join('\n'),
    );
    expect(secrets).toContain('sk-test-secret-123456');
    expect(secrets).toContain('https://internal.example.com/v1');
    expect(secrets).not.toContain('gpt');
  });

  it('allows minimal INTERNET manifest and rejects extra permissions or allowBackup=true', () => {
    const cleanManifest = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application android:allowBackup="false"></application>
        <uses-permission android:name="android.permission.INTERNET" />
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
    expect(() => auditManifestXml(unsafeManifest)).toThrow(/allowBackup|READ_EXTERNAL_STORAGE/);
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
  });
});
