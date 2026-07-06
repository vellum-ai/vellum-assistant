/**
 * Live-voice WebSocket wire protocol.
 *
 * Web-app port of the runtime contract defined in
 * `assistant/src/live-voice/protocol.ts`. Field names and shapes mirror that
 * module exactly so the browser client and daemon agree on the wire format.
 *
 * Pure module: no DOM / WebSocket imports.
 *
 * ## Framing
 *
 * - Client control frames ({@link LiveVoiceClientFrame}) are sent as JSON text
 *   frames.
 * - Audio chunks are sent as raw BINARY WebSocket frames (PCM bytes), NOT as
 *   JSON — there is no `audio` client frame on the web side.
 * - Every server frame ({@link LiveVoiceServerFrame}) is JSON text and carries a
 *   monotonically increasing `seq` number.
 */

// ---------------------------------------------------------------------------
// Client frames (text/JSON control frames; audio goes over binary frames)
// ---------------------------------------------------------------------------

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

/**
 * Canonical client capture/upload audio contract — the single source of truth
 * shared by the capture pipeline (`pcm-capture.ts`) and the `start` frame's
 * `audio` config (`live-voice-client.ts`). Mirrors the runtime contract in
 * `assistant/src/live-voice/protocol.ts`.
 *
 * The AudioWorklet (`pcm-downsample-worklet.ts`) cannot import app modules
 * (audio-thread isolation), so it hardcodes the same `16000` — keep its
 * `TARGET_SAMPLE_RATE` in sync with this.
 */
export const LIVE_VOICE_AUDIO_FORMAT: LiveVoiceAudioConfig = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
};

const _LIVE_VOICE_SESSION_MODES = ["ptt", "open-mic"] as const;

export type LiveVoiceSessionMode = (typeof _LIVE_VOICE_SESSION_MODES)[number];

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
  readonly mode?: LiveVoiceSessionMode;
}

export interface LiveVoiceClientPttReleaseFrame {
  readonly type: "ptt_release";
}

export interface LiveVoiceClientInterruptFrame {
  readonly type: "interrupt";
}

export interface LiveVoiceClientEndFrame {
  readonly type: "end";
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame;

// ---------------------------------------------------------------------------
// Server frames (text/JSON; every frame carries `seq`)
// ---------------------------------------------------------------------------

const LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "stt_partial",
  "stt_final",
  "turn_boundary",
  "interrupted",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "turn_cancelled",
  "metrics",
  "archived",
  "session_ended",
  "error",
] as const;

type LiveVoiceServerFrameType = (typeof LIVE_VOICE_SERVER_FRAME_TYPES)[number];

interface LiveVoiceServerFrameBase {
  readonly type: LiveVoiceServerFrameType;
  readonly seq: number;
}

export interface LiveVoiceReadyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
}

export interface LiveVoiceSttPartialServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_partial";
  readonly text: string;
}

export interface LiveVoiceSttFinalServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_final";
  readonly text: string;
}

/**
 * Server-detected end of user speech; the assistant turn is starting.
 * Emitted in both modes: in PTT it follows `ptt_release`/final transcript,
 * in open-mic it is the primary turn signal.
 */
export interface LiveVoiceTurnBoundaryServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "turn_boundary";
}

/**
 * Barge-in (server-VAD or client `interrupt` frame) was accepted for the
 * given assistant turn; playback must flush and the session keeps listening.
 */
export interface LiveVoiceInterruptedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "interrupted";
  readonly turnId: string;
}

export interface LiveVoiceThinkingServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "thinking";
  readonly turnId: string;
}

export interface LiveVoiceAssistantTextDeltaServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "assistant_text_delta";
  readonly text: string;
}

export interface LiveVoiceTtsAudioServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tts_audio";
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

export interface LiveVoiceTtsDoneServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "tts_done";
  readonly turnId: string;
}

/**
 * The in-flight user turn was retired without an assistant response (e.g.
 * empty transcript, failed assistant turn). Resume listening rather than
 * waiting for `thinking`/`tts_done` that will never come.
 */
export interface LiveVoiceTurnCancelledServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "turn_cancelled";
  readonly reason?: string;
}

/**
 * The server ended the session ([END_CALL] goodbye, max session duration).
 * Sent after pending TTS has been flushed and before the session closes;
 * tear down cleanly back to idle.
 */
export interface LiveVoiceSessionEndedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "session_ended";
  readonly reason: string;
}

export interface LiveVoiceMetricsServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "metrics";
  readonly turnId: string;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly ttsFirstAudioMs: number | null;
  readonly totalMs: number | null;
}

export interface LiveVoiceArchivedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "archived";
  readonly conversationId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly role?: "user" | "assistant";
  readonly attachmentId?: string;
  readonly attachmentIds?: string[];
  readonly warning?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface LiveVoiceErrorServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceTurnBoundaryServerFrame
  | LiveVoiceInterruptedServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceSessionEndedServerFrame
  | LiveVoiceErrorServerFrame;

/**
 * Error frame returned by {@link parseServerFrame} when the raw payload cannot
 * be JSON-parsed or lacks a recognized `type` discriminator.
 */
export interface LiveVoiceInvalidJsonFrame {
  readonly type: "error";
  readonly code: "invalid_json";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isLiveVoiceServerFrameType(
  value: unknown,
): value is LiveVoiceServerFrameType {
  return (
    typeof value === "string" &&
    (LIVE_VOICE_SERVER_FRAME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Parse a raw text frame received from the server into a typed
 * {@link LiveVoiceServerFrame}.
 *
 * Returns a {@link LiveVoiceInvalidJsonFrame} (`code: "invalid_json"`) when the
 * payload is not valid JSON, is not an object, or carries an unknown/missing
 * `type` discriminator.
 */
export function parseServerFrame(
  raw: string,
): LiveVoiceServerFrame | LiveVoiceInvalidJsonFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame is not valid JSON",
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isLiveVoiceServerFrameType((parsed as { type?: unknown }).type)
  ) {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame has missing or unknown type",
    };
  }

  return parsed as LiveVoiceServerFrame;
}
