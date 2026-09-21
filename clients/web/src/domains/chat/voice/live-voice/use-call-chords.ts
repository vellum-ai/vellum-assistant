/**
 * Owns this window's chord binding: the call's chords for exactly as long as
 * there is a call to answer them, handing each press to
 * {@link handleCallChord}, and the introduction's one key for exactly as long
 * as a card is asking for it.
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
 *
 * **One binding, one owner.** The companion's introduction also wants a chord
 * heard: three of its beats draw a call control beside the shortcut for it, and
 * the card lights when the real keys are pressed. The host holds one chord
 * binding per window, so that cannot be a second hook writing
 * `setChordBinding`: the run ends by starting a real call, and two effects
 * arming and releasing around that moment would take turns clearing each
 * other's. So the two live here, in one effect, which computes what should be
 * armed and is the only thing that ever arms it.
 *
 * **The call wins whenever there is one.** A real session is the one thing
 * here whose chords do something, so while it runs the binding is its own and
 * every press goes to {@link handleCallChord}. The introduction's chord is
 * armed only in the gaps, which is where its beats actually live: the run is
 * the demonstration of a call, drawn while there is none.
 */

import { useEffect } from "react";

import {
  callChords,
  handleCallChord,
} from "@/domains/chat/voice/live-voice/call-chords";
import {
  countIntroCallChord,
  introCallChord,
} from "@/domains/chat/voice/live-voice/intro-call-chords";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { liveVoiceCanBeShownTheScreen } from "@/domains/chat/voice/live-voice/screen-share-availability";
import { useCompanionIntroChord } from "@/runtime/companion-intro-chord";
import {
  setChordBinding,
  subscribeToHotkeyEvents,
  supportsChords,
} from "@/runtime/hotkey";

export function useCallChords(): void {
  // Subscribed through the store so the binding follows the session. The
  // mutes are armed for the whole of a call; the share and the pen join them
  // on the shared conjunction, so they are armed exactly when the pill's own
  // Share control is: a chord that could do nothing is a key taken for nothing.
  const onCall = useLiveVoiceStore((session) =>
    isLiveVoiceSessionActive(session.state),
  );
  const canBeShownTheScreen = useLiveVoiceStore(() =>
    liveVoiceCanBeShownTheScreen(),
  );
  // Which control the introduction is asking for a chord for, from main, which
  // is the side that holds the beat. Null on every beat that asks for none, on
  // every launch after the run, and everywhere there is no companion at all.
  const introControl = useCompanionIntroChord();

  useEffect(() => {
    // The call's four keys, or the one key a card is asking for, or nothing.
    // Read once here rather than in the subscription, so what is armed and
    // what a press means are decided together and cannot disagree.
    const binding = onCall
      ? callChords(canBeShownTheScreen)
      : introControl !== null
        ? introCallChord(introControl)
        : null;
    if (binding === null || !supportsChords()) {
      return;
    }

    const unsubscribe = subscribeToHotkeyEvents((event) => {
      if (event.kind !== "chord" || event.key === undefined) {
        return;
      }
      if (onCall) {
        handleCallChord(event.key);
        return;
      }
      // Counted, and nothing else: the beat's pill is a drawing of a call with
      // no session behind it, so there is nothing for the press to do. The
      // count is what lets the card show the shortcut answering while it is
      // teaching that shortcut, the same errand a tap of the voice key runs.
      if (introControl !== null) {
        countIntroCallChord(introControl, event.key);
      }
    });
    void setChordBinding(binding);

    return () => {
      unsubscribe();
      // Cleared on the way out rather than left to the next binding to
      // overwrite: between the two, a press of these keys is the user's own.
      //
      // This clears whatever *this* effect armed, and the effect that replaces
      // it arms what should be armed now, so the hand-over between the run and
      // a call is a release followed by an arm in that order and never the
      // reverse: a commit runs every cleanup before any effect, and a change
      // arriving in a later commit re-runs this one from the top. What it
      // costs when the beat and the call move separately is one release and
      // one re-arm of the same binding, which is what a call being shown the
      // screen mid-session has always cost.
      void setChordBinding({ kind: "off" });
    };
  }, [onCall, canBeShownTheScreen, introControl]);
}
