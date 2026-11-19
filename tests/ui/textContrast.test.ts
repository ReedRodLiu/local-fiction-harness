import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tokensCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'tokens.css'), 'utf8');
const baseCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'base.css'), 'utf8');
const shellCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'shell.css'), 'utf8');

function declarationsFor(selector: string, source: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return Object.fromEntries(
    Array.from(block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g), ([, property, value]) => [property, value.trim()]),
  );
}

function tokenName(value: string | undefined) {
  const match = /^var\(--([\w-]+)\)$/.exec(value ?? '');
  if (!match) throw new Error(`Expected a semantic color token, received ${value}`);
  return match[1];
}

function themeTokens(theme: 'light' | 'dark' | 'warm') {
  const selector = theme === 'light'
    ? /:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/
    : new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`);
  const block = selector.exec(tokensCss)?.[1];
  if (!block) throw new Error(`Missing ${theme} theme tokens`);
  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*(#[\da-f]{3,8}|rgba?\([^)]*\))/gi), ([, key, value]) => [key, value]),
  ) as Record<string, string>;
}

function channels(color: string) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const expanded = hex.length === 3
      ? [...hex].map((channel) => `${channel}${channel}`).join('')
      : hex.slice(0, 6);
    return [0, 2, 4].map((index) => parseInt(expanded.slice(index, index + 2), 16) / 255).concat(1);
  }
  const [red, green, blue, alpha = '1'] = color.match(/[\d.]+/g) ?? [];
  return [Number(red) / 255, Number(green) / 255, Number(blue) / 255, Number(alpha)];
}

function composite(background: string, surface: string) {
  const [red, green, blue, alpha] = channels(background);
  const [surfaceRed, surfaceGreen, surfaceBlue] = channels(surface);
  const compositeHex = [red, green, blue]
    .map((channel, index) => Math.round((channel * alpha + [surfaceRed, surfaceGreen, surfaceBlue][index] * (1 - alpha)) * 255)
      .toString(16).padStart(2, '0'))
    .join('');
  return `#${compositeHex}`;
}

function luminance(color: string) {
  const channelsRgb = channels(color).slice(0, 3);
  const linear = channelsRgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('small text color contrast', () => {
  it.each(['light', 'dark', 'warm'] as const)(
    '%s readable text and semantic status colors meet WCAG AA',
    (theme) => {
      const colors = themeTokens(theme);
      const backgrounds = [
        'bg-canvas',
        'bg-surface',
        'bg-surface-elevated',
        'bg-surface-hover',
        'bg-drawer',
        'bg-user-bubble',
      ];

      for (const foreground of ['text-muted', 'text-secondary']) {
        for (const background of backgrounds) {
          expect(
            contrastRatio(colors[foreground], colors[background]),
            `${theme} ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      const semanticPairs = [
        ['status-danger', 'status-danger-soft'],
        ['status-warn', 'status-warn-soft'],
        ['status-ok', 'bg-canvas'],
        ['accent-fiction', 'accent-fiction-soft'],
      ] as const;
      for (const [foreground, background] of semanticPairs) {
        const renderedBackground = composite(colors[background], colors['bg-canvas']);
        expect(
          contrastRatio(colors[foreground], renderedBackground),
          `${theme} ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      const activeRow = declarationsFor('.story-tree-sibling.active', baseCss);
      const badge = declarationsFor('.badge', shellCss);
      const activeBadge = declarationsFor('.story-tree-sibling.active .badge', baseCss);
      expect(activeRow.background).toBe('var(--bg-surface-hover)');
      expect(badge.background).toBe('var(--accent-fiction-soft)');
      expect(activeBadge.color).toBe('var(--text-primary)');

      const actualBadgeBackground = composite(
        colors[tokenName(badge.background)],
        colors[tokenName(activeRow.background)],
      );
      expect(
        contrastRatio(colors[tokenName(activeBadge.color)], actualBadgeBackground),
        `${theme} active StoryTree badge on its bg-surface-hover row`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
