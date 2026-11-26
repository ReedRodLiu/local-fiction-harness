import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultPromptPackLibrary } from '../../src/harness/index.ts';
import { NarrativePresetQuickSheet } from '../../src/ui/NarrativePresetQuickSheet.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('Ticket #165: NarrativePresetQuickSheet prefixProtocol-aware continuity copy', () => {
  it('renders prefix-enhanced continuity copy for deepseek_beta and standard_assistant_prefill', () => {
    const library = createDefaultPromptPackLibrary();
    for (const prefixProtocol of ['deepseek_beta', 'standard_assistant_prefill'] as const) {
      const markup = renderToStaticMarkup(
        createElement(NarrativePresetQuickSheet, {
          open: true,
          library,
          promptPackMode: 'inherit',
          prefixCompletion: 'inherit',
          prefixProtocol,
          onPromptPackModeChange: vi.fn(),
          onPrefixCompletionChange: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      expect(markup).toContain('叙事连贯保护');
      expect(markup).toContain('前缀续写');
      expect(markup).not.toContain('防拒答');
      expect(markup).not.toContain('破甲');
      expect(markup).not.toContain('规避');
    }
  });

  it('renders standard multi-turn continuation copy when prefixProtocol is none', () => {
    const library = createDefaultPromptPackLibrary();
    const markup = renderToStaticMarkup(
      createElement(NarrativePresetQuickSheet, {
        open: true,
        library,
        promptPackMode: 'inherit',
        prefixCompletion: 'on_retry',
        prefixProtocol: 'none',
        onPromptPackModeChange: vi.fn(),
        onPrefixCompletionChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(markup).toContain('叙事连贯保护');
    expect(markup).toContain('中断或被拒时自动尝试标准续写衔接');
    expect(markup).not.toContain('每轮前缀续写');
    expect(markup).not.toContain('防拒答');
    expect(markup).not.toContain('破甲');
    expect(markup).not.toContain('规避');

    const source = readFileSync(join(repoRoot, 'src/ui/NarrativePresetQuickSheet.tsx'), 'utf8');
    expect(source).not.toContain('防拒答');
    expect(source).not.toContain('破甲');
  });
});
