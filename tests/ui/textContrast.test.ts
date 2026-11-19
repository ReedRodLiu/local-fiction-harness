import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tokensCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'tokens.css'), 'utf8');

function themeTokens(theme: 'light' | 'dark' | 'warm') {
  const selector = theme === 'light'
    ? /:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/
    : new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`);
  const block = selector.exec(tokensCss)?.[1];
  if (!block) throw new Error(`Missing ${theme} theme tokens`);
  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi), ([, key, value]) => [key, value]),
  ) as Record<string, string>;
}

function luminance(hex: string) {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255);
  const linear = channels.map((channel) =>
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
    '%s muted and secondary text meet WCAG AA on app surfaces',
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
    },
  );
});
