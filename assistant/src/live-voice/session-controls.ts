import {
  END_CALL_MARKER,
  MUTE_MARKER,
  parseTerminalSessionControl,
  type SessionControlRequest,
} from "../calls/voice-control-protocol.js";
import type { LiveVoiceSessionControl } from "./protocol.js";

/**
 * Spoken session controls: the user asks out loud to end the call or mute
 * their microphone, the reply acknowledges it and ends with a marker, and the
 * session sends a `session_control` frame once that acknowledgement has been
 * spoken.
 *
 * A marker rather than a tool, because these are the turns a front-door leg
 * answers on its own: "okay, I'm gonna go" should not wait on an escalation to
 * a stronger model before the call can end. The marker is judged by the
 * model, never by matching the user's words, so "I'm all done with that
 * email" does not hang up.
 */

const CONTROL_LINES: Record<LiveVoiceSessionControl, string> = {
  end: `- To end the call (for example "I'm all done" or "okay, I'm gonna go"), say a brief goodbye, then end your reply with ${END_CALL_MARKER}. Being done with a task is not the same as leaving the call; end only when they are leaving.`,
  mute: `- To mute their microphone (for example "mute for 30 seconds" or "mute yourself, I need to take this"), confirm in a few words, then end your reply with [MUTE:<seconds>] when they gave a duration or ${MUTE_MARKER} when they did not. While muted you cannot hear them, so mention they can unmute from the call controls unless the mute is timed.`,
};

/**
 * The control-prompt block that teaches the controls the client declared.
 * Every leg gets it, including the toolless front-door leg: these turns are
 * its to answer.
 *
 * The no-other-markers rule is withheld from the front-door leg, whose
 * routing rule teaches it leading verdict tokens and already confines
 * everything else to speech.
 */
export function sessionControlTeaching(
  controls: readonly LiveVoiceSessionControl[],
  leg: { frontDoor?: boolean },
): string {
  const noOtherMarkers = leg.frontDoor !== true;
  if (controls.length === 0) {
    return noOtherMarkers ? "Never emit bracketed markers of any kind. " : "";
  }
  return [
    "The user can also control this call by asking you. Only when they clearly ask:",
    ...controls.map((control) => CONTROL_LINES[control]),
    `The marker must be the very last thing in your reply. It is never spoken and does nothing anywhere else.${noOtherMarkers ? " Never emit any other bracketed marker." : ""}`,
  ].join("\n");
}

/**
 * The control a completed leg's raw text asks for, when the client declared
 * it; null otherwise. An undeclared control is dropped rather than sent: the
 * client said it cannot carry it out.
 */
export function requestedSessionControl(
  rawText: string,
  controls: readonly LiveVoiceSessionControl[],
): SessionControlRequest | null {
  const request = parseTerminalSessionControl(rawText);
  return request !== null && controls.includes(request.action) ? request : null;
}
