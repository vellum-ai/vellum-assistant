/**
 * Arms the call's chords for exactly as long as there is a call to answer
 * them, and hands each press to {@link handleCallChord}.
 *
 * The window that arms them is the window holding the session, which is where
 * the host sends them back: a chord means something to that renderer and to no
 * other, so a pop-out in front cannot take a press meant for the call.
 *
 * The binding is the thing that has to be scoped, not the handler. While it is
 * armed the host *takes* these presses, so Option+S reaches nothing else on
 * the desktop; outside a call the keys go back to being the user's own, which
 * is the whole reason this is a hook over the session and not a registration
 * made once at launch.
 */

import { useEffect } from "react";

import {
  handleCallChord,
  CALL_CHORDS,
} from "@/domains/chat/voice/live-voice/call-chords";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { liveVoiceCanBeShownTheScreen } from "@/domains/chat/voice/live-voice/screen-share-availability";
import {
  setChordBinding,
  subscribeToHotkeyEvents,
  supportsChords,
} from "@/runtime/hotkey";

export function useCallChords(): void {
  // Subscribed through the store so the binding follows the session, and read
  // through the shared conjunction so it is armed exactly when the pill's own
  // Share control is: a chord that could do nothing is a key taken for nothing.
  const onCall = useLiveVoiceStore(() => liveVoiceCanBeShownTheScreen());

  useEffect(() => {
    if (!onCall || !supportsChords()) {
      return;
    }

    const unsubscribe = subscribeToHotkeyEvents((event) => {
      if (event.kind !== "chord" || event.key === undefined) {
        return;
      }
      handleCallChord(event.key);
    });
    void setChordBinding(CALL_CHORDS);

    return () => {
      unsubscribe();
      // Cleared on the way out rather than left to the next call to overwrite:
      // between the two, a press of these keys is the user's own.
      void setChordBinding({ kind: "off" });
    };
  }, [onCall]);
}
