import type { InterfaceId } from "./channels.js";

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

export const LIVE_VOICE_AUDIO_FORMAT = {
  mimeType: "audio/pcm",
  sampleRate: 16_000,
  channels: 1,
} as const satisfies LiveVoiceAudioConfig;

export const LIVE_VOICE_TURN_DETECTION_MODES = [
  "manual",
  "server_vad",
] as const;

export type LiveVoiceTurnDetectionMode =
  (typeof LIVE_VOICE_TURN_DETECTION_MODES)[number];

export const MIN_SILENCE_THRESHOLD_MS = 100;
export const MAX_SILENCE_THRESHOLD_MS = 5_000;
export const MIN_BARGE_IN_MIN_SPEECH_MS = 0;
export const MAX_BARGE_IN_MIN_SPEECH_MS = 3_000;

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
  readonly sourceInterface?: InterfaceId;
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
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

export interface LiveVoiceClientUpdateConfigFrame {
  readonly type: "update_config";
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

export type LiveVoiceClientControlFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame;

/**
 * Compatibility frame for clients that send audio as base64 JSON. Current
 * clients send PCM bytes in binary WebSocket frames.
 */
export interface LiveVoiceLegacyBase64AudioFrame {
  readonly type: "audio";
  readonly dataBase64: string;
}

export const LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "speech_started",
  "utterance_end",
  "utterance_discarded",
  "stt_partial",
  "stt_final",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "turn_cancelled",
  "minimize_room",
  "metrics",
  "archived",
  "error",
] as const;

export type LiveVoiceServerFrameType =
  (typeof LIVE_VOICE_SERVER_FRAME_TYPES)[number];

export const LiveVoiceProtocolErrorCode = {
  InvalidJson: "invalid_json",
  InvalidFrame: "invalid_frame",
  UnknownType: "unknown_type",
  MissingRequiredField: "missing_required_field",
  InvalidField: "invalid_field",
  InvalidAudioPayload: "invalid_audio_payload",
  CredentialsUnavailable: "credentials_unavailable",
} as const;

export type LiveVoiceProtocolErrorCode =
  (typeof LiveVoiceProtocolErrorCode)[keyof typeof LiveVoiceProtocolErrorCode];

export interface LiveVoiceProtocolError {
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly frameType?: string;
}

interface LiveVoiceServerFrameBase {
  readonly type: LiveVoiceServerFrameType;
  readonly seq: number;
}

export interface LiveVoiceReadyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
}

export interface LiveVoiceSpeechStartedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "speech_started";
}

export interface LiveVoiceUtteranceEndServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "utterance_end";
  readonly reason: "silence" | "max-duration";
}

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

export interface LiveVoiceTurnCancelledServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "turn_cancelled";
  readonly turnId: string;
}

export interface LiveVoiceMinimizeRoomServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "minimize_room";
  readonly turnId: string;
}

export interface LiveVoiceMetricsServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "metrics";
  readonly event?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly turnId: string;
  readonly metrics?: unknown;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly dispatchToFirstDeltaMs?: number | null;
  readonly dispatchToFirstAudioMs?: number | null;
  readonly ttsFirstAudioMs: number | null;
  readonly roundTripMs?: number | null;
  readonly totalMs: number | null;
  readonly endpointHoldCount?: number;
  readonly endpointDecisionMaxLatencyMs?: number;
  readonly ackSpoken?: "first_delta" | "tool_use";
  readonly progressUpdatesSpoken?: number;
}

export interface LiveVoiceArchiveWarning {
  readonly code: string;
  readonly message: string;
}

export interface LiveVoiceArchivedServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "archived";
  readonly conversationId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly role?: "user" | "assistant";
  readonly attachmentId?: string;
  readonly attachmentIds?: string[];
  readonly warning?: LiveVoiceArchiveWarning;
}

export interface LiveVoiceErrorServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
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
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceMinimizeRoomServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceErrorServerFrame;

type WithoutSeq<T> = T extends LiveVoiceServerFrameBase
  ? Omit<T, "seq">
  : never;

export type LiveVoiceServerFramePayload = WithoutSeq<LiveVoiceServerFrame>;

export interface LiveVoiceInvalidJsonFrame {
  readonly type: "error";
  readonly code: "invalid_json";
  readonly message: string;
}

export interface LiveVoiceUnknownServerFrame {
  readonly type: "unknown_frame";
  readonly frameType: string;
}

export type LiveVoiceParsedServerFrame =
  | LiveVoiceServerFrame
  | LiveVoiceInvalidJsonFrame
  | LiveVoiceUnknownServerFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLiveVoiceServerFrameType(
  value: string,
): value is LiveVoiceServerFrameType {
  return (LIVE_VOICE_SERVER_FRAME_TYPES as readonly string[]).includes(value);
}

/**
 * Parses a server text frame by its discriminator. Known frames pass through
 * without strict field validation so clients can remain tolerant of version
 * skew and additional fields.
 */
export function parseLiveVoiceServerFrame(
  raw: string,
): LiveVoiceParsedServerFrame {
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

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return {
      type: "error",
      code: "invalid_json",
      message: "Live voice server frame has a missing or non-string type",
    };
  }

  if (!isLiveVoiceServerFrameType(parsed.type)) {
    return { type: "unknown_frame", frameType: parsed.type };
  }

  return parsed as unknown as LiveVoiceServerFrame;
}
