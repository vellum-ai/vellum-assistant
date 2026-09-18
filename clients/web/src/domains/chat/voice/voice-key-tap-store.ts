import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * How many taps of the voice key landed while the companion's introduction was
 * running, since this window loaded.
 *
 * A tap drives nothing (see `voice-key-gestures`), so nothing in this window
 * has ever had to notice one. The companion's introduction does: it draws a
 * picture of the key and asks for a double tap, and a cap that sat still while
 * the user pressed the real key would be a card teaching a key that looks
 * broken. The window that owns the binding is this one, so this is where the
 * touch is counted, and the count travels to the surface with everything else
 * the surface cannot see for itself (`use-companion-mirror`).
 *
 * **Only during a run**, which is the gate `global-push-to-talk-bridge` holds
 * in front of `countTap`. The introduction is the only reader there has ever
 * been and it happens once, while Fn is the globe key that a macOS user reaches
 * for all day. Every move of this store is a full companion push, so counting
 * outside a run is paid for forever by the one surface that stopped watching.
 * The gate sits on the count and not on the publish so that nothing accumulates
 * behind a closed door: a run always starts from where the last one left off,
 * never from a total gathered while nobody was looking.
 *
 * **A running count rather than a flag.** It crosses a process boundary and is
 * drawn by a renderer that re-renders for its own reasons, so the only shape
 * that can say "that was another one" is a number that goes up. The same
 * bargain `captureCount` makes. It never resets while the window lives, so a
 * reader that wants taps since some moment of its own takes the value at that
 * moment and subtracts, and treats a count below the one it kept as a window
 * that reloaded underneath it. A second run therefore opens on whatever the
 * first one left behind, which is why every reader baselines rather than
 * expecting a zero.
 */
export interface VoiceKeyTapState {
  taps: number;
}

export interface VoiceKeyTapActions {
  /** Count one touch of the key. Called only while a run is up. */
  countTap: () => void;
}

export type VoiceKeyTapStore = VoiceKeyTapState & VoiceKeyTapActions;

const useVoiceKeyTapStoreBase = create<VoiceKeyTapStore>()((set) => ({
  taps: 0,
  countTap: () => {
    set((state) => ({ taps: state.taps + 1 }));
  },
}));

export const useVoiceKeyTapStore = createSelectors(useVoiceKeyTapStoreBase);
