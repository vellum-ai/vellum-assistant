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
 * timer was set for. The user unmuting by hand (and so any later mute too) or
 * the session ending cancels it: a timer must never unmute a mic the user
 * chose to mute themselves.
 *
 * **An unmute is the flag flipping inside a running session.** A hands-free
 * reconnect also clears the flag, in a reset that takes the session through
 * `idle` before restoring the carried-over mute, so a timer that read "not
 * muted" as the user unmuting would drop itself on every socket blip and leave
 * a timed mute muted for good. The logical session is its
 * `sessionGeneration`, which a reconnect keeps and a real end bumps.
 *
 * The reset also clears the registered controls, so a timer that lands in a
 * reconnect gap writes the flag itself; the store-backed flag is what the
 * capture reads and what the next connect carries over.
 */
function scheduleTimedUnmute(durationMs: number): void {
  const generation = useLiveVoiceStore.getState().sessionGeneration;
  const unsubscribe = useLiveVoiceStore.subscribe((state, previous) => {
    if (state.sessionGeneration !== generation) {
      cancelTimedUnmute();
      return;
    }
    const unmutedByHand =
      previous.muted &&
      !state.muted &&
      isLiveVoiceSessionActive(previous.state) &&
      isLiveVoiceSessionActive(state.state);
    if (unmutedByHand) {
      cancelTimedUnmute();
    }
  });
  const timer = setTimeout(() => {
    cancelTimedUnmute();
    const store = useLiveVoiceStore.getState();
    if (store.controls) {
      setLiveVoiceMuted(false);
    } else {
      store.setMuted(false);
    }
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
