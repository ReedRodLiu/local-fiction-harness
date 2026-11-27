import type { ScenarioExecutionResult, SuiteRunContext } from './common.d.mts';

export interface SmokeEntitySnapshot {
  storyIds: string[];
  workIds: string[];
  characterIds: string[];
}

export interface SmokeEntityTracker {
  storyIds: Set<string>;
  workIds: Set<string>;
  characterIds: Set<string>;
}

export function snapshotSmokeEntities(ctx: SuiteRunContext): Promise<SmokeEntitySnapshot>;
export function deleteSmokeEntitiesByIds(
  ctx: SuiteRunContext,
  ids: {
    storyIds?: Iterable<string>;
    workIds?: Iterable<string>;
    characterIds?: Iterable<string>;
  },
): Promise<{ deleted: number }>;
export function runSmokeScenario(
  ctx: SuiteRunContext,
  scenarioId: string,
  tracker?: SmokeEntityTracker,
): Promise<ScenarioExecutionResult>;
