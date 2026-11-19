import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const e2eSource = readFileSync(join(repoRoot, 'tests', 'e2e', 'run-e2e.mjs'), 'utf8');

describe('E2E semantic selectors', () => {
  it('does not couple tests to visual CSS class names', () => {
    const classBasedSelectors = [
      ...e2eSource.matchAll(/locator\((['"])\./g),
      ...e2eSource.matchAll(/querySelector\((['"])\./g),
    ];
    expect(classBasedSelectors).toHaveLength(0);
    for (const retiredSelector of [
      '.turn-card',
      '.story-item',
      '.story-select-btn',
      '.branch-pager',
      '.choice-btn',
      '.hud-panel',
      '.reasoning-details',
      '.reasoning-content',
      '.ds-session-item',
      '.error-banner',
      '.notice-box',
      '.story-tree-sibling',
      '.story-tree-gist',
      '.summary-progress',
    ]) {
      expect(e2eSource).not.toContain(retiredSelector);
    }
  });
});
