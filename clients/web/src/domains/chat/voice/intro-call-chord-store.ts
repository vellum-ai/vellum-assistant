import { create } from "zustand";

import type { CompanionIntroCallControl } from "@vellumai/ipc-contract";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Presses of a call's shortcut made while the companion's introduction was
 * asking for one, since this window loaded.
 *
 * The sibling of `voice-key-tap-store`, for the other half of the run. Three
 * of the introduction's beats draw a call control beside the chord that
 * reaches it, and the chord reaches only the window that armed the binding,
 * which is this one and never the surface's. So the press is counted here and
 * travels to the surface with everything else it cannot see for itself
 * (`use-companion-mirror`).
 *
 * **A press does nothing else.** The beat draws a demonstration of a call
 * rather than a call (`companion-surface-page`), so there is no session for
 * Option+M to mute and no share for Option+D to draw on: every handler on that
 * pill is withheld, and the chord is the keyboard's half of the same picture.
 * Counting it is the whole of what it does, exactly as with a tap of the voice
 * key.
 *
 * **Only while a beat is asking**, which is the gate `use-call-chords` holds:
 * nothing is armed to hear a press outside those three beats, so nothing can
 * reach this store there. The gate is on the arming rather than on the count
 * because the binding is the expensive thing: while it is up the host takes
 * Option+S, so it reaches nothing else the user has bound it to.
 *
 * **A running count rather than a flag**, the bargain `voiceKeyTaps` makes: it
 * crosses a process boundary and is drawn by a renderer that re-renders for its
 * own reasons, so the only shape that can say "that was another one" is a
 * number that goes up. It never resets while the window lives, so a reader
 * wanting presses since some moment of its own takes the value at that moment
 * and subtracts.
 *
 * **The control travels with it.** A count alone says a chord was pressed and
 * not which one, and the card lighting a chip has to know: a press made on the
 * share beat that is still crossing when the run walks on would otherwise light
 * the mute beat's chip for a key nobody pressed on it.
 */
export interface IntroCallChordState {
  presses: number;
  /** Which control the last press was for, or null before there has been one. */
  control: CompanionIntroCallControl | null;
}

export interface IntroCallChordActions {
  /** Count one press of a control's chord. Called only while a beat asks. */
  countPress: (control: CompanionIntroCallControl) => void;
}

export type IntroCallChordStore = IntroCallChordState & IntroCallChordActions;

const useIntroCallChordStoreBase = create<IntroCallChordStore>()((set) => ({
  presses: 0,
  control: null,
  countPress: (control) => {
    set((state) => ({ presses: state.presses + 1, control }));
  },
}));

export const useIntroCallChordStore = createSelectors(
  useIntroCallChordStoreBase,
);
