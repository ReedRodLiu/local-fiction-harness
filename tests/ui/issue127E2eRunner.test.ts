import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const runner = readFileSync(join(repoRoot, 'tests/e2e/issue-127-mode-intent.mjs'), 'utf8');

describe('#127 isolated browser runner', () => {
  it('runs inside verify:all without adding a second browser dependency', () => {
    expect(packageJson.devDependencies['playwright-core']).toBeUndefined();
    expect(packageJson.scripts['test:e2e:issue-127']).toBe(
      'node tests/e2e/issue-127-mode-intent.mjs',
    );

    const steps = packageJson.scripts['verify:all'].split(/\s*&&\s*/);
    expect(steps).toContain('npm run test:e2e:issue-127');
    expect(steps.indexOf('npm run test:e2e')).toBeLessThan(
      steps.indexOf('npm run test:e2e:issue-127'),
    );
  });

  it('reuses the existing Playwright and browser overrides', () => {
    expect(runner).toContain('process.env.PLAYWRIGHT_CORE_PATH');
    expect(runner).toContain('process.env.E2E_BROWSER_PATH');
    expect(runner).not.toContain("spawn('npx'");
  });
});
