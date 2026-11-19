import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const settingsSource = readFileSync(join(repoRoot, 'src', 'ui', 'SettingsPage.tsx'), 'utf8');

describe('display preference boot and production pruning', () => {
  it('applies stored appearance before the React module can render', () => {
    const bootScript = indexHtml.indexOf('lfh-display-boot-config');
    const moduleScript = indexHtml.indexOf('src="/src/main.tsx"');
    expect(bootScript).toBeGreaterThan(-1);
    expect(moduleScript).toBeGreaterThan(bootScript);
    expect(indexHtml).toContain('localStorage.getItem(config.themeStorageKey)');
    expect(indexHtml).toContain('localStorage.getItem(config.fontSizeStorageKey)');
    expect(indexHtml).toContain("document.documentElement.dataset.theme = theme");
  });

  it('guards the development proxy entry with Vite compile-time DEV', () => {
    expect(settingsSource).toContain('{import.meta.env.DEV && showDevTestProxy && (');
  });
});
