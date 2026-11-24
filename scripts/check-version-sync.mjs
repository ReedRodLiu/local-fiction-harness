import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Extracts `versionName` from `android/app/build.gradle`.
 */
export function extractAndroidVersionName(gradleText) {
  const match = /\bversionName\s+["']([^"']+)["']/.exec(gradleText);
  return match ? match[1].trim() : null;
}

/**
 * Verifies that `package.json` version and `android/app/build.gradle` versionName match.
 */
export function verifyVersionSync(rootDir = process.cwd()) {
  const pkgPath = path.join(rootDir, 'package.json');
  const gradlePath = path.join(rootDir, 'android/app/build.gradle');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const packageVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!packageVersion) {
    throw new Error('package.json is missing a valid version string.');
  }

  const gradleText = fs.readFileSync(gradlePath, 'utf8');
  const androidVersionName = extractAndroidVersionName(gradleText);
  if (!androidVersionName) {
    throw new Error('android/app/build.gradle is missing versionName.');
  }

  if (packageVersion !== androidVersionName) {
    throw new Error(
      `Version mismatch: package.json has "${packageVersion}" but android/app/build.gradle has versionName "${androidVersionName}".`,
    );
  }

  return { packageVersion, androidVersionName };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyVersionSync(process.cwd());
  console.log(`VERSION_SYNC_PASSED (version=${result.packageVersion})`);
}
