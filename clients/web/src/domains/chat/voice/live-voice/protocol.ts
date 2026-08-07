/**
 * Live-voice WebSocket wire protocol.
 *
 * Web-app port of the runtime contract defined in
 * `assistant/src/live-voice/protocol.ts`. Field names and shapes mirror that
 * module exactly so the browser client and daemon agree on the wire format.
 *
 * Pure module: no DOM / WebSocket imports. The one import below is a `type`,
 * so it is erased at build time and the module stays side-effect free.
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

import type { ClientOs } from "@/runtime/platform-detection";

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
  /**
   * Per-session override for the trailing-silence duration (ms) that ends the
   * user's turn — the "pause before reply" voice setting. Absent lets the
   * daemon use its configured default. Only meaningful for `server_vad`.
   */
  readonly silenceThresholdMs?: number;
  /**
   * Per-session override for the sustained speech (ms) required to interrupt
   * the assistant mid-reply — the "interrupt sensitivity" voice setting
   * (higher = harder to interrupt; 0 = instant barge-in). Absent lets the
   * daemon use its configured default.
   */
  readonly bargeInMinSpeechMs?: number;
  /**
   * Which client opened the session, as a `ClientOs` surface. The iOS and
   * macOS apps run this same bundle over this same transport, so the OS
   * surface is the only thing that actually distinguishes them, and a literal
   * here would report every native session as `web`.
   *
   * Analytics only: the daemon puts it on the voice turn's telemetry `client`
   * bag so voice turns are countable per client, and never on the turn's
   * interface id, which decides what the turn is allowed to do.
   */
  readonly client?: ClientOs;
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

/**
 * Mid-session tuning update — retunes "pause before reply" / "interrupt
 * sensitivity" on the running server_vad session without reconnecting. Each
 * field is optional; the daemon applies changes from the next utterance.
 */
export interface LiveVoiceClientUpdateConfigFrame {
  readonly type: "update_config";
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

/**
 * A photo taken while the call is running, identified by the id the normal
 * attachment upload (`POST /v1/assistants/{id}/attachments`) already returned.
 *
 * Only the id travels: the bytes go over the same HTTP upload a typed message
 * uses, which already handles HEIF normalization and size caps, and this
 * socket is tuned for 50 ms audio frames.
 *
 * The daemon persists it into the conversation as its own user message and
 * runs no turn. That is what makes the order of shutter and speech
 * irrelevant: whatever the user says next, before or after the snap, is
 * answered by a model whose history already has the image.
 */
export interface LiveVoiceClientAttachImageFrame {
  readonly type: "attach_image";
  readonly attachmentId: string;
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame
  | LiveVoiceClientAttachImageFrame;

// ---------------------------------------------------------------------------
// Server frames (text/JSON; every frame carries `seq`)
// ---------------------------------------------------------------------------

const LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "speech_started",
  "utterance_end",
  "utterance_discarded",
  "stt_partial",
  "stt_final",
  "thinking",
  "activity",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "turn_cancelled",
  "minimize_room",
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
  /**
   * Echoes the turn-detection mode the session is actually running. Absent
   * (older daemons that ignore the start frame's `turnDetection`) means
   * "manual" — hands-free callers must fall back accordingly.
   */
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
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

/**
 * Emitted only in server_vad mode when the closed utterance produced no
 * usable speech (noise/cough): it is dropped without an assistant turn and
 * the client should return to listening.
 */
export interface LiveVoiceUtteranceDiscardedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "utterance_discarded";
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

/**
 * What the assistant is doing inside a turn, as one short user-facing line
 * ("Reading a file"), or `""` when it is doing nothing nameable.
 *
 * The wording is the daemon's, not this layer's, and that is deliberate: the
 * iOS Live Activity is driven both by this socket and by an APNs push the
 * daemon dispatches when this web layer is suspended, the two must carry
 * identical content state, and handing both the same string is the only way to
 * guarantee it. See `assistant/src/live-voice/activity-label.ts`.
 */
export interface LiveVoiceActivityServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "activity";
  readonly turnId: string;
  readonly label: string;
  /**
   * The confirmation this turn is blocked on, when the label describes a wait
   * rather than work in flight. Absent otherwise, including on the frame that
   * retires a wait — so a handler must treat "absent" as "no longer pending",
   * never as "unchanged".
   *
   * It is what makes the wait answerable from the Live Activity: an approval,
   * unlike the island's mute and end buttons, must not be re-resolved against
   * whatever is pending when the tap lands. Mirrors the daemon's frame in
   * `assistant/src/live-voice/protocol.ts`.
   */
  readonly approvalRequestId?: string;
}

export interface LiveVoiceAssistantTextDeltaServerFrame extends LiveVoiceServerFrameBase {
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

/**
 * Assistant-requested room minimize: the just-completed turn asked (via the
 * inline [-1] control marker) for the client to dismiss the full-screen
 * voice room so the user can see the screen behind it. Sent only after the
 * turn's TTS has fully drained, at most once per turn. Advisory — clients
 * without a room (pop-outs, older clients) ignore it.
 */
export interface LiveVoiceMinimizeRoomServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "minimize_room";
  readonly turnId: string;
}

export interface LiveVoiceMetricsServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "metrics";
  /**
   * What the frame reports: `"turn_completed"`, `"turn_cancelled"`, or
   * `"session_ended"`. Optional: daemons predating the field omit it, and
   * readers treat absent as a completed turn.
   */
  readonly event?: string;
  readonly turnId: string;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly ttsFirstAudioMs: number | null;
  /**
   * End-of-speech (utterance_end, or ptt_release in manual mode) to first
   * TTS audio, measured server-side. Optional: daemons predating the field
   * omit it — readers treat absent as null (read fallback, no compat gate
   * for a read-only debug surface; see docs/BACKWARDS_COMPAT.md).
   */
  readonly roundTripMs?: number | null;
  readonly totalMs: number | null;
  /**
   * End-of-turn latency: the local VAD speech-stop mark to the moment the
   * turn committed. Recorded on every committed turn, and measured from the
   * same anchor whichever decider owned the boundary, so front-door and Flux
   * turns are one comparable population. Absent on a turn that never
   * committed and in push-to-talk mode, where there is no local VAD
   * speech-stop mark.
   */
  readonly endpointCommitLatencyMs?: number;
  /**
   * Semantic-endpointing "hold" decisions taken during the turn. Present only
   * when the endpoint decider was consulted (with the
   * feature off the field is absent, keeping frames unchanged).
   */
  readonly endpointHoldCount?: number;
  /**
   * Worst endpoint-decision latency observed during the turn. It spans only
   * the decider's own work, and the two deciders start it at different
   * moments, so it is a diagnostic rather than a cross-path comparison: read
   * `endpointCommitLatencyMs` for that.
   */
  readonly endpointDecisionMaxLatencyMs?: number;
  /**
   * Which path decided the turn's endpoint: the front-door hold verdict or
   * the STT provider's model-integrated end-of-turn. Present under the same
   * condition as the two fields above.
   */
  readonly endpointDecisionSource?: "front-door" | "provider";
  /** Which floor-holding ack actually spoke during the turn, if any. */
  readonly ackSpoken?: "first_delta" | "tool_use";
  /**
   * Spoken progress narrations during the turn. Present only when at least
   * one progress update spoke (otherwise the field is absent, keeping frames
   * unchanged).
   */
  readonly progressUpdatesSpoken?: number;
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
  /**
   * The client frame this error is about, when the daemon knows. Absent from
   * daemons predating the field, which is why the transport still has an
   * "assume it was the settings frame" fallback.
   *
   * What makes an `unknown_type` attributable: this client sends two
   * optional frames (`update_config` and `attach_image`) and an older
   * assistant rejects either with the same code. See the handler in
   * `live-voice-client.ts`.
   */
  readonly frameType?: string;
  /**
   * True when the session continues past the error (e.g. a transient
   * transcriber blip or one failed TTS segment). Absent (including on frames
   * from older daemons) means the error is terminal for the session.
   */
  readonly recoverable?: boolean;
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceSpeechStartedServerFrame
  | LiveVoiceUtteranceEndServerFrame
  | LiveVoiceUtteranceDiscardedServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceActivityServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceMinimizeRoomServerFrame
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
):
  | LiveVoiceServerFrame
  | LiveVoiceInvalidJsonFrame
  | LiveVoiceUnknownServerFrame {
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
