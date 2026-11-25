export function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type ComposerEnterKeyEvent = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

/**
 * Returns true when the primary input device is touch/coarse-pointer (mobile browser or WebView)
 * so Enter on the soft keyboard inserts a newline instead of submitting.
 */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
    if (window.matchMedia('(pointer: fine)').matches) return false;
    if (
      window.matchMedia('(hover: none)').matches &&
      typeof navigator !== 'undefined' &&
      navigator.maxTouchPoints > 0
    ) {
      return true;
    }
  }
  if (typeof navigator !== 'undefined') {
    const hasTouch = navigator.maxTouchPoints > 0;
    const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? '');
    if (hasTouch && isMobileUa) return true;
  }
  return false;
}

export function getComposerEnterKeyHint(coarsePointer = isCoarsePointerDevice()): 'enter' | 'send' {
  return coarsePointer ? 'enter' : 'send';
}

export function shouldSubmitComposerOnEnter(
  event: ComposerEnterKeyEvent,
  coarsePointer = isCoarsePointerDevice(),
): boolean {
  if (coarsePointer || event.key !== 'Enter' || event.shiftKey) {
    return false;
  }
  const isComposing = event.nativeEvent?.isComposing ?? event.isComposing ?? false;
  const keyCode = event.nativeEvent?.keyCode ?? event.keyCode;
  return !isComposing && keyCode !== 229;
}

const NETWORK_ABORT_PATTERN =
  /software caused connection abort|econnaborted|connection abort/i;
const SOCKET_RESET_PATTERN =
  /connection reset|econnreset|broken pipe|epipe|unexpected end of stream/i;
const NETWORK_TIMEOUT_PATTERN =
  /timed?\s*out|etimedout|sockettimeoutexception/i;
const NETWORK_OFFLINE_PATTERN =
  /failed to fetch|networkerror when attempting to fetch|load failed|unknownhostexception|unable to resolve host|err_internet_disconnected|err_network_changed/i;
const TLS_ERROR_PATTERN = /sslexception|sslhandshakeexception|certpathvalidatorexception/i;

export function toErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error && err.message ? err.message.trim() : '';
  if (!raw) return fallback;
  if (NETWORK_ABORT_PATTERN.test(raw)) {
    return '网络连接在等待响应期间被系统或网络切换中断（如锁屏、切后台、VPN 或 Wi-Fi/5G 切换），请保持网络稳定并在系统设置中允许 Folio 后台运行后重试。';
  }
  if (SOCKET_RESET_PATTERN.test(raw)) {
    return '与模型服务器的连接意外断开（连接重置），可能是网络波动或 VPN 隧道切换导致，请重试。';
  }
  if (NETWORK_TIMEOUT_PATTERN.test(raw)) {
    return '等待模型响应超时，请稍后重试；若使用了较高思考强度，可在等待期间保持屏幕亮起。';
  }
  if (TLS_ERROR_PATTERN.test(raw)) {
    return 'HTTPS 安全连接握手或传输异常，请检查系统时间、网络或 VPN 代理设置后重试。';
  }
  if (NETWORK_OFFLINE_PATTERN.test(raw)) {
    return '无法连接模型服务器，请检查当前网络、DNS 或 VPN 状态后重试。';
  }
  return raw;
}
