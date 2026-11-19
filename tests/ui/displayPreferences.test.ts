import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  parseDisplayPreferences,
  resolveDisplayTheme,
} from '../../src/ui/displayPreferences.ts';

describe('display preferences', () => {
  it('falls back safely when stored preferences contain invalid legacy values', () => {
    expect(parseDisplayPreferences('neon', '13')).toEqual(DEFAULT_DISPLAY_PREFERENCES);
  });

  it('accepts every supported theme and font size', () => {
    expect(parseDisplayPreferences('warm', '20')).toEqual({
      theme: 'warm',
      fontSize: 20,
    });
    expect(parseDisplayPreferences('system', '14')).toEqual({
      theme: 'system',
      fontSize: 14,
    });
  });

  it('resolves system appearance from the operating system preference', () => {
    expect(resolveDisplayTheme('system', true)).toBe('dark');
    expect(resolveDisplayTheme('system', false)).toBe('light');
    expect(resolveDisplayTheme('warm', true)).toBe('warm');
  });
});
