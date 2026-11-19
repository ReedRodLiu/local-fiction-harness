import { useState } from 'react';

export function usePresentationOverlayState() {
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const [storyTreeOpen, setStoryTreeOpen] = useState(false);

  return {
    showImport,
    setShowImport,
    showSettings,
    setShowSettings,
    mobileLibraryOpen,
    setMobileLibraryOpen,
    storyTreeOpen,
    setStoryTreeOpen,
  };
}
