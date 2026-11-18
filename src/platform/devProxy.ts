export const DEV_PROXY_BASE_URL = '/__dev_llm_proxy';
const DEV_SESSION_PROXY_KEY = 'lfh.dev_proxy_session';

export interface DevSessionProxyState {
  baseUrl: string;
  model?: string;
  hasEnvKey: boolean;
}

export interface DevTestConfigResponse {
  available: boolean;
  proxyBaseUrl: string;
  model: string;
  hasEnvKey: boolean;
}

export function isDevProxyBaseUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === DEV_PROXY_BASE_URL || trimmed.startsWith(`${DEV_PROXY_BASE_URL}/`);
}

export function readDevSessionProxy(isWebDev: boolean): DevSessionProxyState | null {
  if (!isWebDev) return null;
  try {
    const raw = window.sessionStorage.getItem(DEV_SESSION_PROXY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DevSessionProxyState>;
    const sessionBaseUrl = parsed.baseUrl || DEV_PROXY_BASE_URL;
    if (!isDevProxyBaseUrl(sessionBaseUrl)) return null;
    return {
      baseUrl: sessionBaseUrl,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined,
      hasEnvKey: parsed.hasEnvKey !== false,
    };
  } catch {
    return null;
  }
}

export function writeDevSessionProxy(state: DevSessionProxyState): void {
  try {
    window.sessionStorage.setItem(
      DEV_SESSION_PROXY_KEY,
      JSON.stringify({
        baseUrl: state.baseUrl.trim(),
        model: state.model,
        hasEnvKey: state.hasEnvKey,
      }),
    );
  } catch {
    // Ignore storage errors outside browser sessions
  }
}

export function clearDevSessionProxy(): void {
  try {
    window.sessionStorage.removeItem(DEV_SESSION_PROXY_KEY);
  } catch {
    // Ignore storage errors outside browser sessions
  }
}

export async function fetchDevTestConfig(): Promise<DevTestConfigResponse | null> {
  try {
    const res = await fetch('/__dev_test_config');
    if (!res.ok) return null;
    const data = (await res.json()) as DevTestConfigResponse;
    return data?.available ? data : null;
  } catch {
    return null;
  }
}
