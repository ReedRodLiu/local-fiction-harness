import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
};

describe('default verification gate', () => {
  it('runs the UI-IMPL-05 development and built-production suites in order', () => {
    expect(packageJson.scripts['test:ui-impl-05:dev']).toBe(
      'LFH_UI_IMPL_05_ONLY=1 node tests/e2e/run-e2e.mjs',
    );
    expect(packageJson.scripts['test:ui-impl-05:production']).toBe(
      'LFH_E2E_PRODUCTION=1 LFH_UI_IMPL_05_PRODUCTION_ONLY=1 node tests/e2e/run-e2e.mjs',
    );

    const steps = packageJson.scripts['verify:all'].split(/\s*&&\s*/);
    expect(steps).toContain('npm run test:ui-impl-05:dev');
    expect(steps).toContain('npm run test:ui-impl-05:production');
    expect(steps.indexOf('npm run build')).toBeLessThan(
      steps.indexOf('npm run test:ui-impl-05:production'),
    );
    expect(packageJson.scripts['test:ui-impl-05:dev']).not.toContain('verify:all');
    expect(packageJson.scripts['test:ui-impl-05:production']).not.toContain('verify:all');
  });
});
