import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  auditApkArchive,
  auditApkSigningCertificate,
  auditManifestXml,
  auditNetworkSecurityConfigXml,
  auditReleaseArtifacts,
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

  it('supports dynamic packageId permission allowlisting and release debuggable/networkSecurityConfig manifest checks', () => {
    const e2eManifest = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application
          android:allowBackup="false"
          android:networkSecurityConfig="@xml/network_security_config"
          android:debuggable="true"></application>
        <uses-permission android:name="android.permission.INTERNET" />
        <uses-permission android:name="io.localfiction.harness.e2e.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
      </manifest>
    `;
    expect(() =>
      auditManifestXml(e2eManifest, {
        packageId: 'io.localfiction.harness.e2e',
        requireNetworkSecurityConfig: true,
      }),
    ).not.toThrow();

    expect(() =>
      auditManifestXml(e2eManifest, {
        packageId: 'io.localfiction.harness',
      }),
    ).toThrow(/io\.localfiction\.harness\.e2e\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION/);

    expect(() =>
      auditManifestXml(e2eManifest, {
        packageId: 'io.localfiction.harness.e2e',
        forbidDebuggable: true,
      }),
    ).toThrow(/debuggable/i);

    const missingNscManifest = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application android:allowBackup="false"></application>
      </manifest>
    `;
    expect(() =>
      auditManifestXml(missingNscManifest, {
        requireNetworkSecurityConfig: true,
      }),
    ).toThrow(/networkSecurityConfig/i);
  });

  it('validates strict release/smoke network_security_config.xml vs e2e loopback-only config', () => {
    const strictConfig = `<?xml version="1.0" encoding="utf-8"?>
      <network-security-config>
        <base-config cleartextTrafficPermitted="false">
          <trust-anchors>
            <certificates src="system" />
          </trust-anchors>
        </base-config>
      </network-security-config>
    `;
    const e2eConfig = `<?xml version="1.0" encoding="utf-8"?>
      <network-security-config>
        <base-config cleartextTrafficPermitted="false">
          <trust-anchors>
            <certificates src="system" />
          </trust-anchors>
        </base-config>
        <domain-config cleartextTrafficPermitted="true">
          <domain includeSubdomains="false">127.0.0.1</domain>
          <domain includeSubdomains="false">localhost</domain>
        </domain-config>
      </network-security-config>
    `;
    const externalCleartextConfig = `<?xml version="1.0" encoding="utf-8"?>
      <network-security-config>
        <base-config cleartextTrafficPermitted="false" />
        <domain-config cleartextTrafficPermitted="true">
          <domain includeSubdomains="false">api.example.com</domain>
        </domain-config>
      </network-security-config>
    `;
    const userCaConfig = `<?xml version="1.0" encoding="utf-8"?>
      <network-security-config>
        <base-config cleartextTrafficPermitted="false">
          <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
          </trust-anchors>
        </base-config>
      </network-security-config>
    `;

    expect(() =>
      auditNetworkSecurityConfigXml(strictConfig, { forbidCleartext: true }),
    ).not.toThrow();
    expect(() =>
      auditNetworkSecurityConfigXml(e2eConfig, { forbidCleartext: true }),
    ).toThrow(/cleartext|127\.0\.0\.1|domain-config/i);
    expect(() =>
      auditNetworkSecurityConfigXml(e2eConfig, { allowLoopbackOnly: true }),
    ).not.toThrow();
    expect(() =>
      auditNetworkSecurityConfigXml(externalCleartextConfig, { allowLoopbackOnly: true }),
    ).toThrow(/api\.example\.com/);
    expect(() =>
      auditNetworkSecurityConfigXml(userCaConfig, { forbidCleartext: true }),
    ).toThrow(/user/i);
  });

  it('enforces release APK checks for WebView debugging, remote server.url, debuggable manifest, and cleartext network config', () => {
    const cleanReleaseApk = zipSync({
      'AndroidManifest.xml': strToU8(
        '<manifest><application android:allowBackup="false" android:networkSecurityConfig="@xml/network_security_config" /></manifest>',
      ),
      'res/xml/network_security_config.xml': strToU8(
        '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>',
      ),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
    });

    const releaseOptions = {
      forbidDebuggable: true,
      forbidCleartextNetworkConfig: true,
      forbidWebViewDebugging: true,
      forbidRemoteServerUrl: true,
    };

    expect(() => auditApkArchive(cleanReleaseApk, [], releaseOptions)).not.toThrow();

    const webviewDebugApk = zipSync({
      'AndroidManifest.xml': strToU8(
        '<manifest><application android:allowBackup="false" /></manifest>',
      ),
      'res/xml/network_security_config.xml': strToU8(
        '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>',
      ),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({
          android: { webContentsDebuggingEnabled: true },
          plugins: { CapacitorHttp: { enabled: false } },
        }),
      ),
    });
    expect(() => auditApkArchive(webviewDebugApk, [], releaseOptions)).toThrow(
      /webContentsDebuggingEnabled/i,
    );

    const remoteUrlApk = zipSync({
      'AndroidManifest.xml': strToU8(
        '<manifest><application android:allowBackup="false" /></manifest>',
      ),
      'res/xml/network_security_config.xml': strToU8(
        '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>',
      ),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({
          server: { url: 'http://192.168.1.5:5173' },
          plugins: { CapacitorHttp: { enabled: false } },
        }),
      ),
    });
    expect(() => auditApkArchive(remoteUrlApk, [], releaseOptions)).toThrow(/server\.url/i);

    const cleartextApk = zipSync({
      'AndroidManifest.xml': strToU8(
        '<manifest><application android:allowBackup="false" /></manifest>',
      ),
      'res/xml/network_security_config.xml': strToU8(
        '<network-security-config><base-config cleartextTrafficPermitted="false" /><domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config></network-security-config>',
      ),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
    });
    expect(() => auditApkArchive(cleartextApk, [], releaseOptions)).toThrow(
      /cleartext|127\.0\.0\.1|domain-config/i,
    );

    const obfuscatedResourceReleaseApk = zipSync({
      'AndroidManifest.xml': strToU8(
        '<manifest><application android:allowBackup="false" /></manifest>',
      ),
      'res/8G.xml': strToU8(
        '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>',
      ),
      'assets/public/index.html': strToU8('<html></html>'),
      'assets/capacitor.config.json': strToU8(
        JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
      ),
    });
    expect(() =>
      auditApkArchive(obfuscatedResourceReleaseApk, [], releaseOptions),
    ).not.toThrow();
  });

  it('audits release build artifacts directory for merged manifest, network security config, and release APK', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lfh-release-audit-'));
    try {
      const writeFixture = (relPath: string, content: string | Uint8Array) => {
        const abs = path.join(tmpRoot, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      };

      const cleanManifest = `
        <manifest xmlns:android="http://schemas.android.com/apk/res/android">
          <application
            android:allowBackup="false"
            android:networkSecurityConfig="@xml/network_security_config" />
          <uses-permission android:name="android.permission.INTERNET" />
          <uses-permission android:name="io.localfiction.harness.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
        </manifest>
      `;
      const cleanNsc = `<?xml version="1.0" encoding="utf-8"?>
        <network-security-config>
          <base-config cleartextTrafficPermitted="false">
            <trust-anchors><certificates src="system" /></trust-anchors>
          </base-config>
        </network-security-config>
      `;
      const cleanApk = zipSync({
        'AndroidManifest.xml': strToU8(cleanManifest),
        'res/xml/network_security_config.xml': strToU8(cleanNsc),
        'assets/public/index.html': strToU8('<html></html>'),
        'assets/capacitor.config.json': strToU8(
          JSON.stringify({ plugins: { CapacitorHttp: { enabled: false } } }),
        ),
      });

      writeFixture(
        'android/app/src/main/res/xml/network_security_config.xml',
        cleanNsc,
      );
      writeFixture(
        'android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml',
        cleanManifest,
      );
      writeFixture(
        'android/app/build/outputs/apk/release/app-release-unsigned.apk',
        cleanApk,
      );

      const summary = auditReleaseArtifacts(tmpRoot, []);
      expect(summary.apkPath).toContain('app-release-unsigned.apk');
      expect(summary.signed).toBe(false);

      // Signed release APK triggers certificate verification
      fs.rmSync(
        path.join(tmpRoot, 'android/app/build/outputs/apk/release/app-release-unsigned.apk'),
      );
      writeFixture(
        'android/app/build/outputs/apk/release/Folio-v0.5.0-beta.1-release.apk',
        cleanApk,
      );
      const signedSummary = auditReleaseArtifacts(tmpRoot, [], {
        runCommand: (_cmd: string, args: string[]) => {
          expect(args).toContain('verify');
          expect(args).toContain('--print-certs');
          return [
            'Signer #1 certificate DN: CN=Folio Release, O=LocalFiction',
            'Signer #1 certificate SHA-256 digest: 0cce9656dcfcc439564f71418cce015c2cab428193a5654ad46670573b0a040d',
          ].join('\n');
        },
      });
      expect(signedSummary.apkPath).toContain('Folio-v0.5.0-beta.1-release.apk');
      expect(signedSummary.signed).toBe(true);
      expect(signedSummary.signingCertSha256).toBe(
        '0cce9656dcfcc439564f71418cce015c2cab428193a5654ad46670573b0a040d',
      );

      writeFixture(
        'android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml',
        cleanManifest.replace(
          'android:allowBackup="false"',
          'android:allowBackup="false" android:debuggable="true"',
        ),
      );
      expect(() => auditReleaseArtifacts(tmpRoot, [])).toThrow(/debuggable/i);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('verifies release APK signing certificate SHA-256 and rejects Android Debug or mismatched certs', () => {
    const validOutput = [
      'Signer #1 certificate DN: CN=Folio, OU=Release, O=Folio',
      'Signer #1 certificate SHA-256 digest: 0cce9656dcfcc439564f71418cce015c2cab428193a5654ad46670573b0a040d',
    ].join('\n');

    const cert = auditApkSigningCertificate({
      apkPath: '/tmp/Folio-v0.5.0-beta.1-release.apk',
      runCommand: (_cmd: string, args: string[]) => {
        expect(args).toEqual(['verify', '--print-certs', '/tmp/Folio-v0.5.0-beta.1-release.apk']);
        return validOutput;
      },
    });
    expect(cert.sha256).toBe('0cce9656dcfcc439564f71418cce015c2cab428193a5654ad46670573b0a040d');
    expect(cert.signed).toBe(true);

    expect(() =>
      auditApkSigningCertificate({
        apkPath: '/tmp/app-release.apk',
        runCommand: () =>
          [
            'Signer #1 certificate DN: CN=Android Debug, O=Android, C=US',
            'Signer #1 certificate SHA-256 digest: 0cce9656dcfcc439564f71418cce015c2cab428193a5654ad46670573b0a040d',
          ].join('\n'),
      }),
    ).toThrow(/Android Debug/i);

    expect(() =>
      auditApkSigningCertificate({
        apkPath: '/tmp/app-release.apk',
        runCommand: () =>
          [
            'Signer #1 certificate DN: CN=Wrong Cert',
            'Signer #1 certificate SHA-256 digest: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          ].join('\n'),
      }),
    ).toThrow(/SHA-256|mismatch/i);
  });
});
