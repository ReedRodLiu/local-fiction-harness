import { useState } from 'react';

export type SettingsSubPage = 'main' | 'narrative-presets';

export function usePresentationOverlayState() {
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSubPage, setSettingsSubPage] = useState<SettingsSubPage>('main');
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const [storyTreeOpen, setStoryTreeOpen] = useState(false);

  return {
    showImport,
    setShowImport,
    showSettings,
    setShowSettings,
    settingsSubPage,
    setSettingsSubPage,
    mobileLibraryOpen,
    setMobileLibraryOpen,
    storyTreeOpen,
    setStoryTreeOpen,
  };
}
