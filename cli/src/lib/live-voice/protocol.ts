/**
 * Live-voice wire contract, as much of it as a microphone-less client needs.
 *
 * Ported from `assistant/src/live-voice/protocol.ts`, the same way
 * `clients/web/src/domains/chat/voice/live-voice/protocol.ts` is: the CLI ships
 * as an npm package and nothing outside `cli/` lands in the tarball, so the
 * daemon's copy cannot be imported. Deliberately a subset rather than a full
 * port. This client never captures audio, so the capture half of the protocol
 * (`audio`, `ptt_release`, `speech_started`, `utterance_end`, the `stt_*`
 * frames) is absent instead of present and unreachable.
 *
 * The one thing that must not drift is what goes *out*. Frames the daemon
 * validates strictly are spelled out in full below; frames it sends are parsed
 * leniently, so a newer daemon adding fields never breaks an older CLI.
 */

/**
 * Capture format, declared on the `start` frame.
 *
 * A client with no microphone still has to state one: `audio` is required on
 * the start frame, and the session sizes its transcriber against it whether or
 * not a byte ever arrives. Mirrors the daemon's canonical
 * `LIVE_VOICE_AUDIO_FORMAT`.
 */
export const LIVE_VOICE_AUDIO_FORMAT = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
} as const;

/** Longest typed turn the daemon accepts on a `text` frame. */
export const MAX_TEXT_TURN_CHARS = 4_000;

export interface LiveVoiceStartFrame {
  readonly type: "start";
  readonly audio: typeof LIVE_VOICE_AUDIO_FORMAT;
  readonly conversationId?: string;
  /**
   * Always true from this client, and load-bearing rather than informational:
   * it is what lets a session whose speech-to-text leg has no working
   * credential open text-only (`ready.audioInput: false`) instead of being
   * refused outright with `credentials_unavailable`. A CLI that cannot hear
   * loses nothing: it was never going to listen.
   */
  readonly textInput: true;
}

export interface LiveVoiceTextFrame {
  readonly type: "text";
  readonly text: string;
}

/** Every server frame carries a monotonic sequence number. */
interface ServerFrameBase {
  readonly seq: number;
}

export interface LiveVoiceReadyFrame extends ServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
  /**
   * Whether this daemon takes `text` frames. Absent means no: a daemon
   * predating typed turns answers each one with `unknown_type`, which is
   * byte-identical to the `update_config` rejection, so the only safe read of
   * silence is that typed turns are unavailable.
   */
  readonly textInput?: boolean;
  /**
   * Whether the speech-to-text leg is live. Absent means yes, because an older daemon
   * refuses any session it cannot transcribe, so every session it readies can
   * hear. False is reachable only because this client declared `textInput`.
   */
  readonly audioInput?: boolean;
}

export interface LiveVoiceBusyFrame extends ServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
}

export interface LiveVoiceAssistantTextDeltaFrame extends ServerFrameBase {
  readonly type: "assistant_text_delta";
  readonly text: string;
}

export interface LiveVoiceTtsAudioFrame extends ServerFrameBase {
  readonly type: "tts_audio";
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

export interface LiveVoiceTtsDoneFrame extends ServerFrameBase {
  readonly type: "tts_done";
  readonly turnId: string;
}

export interface LiveVoiceTurnCancelledFrame extends ServerFrameBase {
  readonly type: "turn_cancelled";
  readonly turnId: string;
}

export interface LiveVoiceThinkingFrame extends ServerFrameBase {
  readonly type: "thinking";
  readonly turnId?: string;
}

export interface LiveVoiceActivityFrame extends ServerFrameBase {
  readonly type: "activity";
  readonly turnId: string;
  readonly label: string;
}

export interface LiveVoiceErrorFrame extends ServerFrameBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  /** Which client frame the error is about. Absent on older daemons. */
  readonly frameType?: string;
}

/**
 * A frame this build has no handling for: a newer daemon's addition, or one
 * of the capture-side frames a microphone-less session never acts on.
 * Surfaced as a type rather than dropped in the parser so the client can log
 * it at debug level instead of silently swallowing protocol drift.
 */
export interface LiveVoiceUnhandledFrame {
  readonly type: "unhandled";
  readonly frameType: string;
}

/** A payload that did not parse as a server frame at all. */
export interface LiveVoiceMalformedFrame {
  readonly type: "malformed";
  readonly raw: string;
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyFrame
  | LiveVoiceBusyFrame
  | LiveVoiceAssistantTextDeltaFrame
  | LiveVoiceTtsAudioFrame
  | LiveVoiceTtsDoneFrame
  | LiveVoiceTurnCancelledFrame
  | LiveVoiceThinkingFrame
  | LiveVoiceActivityFrame
  | LiveVoiceErrorFrame
  | LiveVoiceUnhandledFrame
  | LiveVoiceMalformedFrame;

/** Frame types this client acts on. Anything else becomes `unhandled`. */
const HANDLED_FRAME_TYPES = new Set([
  "ready",
  "busy",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "turn_cancelled",
  "thinking",
  "activity",
  "error",
]);

/**
 * Parse one inbound server payload.
 *
 * Lenient by design: a frame whose type this build knows is returned as-is
 * (extra fields ride along harmlessly), an unrecognized type becomes
 * `unhandled`, and anything unparseable becomes `malformed`. Nothing here
 * throws, because a single bad frame must never take down a session.
 */
export function parseServerFrame(payload: string): LiveVoiceServerFrame {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { type: "malformed", raw: payload };
  }
  if (typeof value !== "object" || value === null) {
    return { type: "malformed", raw: payload };
  }
  const frameType = (value as { type?: unknown }).type;
  if (typeof frameType !== "string") {
    return { type: "malformed", raw: payload };
  }
  if (!HANDLED_FRAME_TYPES.has(frameType)) {
    return { type: "unhandled", frameType };
  }
  return value as LiveVoiceServerFrame;
}
