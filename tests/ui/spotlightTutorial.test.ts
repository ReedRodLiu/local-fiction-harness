import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '../../src/harness/index.ts';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';
import {
  buildEvenOddPolygonClipPath,
  computeSpotlightLayout,
  padAndClampRect,
} from '../../src/ui/spotlightLayout.ts';
import { SpotlightTutorial } from '../../src/ui/SpotlightTutorial.tsx';
import {
  TUTORIAL_MAIN_DONE_STORAGE_KEY,
  TUTORIAL_SETTINGS_DONE_STORAGE_KEY,
  parseTutorialState,
  persistTutorialStageDone,
  readTutorialState,
  resetTutorialState,
} from '../../src/ui/tutorialState.ts';
import {
  buildMainTutorialSteps,
  buildSettingsTutorialSteps,
} from '../../src/ui/tutorialSteps.ts';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function installMockWindowStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const localStorageMock = {
    getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
  vi.stubGlobal('window', { localStorage: localStorageMock });
  return { store, localStorageMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tutorialState persistent storage', () => {
  it('defaults both Stage 1 and Stage 2 completion flags to false on fresh install', () => {
    installMockWindowStorage();
    expect(TUTORIAL_MAIN_DONE_STORAGE_KEY).toBe('folio.tutorial.mainDone');
    expect(TUTORIAL_SETTINGS_DONE_STORAGE_KEY).toBe('folio.tutorial.settingsDone');
    expect(parseTutorialState(null, null)).toEqual({
      mainDone: false,
      settingsDone: false,
    });
    expect(readTutorialState()).toEqual({
      mainDone: false,
      settingsDone: false,
    });
  });

  it('persists mainDone and settingsDone independently and ignores invalid legacy values', () => {
    const { store } = installMockWindowStorage({
      [TUTORIAL_MAIN_DONE_STORAGE_KEY]: 'unexpected',
      [TUTORIAL_SETTINGS_DONE_STORAGE_KEY]: '1',
    });
    expect(readTutorialState()).toEqual({
      mainDone: false,
      settingsDone: false,
    });

    const afterMain = persistTutorialStageDone('main', true);
    expect(afterMain).toEqual({ mainDone: true, settingsDone: false });
    expect(store.get(TUTORIAL_MAIN_DONE_STORAGE_KEY)).toBe('true');
    expect(store.get(TUTORIAL_SETTINGS_DONE_STORAGE_KEY)).toBe('1');
    expect(readTutorialState()).toEqual({ mainDone: true, settingsDone: false });

    const afterSettings = persistTutorialStageDone('settings', true);
    expect(afterSettings).toEqual({ mainDone: true, settingsDone: true });
    expect(store.get(TUTORIAL_SETTINGS_DONE_STORAGE_KEY)).toBe('true');
    expect(readTutorialState()).toEqual({ mainDone: true, settingsDone: true });
  });

  it('resets both stage flags when replaying the tutorial', () => {
    const { store } = installMockWindowStorage({
      [TUTORIAL_MAIN_DONE_STORAGE_KEY]: 'true',
      [TUTORIAL_SETTINGS_DONE_STORAGE_KEY]: 'true',
    });

    const reset = resetTutorialState();
    expect(reset).toEqual({ mainDone: false, settingsDone: false });
    expect(store.get(TUTORIAL_MAIN_DONE_STORAGE_KEY)).toBe('false');
    expect(store.get(TUTORIAL_SETTINGS_DONE_STORAGE_KEY)).toBe('false');
    expect(readTutorialState()).toEqual({ mainDone: false, settingsDone: false });
  });

  it('falls back safely without throwing if localStorage is unavailable or throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });

    expect(readTutorialState()).toEqual({ mainDone: false, settingsDone: false });
    expect(persistTutorialStageDone('main', true)).toEqual({
      mainDone: true,
      settingsDone: false,
    });
    expect(resetTutorialState()).toEqual({ mainDone: false, settingsDone: false });
  });
});

describe('spotlightLayout geometry', () => {
  it('places card cleanly above bottom target without clipping on 360x800 mobile', () => {
    const viewport = { width: 360, height: 800 };
    const inputRect = padAndClampRect(
      { left: 16, top: 660, right: 344, bottom: 716, width: 328, height: 56 },
      viewport,
      6,
    );
    const drawerBtnRect = padAndClampRect(
      { left: 12, top: 6, right: 56, bottom: 50, width: 44, height: 44 },
      viewport,
      6,
    );
    const layout = computeSpotlightLayout({
      viewport,
      targetRects: [inputRect, drawerBtnRect],
      cardSize: { width: 336, height: 220 },
    });

    expect(layout.left).toBeGreaterThanOrEqual(12);
    expect(layout.left + layout.width).toBeLessThanOrEqual(348);
    expect(layout.top).toBeGreaterThanOrEqual(12);
    expect(layout.top + layout.height).toBeLessThanOrEqual(inputRect.top);
    expect(layout.top).toBeGreaterThanOrEqual(drawerBtnRect.bottom);
  });

  it('avoids both desktop sidebar and bottom composer on 1280x800 desktop', () => {
    const viewport = { width: 1280, height: 800 };
    const inputRect = padAndClampRect(
      { left: 360, top: 660, right: 1120, bottom: 716, width: 760, height: 56 },
      viewport,
      6,
    );
    const sidebarRect = padAndClampRect(
      { left: 0, top: 56, right: 288, bottom: 800, width: 288, height: 744 },
      viewport,
      4,
    );
    const layout = computeSpotlightLayout({
      viewport,
      targetRects: [inputRect, sidebarRect],
      cardSize: { width: 360, height: 220 },
    });

    expect(layout.left).toBeGreaterThanOrEqual(sidebarRect.right);
    expect(layout.top + layout.height).toBeLessThanOrEqual(inputRect.top);
    expect(layout.left + layout.width).toBeLessThanOrEqual(1264);
  });

  it('clamps card inside viewport even when target spans most of a 360x800 mobile screen', () => {
    const viewport = { width: 360, height: 800 };
    const tallGroup = padAndClampRect(
      { left: 12, top: 72, right: 348, bottom: 690, width: 336, height: 618 },
      viewport,
      6,
    );
    const layout = computeSpotlightLayout({
      viewport,
      targetRects: [tallGroup],
      cardSize: { width: 336, height: 210 },
    });

    expect(layout.left).toBeGreaterThanOrEqual(12);
    expect(layout.left + layout.width).toBeLessThanOrEqual(348);
    expect(layout.top).toBeGreaterThanOrEqual(12);
    expect(layout.top + layout.height).toBeLessThanOrEqual(788);
  });

  it('builds a valid evenodd polygon clip-path for multiple cutouts', () => {
    const clipPath = buildEvenOddPolygonClipPath([
      { left: 10, top: 20, right: 60, bottom: 70, width: 50, height: 50 },
      { left: 10, top: 600, right: 350, bottom: 700, width: 340, height: 100 },
    ]);
    expect(clipPath.startsWith('polygon(evenodd,')).toBe(true);
    expect(clipPath).toContain('60px 70px');
    expect(clipPath).toContain('350px 700px');
  });
});

describe('SpotlightTutorial component contract', () => {
  const sampleSteps = [
    {
      id: 'step-1',
      targetGroups: [['#turn-input']],
      title: '自然语言开局 & 三模式书架',
      description: '直接输入即可开始。',
    },
    {
      id: 'step-2',
      targetGroups: [['[data-testid="welcome-key-hint"]']],
      title: '连接 DeepSeek 开始使用',
      description: '连接后即可开始创作。',
      extraAction: {
        label: '去连接 DeepSeek',
        testId: 'tutorial-connect-cta',
        onClick: vi.fn(),
      },
    },
  ];

  it('renders step 1 with Skip and Next controls and no Prev button', () => {
    const markup = renderToStaticMarkup(
      createElement(SpotlightTutorial, {
        open: true,
        label: '新手引导',
        steps: sampleSteps,
        stepIndex: 0,
        onStepChange: vi.fn(),
        onSkip: vi.fn(),
        onComplete: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="spotlight-tutorial"');
    expect(markup).toContain('data-testid="spotlight-card"');
    expect(markup).toContain('1 / 2');
    expect(markup).toContain('自然语言开局 &amp; 三模式书架');
    expect(markup).toContain('data-testid="spotlight-skip-btn"');
    expect(markup).toContain('跳过');
    expect(markup).toContain('data-testid="spotlight-next-btn"');
    expect(markup).toContain('下一步');
    expect(markup).not.toContain('data-testid="spotlight-prev-btn"');
    expect(markup).not.toContain('data-testid="spotlight-finish-btn"');
  });

  it('renders Prev, Finish, and optional CTA on the final step', () => {
    const markup = renderToStaticMarkup(
      createElement(SpotlightTutorial, {
        open: true,
        label: '新手引导',
        steps: sampleSteps,
        stepIndex: 1,
        onStepChange: vi.fn(),
        onSkip: vi.fn(),
        onComplete: vi.fn(),
      }),
    );

    expect(markup).toContain('2 / 2');
    expect(markup).toContain('data-testid="spotlight-prev-btn"');
    expect(markup).toContain('上一步');
    expect(markup).toContain('data-testid="spotlight-finish-btn"');
    expect(markup).toContain('完成');
    expect(markup).toContain('data-testid="tutorial-connect-cta"');
    expect(markup).toContain('去连接 DeepSeek');
    expect(markup).not.toContain('data-testid="spotlight-next-btn"');
  });
});

describe('tutorialSteps canonical terminology and Settings replay integration', () => {
  it('uses canonical GLOSSARY / ADR-0016 terms and avoids forbidden wording or TopBar mode dropdown references', () => {
    const onConnectAction = vi.fn();
    const mainSteps = buildMainTutorialSteps({ onConnectAction });
    const settingsSteps = buildSettingsTutorialSteps();

    expect(mainSteps).toHaveLength(4);
    expect(settingsSteps).toHaveLength(4);

    const allCopy = [...mainSteps, ...settingsSteps]
      .map((step) => `${step.title}\n${step.description}\n${step.extraAction?.label ?? ''}`)
      .join('\n');

    expect(allCopy).toContain('叙事预设');
    expect(allCopy).toContain('叙事连贯保护');
    expect(allCopy).not.toContain('破甲');
    expect(allCopy).not.toContain('防拒答');
    expect(allCopy).not.toContain('topbar-mode-switcher');
    expect(allCopy).not.toContain('顶部模式切换');

    mainSteps[3].extraAction?.onClick();
    expect(onConnectAction).toHaveBeenCalledTimes(1);

    const tutorialStepsSource = readFileSync(
      join(repoRoot, 'src', 'ui', 'tutorialSteps.ts'),
      'utf8',
    );
    expect(tutorialStepsSource).not.toContain('topbar-mode-switcher');
    expect(tutorialStepsSource).not.toContain('破甲');
    expect(tutorialStepsSource).not.toContain('防拒答');
  });

  it('renders the 「重新查看引导教程」 button inside SettingsPage', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        appVersion: '0.4.2',
        hasCredentials: false,
        config: DEFAULT_MODEL_CONFIG,
        useDevEnvKey: false,
        showDevTestProxy: false,
        themePreference: 'light',
        fontSize: 16,
        canExportCurrentStory: false,
        currentStoryTitle: '',
        onBack: vi.fn(),
        onOpenSetupWizard: vi.fn(),
        onClearSavedKey: vi.fn(),
        onApplyDevTestConfig: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        onOpenPublicMemory: vi.fn(),
        onExportCurrentStory: vi.fn(),
        onImportBackupFile: vi.fn(),
        onThemePreferenceChange: vi.fn(),
        onFontSizeChange: vi.fn(),
        onReplayTutorial: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="settings-tutorial-group"');
    expect(markup).toContain('data-testid="replay-tutorial-btn"');
    expect(markup).toContain('重新查看引导教程');
  });
});
