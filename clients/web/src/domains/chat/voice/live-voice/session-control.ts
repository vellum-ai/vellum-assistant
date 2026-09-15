/**
 * Carries out a session control the user asked for out loud ("okay, I'm
 * gonna go", "mute for 30 seconds"). The assistant decides; this only acts,
 * through the same store controls the end and mute buttons use, so a spoken
 * mute and a pressed one are the same mute.
 *
 * The timed unmute lives here rather than in the assistant because a muted
 * mic sends silence: nothing upstream can hear the user ask to unmute, so the
 * timer has to be the client's.
 */

import type { LiveVoiceSessionControlServerFrame } from "@/domains/chat/voice/live-voice/protocol";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  setLiveVoiceMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";

interface TimedUnmute {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly unsubscribe: () => void;
}

let pendingUnmute: TimedUnmute | null = null;

function cancelTimedUnmute(): void {
  if (pendingUnmute === null) {
    return;
  }
  clearTimeout(pendingUnmute.timer);
  pendingUnmute.unsubscribe();
  pendingUnmute = null;
}

/**
 * Unmute once `durationMs` elapses, unless the mute is no longer the one this
 * timer was set for. Anything the user does to the mic in between (unmuting
 * by hand, and so any later mute too) or the session ending cancels it: a
 * timer must never unmute a mic the user chose to mute themselves.
 */
function scheduleTimedUnmute(durationMs: number): void {
  const unsubscribe = useLiveVoiceStore.subscribe((state) => {
    if (!state.muted || !isLiveVoiceSessionActive(state.state)) {
      cancelTimedUnmute();
    }
  });
  const timer = setTimeout(() => {
    cancelTimedUnmute();
    setLiveVoiceMuted(false);
  }, durationMs);
  pendingUnmute = { timer, unsubscribe };
}

export function applyLiveVoiceSessionControl(
  frame: Pick<LiveVoiceSessionControlServerFrame, "action" | "durationMs">,
): void {
  switch (frame.action) {
    case "end":
      cancelTimedUnmute();
      endLiveVoiceSession();
      return;
    case "mute": {
      // A newer mute replaces an older timer, timed or not: the latest ask is
      // the one the user heard confirmed.
      cancelTimedUnmute();
      setLiveVoiceMuted(true);
      const { durationMs } = frame;
      if (
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs > 0 &&
        useLiveVoiceStore.getState().muted
      ) {
        scheduleTimedUnmute(durationMs);
      }
      return;
    }
    default:
      // A control this client does not know; nothing to do.
      return;
  }
}
