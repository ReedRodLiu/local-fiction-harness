import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const shellCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'shell.css'), 'utf8');
const importWizardCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'import-wizard.css'), 'utf8');
const exitFallback = readFileSync(join(repoRoot, 'src', 'ui', 'primitives', 'waitForExitAnimation.ts'), 'utf8');

describe('older WebView shell compatibility', () => {
  it('bounds the sheet with vh fallbacks and uses an explicit expanded state', () => {
    expect(shellCss).toMatch(/\.sheet-dialog\s*\{[^}]*height:\s*74vh;[^}]*height:\s*74dvh;[^}]*max-height:\s*92vh;[^}]*max-height:\s*92dvh;/s);
    expect(shellCss).toMatch(/\.sheet-dialog\.is-expanded\s*\{[^}]*height:\s*92vh;[^}]*height:\s*92dvh;/s);
    expect(shellCss).toMatch(/\.sheet-dialog\.is-expanded\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s);
    expect(shellCss).not.toMatch(/:has\s*\(/);
  });

  it('transitions native dialogs and waits for exit animations with a timeout fallback', () => {
    expect(shellCss).toMatch(/\.modal-dialog,\s*\.sheet-dialog\s*\{[^}]*transition:\s*opacity[^;]*transform/s);
    expect(shellCss).toContain('transition: opacity 180ms ease, transform 180ms ease, height 180ms ease;');
    expect(shellCss).toContain('@supports (transition-behavior: allow-discrete)');
    expect(shellCss).toContain('.sheet-dialog[data-closing="true"]');
    expect(shellCss).toContain('.library-dialog[data-closing="true"] .library-dialog-sheet');
    expect(exitFallback).toContain('element.getAnimations()');
    expect(exitFallback).toContain('setTimeout(finish, EXIT_FALLBACK_MS)');
  });

  it('provides a vh fallback before every dynamic viewport height in import wizards', () => {
    expect(importWizardCss).toMatch(
      /\.overlay-page-shell\[data-has-footer='true'\]\s*\{[^}]*height:\s*calc\(100vh - 32px - var\(--safe-area-bottom\)\);[^}]*height:\s*calc\(100dvh - 32px - var\(--safe-area-bottom\)\);/s,
    );
    expect(importWizardCss).toMatch(
      /@media \(max-width: 560px\)\s*\{[^}]*\.overlay-page-shell\[data-has-footer='true'\]\s*\{[^}]*height:\s*calc\(100vh - 26px - var\(--safe-area-bottom\)\);[^}]*height:\s*calc\(100dvh - 26px - var\(--safe-area-bottom\)\);/s,
    );
  });
});
