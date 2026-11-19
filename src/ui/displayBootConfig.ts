export const DISPLAY_THEME_STORAGE_KEY = 'lfh.ui.theme';
export const DISPLAY_FONT_SIZE_STORAGE_KEY = 'lfh.ui.font_size';

export const DISPLAY_THEME_PREFERENCES = ['system', 'light', 'dark', 'warm'] as const;
export const DISPLAY_THEMES = ['light', 'dark', 'warm'] as const;
export const DISPLAY_FONT_SIZES = [14, 16, 18, 20] as const;

export type DisplayThemePreference = (typeof DISPLAY_THEME_PREFERENCES)[number];
export type DisplayTheme = (typeof DISPLAY_THEMES)[number];
export type DisplayFontSize = (typeof DISPLAY_FONT_SIZES)[number];

export const DISPLAY_BOOT_CONFIG = {
  themeStorageKey: DISPLAY_THEME_STORAGE_KEY,
  fontSizeStorageKey: DISPLAY_FONT_SIZE_STORAGE_KEY,
  themePreferences: DISPLAY_THEME_PREFERENCES,
  themes: DISPLAY_THEMES,
  fontSizes: DISPLAY_FONT_SIZES,
  defaultThemePreference: 'system',
  defaultFontSize: 16,
} as const;
