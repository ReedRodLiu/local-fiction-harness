import { useWebHistoryLayer } from './useWebHistoryLayer.ts';

interface AppOverlayHistoryOptions {
  wizardOpen: boolean;
  wizardVerifying: boolean;
  onWizardBack: () => void;
  storyTreeOpen: boolean;
  onStoryTreeBack: () => void;
  mobileLibraryOpen: boolean;
  onMobileLibraryBack: () => void;
  showSettings: boolean;
  onSettingsBack: () => void;
  showImport: boolean;
  onImportBack: () => void;
  canCloseImport: () => boolean;
  returnFocus: () => HTMLElement | null;
}

export function useAppOverlayHistory({
  wizardOpen,
  wizardVerifying,
  onWizardBack,
  storyTreeOpen,
  onStoryTreeBack,
  mobileLibraryOpen,
  onMobileLibraryBack,
  showSettings,
  onSettingsBack,
  showImport,
  onImportBack,
  canCloseImport,
  returnFocus,
}: AppOverlayHistoryOptions) {
  useWebHistoryLayer(
    'setup-wizard',
    80,
    wizardOpen,
    onWizardBack,
    !wizardVerifying,
    () => !document.querySelector('[data-testid="deepseek-setup-wizard"] [data-verifying="true"]'),
    () => null,
  );
  useWebHistoryLayer(
    'companion-sheet',
    40,
    storyTreeOpen,
    onStoryTreeBack,
    true,
    undefined,
    () => document.querySelector<HTMLElement>('[data-testid="open-story-tree"]'),
  );
  useWebHistoryLayer('mobile-library', 30, mobileLibraryOpen, onMobileLibraryBack);
  useWebHistoryLayer('settings', 20, showSettings, onSettingsBack, true, undefined, returnFocus);
  useWebHistoryLayer('import-view', 20, showImport, onImportBack, true, canCloseImport, returnFocus);
}
