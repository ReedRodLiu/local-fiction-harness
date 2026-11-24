import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const MAX_APK_BYTES = 20 * 1024 * 1024;
const ALLOWED_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'io.localfiction.harness.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
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

export function auditManifestXml(xmlText) {
  if (!/<application\b[^>]*\bandroid:allowBackup\s*=\s*"false"/i.test(xmlText)) {
    throw new Error('AndroidManifest.xml must keep android:allowBackup="false".');
  }
  if (/android:usesCleartextTraffic\s*=\s*"true"/i.test(xmlText)) {
    throw new Error('AndroidManifest.xml must not enable android:usesCleartextTraffic="true".');
  }
  const permMatches = xmlText.matchAll(/<uses-permission\b[^>]*android:name\s*=\s*"([^"]+)"/gi);
  for (const match of permMatches) {
    const perm = match[1];
    if (!ALLOWED_PERMISSIONS.has(perm)) {
      throw new Error(`Unexpected Android permission declared: ${perm}`);
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

export function auditApkArchive(apkBytes, secretValues = []) {
  if (apkBytes.byteLength === 0) {
    throw new Error('Debug APK archive is empty.');
  }
  if (apkBytes.byteLength > MAX_APK_BYTES) {
    throw new Error(`Debug APK size (${apkBytes.byteLength} bytes) exceeds 20 MB minimal ceiling.`);
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
  if (capConfig?.plugins?.CapacitorHttp?.enabled !== false) {
    throw new Error('APK capacitor.config.json must explicitly keep CapacitorHttp.enabled === false.');
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

export function runRepoArtifactAudit(rootDir = process.cwd()) {
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

  const sourceManifest = fs.readFileSync(
    path.join(rootDir, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  auditManifestXml(sourceManifest);

  const packagedManifestPath = path.join(
    rootDir,
    'android/app/build/intermediates/packaged_manifests/debug/processDebugManifestForPackage/AndroidManifest.xml',
  );
  if (!fs.existsSync(packagedManifestPath)) {
    throw new Error(`Packaged Debug manifest not found at ${packagedManifestPath}`);
  }
  auditManifestXml(fs.readFileSync(packagedManifestPath, 'utf8'));

  const apkPath = path.join(rootDir, 'android/app/build/outputs/apk/debug/app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    throw new Error(`Debug APK not found at ${apkPath}`);
  }
  const apkBytes = new Uint8Array(fs.readFileSync(apkPath));
  auditApkArchive(apkBytes, secretValues);

  return {
    distAssetCount: distFiles.length,
    syncedAssetCount: syncedFiles.length,
    apkBytes: apkBytes.byteLength,
    apkPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = runRepoArtifactAudit(process.cwd());
  const mb = (summary.apkBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `ARTIFACT_AUDIT_PASSED (dist=${summary.distAssetCount} files, synced=${summary.syncedAssetCount} files, apk=${mb} MB)`,
  );
}
