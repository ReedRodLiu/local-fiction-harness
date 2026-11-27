import type { AppWebViewSession } from '../android-driver/index.mjs';
import type { AdbRunner } from './common.d.mts';

export const DRY_RUN_DUMPSYS_WINDOW: string;

export interface DryRunHarness {
  serial: string;
  state: Record<string, unknown>;
  adbCalls: Array<{ cmd: string; args: string[] }>;
  evaluatedExpressions: string[];
  pmClearCalls: string[];
  screenrecordStarts: string[];
  deletedEntities: {
    storyIds: string[];
    workIds: string[];
    characterIds: string[];
  };
  adbRunner: AdbRunner;
  cdpFactory: (opts: {
    serial: string;
    packageId: string;
    runCommand: AdbRunner;
  }) => Promise<AppWebViewSession>;
}

export function createDryRunHarness(options?: {
  suite?: 'e2e' | 'smoke';
  packageId?: string;
  serial?: string;
  lockscreenProtected?: boolean;
  hasCustomProfile?: boolean;
  failScenario?: string;
}): DryRunHarness;
