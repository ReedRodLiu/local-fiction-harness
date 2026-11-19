import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readSource = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

function exactFocusSelectors(source: string) {
  return Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(([, , declarations]) => declarations.includes(':focus-visible') || declarations.includes('outline'))
    .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim()))
    .filter((selector) => selector.includes(':focus-visible'));
}

describe('UI review fix contracts', () => {
  it('loads every presentation module through the stylesheet barrel', () => {
    const barrel = readSource('src/ui/styles.css');
    for (const moduleName of [
      'play-stage.css',
      'companion-sheet.css',
      'story-blueprint-card.css',
      'settings.css',
      'diagnostics.css',
    ]) {
      expect(barrel).toContain(`./styles/${moduleName}`);
    }

    for (const component of [
      'App.tsx',
      'CompanionSheet.tsx',
      'SettingsPage.tsx',
      'StoryBlueprintCard.tsx',
    ]) {
      expect(readSource(`src/ui/${component}`), component).not.toMatch(
        /import\s+['"]\.\/styles\/[^'"]+\.css['"]/,
      );
    }
  });

  it('keeps drawer lifecycle in primitives and errors in BannerAlert', () => {
    const drawer = readSource('src/ui/LibraryDrawer.tsx');
    expect(drawer).not.toContain('showModal()');
    expect(drawer).not.toContain('const closeMobile');
    expect(readSource('src/ui/DiagnosticsPreview.tsx')).toContain('<BannerAlert');
    expect(readSource('src/ui/StoryBlueprintCard.tsx')).toContain('<BannerAlert');
  });

  it('uses renderable icons and neutral tokens outside story structure', () => {
    for (const sourcePath of [
      'src/ui/App.tsx',
      'src/ui/TopBar.tsx',
      'src/ui/StoryTree.tsx',
      'src/ui/DeepSeekImportPanel.tsx',
    ]) {
      expect(readSource(sourcePath), sourcePath).not.toMatch(/[✦⑂]/);
    }

    const shell = readSource('src/ui/styles/shell.css');
    expect(shell).toMatch(
      /\.library-brand-icon\s*\{[^}]*color:\s*var\(--text-secondary\)/s,
    );
    expect(shell).toMatch(
      /\.welcome-mark\s*\{[^}]*background:\s*var\(--bg-surface\);[^}]*color:\s*var\(--text-secondary\)/s,
    );
    expect(shell).toMatch(
      /\.badge\s*\{[^}]*background:\s*var\(--bg-surface-hover\);[^}]*color:\s*var\(--text-secondary\)/s,
    );
    expect(readSource('src/ui/styles/import-wizard.css')).toMatch(
      /\.overlay-page-progress-track span\s*\{[^}]*background:\s*var\(--text-secondary\)/s,
    );
  });

  it('meets the 44px target for compact stage controls', () => {
    const playStage = readSource('src/ui/styles/play-stage.css');
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.reasoning-details summary\s*\{[^}]*min-height:\s*44px/s,
    );
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.hud-view-toggle\s*\{[^}]*min-height:\s*44px/s,
    );
  });

  it('boots display preferences from the same source used by React', () => {
    const preferences = readSource('src/ui/displayPreferences.ts');
    const indexHtml = readSource('index.html');
    expect(preferences).toContain('DISPLAY_BOOT_CONFIG');
    expect(indexHtml).toContain('lfh-display-boot-config');
    expect(indexHtml).not.toMatch(/\[\s*'system',\s*'light',\s*'dark',\s*'warm'\s*\]/);
    expect(indexHtml).not.toMatch(/\[\s*14,\s*16,\s*18,\s*20\s*\]/);
  });

  it('keeps legacy base component rules out of the rebuilt shell cascade', () => {
    const base = readSource('src/ui/styles/base.css');
    for (const selector of [
      '.main-stage',
      '.timeline',
      '.turn-card',
      '.reasoning-details',
      '.composer',
      '.story-list',
      '.btn-primary',
    ]) {
      expect(base).not.toMatch(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'm'));
    }
  });

  it('defines shared keyboard focus treatment for buttons and summaries once', () => {
    const selectors = exactFocusSelectors(
      `${readSource('src/ui/styles/base.css')}\n${readSource('src/ui/styles/shell.css')}`,
    );
    expect(selectors.filter((selector) => selector === 'button:focus-visible')).toHaveLength(1);
    expect(selectors.filter((selector) => selector === 'summary:focus-visible')).toHaveLength(1);
  });

  it('keeps App state and history wiring in focused presentation hooks', () => {
    const app = readSource('src/ui/App.tsx');
    expect(app).toContain("from './useDisplayPreferences.ts'");
    expect(app).toContain("from './useAppOverlayHistory.ts'");
    expect(app).toContain("from './usePresentationOverlayState.ts'");
    expect(app).not.toContain('useState<DisplayPreferences>');
    expect(app).not.toContain('applyDisplayPreferences(');
    expect(app).not.toContain('useWebHistoryLayer(');
  });
});
