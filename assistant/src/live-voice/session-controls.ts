import {
  END_CALL_MARKER,
  FEWER_UPDATES_MARKER,
  LOOK_CAMERA_MARKER,
  LOOK_SCREEN_MARKER,
  LOOK_STOP_MARKER,
  MUTE_MARKER,
  NORMAL_UPDATES_MARKER,
  parseTerminalSessionControl,
  type SessionControlRequest,
} from "../calls/voice-control-protocol.js";
import type { VoiceProgressConfig } from "../config/schemas/voice.js";
import type { LiveVoiceSessionControl } from "./protocol.js";

/**
 * Spoken session controls: the user asks out loud to end the call, mute their
 * microphone, or hear fewer progress updates, the reply acknowledges it and
 * ends with a marker, and the session carries it out once that
 * acknowledgement has been spoken.
 *
 * A marker rather than a tool, because these are the turns a front-door leg
 * answers on its own: "okay, I'm gonna go" should not wait on an escalation to
 * a stronger model before the call can end. The marker is judged by the
 * model, never by matching the user's words, so "I'm all done with that
 * email" does not hang up.
 */

const CLIENT_CONTROL_LINES: Record<LiveVoiceSessionControl, string> = {
  end: `- To end the call (for example "I'm all done" or "okay, I'm gonna go"), say a brief goodbye, then end your reply with ${END_CALL_MARKER}. Being done with a task is not the same as leaving the call; end only when they are leaving.`,
  look_screen: `- To look at their screen (for example "take a look at my screen" or "can you see what I'm looking at?"), say you are taking a look, then end your reply with ${LOOK_SCREEN_MARKER}. Their screen starts being shared with you once you finish speaking, so you cannot describe it yet: ask what they want you to look at, or say you will take it from their next words.`,
  look_camera: `- To look through their camera (for example "look at this" or "can you see this?" while they hold something up), say you are taking a look, then end your reply with ${LOOK_CAMERA_MARKER}. The camera turns on once you finish speaking, so you cannot describe what it sees yet: ask them to show you, or say you will take it from their next words.`,
  look_stop: `- To stop showing you their screen or camera (for example "stop sharing" or "you can stop looking now"), confirm in a few words, then end your reply with ${LOOK_STOP_MARKER}.`,
  mute: `- To mute their microphone (for example "mute for 30 seconds" or "mute yourself, I need to take this"), confirm in a few words, then end your reply with [MUTE:<seconds>] when they gave a duration or ${MUTE_MARKER} when they did not. While muted you cannot hear them, so mention they can unmute from the call controls unless the mute is timed.`,
};

// Always taught: narration is the session's own, so no client has to be able
// to carry it out.
const UPDATES_LINE = `- To hear fewer spoken progress updates while you work (for example "don't give me updates so often"), confirm that you will only check in now and then and will tell them when it is done, then end your reply with ${FEWER_UPDATES_MARKER}. If they later want regular updates back, confirm and end with ${NORMAL_UPDATES_MARKER}.`;

/**
 * The control-prompt block that teaches the session controls: the ones the
 * client declared plus the progress-update cadence. Every leg gets it,
 * including the toolless front-door leg: these turns are its to answer.
 *
 * The no-other-markers rule is withheld from the front-door leg, whose
 * routing rule teaches it leading verdict tokens and already confines
 * everything else to speech.
 */
export function sessionControlTeaching(
  controls: readonly LiveVoiceSessionControl[],
  leg: { frontDoor?: boolean },
): string {
  return [
    "The user can also control this call by asking you. Only when they clearly ask:",
    ...controls.map((control) => CLIENT_CONTROL_LINES[control]),
    ...lookGuidance(controls),
    UPDATES_LINE,
    `The marker must be the very last thing in your reply. It is never spoken and does nothing anywhere else.${leg.frontDoor === true ? "" : " Never emit any other bracketed marker."}`,
  ].join("\n");
}

/**
 * What to say about looking beyond the per-control lines: ask which when the
 * device can do both and the request does not say, and say so plainly when it
 * can do neither, rather than failing silently.
 */
function lookGuidance(controls: readonly LiveVoiceSessionControl[]): string[] {
  const screen = controls.includes("look_screen");
  const camera = controls.includes("look_camera");
  if (screen && camera) {
    return [
      `- If they just say "take a look" and it is not clear whether they mean their screen or their camera, ask which one instead of guessing, and use no marker until they answer.`,
    ];
  }
  if (!screen && !camera) {
    return [
      "- This call cannot turn on a screen share or the camera. If they ask you to look at their screen or at something and you have no other way to see it, say so briefly instead of pretending to look.",
    ];
  }
  return [];
}

/** A session control the client carries out, sent as a `session_control` frame. */
export type ClientSessionControlRequest = Exclude<
  SessionControlRequest,
  { action: "updates" }
>;

/**
 * The control a completed leg's raw text asks for; null when there is none or
 * when it is a client control the client did not declare. An undeclared
 * control is dropped rather than sent: the client said it cannot carry it out.
 * The update cadence always passes, since the session carries it out itself.
 */
export function requestedSessionControl(
  rawText: string,
  controls: readonly LiveVoiceSessionControl[],
): SessionControlRequest | null {
  const request = parseTerminalSessionControl(rawText);
  if (request === null) {
    return null;
  }
  if (request.action === "updates") {
    return request;
  }
  return controls.includes(request.action) ? request : null;
}

/**
 * Silence (ms) a session that asked for fewer updates waits through before a
 * progress update. Long enough that a minute-long task runs without a word;
 * short enough that a really long one still proves the call is alive.
 */
export const FEWER_UPDATES_INTERVAL_MS = 60_000;

/**
 * The progress config a turn runs on under the session's update cadence.
 *
 * Fewer updates means no update for tool activity (a burst of ops or a long
 * op finishing, each normally its own beat) and the silence tick stretched to
 * {@link FEWER_UPDATES_INTERVAL_MS}, so the only thing that speaks is a long
 * stretch of silence. Done is still said: the reply itself is the "it's done".
 */
export function progressConfigForCadence(
  config: VoiceProgressConfig,
  cadence: "fewer" | "normal",
): VoiceProgressConfig {
  if (cadence === "normal") {
    return config;
  }
  const intervalMs = Math.max(FEWER_UPDATES_INTERVAL_MS, config.maxSilenceMs);
  return {
    ...config,
    opsThreshold: Number.MAX_SAFE_INTEGER,
    longOpMs: Number.MAX_SAFE_INTEGER,
    idleIntervalMs: intervalMs,
    maxSilenceMs: intervalMs,
  };
}
