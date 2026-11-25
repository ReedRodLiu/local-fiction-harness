export const TUTORIAL_MAIN_DONE_STORAGE_KEY = 'folio.tutorial.mainDone';
export const TUTORIAL_SETTINGS_DONE_STORAGE_KEY = 'folio.tutorial.settingsDone';
export const TUTORIAL_REPLAY_PENDING_STORAGE_KEY = 'folio.tutorial.replayPending';

export type TutorialStage = 'main' | 'settings';

export interface TutorialState {
  mainDone: boolean;
  settingsDone: boolean;
  replayPending: boolean;
}

export const DEFAULT_TUTORIAL_STATE: TutorialState = {
  mainDone: false,
  settingsDone: false,
  replayPending: false,
};

/** Parse raw localStorage string flags into normalized tutorial completion state. */
export function parseTutorialState(
  mainDoneRaw: string | null,
  settingsDoneRaw: string | null,
  replayPendingRaw: string | null = null,
): TutorialState {
  return {
    mainDone: mainDoneRaw === 'true',
    settingsDone: settingsDoneRaw === 'true',
    replayPending: replayPendingRaw === 'true',
  };
}

/** Read persistent two-stage tutorial completion flags from localStorage safely. */
export function readTutorialState(): TutorialState {
  try {
    return parseTutorialState(
      window.localStorage.getItem(TUTORIAL_MAIN_DONE_STORAGE_KEY),
      window.localStorage.getItem(TUTORIAL_SETTINGS_DONE_STORAGE_KEY),
      window.localStorage.getItem(TUTORIAL_REPLAY_PENDING_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_TUTORIAL_STATE;
  }
}

/** Return true when Stage 1 should launch automatically on the main screen. */
export function shouldShowMainTutorial(state: TutorialState, hasCredentials: boolean): boolean {
  return !state.mainDone && (!hasCredentials || state.replayPending);
}

/** Persist completion state for one tutorial stage without overwriting the other stage. */
export function persistTutorialStageDone(
  stage: TutorialStage,
  done = true,
): TutorialState {
  const current = readTutorialState();
  const clearReplay = stage === 'main' && done;
  const next: TutorialState = {
    mainDone: stage === 'main' ? done : current.mainDone,
    settingsDone: stage === 'settings' ? done : current.settingsDone,
    replayPending: clearReplay ? false : current.replayPending,
  };
  const targetKey =
    stage === 'main' ? TUTORIAL_MAIN_DONE_STORAGE_KEY : TUTORIAL_SETTINGS_DONE_STORAGE_KEY;
  try {
    window.localStorage.setItem(targetKey, String(done));
    if (clearReplay) {
      window.localStorage.setItem(TUTORIAL_REPLAY_PENDING_STORAGE_KEY, 'false');
    }
  } catch {
    // Tutorial persistence is non-critical and must not block gameplay or settings.
  }
  return next;
}

/** Reset both Stage 1 and Stage 2 tutorial flags so the walkthrough can be replayed across reloads. */
export function resetTutorialState(): TutorialState {
  try {
    window.localStorage.setItem(TUTORIAL_MAIN_DONE_STORAGE_KEY, 'false');
    window.localStorage.setItem(TUTORIAL_SETTINGS_DONE_STORAGE_KEY, 'false');
    window.localStorage.setItem(TUTORIAL_REPLAY_PENDING_STORAGE_KEY, 'true');
  } catch {
    // Ignore storage failures in restricted browser environments.
  }
  return { mainDone: false, settingsDone: false, replayPending: true };
}
