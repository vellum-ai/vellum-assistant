/**
 * Who is talking, for the camera-mode status pill's dot.
 *
 * The assistant half is exact: the session's `speaking` phase gated on audio
 * actually flowing, the same pairing `toVoiceAvatarVisual` uses so the dot and
 * the room's other cast never disagree about whether a turn is audible.
 *
 * The user half has no exact signal to read. The session's own VAD boundaries
 * (`speech_started` / `utterance_end`) stay inside `use-live-voice.ts` as a
 * ref, so nothing is published for a surface to read, and thresholding the
 * amplitude is the closest stand-in. It is polled on a coarse interval rather
 * than per frame, and the boolean only moves when the thresholded value
 * crosses: a dot that blinks on a 1.5s CSS keyframe needs to know *whether* a
 * voice is active, not how loud it is, and driving a decorative loop through
 * React state is exactly what CONVENTIONS.md (LUM-2859) forbids.
 */

import { useEffect, useState } from "react";

import {
  getLiveVoiceInputAmplitude,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

/**
 * Whose voice the pill's dot is reporting. `assistant` outranks `user`, and
 * everything with no voice in it (connecting, transcribing, thinking) is
 * `idle`: none of them has a voice in the room, so a static dot beside the
 * session's own status word stays true.
 */
export type CameraVoiceState = "idle" | "user" | "assistant";

/**
 * Mic amplitude (the store's smoothed [0, 1] value) above which the dot counts
 * the user as talking. The session's own barge-in threshold, which is the
 * louder of the two levels `use-live-voice.ts` works in and therefore the one
 * that survives a 250ms sample without blinking at room noise.
 */
const USER_SPEAKING_AMPLITUDE = 0.05;

/** Sample spacing. Four samples a second is a dot, not a waveform. */
const POLL_MS = 250;

export function useCameraVoiceState(
  state: LiveVoiceSessionState,
  assistantAudioActive: boolean,
  /** False while the camera is closed: nothing renders the dot, so don't poll. */
  enabled: boolean,
): CameraVoiceState {
  const listening = enabled && state === "listening";
  const [userSpeaking, setUserSpeaking] = useState(false);

  useEffect(() => {
    if (!listening) {
      setUserSpeaking(false);
      return;
    }
    const id = window.setInterval(() => {
      const speaking = getLiveVoiceInputAmplitude() >= USER_SPEAKING_AMPLITUDE;
      // Same value in means the same value out, which React bails out on, so a
      // steady voice (or a steady silence) costs no renders at all.
      setUserSpeaking((was) => (was === speaking ? was : speaking));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [listening]);

  if (state === "speaking" && assistantAudioActive) {
    return "assistant";
  }
  return listening && userSpeaking ? "user" : "idle";
}
