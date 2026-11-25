import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyWorkspace,
  newCharacter,
  newConversation,
  newWork,
} from '../../src/harness/index.ts';
import { CharacterPane } from '../../src/ui/CharacterPane.tsx';
import { DraftPane } from '../../src/ui/DraftPane.tsx';
import {
  getComposerEnterKeyHint,
  isCoarsePointerDevice,
  shouldSubmitComposerOnEnter,
} from '../../src/ui/textHelpers.ts';
import { sendOnEnter } from '../../src/ui/useCreativeReply.ts';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readSource = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function stubBrowserEnv(options: {
  coarse?: boolean;
  fine?: boolean;
  hoverNone?: boolean;
  hasMatchMedia?: boolean;
  maxTouchPoints?: number;
  userAgent?: string;
}) {
  const {
    coarse = false,
    fine = !coarse,
    hoverNone = coarse,
    hasMatchMedia = true,
    maxTouchPoints = coarse ? 5 : 0,
    userAgent = coarse ? 'Mozilla/5.0 (Linux; Android 14)' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
  } = options;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: hasMatchMedia
      ? {
          matchMedia: (query: string) => ({
            matches:
              (query === '(pointer: coarse)' && coarse) ||
              (query === '(pointer: fine)' && fine) ||
              (query === '(hover: none)' && hoverNone),
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }),
        }
      : {},
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints, userAgent },
  });
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

function makeKeyEvent(
  overrides: Partial<{
    key: string;
    shiftKey: boolean;
    isComposing: boolean;
    keyCode: number;
    onPreventDefault: () => void;
    onRequestSubmit: () => void;
  }> = {},
) {
  const preventDefault = overrides.onPreventDefault ?? vi.fn();
  const requestSubmit = overrides.onRequestSubmit ?? vi.fn();
  return {
    key: overrides.key ?? 'Enter',
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: {
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 13,
    },
    preventDefault,
    currentTarget: {
      form: { requestSubmit },
    },
  } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>;
}

describe('Issue #137: composer focus spacing and mobile Enter behavior', () => {
  it('moves the focus ring to .composer:focus-within and gives double-row textarea comfortable inner padding', () => {
    const shellCss = readSource('src/ui/styles/shell.css');
    const playStageCss = readSource('src/ui/styles/play-stage.css');
    const tokensCss = readSource('src/ui/styles/tokens.css');

    // Inner textarea does not keep the cramped inward outline
    expect(shellCss).toMatch(/\.composer textarea:focus-visible\s*\{[^}]*outline:\s*none;/s);
    expect(shellCss).not.toMatch(/\.composer textarea:focus-visible\s*\{[^}]*outline-offset:\s*-2px;/s);

    // Outer .composer receives focus-within indicator using semantic accent token
    expect(shellCss).toMatch(
      /\.composer:focus-within\s*\{[^}]*border-color:\s*var\(--accent-fiction\);[^}]*outline:\s*2px solid var\(--accent-fiction\);/s,
    );
    expect(playStageCss).toMatch(
      /\.main-stage\.is-playing > \.composer:focus-within,\s*\.main-stage\.is-playing > \.composer-dock > \.composer:focus-within\s*\{[^}]*border-color:\s*var\(--accent-fiction\);/s,
    );

    // Double-row textarea has comfortable inner padding (>= 8px) instead of 4px 2px
    const doubleRowMatch = /\.composer\.composer-double-row textarea\s*\{([^}]*)\}/s.exec(shellCss);
    expect(doubleRowMatch).not.toBeNull();
    const doubleRowDecls = doubleRowMatch![1];
    const paddingMatch = /padding:\s*(\d+)px\s+(\d+)px/.exec(doubleRowDecls);
    expect(paddingMatch).not.toBeNull();
    expect(Number(paddingMatch![1])).toBeGreaterThanOrEqual(8);
    expect(Number(paddingMatch![2])).toBeGreaterThanOrEqual(8);

    // Accent token exists in light, dark, and warm themes
    for (const theme of ['light', 'dark', 'warm']) {
      expect(tokensCss).toMatch(new RegExp(`\\[data-theme="${theme}"\\][^}]*--accent-fiction:`, 's'));
    }
  });

  it('detects coarse-pointer mobile vs fine-pointer desktop contexts accurately', () => {
    // SSR / Node without window defaults to desktop
    delete (globalThis as { window?: unknown }).window;
    expect(isCoarsePointerDevice()).toBe(false);
    expect(getComposerEnterKeyHint()).toBe('send');

    // Standard desktop
    stubBrowserEnv({ coarse: false, fine: true, hoverNone: false, maxTouchPoints: 0 });
    expect(isCoarsePointerDevice()).toBe(false);
    expect(getComposerEnterKeyHint()).toBe('send');

    // Touch-screen laptop with primary fine pointer (mouse/trackpad) stays desktop
    stubBrowserEnv({ coarse: false, fine: true, hoverNone: false, maxTouchPoints: 10 });
    expect(isCoarsePointerDevice()).toBe(false);
    expect(getComposerEnterKeyHint()).toBe('send');

    // Minimal test stub returning matches: false for all queries defaults to desktop
    stubBrowserEnv({ coarse: false, fine: false, hoverNone: false, maxTouchPoints: 0 });
    expect(isCoarsePointerDevice()).toBe(false);
    expect(getComposerEnterKeyHint()).toBe('send');

    // Coarse-pointer mobile device
    stubBrowserEnv({ coarse: true, fine: false, hoverNone: true, maxTouchPoints: 5 });
    expect(isCoarsePointerDevice()).toBe(true);
    expect(getComposerEnterKeyHint()).toBe('enter');

    // Mobile WebView reporting hover: none + touch points even if (pointer: coarse) is false
    stubBrowserEnv({ coarse: false, fine: false, hoverNone: true, maxTouchPoints: 5 });
    expect(isCoarsePointerDevice()).toBe(true);
    expect(getComposerEnterKeyHint()).toBe('enter');

    // Mobile WebView without matchMedia support
    stubBrowserEnv({
      hasMatchMedia: false,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36',
    });
    expect(isCoarsePointerDevice()).toBe(true);
    expect(getComposerEnterKeyHint()).toBe('enter');
  });

  it('submits on unmodified Enter on desktop, inserts newline on mobile/Shift+Enter/IME', () => {
    // Desktop fine pointer
    stubBrowserEnv({ coarse: false, fine: true });
    const desktopSubmit = vi.fn();
    const desktopPrevent = vi.fn();
    const enterEvent = makeKeyEvent({ onPreventDefault: desktopPrevent, onRequestSubmit: desktopSubmit });
    expect(shouldSubmitComposerOnEnter(enterEvent)).toBe(true);
    sendOnEnter(enterEvent);
    expect(desktopPrevent).toHaveBeenCalledTimes(1);
    expect(desktopSubmit).toHaveBeenCalledTimes(1);

    // Desktop Shift+Enter inserts newline
    const shiftPrevent = vi.fn();
    const shiftSubmit = vi.fn();
    const shiftEnter = makeKeyEvent({
      shiftKey: true,
      onPreventDefault: shiftPrevent,
      onRequestSubmit: shiftSubmit,
    });
    expect(shouldSubmitComposerOnEnter(shiftEnter)).toBe(false);
    sendOnEnter(shiftEnter);
    expect(shiftPrevent).not.toHaveBeenCalled();
    expect(shiftSubmit).not.toHaveBeenCalled();

    // Desktop IME composition (isComposing or keyCode 229) does not submit
    expect(shouldSubmitComposerOnEnter(makeKeyEvent({ isComposing: true }))).toBe(false);
    expect(shouldSubmitComposerOnEnter(makeKeyEvent({ keyCode: 229 }))).toBe(false);

    // Mobile coarse pointer: plain Enter inserts newline instead of submitting
    stubBrowserEnv({ coarse: true, fine: false });
    const mobilePrevent = vi.fn();
    const mobileSubmit = vi.fn();
    const mobileEnter = makeKeyEvent({ onPreventDefault: mobilePrevent, onRequestSubmit: mobileSubmit });
    expect(shouldSubmitComposerOnEnter(mobileEnter)).toBe(false);
    sendOnEnter(mobileEnter);
    expect(mobilePrevent).not.toHaveBeenCalled();
    expect(mobileSubmit).not.toHaveBeenCalled();
  });

  it('renders enterKeyHint="enter" on coarse-pointer mobile and "send" on desktop across composer modes', () => {
    const work = newWork('雨夜站台');
    const character = newCharacter('岑灯', '夜航员');
    const conv = newConversation(character, 'personal');
    character.conversations = [conv];
    character.activeConversationId = conv.id;
    const workspace = {
      ...emptyWorkspace(),
      works: [work],
      activeWorkId: work.id,
      characters: [character],
      activeCharacterId: character.id,
    };

    const renderDraftDiscussion = () =>
      renderToStaticMarkup(
        createElement(DraftPane, {
          work,
          workspace,
          save: async () => workspace,
          read: async () => workspace,
          runtime: {} as never,
          requestModel: () => undefined,
          openPublic: () => undefined,
          openDocument: () => undefined,
          manuscript: false,
          initialTurn: null,
          onConsumeInitialTurn: () => undefined,
          companionOpen: false,
          setCompanionOpen: () => undefined,
        }),
      );

    const renderDraftManuscript = () =>
      renderToStaticMarkup(
        createElement(DraftPane, {
          work: { ...work, writingStarted: true },
          workspace,
          save: async () => workspace,
          read: async () => workspace,
          runtime: {} as never,
          requestModel: () => undefined,
          openPublic: () => undefined,
          openDocument: () => undefined,
          manuscript: true,
          initialTurn: null,
          onConsumeInitialTurn: () => undefined,
          companionOpen: false,
          setCompanionOpen: () => undefined,
        }),
      );

    const renderCharacter = () =>
      renderToStaticMarkup(
        createElement(CharacterPane, {
          character,
          workspace,
          save: async () => workspace,
          read: async () => workspace,
          runtime: {} as never,
          requestModel: () => undefined,
          openPublic: () => undefined,
          openDocument: () => undefined,
          initialTurn: null,
          onConsumeInitialTurn: () => undefined,
          companionOpen: false,
          setCompanionOpen: () => undefined,
        }),
      );

    // Desktop fine-pointer
    stubBrowserEnv({ coarse: false, fine: true });
    expect(renderDraftDiscussion()).toMatch(/id="writing-discussion-input"[^>]*enterKeyHint="send"|id="writing-discussion-input"[^>]*enterkeyhint="send"/i);
    expect(renderDraftManuscript()).toMatch(/id="writing-suggestion-input"[^>]*enterKeyHint="send"|id="writing-suggestion-input"[^>]*enterkeyhint="send"/i);
    expect(renderCharacter()).toMatch(/id="character-chat-input"[^>]*enterKeyHint="send"|id="character-chat-input"[^>]*enterkeyhint="send"/i);

    // Mobile coarse-pointer
    stubBrowserEnv({ coarse: true, fine: false });
    expect(renderDraftDiscussion()).toMatch(/id="writing-discussion-input"[^>]*enterKeyHint="enter"|id="writing-discussion-input"[^>]*enterkeyhint="enter"/i);
    expect(renderDraftManuscript()).toMatch(/id="writing-suggestion-input"[^>]*enterKeyHint="enter"|id="writing-suggestion-input"[^>]*enterkeyhint="enter"/i);
    expect(renderCharacter()).toMatch(/id="character-chat-input"[^>]*enterKeyHint="enter"|id="character-chat-input"[^>]*enterkeyhint="enter"/i);

    // App.tsx #turn-input wires the shared Enter helper and enterKeyHint
    const appSource = readSource('src/ui/App.tsx');
    expect(appSource).toContain('useComposerEnterKeyHint');
    expect(appSource).toContain('sendOnEnter(event, () => handleSubmit())');
    expect(appSource).toContain('enterKeyHint={composerEnterKeyHint}');
  });
});
