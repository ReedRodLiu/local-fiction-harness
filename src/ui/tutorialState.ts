export const TUTORIAL_MAIN_DONE_STORAGE_KEY = 'folio.tutorial.mainDone';
export const TUTORIAL_SETTINGS_DONE_STORAGE_KEY = 'folio.tutorial.settingsDone';

export type TutorialStage = 'main' | 'settings';

export interface TutorialState {
  mainDone: boolean;
  settingsDone: boolean;
}

export const DEFAULT_TUTORIAL_STATE: TutorialState = {
  mainDone: false,
  settingsDone: false,
};

/** Parse raw localStorage string flags into normalized tutorial completion state. */
export function parseTutorialState(
  mainDoneRaw: string | null,
  settingsDoneRaw: string | null,
): TutorialState {
  return {
    mainDone: mainDoneRaw === 'true',
    settingsDone: settingsDoneRaw === 'true',
  };
}

/** Read persistent two-stage tutorial completion flags from localStorage safely. */
export function readTutorialState(): TutorialState {
  try {
    return parseTutorialState(
      window.localStorage.getItem(TUTORIAL_MAIN_DONE_STORAGE_KEY),
      window.localStorage.getItem(TUTORIAL_SETTINGS_DONE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_TUTORIAL_STATE;
  }
}

/** Persist completion state for one tutorial stage without overwriting the other stage. */
export function persistTutorialStageDone(
  stage: TutorialStage,
  done = true,
): TutorialState {
  const current = readTutorialState();
  const next: TutorialState = {
    mainDone: stage === 'main' ? done : current.mainDone,
    settingsDone: stage === 'settings' ? done : current.settingsDone,
  };
  const targetKey =
    stage === 'main' ? TUTORIAL_MAIN_DONE_STORAGE_KEY : TUTORIAL_SETTINGS_DONE_STORAGE_KEY;
  try {
    window.localStorage.setItem(targetKey, String(done));
  } catch {
    // Tutorial persistence is non-critical and must not block gameplay or settings.
  }
  return next;
}

/** Reset both Stage 1 and Stage 2 tutorial flags so the walkthrough can be replayed. */
export function resetTutorialState(): TutorialState {
  try {
    window.localStorage.setItem(TUTORIAL_MAIN_DONE_STORAGE_KEY, 'false');
    window.localStorage.setItem(TUTORIAL_SETTINGS_DONE_STORAGE_KEY, 'false');
  } catch {
    // Ignore storage failures in restricted browser environments.
  }
  return { mainDone: false, settingsDone: false };
}
