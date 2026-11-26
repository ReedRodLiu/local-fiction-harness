import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readStyle = (name: string) =>
  readFileSync(join(repoRoot, 'src', 'ui', 'styles', name), 'utf8');

function themeTokens(tokensCss: string, theme: 'light' | 'dark' | 'warm') {
  const selector =
    theme === 'light'
      ? /:root,\s*:root\[data-theme="light"\],\s*\[data-theme="light"\]\s*\{([^}]*)\}/
      : new RegExp(`:root\\[data-theme="${theme}"\\],\\s*\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`);
  const block = selector.exec(tokensCss)?.[1];
  if (!block) throw new Error(`Missing ${theme} theme tokens`);
  return Object.fromEntries(
    Array.from(
      block.matchAll(/--([\w-]+):\s*(#[\da-f]{3,8}|rgba?\([^)]*\))/gi),
      ([, key, value]) => [key, value],
    ),
  ) as Record<string, string>;
}

function channels(color: string) {
  const hex = color.slice(1);
  const expanded =
    hex.length === 3
      ? [...hex].map((channel) => `${channel}${channel}`).join('')
      : hex.slice(0, 6);
  return [0, 2, 4].map((index) => parseInt(expanded.slice(index, index + 2), 16) / 255);
}

function luminance(color: string) {
  const linear = channels(color).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function findRuleBlock(source: string, selectorPrefix: string) {
  const escaped = selectorPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(
    source.matchAll(new RegExp(`(?:^|[},\\s])${escaped}(?=[\\s,{])[^{]*\\{([^}]*)\\}`, 'gs')),
    (match) => match[1],
  );
  return matches.join('\n');
}

describe('Issue #99: tap highlight suppression, rounded hit targets, and :active feedback', () => {
  it('suppresses native WebView tap highlight across interactive controls', () => {
    const shellCss = readStyle('shell.css');
    const tapHighlightMatch = /([^{}]+)\{[^}]*-webkit-tap-highlight-color:\s*transparent\s*;[^}]*\}/s.exec(shellCss);
    expect(tapHighlightMatch, 'Expected a global -webkit-tap-highlight-color: transparent rule in shell.css').toBeTruthy();

    const selectors = tapHighlightMatch![1]
      .split(',')
      .map((item) => item.trim());
    for (const required of [
      'button',
      'summary',
      'a',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      'label',
    ]) {
      expect(selectors, `Missing ${required} in tap-highlight reset`).toContain(required);
    }
  });

  it('gives every expanded 44px ::after touch target a matching rounded border-radius', () => {
    const shellCss = readStyle('shell.css');
    const playStageCss = readStyle('play-stage.css');
    const creativeCss = readStyle('creative.css');

    const expanders: Array<{ file: string; source: string; selector: string }> = [
      { file: 'shell.css', source: shellCss, selector: '.branch-badge::after' },
      { file: 'shell.css', source: shellCss, selector: '.topbar-segment-btn::after' },
      { file: 'play-stage.css', source: playStageCss, selector: '.main-stage.is-playing .reasoning-details summary::after' },
      { file: 'play-stage.css', source: playStageCss, selector: '.main-stage.is-playing .hud-view-toggle::after' },
      { file: 'creative.css', source: creativeCss, selector: '.writing-ref-pill::after' },
    ];

    for (const { file, source, selector } of expanders) {
      const block = findRuleBlock(source, selector);
      expect(block, `${file}: missing rule for ${selector}`).not.toBe('');
      expect(block, `${file}: ${selector} must specify rounded border-radius`).toMatch(
        /border-radius:\s*var\(--radius-full\)/,
      );
    }
  });

  it('defines semantic :active tokens across light, dark, and warm themes with WCAG AA contrast', () => {
    const tokensCss = readStyle('tokens.css');
    for (const theme of ['light', 'dark', 'warm'] as const) {
      const tokens = themeTokens(tokensCss, theme);
      expect(tokens['bg-surface-active'], `${theme} --bg-surface-active`).toBeTruthy();
      expect(tokens['action-primary-active-bg'], `${theme} --action-primary-active-bg`).toBeTruthy();
      expect(tokens['accent-fiction-active'], `${theme} --accent-fiction-active`).toBeTruthy();

      expect(
        contrastRatio(tokens['text-secondary'], tokens['bg-surface-active']),
        `${theme} text-secondary on bg-surface-active`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokens['action-primary-fg'], tokens['action-primary-active-bg']),
        `${theme} action-primary-fg on action-primary-active-bg`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('provides subtle semantic-token :active press feedback on buttons and interactive pills', () => {
    const baseCss = readStyle('base.css');
    const shellCss = readStyle('shell.css');
    const libraryDrawerCss = readStyle('library-drawer.css');
    const playStageCss = readStyle('play-stage.css');
    const creativeCss = readStyle('creative.css');

    expect(shellCss).toMatch(/\.btn:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(shellCss).toMatch(/\.btn-primary:active:not\(:disabled\)\s*\{[^}]*var\(--action-primary-active-bg\)/s);
    expect(shellCss).toMatch(/\.icon-button:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(shellCss).toMatch(/\.branch-badge:active:not\(:disabled\)\s*\{[^}]*var\(--accent-fiction-active\)/s);
    expect(shellCss).toMatch(/\.topbar-segment-btn:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(libraryDrawerCss).toMatch(/\.library-categories button:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(baseCss).toMatch(/\.story-tree-span-toggle:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(playStageCss).toMatch(/\.main-stage\.is-playing \.choice-btn:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(playStageCss).toMatch(/\.main-stage\.is-playing \.reasoning-details summary:active\s*\{[^}]*var\(--bg-surface-active\)/s);
    expect(creativeCss).toMatch(/\.writing-enter-pill:active:not\(:disabled\)\s*\{[^}]*var\(--bg-surface-active\)/s);

    expect(shellCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*button:active[\s\S]*transform:\s*none/,
    );
  });

  it('aligns Story Tree toggle controls and links with rounded :focus-visible outlines', () => {
    const baseCss = readStyle('base.css');
    const playStageCss = readStyle('play-stage.css');

    const spanToggleBlock = findRuleBlock(baseCss, '.story-tree-span-toggle');
    expect(spanToggleBlock).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(baseCss).toMatch(/\.story-tree-span-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-fiction\)/s);
    expect(baseCss).toMatch(/a:focus-visible[^}]*outline:\s*2px solid var\(--accent-fiction\)/s);

    const hudCollapseBlock = findRuleBlock(playStageCss, '.main-stage.is-playing .hud-collapse-toggle');
    expect(hudCollapseBlock).toMatch(/border-radius:\s*50%/);
  });

  it('removes dead V0.1 welcome mode-pill and retired TopBar mode-switcher CSS rules from shell.css', () => {
    const shellCss = readStyle('shell.css');
    for (const deadSelector of [
      '.welcome-mode-controls',
      '.welcome-mode-pills',
      '.welcome-mode-pill',
      '.welcome-quick-actions',
      '.welcome-quick-pill',
      '.welcome-character-name',
      '.topbar-mode-switcher',
      '.topbar-mode-chip',
      '.topbar-mode-menu',
      '.topbar-mode-menu-item',
    ]) {
      expect(shellCss, `Dead selector ${deadSelector} should be removed`).not.toContain(deadSelector);
    }
  });
});
