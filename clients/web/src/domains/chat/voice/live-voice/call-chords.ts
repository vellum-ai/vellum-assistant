/**
 * The keyboard's version of the call row's controls: show the assistant a
 * screen, draw on what it is being shown, and mute either side of the call.
 *
 * All four are on the companion's call row, and the call row is on a surface
 * the user is looking away from while a call runs: the screen worth showing is
 * the one in front of them, and reaching for the pill means leaving it. So all
 * four are reachable from wherever they are working.
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
  CALL_DRAW_KEY,
  CALL_MUTE_ASSISTANT_KEY,
  CALL_MUTE_MIC_KEY,
  CALL_SHARE_KEY,
} from "@/domains/chat/voice/live-voice/call-chord-keys";
import {
  isLiveVoiceSessionActive,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { liveVoiceCanBeShownTheScreen } from "@/domains/chat/voice/live-voice/screen-share-availability";
import {
  setCompanionScreenShare,
  toggleCompanionAnnotating,
} from "@/runtime/companion-surface";

/**
 * What a call listens for.
 *
 * Option alone, because a chord under it is deliberate enough not to be made
 * by accident and short enough to make while talking. Exactly Option: the host
 * lets Option+Shift+S past, so the shortcuts the user already has under those
 * combinations keep working.
 *
 * The mutes for any call, the share and the pen only for a call that can be
 * shown the screen: a key taken for a control the row does not offer is a key
 * taken for nothing, and the pill offers Share on exactly this answer.
 */
export function callChords(canBeShownTheScreen: boolean): ChordBinding {
  return {
    kind: "chord",
    modifiers: ["option"],
    keys: canBeShownTheScreen
      ? [
          CALL_SHARE_KEY,
          CALL_DRAW_KEY,
          CALL_MUTE_MIC_KEY,
          CALL_MUTE_ASSISTANT_KEY,
        ]
      : [CALL_MUTE_MIC_KEY, CALL_MUTE_ASSISTANT_KEY],
  };
}

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
 * and a press landing in it belongs to whatever the user has moved on to. The
 * share and the pen are refused the same way once the call can no longer be
 * shown the screen, for the same gap.
 *
 * A key that is none of ours does nothing rather than throwing: the host was
 * asked for a fixed set, and another arriving means the two sides disagree
 * about which, which is a reason to leave the press alone.
 */
export function handleCallChord(key: string): void {
  const session = useLiveVoiceStore.getState();
  if (!isLiveVoiceSessionActive(session.state)) {
    return;
  }
  if (key === CALL_MUTE_MIC_KEY) {
    setLiveVoiceMuted(!session.muted);
    return;
  }
  if (key === CALL_MUTE_ASSISTANT_KEY) {
    setLiveVoiceOutputMuted(!session.outputMuted);
    return;
  }
  if (!liveVoiceCanBeShownTheScreen()) {
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
