import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from '../../src/harness/index.ts';
import {
  GenerationControls,
  mergeGenerationPreference,
} from '../../src/ui/GenerationControls.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readSource = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

describe('Issue #109 Slice 2: Reusable GenerationControls double-row composer toolbar', () => {
  it('renders Flash/Pro 2-way selector, 4-stop thinking slider (关闭 / 低 / 高 / 极限), and optional leading/trailing slots', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        leadingSlot: createElement('button', { type: 'button', 'data-testid': 'welcome-plus-menu-trigger' }, '+'),
        trailingSlot: createElement('button', { type: 'submit', 'data-testid': 'send-btn' }, '发送'),
      }),
    );

    expect(markup).toContain('data-testid="composer-generation-controls"');
    expect(markup).toContain('data-testid="welcome-plus-menu-trigger"');
    expect(markup).toContain('data-testid="send-btn"');
    expect(markup).toContain('data-testid="composer-model-deepseek-flash"');
    expect(markup).toContain('data-testid="composer-model-deepseek-v4-pro"');
    expect(markup).toContain('日常轻量');
    expect(markup).toContain('Flash');
    expect(markup).toContain('旗舰深度');
    expect(markup).toContain('Pro');
    expect(markup).toMatch(/data-testid="composer-model-deepseek-flash"[^>]*aria-pressed="true"/);
    expect(markup).toMatch(/data-testid="composer-model-deepseek-v4-pro"[^>]*aria-pressed="false"/);
    expect(markup).not.toContain('data-testid="composer-pro-cost-hint"');

    expect(markup).toContain('data-testid="composer-reasoning-slider"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-none"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-low"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-high"');
    expect(markup).toContain('data-testid="composer-reasoning-stop-max"');
    expect(markup).toContain('关闭');
    expect(markup).toContain('低');
    expect(markup).toContain('高');
    expect(markup).toContain('极限');
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-high"[^>]*aria-pressed="true"/);
  });

  it('shows inline non-blocking Pro cost hint when deepseek-v4-pro is selected', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }),
    );

    expect(markup).toMatch(/data-testid="composer-model-deepseek-v4-pro"[^>]*aria-pressed="true"/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-max"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="composer-pro-cost-hint"');
    expect(markup).toContain('3–4 倍');
  });

  it('disables model toggle and thinking slider/stops during streaming while leaving trailing stop slot enabled', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationControls, {
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
        disabled: true,
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
        trailingSlot: createElement('button', { type: 'button', 'aria-label': '停止生成' }, '停止'),
      }),
    );

    expect(markup).toMatch(/<button[^>]*data-testid="composer-model-deepseek-flash"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*data-testid="composer-model-deepseek-v4-pro"[^>]*disabled=""/);
    const sliderTag = /<input[^>]*data-testid="composer-reasoning-slider"[^>]*>/.exec(markup)?.[0];
    expect(sliderTag).toBeDefined();
    expect(sliderTag).toContain('disabled=""');
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-none"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-low"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-high"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="composer-reasoning-stop-max"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="停止生成"[^>]*>停止<\/button>/);
    expect(markup).not.toMatch(/aria-label="停止生成"[^>]*disabled/);
  });

  it('merges partial generationPreference patches without dropping sibling overrides or mutating global config', () => {
    const globalSnapshot: ModelConfig = { ...DEFAULT_MODEL_CONFIG };

    const afterModel = mergeGenerationPreference(
      { promptPackMode: 'pack-a', prefixCompletion: 'always' },
      { model: 'deepseek-v4-pro' },
    );
    expect(afterModel).toEqual({
      model: 'deepseek-v4-pro',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterEffort = mergeGenerationPreference(afterModel, { reasoningEffort: 'max' });
    expect(afterEffort).toEqual({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterSwitchBack = mergeGenerationPreference(afterEffort, { model: 'deepseek-flash' });
    expect(afterSwitchBack).toEqual({
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      promptPackMode: 'pack-a',
      prefixCompletion: 'always',
    });

    const afterInvalidPatch = mergeGenerationPreference(afterSwitchBack, {
      model: 'invalid-model' as never,
      promptPackMode: '   ',
      prefixCompletion: 'invalid-mode' as never,
    });
    expect(afterInvalidPatch).toEqual({ reasoningEffort: 'max' });

    expect(mergeGenerationPreference(undefined, {})).toBeUndefined();
    expect(globalSnapshot).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('wires double-row composer, GenerationControls, welcome ephemeral pref, and story override persistence in App.tsx and styles', () => {
    const appSource = readSource('src/ui/App.tsx');
    const shellCss = readSource('src/ui/styles/shell.css');
    const playStageCss = readSource('src/ui/styles/play-stage.css');

    // App.tsx wires GenerationControls into the double-row composer
    expect(appSource).toContain("from './GenerationControls.tsx'");
    expect(appSource).toContain('className="composer composer-double-row"');
    expect(appSource).toContain('<GenerationControls');
    expect(appSource).toContain('pendingWelcomePref');
    expect(appSource).toContain('resolveEffectiveModelConfig(activeCfg, prefAtSubmit)');
    expect(appSource).toContain('generationPreference: prefAtSubmit');

    // Double-row column layout in both shell.css (welcome) and play-stage.css (story)
    expect(shellCss).toMatch(/\.composer\.composer-double-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s);
    expect(shellCss).toMatch(/\.composer\.composer-double-row textarea\s*\{[^}]*width:\s*100%;/s);
    expect(playStageCss).toMatch(/\.main-stage\.is-playing > \.composer\.composer-double-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s);

    // Narrow mobile rules hide secondary tier label so controls never squeeze textarea or overflow
    expect(shellCss).toMatch(/@media \(max-width: 560px\)[\s\S]*\.composer-model-tier\s*\{[^}]*display:\s*none;/s);
  });

  it('wires double-row GenerationControls into DraftPane (both discussion and manuscript views) and CharacterPane', () => {
    const draftSource = readSource('src/ui/DraftPane.tsx');
    const charSource = readSource('src/ui/CharacterPane.tsx');
    const workspaceSource = readSource('src/ui/CreativeWorkspace.tsx');

    expect(workspaceSource).toContain('defaultConfig?: ModelConfig');
    expect(draftSource).toContain("from './GenerationControls.tsx'");
    expect(draftSource).toContain('className="composer composer-double-row"');
    expect(draftSource).toContain('className="composer writing-composer composer-double-row"');
    expect(draftSource).toContain('resolveEffectiveModelConfig(config, live.generationPreference)');

    expect(charSource).toContain("from './GenerationControls.tsx'");
    expect(charSource).toContain('className="composer composer-double-row"');
    expect(charSource).toContain('resolveEffectiveModelConfig(config, current.generationPreference)');
  });
});
