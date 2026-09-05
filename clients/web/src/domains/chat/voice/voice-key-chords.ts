/**
 * The two gestures the voice key carries besides its own: show the assistant
 * a screen, and draw on what it is being shown.
 *
 * Both are controls the companion's call row already draws, and both are
 * needed most by someone who is not looking at the companion: the surface
 * worth showing is the one in front of them, and reaching for the pill means
 * leaving it. So they are chords on the key that already starts the call,
 * held from wherever the user is working.
 *
 * The letters are the app's, not the host's. The helper is told which keys to
 * name and takes those presses; what they mean is decided here.
 */

import {
  setCompanionScreenShare,
  toggleCompanionAnnotating,
} from "@/runtime/companion-surface";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { expectScreenShare } from "@/domains/chat/voice/live-voice/pending-screen-share";
import {
  startVoiceFromSurface,
  type VoiceStartNavigate,
} from "@/domains/chat/voice/live-voice/start-voice-request";

/** Share the screen the pointer is on, or stop the share that is running. */
export const VOICE_KEY_SHARE_CHORD = "s";

/** Draw on the shared surface, or give the mouse back to the desktop. */
export const VOICE_KEY_DRAW_CHORD = "d";

/**
 * The keys the host is asked to name and to take. Only these: a chord is
 * swallowed on the strength of being one of them, and every key not here is
 * still the front app's.
 */
export const VOICE_KEY_CHORD_KEYS = [
  VOICE_KEY_SHARE_CHORD,
  VOICE_KEY_DRAW_CHORD,
] as const;

/**
 * Show the assistant the screen the pointer is on, or stop showing it.
 *
 * One press for both directions, the way the double tap is one press for
 * starting and ending a call: the user pressing this is in another
 * application, and the control that would undo it is on a surface they are
 * not looking at.
 *
 * **With no call, this starts one.** The gesture means show the assistant
 * this, which is a call and a share; asking the user to make the call first
 * would be asking them for the half of it they did not have in mind. The
 * target is resolved now and waits for the session
 * ({@link expectScreenShare}), so what is shared is what they were pointing
 * at when they asked.
 */
function toggleShare(navigate: VoiceStartNavigate): void {
  const store = useLiveVoiceStore.getState();
  if (store.screenShareTarget !== null) {
    setCompanionScreenShare();
    return;
  }
  const calling = isLiveVoiceSessionActive(store.state);
  if (!calling) {
    expectScreenShare();
  }
  setCompanionScreenShare({ kind: "pointerDisplay" });
  if (!calling) {
    startVoiceFromSurface(navigate, { entry: "voice_key" });
  }
}

/**
 * Act on a chord the host named.
 *
 * A key that is none of ours does nothing rather than throwing: the host was
 * asked to name two keys, and a third arriving means the two sides disagree
 * about which, which is a reason to leave the user's press alone.
 */
export function handleVoiceKeyChord(
  key: string,
  navigate: VoiceStartNavigate,
): void {
  if (key === VOICE_KEY_SHARE_CHORD) {
    toggleShare(navigate);
    return;
  }
  if (key === VOICE_KEY_DRAW_CHORD) {
    // Main's to flip: it holds the mode, and it is the side that knows
    // whether there is a shared surface to draw on at all.
    toggleCompanionAnnotating();
  }
}
