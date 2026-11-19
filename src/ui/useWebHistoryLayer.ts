import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    __lfhOverlayHistorySession?: string;
  }
}

interface HistoryLayer {
  id: string;
  priority: number;
  close: () => boolean;
}

const HISTORY_SESSION_KEY = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
window.__lfhOverlayHistorySession = HISTORY_SESSION_KEY;
const layers = new Map<string, HistoryLayer>();
let currentDepth = readCurrentDepth();
let installPromise: Promise<void> | null = null;
let pendingProgrammaticBacks = 0;
let syncQueued = false;

function readHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === 'object' ? state as Record<string, unknown> : {};
}

function readCurrentDepth(): number {
  const state = readHistoryState();
  if (state.lfhOverlaySession !== HISTORY_SESSION_KEY) return 0;
  const depth = Number(state.lfhOverlayDepth);
  return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

function topLayer(): HistoryLayer | null {
  return [...layers.values()].sort((left, right) => right.priority - left.priority)[0] ?? null;
}

function handlePopState(): void {
  currentDepth = readCurrentDepth();
  if (pendingProgrammaticBacks > 0) {
    pendingProgrammaticBacks -= 1;
    return;
  }
  const top = topLayer();
  if (top && !top.close()) scheduleHistorySync();
}

function ensureInstalled(): void {
  if (installPromise) return;
  window.addEventListener('popstate', handlePopState);
  currentDepth = readCurrentDepth();
  installPromise = Promise.resolve();
}

function scheduleHistorySync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    currentDepth = readCurrentDepth();
    const desiredDepth = layers.size;
    if (desiredDepth > currentDepth) {
      currentDepth += 1;
      window.history.pushState(
        {
          ...readHistoryState(),
          lfhOverlaySession: HISTORY_SESSION_KEY,
          lfhOverlayDepth: currentDepth,
        },
        '',
        window.location.href,
      );
      return;
    }
    if (desiredDepth < currentDepth) {
      pendingProgrammaticBacks += 1;
      window.history.back();
    }
  });
}

function registerLayer(layer: HistoryLayer): () => void {
  ensureInstalled();
  layers.set(layer.id, layer);
  scheduleHistorySync();
  return () => {
    if (layers.get(layer.id) !== layer) return;
    layers.delete(layer.id);
    scheduleHistorySync();
  };
}

function restoreVisibleFocus(preferred: HTMLElement | null): void {
  const current = document.activeElement;
  if (
    current instanceof HTMLElement &&
    current !== document.body &&
    current.isConnected &&
    current.getClientRects().length > 0 &&
    !current.closest('dialog[open]')
  ) {
    return;
  }
  const candidates = [
    preferred,
    document.querySelector<HTMLElement>('[data-testid="crash-open-diagnostics"]'),
    document.querySelector<HTMLElement>('[data-testid="open-diagnostics"]'),
    document.querySelector<HTMLElement>('[data-testid="change-key-btn"]'),
    document.querySelector<HTMLElement>('[data-testid="open-setup-wizard-btn"]'),
    document.querySelector<HTMLElement>('[data-testid="library-drawer-trigger"]'),
    document.querySelector<HTMLElement>('[data-testid="settings-page"] button'),
    document.querySelector<HTMLElement>('[data-testid="app-topbar"] button'),
  ];
  const target = candidates.find((candidate) =>
    Boolean(candidate?.isConnected && candidate.getClientRects().length > 0 && !candidate.matches(':disabled'))
  );
  target?.focus();
}

export function isTopHistoryLayer(id: string): boolean {
  return topLayer()?.id === id;
}

export function useWebHistoryLayer(
  id: string,
  priority: number,
  open: boolean,
  onClose: () => void,
  closeEnabled = true,
  canClose?: () => boolean,
  restoreFocus?: () => HTMLElement | null,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closeEnabledRef = useRef(closeEnabled);
  closeEnabledRef.current = closeEnabled;
  const canCloseRef = useRef(canClose);
  canCloseRef.current = canClose;
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = restoreFocus === undefined
      ? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      : restoreFocus();

    const close = () => {
      if (!closeEnabledRef.current || (canCloseRef.current && !canCloseRef.current())) return false;
      closeRef.current();
      return true;
    };
    const unregister = registerLayer({ id, priority, close });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isTopHistoryLayer(id) || event.defaultPrevented) return;
      if (!closeEnabledRef.current || (canCloseRef.current && !canCloseRef.current())) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unregister();
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => restoreVisibleFocus(restoreTarget));
      });
    };
  }, [id, open, priority]);
}
