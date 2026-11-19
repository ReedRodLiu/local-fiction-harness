import { useEffect, useState } from 'react';

const LIBRARY_COLLAPSED_PREFERENCE = 'lfh.ui.library_collapsed';

function readLibraryCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(LIBRARY_COLLAPSED_PREFERENCE) === 'true';
  } catch {
    return false;
  }
}

export function useLibraryCollapsedPreference() {
  const [collapsed, setCollapsed] = useState(readLibraryCollapsedPreference);

  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_COLLAPSED_PREFERENCE, String(collapsed));
    } catch {
      // A collapsed sidebar is a display preference and does not block the player.
    }
  }, [collapsed]);

  return [collapsed, setCollapsed] as const;
}
