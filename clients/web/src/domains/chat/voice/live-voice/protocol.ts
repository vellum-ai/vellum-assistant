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

export type LiveVoiceTurnDetectionMode = "manual" | "server_vad";

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
  /**
   * Turn-detection mode for the session. Absent means "manual" (push-to-talk).
   * "server_vad" also implies a multi-turn session: the server detects
   * utterance boundaries and runs repeated utterance→turn cycles.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
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
  "speech_started",
  "utterance_end",
  "stt_partial",
  "stt_final",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "turn_cancelled",
  "metrics",
  "archived",
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

/**
 * Emitted when the server VAD detects user speech. The client MUST
 * immediately stop local TTS playback — this doubles as the flush-tail-audio
 * signal.
 */
export interface LiveVoiceSpeechStartedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "speech_started";
}

/**
 * Emitted when the server VAD closes the utterance and the turn's
 * transcription begins (plays the role ptt_release plays in manual mode).
 */
export interface LiveVoiceUtteranceEndServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "utterance_end";
  readonly reason: "silence" | "max-duration";
}

export interface LiveVoiceSttPartialServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_partial";
  readonly text: string;
}

export interface LiveVoiceSttFinalServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "stt_final";
  readonly text: string;
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
 * Emitted when an in-flight assistant turn is aborted by barge-in. The client
 * must drop any buffered tts_audio for that turn; no tts_done will follow.
 */
export interface LiveVoiceTurnCancelledServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "turn_cancelled";
  readonly turnId: string;
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
  | LiveVoiceSpeechStartedServerFrame
  | LiveVoiceUtteranceEndServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceErrorServerFrame;

/**
 * Error frame returned by {@link parseServerFrame} when the raw payload cannot
 * be JSON-parsed or lacks a `type` discriminator.
 */
export interface LiveVoiceInvalidJsonFrame {
  readonly type: "error";
  readonly code: "invalid_json";
  readonly message: string;
}

/**
 * Result returned by {@link parseServerFrame} for a structurally valid frame
 * whose `type` is not in this client's allowlist. Newer servers may emit frame
 * types this client version does not know; callers must ignore these rather
 * than treat them as protocol errors.
 */
export interface LiveVoiceUnknownServerFrame {
  readonly type: "unknown_frame";
  /** The wire `type` this client does not recognize. */
  readonly frameType: string;
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
 * payload is not valid JSON, is not an object, or lacks a string `type`
 * discriminator. A well-formed frame whose `type` is not in this client's
 * allowlist parses to a {@link LiveVoiceUnknownServerFrame} instead, so future
 * protocol additions are ignorable rather than session-fatal.
 */
export function parseServerFrame(
  raw: string,
): LiveVoiceServerFrame | LiveVoiceInvalidJsonFrame | LiveVoiceUnknownServerFrame {
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

  const frameType =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { type?: unknown }).type
      : undefined;
  if (typeof frameType !== "string") {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame has a missing or non-string type",
    };
  }

  if (!isLiveVoiceServerFrameType(frameType)) {
    return { type: "unknown_frame", frameType };
  }

  return parsed as LiveVoiceServerFrame;
}
