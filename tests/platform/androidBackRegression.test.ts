import { describe, expect, it } from 'vitest';
import {
  installApkForCleanRun,
  evaluateLauncherEvidence,
} from '../../scripts/android-back-regression.mjs';

const APP_PACKAGE = 'io.localfiction.harness';

describe('Android back regression Launcher evidence', () => {
  it('accepts only stable Launcher evidence that differs from the previous app frame', () => {
    const evidence = {
      activityTopResumed: false,
      launcherTopResumed: true,
      focusSamples: [
        'mCurrentFocus=Window{42 u0 com.android.launcher3/.Launcher}',
        'mCurrentFocus=Window{42 u0 com.android.launcher3/.Launcher}',
      ],
      stableAfterMs: 400,
      hierarchy: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<hierarchy rotation="0">',
        '  <node package="com.android.launcher3" text="Apps" />',
        '</hierarchy>',
      ].join('\n'),
      screenshotSha256: 'launcher-frame',
      previousAppScreenshotSha256: 'app-frame',
    };

    expect(evaluateLauncherEvidence(evidence, APP_PACKAGE)).toEqual({
      valid: true,
      failures: [],
    });
  });

  it('rejects app content, focus churn, a short wait, or a reused app frame', () => {
    const evidence = {
      activityTopResumed: false,
      launcherTopResumed: true,
      focusSamples: [
        'mCurrentFocus=Window{42 u0 com.android.launcher3/.Launcher}',
        `mCurrentFocus=Window{43 u0 ${APP_PACKAGE}/.MainActivity}`,
      ],
      stableAfterMs: 100,
      hierarchy: `<hierarchy><node package="${APP_PACKAGE}" text="合成回归故事" /></hierarchy>`,
      screenshotSha256: 'same-frame',
      previousAppScreenshotSha256: 'same-frame',
    };

    const result = evaluateLauncherEvidence(evidence, APP_PACKAGE);

    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([
      'window or focus did not remain Launcher-stable',
      'Launcher evidence window was shorter than 300 ms',
      'uiautomator hierarchy still contains app content',
      'Launcher screenshot matches the previous app screenshot',
    ]);
  });

  it('rejects a non-Launcher top task even when the app left the foreground', () => {
    const result = evaluateLauncherEvidence({
      activityTopResumed: false,
      launcherTopResumed: false,
      focusSamples: [
        'mCurrentFocus=Window{42 u0 com.android.systemui/.Keyguard}',
        'mCurrentFocus=Window{42 u0 com.android.systemui/.Keyguard}',
      ],
      stableAfterMs: 400,
      hierarchy: '<hierarchy><node package="com.android.systemui" /></hierarchy>',
      screenshotSha256: 'launcher-frame',
      previousAppScreenshotSha256: 'app-frame',
    }, APP_PACKAGE);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('Launcher home task is not top-resumed');
  });

  it('installs an absent package before the only pre-launch data clear', () => {
    const commands: string[] = [];
    let packagePathChecks = 0;
    const outputs = new Map([
      ['shell am force-stop io.localfiction.harness', ''],
      ['install -r -t /tmp/app-debug.apk', 'Success'],
      ['shell pm clear io.localfiction.harness', 'Success'],
    ]);
    const install = installApkForCleanRun({
      serial: 'emulator-5554',
      apkPath: '/tmp/app-debug.apk',
      runCommand: (_command: string, args: string[]) => {
        const key = args.slice(2).join(' ');
        commands.push(key);
        if (key === 'shell pm path io.localfiction.harness') {
          packagePathChecks += 1;
          return packagePathChecks === 1 ? '' : 'package:/data/app/base.apk';
        }
        return outputs.get(key) ?? '';
      },
    });

    const installIndex = commands.indexOf('install -r -t /tmp/app-debug.apk');
    const clearIndexes = commands.flatMap((command, index) =>
      command === 'shell pm clear io.localfiction.harness' ? [index] : [],
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(clearIndexes).toEqual([installIndex + 1]);
    expect(install).toMatchObject({
      packageWasInstalled: false,
      clearOutput: 'Success',
      installedPath: 'package:/data/app/base.apk',
    });
  });
});
