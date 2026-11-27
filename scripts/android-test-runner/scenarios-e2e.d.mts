import type { ScenarioExecutionResult, SuiteRunContext } from './common.d.mts';

export function runE2eScenario(
  ctx: SuiteRunContext,
  scenarioId: string,
): Promise<ScenarioExecutionResult>;
