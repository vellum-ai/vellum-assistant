/**
 * Who is talking, for the camera-mode status pill's dot.
 *
 * Both halves are the session's own signals, so the dot never claims a voice
 * the session does not have. The assistant half is the `speaking` phase gated
 * on audio actually flowing, the same pairing `toVoiceAvatarVisual` uses so the
 * dot and the room's other cast never disagree about whether a turn is audible.
 * The user half is the server VAD's utterance boundary, published by the
 * controller as the store's `utteranceOpen`: the same signal that decides when
 * the user's turn ends.
 *
 * The mute check is not redundant with it. Muting streams silence rather than
 * closing the socket, so an utterance the user was mid-way through stays open
 * until the VAD's silence window expires, and for that window the dot would say
 * the user is talking beside a label that reads "Muted".
 */

import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

/**
 * Whose voice the pill's dot is reporting. `assistant` outranks `user`, and
 * everything with no voice in it (connecting, transcribing, thinking) is
 * `idle`: none of them has a voice in the room, so a static dot beside the
 * session's own status word stays true.
 */
export type CameraVoiceState = "idle" | "user" | "assistant";

export function useCameraVoiceState(
  state: LiveVoiceSessionState,
  assistantAudioActive: boolean,
  /** False while the camera is closed: nothing renders the dot. */
  enabled: boolean,
): CameraVoiceState {
  const utteranceOpen = useLiveVoiceStore.use.utteranceOpen();
  const muted = useLiveVoiceStore.use.muted();

  if (state === "speaking" && assistantAudioActive) {
    return "assistant";
  }
  if (enabled && state === "listening" && utteranceOpen && !muted) {
    return "user";
  }
  return "idle";
}
