/**
 * The keyboard's version of the two in-call controls: show the assistant a
 * screen, and draw on what it is being shown.
 *
 * Both are on the companion's call row, and the call row is on a surface the
 * user is looking away from while a call runs: the screen worth showing is the
 * one in front of them, and reaching for the pill means leaving it. So both
 * are reachable from wherever they are working.
 *
 * **Option, not the voice key.** The voice key is call control (tap, hold,
 * double tap) and these are things a call does, so they are a family of their
 * own with no gesture in common. Nothing here is armed unless a session is
 * running, which is also what makes taking Option+S reasonable: the rest of
 * the time it is the user's own key, doing whatever their keyboard says it
 * does.
 */

import type { ChordBinding } from "@vellumai/ipc-contract";

import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  setCompanionScreenShare,
  toggleCompanionAnnotating,
} from "@/runtime/companion-surface";

/** Share the screen the pointer is on, or stop the share that is running. */
export const CALL_SHARE_KEY = "s";

/** Draw on the shared surface, or give the mouse back to the desktop. */
export const CALL_DRAW_KEY = "d";

/**
 * What a call listens for.
 *
 * Option alone, because a chord under it is deliberate enough not to be made
 * by accident and short enough to make while talking. Exactly Option: the host
 * lets Option+Shift+S past, so the shortcuts the user already has under those
 * combinations keep working.
 */
export const CALL_CHORDS: ChordBinding = {
  kind: "chord",
  modifiers: ["option"],
  keys: [CALL_SHARE_KEY, CALL_DRAW_KEY],
};

/**
 * Show the assistant the screen the pointer is on, or stop showing it.
 *
 * One press for both directions, the way the voice key's double tap is one
 * press for starting and ending a call: the user pressing this is in another
 * application, and the control that would undo it is on a surface they are not
 * looking at.
 *
 * The pointer's display is named as the question rather than answered here.
 * Where the mouse is belongs to the host, at the moment the press lands.
 */
function toggleShare(): void {
  if (useLiveVoiceStore.getState().screenShareTarget !== null) {
    setCompanionScreenShare();
    return;
  }
  setCompanionScreenShare({ kind: "pointerDisplay" });
}

/**
 * Act on a chord the host reported.
 *
 * Refused with no session running. The binding is armed only while there is
 * one, so this is the gap between a call ending and the host hearing about it,
 * and a press landing in it belongs to whatever the user has moved on to.
 *
 * A key that is neither of ours does nothing rather than throwing: the host
 * was asked for two, and a third arriving means the two sides disagree about
 * which, which is a reason to leave the press alone.
 */
export function handleCallChord(key: string): void {
  if (!isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    return;
  }
  if (key === CALL_SHARE_KEY) {
    toggleShare();
    return;
  }
  if (key === CALL_DRAW_KEY) {
    // Main's to flip: it holds the mode, and it is the side that knows whether
    // there is a shared surface to draw on at all.
    toggleCompanionAnnotating();
  }
}
