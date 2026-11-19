export const DISPLAY_THEME_STORAGE_KEY = 'lfh.ui.theme';
export const DISPLAY_FONT_SIZE_STORAGE_KEY = 'lfh.ui.font_size';

export type DisplayThemePreference = 'system' | 'light' | 'dark' | 'warm';
export type DisplayTheme = 'light' | 'dark' | 'warm';
export type DisplayFontSize = 14 | 16 | 18 | 20;

export interface DisplayPreferences {
  theme: DisplayThemePreference;
  fontSize: DisplayFontSize;
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  theme: 'system',
  fontSize: 16,
};

const SUPPORTED_THEMES = new Set<DisplayThemePreference>(['system', 'light', 'dark', 'warm']);
const SUPPORTED_FONT_SIZES = new Set<DisplayFontSize>([14, 16, 18, 20]);

export function parseDisplayPreferences(
  storedTheme: string | null,
  storedFontSize: string | null,
): DisplayPreferences {
  const theme = storedTheme && SUPPORTED_THEMES.has(storedTheme as DisplayThemePreference)
    ? storedTheme as DisplayThemePreference
    : DEFAULT_DISPLAY_PREFERENCES.theme;
  const parsedFontSize = Number(storedFontSize);
  const fontSize = SUPPORTED_FONT_SIZES.has(parsedFontSize as DisplayFontSize)
    ? parsedFontSize as DisplayFontSize
    : DEFAULT_DISPLAY_PREFERENCES.fontSize;
  return { theme, fontSize };
}

export function resolveDisplayTheme(
  preference: DisplayThemePreference,
  prefersDark: boolean,
): DisplayTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function readDisplayPreferences(): DisplayPreferences {
  try {
    return parseDisplayPreferences(
      window.localStorage.getItem(DISPLAY_THEME_STORAGE_KEY),
      window.localStorage.getItem(DISPLAY_FONT_SIZE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_DISPLAY_PREFERENCES;
  }
}

export function applyDisplayPreferences(
  preferences: DisplayPreferences,
  prefersDark: boolean,
): void {
  const root = document.documentElement;
  root.dataset.theme = resolveDisplayTheme(preferences.theme, prefersDark);
  root.dataset.themePreference = preferences.theme;
  root.dataset.fontSize = String(preferences.fontSize);
  root.style.setProperty('--font-size', `${preferences.fontSize}px`);
}

export function persistDisplayPreferences(preferences: DisplayPreferences): void {
  try {
    window.localStorage.setItem(DISPLAY_THEME_STORAGE_KEY, preferences.theme);
    window.localStorage.setItem(DISPLAY_FONT_SIZE_STORAGE_KEY, String(preferences.fontSize));
  } catch {
    // Display preferences are non-critical and must not block story playback.
  }
}
