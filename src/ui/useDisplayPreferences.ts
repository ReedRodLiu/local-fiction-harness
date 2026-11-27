import { useEffect, useState } from 'react';
import {
  applyDisplayPreferences,
  persistDisplayPreferences,
  readDisplayPreferences,
  type DisplayFontSize,
  type DisplayThemePreference,
} from './displayPreferences.ts';

export function useDisplayPreferences() {
  const [displayPreferences, setDisplayPreferences] = useState(readDisplayPreferences);
  const [prefersDark, setPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updatePreference = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setPrefersDark(media.matches);
    media.addEventListener?.('change', updatePreference);
    return () => media.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    applyDisplayPreferences(displayPreferences, prefersDark);
  }, [displayPreferences, prefersDark]);

  useEffect(() => {
    persistDisplayPreferences(displayPreferences);
  }, [displayPreferences]);

  const setThemePreference = (theme: DisplayThemePreference) => {
    setDisplayPreferences((current) => ({ ...current, theme }));
  };

  const setDisplayFontSize = (fontSize: DisplayFontSize) => {
    setDisplayPreferences((current) => ({ ...current, fontSize }));
  };

  return {
    displayPreferences,
    setThemePreference,
    setDisplayFontSize,
  };
}
