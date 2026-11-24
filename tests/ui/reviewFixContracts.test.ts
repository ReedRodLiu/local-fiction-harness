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
      'creative.css',
      'settings.css',
      'diagnostics.css',
    ]) {
      expect(barrel).toContain(`./styles/${moduleName}`);
    }

    for (const component of [
      'App.tsx',
      'CompanionSheet.tsx',
      'SettingsPage.tsx',
      'ProposalCard.tsx',
    ]) {
      expect(readSource(`src/ui/${component}`), component).not.toMatch(
        /import\s+['"]\.\/styles\/[^'"]+\.css['"]/,
      );
    }
  });

  it('keeps drawer lifecycle in primitives, errors in BannerAlert, and V0.2 ProposalCard styles in base.css', () => {
    const drawer = readSource('src/ui/LibraryDrawer.tsx');
    expect(drawer).not.toContain('showModal()');
    expect(drawer).not.toContain('const closeMobile');
    expect(readSource('src/ui/DiagnosticsPreview.tsx')).toContain('<BannerAlert');
    expect(readSource('src/ui/DocumentDialog.tsx')).toContain('<BannerAlert');
    expect(readSource('src/ui/DraftPane.tsx')).toContain('<BannerAlert');
    expect(readSource('src/ui/ProposalCard.tsx')).toContain('proposal-card');
    expect(readSource('src/ui/styles/base.css')).toContain('.proposal-card');
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
      /\.badge\s*\{[^}]*background:\s*var\(--bg-surface-hover\);[^}]*color:\s*var\(--text-secondary\)/s,
    );
    expect(shell).toMatch(
      /\.branch-badge::after\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s,
    );
    expect(readSource('src/ui/styles/import-wizard.css')).toMatch(
      /\.overlay-page-progress-track span\s*\{[^}]*background:\s*var\(--text-secondary\)/s,
    );
  });

  it('keeps compact stage controls small while retaining 44px hit targets', () => {
    const playStage = readSource('src/ui/styles/play-stage.css');
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.reasoning-details summary\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*28px;/s,
    );
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.reasoning-details summary::after\s*\{[^}]*min-height:\s*44px;/s,
    );
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.hud-view-toggle\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*24px;/s,
    );
    expect(playStage).toMatch(
      /\.main-stage\.is-playing \.hud-view-toggle::after\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('keeps welcome and play composers on the same compact row geometry', () => {
    const shell = readSource('src/ui/styles/shell.css');
    expect(shell).toMatch(
      /\.composer\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*row;[^}]*width:\s*min\(100%,\s*68ch\);[^}]*background:\s*var\(--bg-surface\);/s,
    );
    expect(shell).toMatch(
      /\.composer textarea\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*26px;[^}]*padding:\s*4px 0;/s,
    );
    expect(shell).toMatch(
      /\.composer-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-height:\s*40px;[^}]*padding:\s*0;/s,
    );
    expect(shell).toMatch(
      /\.composer \.composer-send\s*\{[^}]*width:\s*40px;[^}]*min-width:\s*40px;[^}]*min-height:\s*40px;[^}]*border-radius:\s*50%;/s,
    );
  });

  it('allows local theme previews to inherit the matching token scope', () => {
    const tokens = readSource('src/ui/styles/tokens.css');
    expect(tokens).toContain('[data-theme="light"] {');
    expect(tokens).toContain('[data-theme="dark"] {');
    expect(tokens).toContain('[data-theme="warm"] {');
    expect(readSource('src/ui/SettingsPage.tsx')).toContain(
      "data-theme={option.value === 'system' ? 'light' : option.value}",
    );
  });

  it('keeps the story tree spine continuous without the legacy dashed branch rail', () => {
    const companionSheet = readSource('src/ui/styles/companion-sheet.css');
    expect(companionSheet).toMatch(
      /\.story-tree-spine::before\s*\{[^}]*left:\s*11px;[^}]*opacity:\s*1;/s,
    );
    expect(companionSheet).toMatch(
      /\.story-tree-spine-item::before\s*\{[^}]*left:\s*-24px;[^}]*width:\s*10px;[^}]*height:\s*10px;/s,
    );
    expect(companionSheet).toMatch(
      /\.story-tree-siblings\s*\{[^}]*border-inline-start:\s*0;[^}]*padding-inline-start:\s*0;/s,
    );
    expect(companionSheet).toMatch(/\.story-tree-connector\s*\{[^}]*display:\s*none;/s);
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

  it('keeps CharacterPane regeneration on the accepted public research reference', () => {
    const characterPane = readSource('src/ui/CharacterPane.tsx');
    const regenerateSource = characterPane.slice(
      characterPane.indexOf('const regenerateNode ='),
      characterPane.indexOf('const effectiveGenerationConfig'),
    );

    expect(regenerateSource).toContain('resolvePublicResearchForTurn');
    expect(regenerateSource).toContain('preferred: node.publicResearch');
    expect(regenerateSource).toContain('research.reference ?? undefined');
    expect(regenerateSource).toContain('...(research.reference ? { publicResearch: research.reference } : {})');
    expect(regenerateSource).toContain('...(research.failure ? { publicResearchFailure: research.failure } : {})');
    expect(regenerateSource).toContain('preferredResearch: node.publicResearch');
  });
});
