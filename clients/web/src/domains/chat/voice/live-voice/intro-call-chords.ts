/**
 * The one chord the companion's introduction asks for, and what a press of it
 * amounts to.
 *
 * Three beats of the run draw a call control beside the shortcut that reaches
 * it, and a chip that stayed grey while the user pressed the real keys would be
 * a card teaching a shortcut that looks broken, which is the same argument the
 * drawn keycap answers the voice key with.
 *
 * **One key at a time, and only the one on the card.** The call arms four
 * (`call-chords`), because a call offers four; a beat offers one, and while a
 * binding is armed the host takes those presses, so Option+S reaches nothing
 * else the user has it bound to. Arming the beat's own key is the narrowest
 * thing that can answer the card, and it makes a press that arrives
 * self-evidently the press the card asked for.
 *
 * **Nothing is performed.** The beat draws a demonstration rather than a call,
 * with every handler on the pill withheld (`companion-surface-page`), so
 * `handleCallChord` has nothing to act on and is deliberately not reached from
 * here: both halves of the card's Click/Shortcut pair are pictures of a
 * control. The press is counted and that is all.
 */

import type {
  ChordBinding,
  CompanionIntroCallControl,
} from "@vellumai/ipc-contract";

import {
  CALL_DRAW_KEY,
  CALL_MUTE_MIC_KEY,
  CALL_SHARE_KEY,
} from "@/domains/chat/voice/live-voice/call-chord-keys";
import { useIntroCallChordStore } from "@/domains/chat/voice/intro-call-chord-store";

/**
 * The key each beat's card prints, from the constants the call itself is armed
 * with, so the card cannot teach a key the call does not answer.
 *
 * The mute beat draws the microphone and its key alone. The call also mutes
 * the assistant under Option+A, but that is a second control on one card, and
 * the run gives each control a card of its own.
 */
export const INTRO_CALL_CHORD_KEYS = {
  share: CALL_SHARE_KEY,
  draw: CALL_DRAW_KEY,
  mute: CALL_MUTE_MIC_KEY,
} as const satisfies Record<CompanionIntroCallControl, string>;

/** What a beat asking for a control listens for: Option and its one key. */
export function introCallChord(
  control: CompanionIntroCallControl,
): ChordBinding {
  return {
    kind: "chord",
    modifiers: ["option"],
    keys: [INTRO_CALL_CHORD_KEYS[control]],
  };
}

/**
 * Count a chord the host reported against the control the beat is asking for.
 *
 * A key that is not that control's does nothing rather than throwing, the way
 * `handleCallChord` treats one: only that key was armed, so another arriving
 * means the two sides disagree about the binding, which is a reason to leave
 * the press alone rather than to light a chip with it.
 */
export function countIntroCallChord(
  control: CompanionIntroCallControl,
  key: string,
): void {
  if (key !== INTRO_CALL_CHORD_KEYS[control]) {
    return;
  }
  useIntroCallChordStore.getState().countPress(control);
}
