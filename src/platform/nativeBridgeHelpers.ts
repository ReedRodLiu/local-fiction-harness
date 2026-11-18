import type { AbortSignalLike } from '../harness/index.ts';

export interface AbortEventTargetLike {
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export function createAbortError(message = '操作已中止。'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function decodeBase64ToBytes(base64: string, label = '原生分块数据'): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    throw new Error(
      `无法解码${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function bindAbortSignal(
  signal: AbortSignalLike | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) {
    return () => {};
  }
  const signalTarget = signal as AbortSignalLike & AbortEventTargetLike;
  if (typeof signalTarget.addEventListener === 'function') {
    signalTarget.addEventListener('abort', onAbort, { once: true });
    return () => {
      signalTarget.removeEventListener?.('abort', onAbort);
    };
  }
  const pollTimer = setInterval(() => {
    if (signal.aborted) {
      clearInterval(pollTimer);
      onAbort();
    }
  }, 20);
  return () => {
    clearInterval(pollTimer);
  };
}
