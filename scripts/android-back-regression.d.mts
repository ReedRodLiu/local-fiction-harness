export interface LauncherEvidence {
  activityTopResumed: boolean;
  launcherTopResumed: boolean;
  focusSamples: readonly string[];
  stableAfterMs: number;
  hierarchy: string;
  screenshotSha256: string;
  previousAppScreenshotSha256?: string;
}

export function evaluateLauncherEvidence(
  evidence: LauncherEvidence,
  appPackage?: string,
): {
  valid: boolean;
  failures: string[];
};

export function installApkForCleanRun(options: {
  serial: string;
  apkPath: string;
  runCommand?: (
    command: string,
    args: string[],
    options?: { allowFailure?: boolean },
  ) => string;
}): {
  packageWasInstalled: boolean;
  existingPath: string | null;
  installOutput: string;
  clearOutput: string;
  installedPath: string;
};
