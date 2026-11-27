import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const MAX_APK_BYTES = 20 * 1024 * 1024;
const DEFAULT_PACKAGE_ID = 'io.localfiction.harness';
const BASE_ALLOWED_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  // Active SSE stream dataSync ForegroundService + bounded PARTIAL_WAKE_LOCK keepalive (ADR-0005).
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
]);
const FORBIDDEN_ASSET_MARKERS = [
  '/__dev_llm_proxy',
  '/__dev_test_config',
  'x-use-dev-env-key',
  'VITE_TEST_API_KEY',
  'VITE_TEST_BASE_URL',
];
const FORBIDDEN_APK_PATH_PATTERNS = [
  /(^|\/)(lib)?(node|proot|busybox|bash|dash|ash|sh|dsh)(\.so)?$/i,
  /ubuntu/i,
  /(^|\/)\.env(\.[^/]+)?$/i,
];
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function extractEnvSecretValues(envText) {
  const secrets = [];
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!/(_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(key)) continue;
    const val = line.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (val.length >= 6) {
      secrets.push(val);
    }
  }
  return secrets;
}

export function auditManifestXml(xmlText, options = {}) {
  const packageId = options.packageId || DEFAULT_PACKAGE_ID;
  const forbidDebuggable = options.forbidDebuggable === true;
  const requireNetworkSecurityConfig = options.requireNetworkSecurityConfig === true;

  if (!/<application\b[^>]*\bandroid:allowBackup\s*=\s*"false"/i.test(xmlText)) {
    throw new Error('AndroidManifest.xml must keep android:allowBackup="false".');
  }
  if (/android:usesCleartextTraffic\s*=\s*"true"/i.test(xmlText)) {
    throw new Error('AndroidManifest.xml must not enable android:usesCleartextTraffic="true".');
  }
  if (
    requireNetworkSecurityConfig &&
    !/<application\b[^>]*\bandroid:networkSecurityConfig\s*=\s*"@xml\/network_security_config"/i.test(
      xmlText,
    )
  ) {
    throw new Error(
      'AndroidManifest.xml must declare android:networkSecurityConfig="@xml/network_security_config".',
    );
  }
  if (forbidDebuggable && /android:debuggable\s*=\s*"true"/i.test(xmlText)) {
    throw new Error('Release AndroidManifest.xml must not set android:debuggable="true".');
  }

  const dynamicReceiverPermission = `${packageId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
  const permMatches = xmlText.matchAll(/<uses-permission\b[^>]*android:name\s*=\s*"([^"]+)"/gi);
  for (const match of permMatches) {
    const perm = match[1];
    if (!BASE_ALLOWED_PERMISSIONS.has(perm) && perm !== dynamicReceiverPermission) {
      throw new Error(`Unexpected Android permission declared: ${perm}`);
    }
  }
}

export function auditNetworkSecurityConfigXml(xmlText, options = {}) {
  const allowLoopbackOnly = options.allowLoopbackOnly === true;
  const forbidCleartext = options.forbidCleartext !== false && !allowLoopbackOnly;

  if (!/<base-config\b[^>]*\bcleartextTrafficPermitted\s*=\s*"false"/i.test(xmlText)) {
    throw new Error(
      'network_security_config.xml must declare <base-config cleartextTrafficPermitted="false">.',
    );
  }
  if (/<certificates\b[^>]*\bsrc\s*=\s*"user"/i.test(xmlText)) {
    throw new Error('network_security_config.xml must not trust user-installed CA certificates.');
  }
  if (/<debug-overrides\b/i.test(xmlText)) {
    throw new Error('network_security_config.xml must not define <debug-overrides>.');
  }

  if (forbidCleartext) {
    if (/cleartextTrafficPermitted\s*=\s*"true"/i.test(xmlText)) {
      throw new Error('Strict network_security_config.xml must not enable cleartextTrafficPermitted="true".');
    }
    if (/<domain-config\b/i.test(xmlText) || /\b127\.0\.0\.1\b|\blocalhost\b/i.test(xmlText)) {
      throw new Error('Strict network_security_config.xml must not declare loopback or domain cleartext rules.');
    }
    return;
  }

  // Loopback-only mode (for e2e variant): every <domain-config> domain must be 127.0.0.1 or localhost without includeSubdomains="true".
  const domainMatches = [...xmlText.matchAll(/<domain\b([^>]*)>([^<]+)<\/domain>/gi)];
  for (const match of domainMatches) {
    const attrs = match[1] || '';
    const host = match[2].trim().toLowerCase();
    if (/includeSubdomains\s*=\s*"true"/i.test(attrs)) {
      throw new Error(`Loopback domain "${host}" must not set includeSubdomains="true".`);
    }
    if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
      throw new Error(`Disallowed cleartext domain in e2e network_security_config.xml: ${host}`);
    }
  }
}

export function auditTextAssets(files, secretValues = []) {
  for (const file of files) {
    for (const marker of FORBIDDEN_ASSET_MARKERS) {
      if (file.content.includes(marker)) {
        throw new Error(`Dev-only marker "${marker}" leaked into built asset: ${file.path}`);
      }
    }
    for (const secret of secretValues) {
      if (file.content.includes(secret)) {
        throw new Error(`Local .env secret value leaked into built asset: ${file.path}`);
      }
    }
  }
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function isBinaryAxml(bytes) {
  return (
    bytes.byteLength >= 8 &&
    readUint16LE(bytes, 0) === 0x0003 &&
    readUint16LE(bytes, 2) === 0x0008
  );
}

function extractAxmlStringPool(bytes) {
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = readUint16LE(bytes, offset);
    const chunkSize = readUint32LE(bytes, offset + 4);
    if (chunkSize < 8 || offset + chunkSize > bytes.byteLength) break;
    if (chunkType === 0x0001) {
      const stringCount = readUint32LE(bytes, offset + 8);
      const flags = readUint32LE(bytes, offset + 16);
      const stringsStart = readUint32LE(bytes, offset + 20);
      const isUtf8 = (flags & 0x0100) !== 0;
      const strings = [];
      for (let i = 0; i < stringCount; i++) {
        const relOffset = readUint32LE(bytes, offset + 28 + i * 4);
        let pos = offset + stringsStart + relOffset;
        if (pos >= offset + chunkSize) {
          strings.push('');
          continue;
        }
        if (isUtf8) {
          // Skip UTF-16 char length (1 or 2 bytes)
          if ((bytes[pos] & 0x80) !== 0) pos += 2;
          else pos += 1;
          let byteLen = bytes[pos++];
          if ((byteLen & 0x80) !== 0) {
            byteLen = ((byteLen & 0x7f) << 8) | bytes[pos++];
          }
          strings.push(strFromU8(bytes.subarray(pos, pos + byteLen)));
        } else {
          let charLen = readUint16LE(bytes, pos);
          pos += 2;
          if ((charLen & 0x8000) !== 0) {
            charLen = ((charLen & 0x7fff) << 16) | readUint16LE(bytes, pos);
            pos += 2;
          }
          let out = '';
          for (let c = 0; c < charLen && pos + 1 < bytes.byteLength; c++) {
            out += String.fromCharCode(readUint16LE(bytes, pos));
            pos += 2;
          }
          strings.push(out);
        }
      }
      return strings;
    }
    offset += chunkSize;
  }
  return [];
}

function hasBinaryManifestDebuggableTrue(bytes) {
  const strings = extractAxmlStringPool(bytes);
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = readUint16LE(bytes, offset);
    const chunkSize = readUint32LE(bytes, offset + 4);
    if (chunkSize < 8 || offset + chunkSize > bytes.byteLength) break;
    if (chunkType === 0x0102 && offset + 36 <= bytes.byteLength) {
      // ResXMLTree_attrExt starts at offset + 16
      const attrStart = readUint16LE(bytes, offset + 24);
      const attrSize = readUint16LE(bytes, offset + 26);
      const attrCount = readUint16LE(bytes, offset + 28);
      const attrsBase = offset + 16 + attrStart;
      for (let i = 0; i < attrCount; i++) {
        const attrOff = attrsBase + i * attrSize;
        if (attrOff + 20 > offset + chunkSize) break;
        const nameIdx = readUint32LE(bytes, attrOff + 4);
        const dataType = bytes[attrOff + 15];
        const data = readUint32LE(bytes, attrOff + 16);
        if (strings[nameIdx] === 'debuggable' && dataType === 0x12 && data !== 0) {
          return true;
        }
      }
    }
    offset += chunkSize;
  }
  return false;
}

function auditBinaryNetworkSecurityConfig(bytes) {
  const strings = extractAxmlStringPool(bytes);
  if (!strings.includes('base-config')) {
    throw new Error('Compiled network_security_config.xml missing base-config.');
  }
  for (const forbidden of ['domain-config', '127.0.0.1', 'localhost', 'debug-overrides', 'user']) {
    if (strings.includes(forbidden)) {
      throw new Error(
        `Release APK network_security_config.xml must not include "${forbidden}".`,
      );
    }
  }
}

export function auditCapacitorConfig(capConfig, options = {}) {
  if (capConfig?.plugins?.CapacitorHttp?.enabled !== false) {
    throw new Error('capacitor.config.json must explicitly keep CapacitorHttp.enabled === false.');
  }
  if (
    options.forbidWebViewDebugging &&
    (capConfig?.android?.webContentsDebuggingEnabled === true ||
      capConfig?.webContentsDebuggingEnabled === true)
  ) {
    throw new Error('capacitor.config.json must not enable webContentsDebuggingEnabled in release.');
  }
  if (
    options.forbidRemoteServerUrl &&
    typeof capConfig?.server?.url === 'string' &&
    capConfig.server.url.trim().length > 0
  ) {
    throw new Error('capacitor.config.json must not configure a remote server.url in release.');
  }
}

export function auditApkArchive(apkBytes, secretValues = [], options = {}) {
  if (apkBytes.byteLength === 0) {
    throw new Error('APK archive is empty.');
  }
  if (apkBytes.byteLength > MAX_APK_BYTES) {
    throw new Error(`APK size (${apkBytes.byteLength} bytes) exceeds 20 MB minimal ceiling.`);
  }

  const entries = unzipSync(apkBytes);
  const entryNames = Object.keys(entries);
  if (!entryNames.includes('assets/public/index.html')) {
    throw new Error('APK missing synced web asset: assets/public/index.html');
  }
  const capConfigBytes = entries['assets/capacitor.config.json'];
  if (!capConfigBytes) {
    throw new Error('APK missing assets/capacitor.config.json');
  }
  const capConfig = JSON.parse(strFromU8(capConfigBytes));
  auditCapacitorConfig(capConfig, {
    forbidWebViewDebugging: options.forbidWebViewDebugging === true,
    forbidRemoteServerUrl: options.forbidRemoteServerUrl === true,
  });

  if (options.forbidDebuggable) {
    const manifestBytes = entries['AndroidManifest.xml'];
    if (manifestBytes) {
      if (isBinaryAxml(manifestBytes)) {
        if (hasBinaryManifestDebuggableTrue(manifestBytes)) {
          throw new Error('Release APK AndroidManifest.xml must not set android:debuggable="true".');
        }
      } else {
        const manifestText = strFromU8(manifestBytes);
        if (/<manifest\b/i.test(manifestText)) {
          auditManifestXml(manifestText, {
            packageId: options.packageId,
            forbidDebuggable: true,
          });
        }
      }
    }
  }

  if (options.forbidCleartextNetworkConfig) {
    const directNscBytes = entries['res/xml/network_security_config.xml'];
    const nscCandidates = [];
    if (directNscBytes) {
      nscCandidates.push(directNscBytes);
    } else {
      for (const name of entryNames) {
        if (!/^res\/.*\.xml$/i.test(name)) continue;
        const candidateBytes = entries[name];
        if (isBinaryAxml(candidateBytes)) {
          if (extractAxmlStringPool(candidateBytes).includes('network-security-config')) {
            nscCandidates.push(candidateBytes);
          }
        } else if (/<network-security-config\b/i.test(strFromU8(candidateBytes))) {
          nscCandidates.push(candidateBytes);
        }
      }
    }
    if (nscCandidates.length === 0) {
      throw new Error('Release APK missing res/xml/network_security_config.xml.');
    }
    for (const nscBytes of nscCandidates) {
      if (isBinaryAxml(nscBytes)) {
        auditBinaryNetworkSecurityConfig(nscBytes);
      } else {
        auditNetworkSecurityConfigXml(strFromU8(nscBytes), { forbidCleartext: true });
      }
    }
  }

  for (const name of entryNames) {
    for (const pattern of FORBIDDEN_APK_PATH_PATTERNS) {
      if (pattern.test(name)) {
        throw new Error(`Forbidden runtime/secret entry packaged inside APK: ${name}`);
      }
    }
  }

  const textAssets = entryNames
    .filter((name) => name.startsWith('assets/public/') && /\.(html|js|css|json|txt)$/i.test(name))
    .map((name) => ({ path: name, content: strFromU8(entries[name]) }));
  auditTextAssets(textAssets, secretValues);
}

function collectTextFiles(dirPath, prefix = '') {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Expected directory does not exist: ${dirPath}`);
  }
  const collected = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const abs = path.join(dirPath, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collected.push(...collectTextFiles(abs, rel));
    } else {
      if (/^\.env(\.|$)/i.test(entry.name)) {
        throw new Error(`Forbidden env file found in built directory: ${rel}`);
      }
      if (/\.(html|js|css|json|txt)$/i.test(entry.name)) {
        collected.push({ path: rel, content: fs.readFileSync(abs, 'utf8') });
      }
    }
  }
  return collected;
}

function resolveReleaseApkPath(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    return null;
  }
  const files = fs.readdirSync(releaseDir).filter((name) => name.endsWith('.apk'));
  if (files.length === 0) {
    return null;
  }
  const preferred =
    files.find((name) => /^Folio-.*-release\.apk$/i.test(name)) ||
    files.find((name) => name === 'app-release.apk') ||
    files.find((name) => name === 'app-release-unsigned.apk') ||
    files[0];
  return path.join(releaseDir, preferred);
}

export function auditReleaseArtifacts(rootDir = process.cwd(), secretValues = []) {
  const mainNscPath = path.join(
    rootDir,
    'android/app/src/main/res/xml/network_security_config.xml',
  );
  if (!fs.existsSync(mainNscPath)) {
    throw new Error(`Missing main network_security_config.xml at ${mainNscPath}`);
  }
  auditNetworkSecurityConfigXml(fs.readFileSync(mainNscPath, 'utf8'), {
    forbidCleartext: true,
  });

  const releasePackagedManifestPath = path.join(
    rootDir,
    'android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml',
  );
  if (!fs.existsSync(releasePackagedManifestPath)) {
    throw new Error(`Release packaged manifest not found at ${releasePackagedManifestPath}`);
  }
  auditManifestXml(fs.readFileSync(releasePackagedManifestPath, 'utf8'), {
    packageId: DEFAULT_PACKAGE_ID,
    forbidDebuggable: true,
    requireNetworkSecurityConfig: true,
  });

  const releasePackagedNscPath = path.join(
    rootDir,
    'android/app/build/intermediates/packaged_res/release/packageReleaseResources/xml/network_security_config.xml',
  );
  if (fs.existsSync(releasePackagedNscPath)) {
    auditNetworkSecurityConfigXml(fs.readFileSync(releasePackagedNscPath, 'utf8'), {
      forbidCleartext: true,
    });
  }

  const capConfigPath = path.join(rootDir, 'android/app/src/main/assets/capacitor.config.json');
  if (fs.existsSync(capConfigPath)) {
    auditCapacitorConfig(JSON.parse(fs.readFileSync(capConfigPath, 'utf8')), {
      forbidWebViewDebugging: true,
      forbidRemoteServerUrl: true,
    });
  }

  const releaseApkPath = resolveReleaseApkPath(
    path.join(rootDir, 'android/app/build/outputs/apk/release'),
  );
  if (!releaseApkPath) {
    throw new Error(
      `Release APK not found in ${path.join(rootDir, 'android/app/build/outputs/apk/release')}`,
    );
  }
  const releaseApkBytes = new Uint8Array(fs.readFileSync(releaseApkPath));
  auditApkArchive(releaseApkBytes, secretValues, {
    packageId: DEFAULT_PACKAGE_ID,
    forbidDebuggable: true,
    forbidCleartextNetworkConfig: true,
    forbidWebViewDebugging: true,
    forbidRemoteServerUrl: true,
  });

  return {
    apkPath: releaseApkPath,
    apkBytes: releaseApkBytes.byteLength,
  };
}

export function runRepoArtifactAudit(rootDir = process.cwd(), options = {}) {
  const envPath = path.join(rootDir, '.env.local');
  const secretValues = fs.existsSync(envPath)
    ? extractEnvSecretValues(fs.readFileSync(envPath, 'utf8'))
    : [];

  const distFiles = collectTextFiles(path.join(rootDir, 'dist'));
  auditTextAssets(distFiles, secretValues);

  const syncedFiles = collectTextFiles(
    path.join(rootDir, 'android/app/src/main/assets/public'),
  );
  auditTextAssets(syncedFiles, secretValues);

  const capConfigPath = path.join(rootDir, 'android/app/src/main/assets/capacitor.config.json');
  if (fs.existsSync(capConfigPath)) {
    auditCapacitorConfig(JSON.parse(fs.readFileSync(capConfigPath, 'utf8')), {
      forbidWebViewDebugging: true,
      forbidRemoteServerUrl: true,
    });
  }

  const sourceManifest = fs.readFileSync(
    path.join(rootDir, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  auditManifestXml(sourceManifest, {
    packageId: DEFAULT_PACKAGE_ID,
    forbidDebuggable: true,
    requireNetworkSecurityConfig: true,
  });

  const mainNscPath = path.join(
    rootDir,
    'android/app/src/main/res/xml/network_security_config.xml',
  );
  if (!fs.existsSync(mainNscPath)) {
    throw new Error(`Default network_security_config.xml not found at ${mainNscPath}`);
  }
  auditNetworkSecurityConfigXml(fs.readFileSync(mainNscPath, 'utf8'), {
    forbidCleartext: true,
  });

  const e2eNscPath = path.join(
    rootDir,
    'android/app/src/e2e/res/xml/network_security_config.xml',
  );
  if (fs.existsSync(e2eNscPath)) {
    auditNetworkSecurityConfigXml(fs.readFileSync(e2eNscPath, 'utf8'), {
      allowLoopbackOnly: true,
    });
  }

  const packagedManifestPath = path.join(
    rootDir,
    'android/app/build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml',
  );
  if (!fs.existsSync(packagedManifestPath)) {
    throw new Error(`Packaged Debug manifest not found at ${packagedManifestPath}`);
  }
  auditManifestXml(fs.readFileSync(packagedManifestPath, 'utf8'), {
    packageId: DEFAULT_PACKAGE_ID,
    requireNetworkSecurityConfig: true,
  });

  const variantManifestChecks = [
    {
      packageId: `${DEFAULT_PACKAGE_ID}.e2e`,
      manifestPath: path.join(
        rootDir,
        'android/app/build/intermediates/packaged_manifests/e2e/processE2eManifestForPackage/AndroidManifest.xml',
      ),
    },
    {
      packageId: `${DEFAULT_PACKAGE_ID}.smoke`,
      manifestPath: path.join(
        rootDir,
        'android/app/build/intermediates/packaged_manifests/smoke/processSmokeManifestForPackage/AndroidManifest.xml',
      ),
    },
  ];
  for (const variant of variantManifestChecks) {
    if (fs.existsSync(variant.manifestPath)) {
      auditManifestXml(fs.readFileSync(variant.manifestPath, 'utf8'), {
        packageId: variant.packageId,
        requireNetworkSecurityConfig: true,
      });
    }
  }

  const apkPath = path.join(rootDir, 'android/app/build/outputs/apk/debug/app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    throw new Error(`Debug APK not found at ${apkPath}`);
  }
  const apkBytes = new Uint8Array(fs.readFileSync(apkPath));
  auditApkArchive(apkBytes, secretValues, {
    packageId: DEFAULT_PACKAGE_ID,
    forbidWebViewDebugging: true,
    forbidRemoteServerUrl: true,
  });

  const releaseManifestExists = fs.existsSync(
    path.join(
      rootDir,
      'android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml',
    ),
  );
  const releaseApkExists = Boolean(
    resolveReleaseApkPath(path.join(rootDir, 'android/app/build/outputs/apk/release')),
  );
  const releaseSummary =
    options.requireRelease === true || releaseManifestExists || releaseApkExists
      ? auditReleaseArtifacts(rootDir, secretValues)
      : undefined;

  return {
    distAssetCount: distFiles.length,
    syncedAssetCount: syncedFiles.length,
    apkBytes: apkBytes.byteLength,
    apkPath,
    ...(releaseSummary ? { release: releaseSummary } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = runRepoArtifactAudit(process.cwd());
  const mb = (summary.apkBytes / (1024 * 1024)).toFixed(2);
  const releaseNote = summary.release
    ? `, release=${(summary.release.apkBytes / (1024 * 1024)).toFixed(2)} MB`
    : '';
  console.log(
    `ARTIFACT_AUDIT_PASSED (dist=${summary.distAssetCount} files, synced=${summary.syncedAssetCount} files, apk=${mb} MB${releaseNote})`,
  );
}
