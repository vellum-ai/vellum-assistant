const LIVE_VOICE_CLIENT_FRAME_TYPES = [
  "start",
  "audio",
  "ptt_release",
  "interrupt",
  "end",
  "update_config",
] as const;

type LiveVoiceClientFrameType = (typeof LIVE_VOICE_CLIENT_FRAME_TYPES)[number];

const _LIVE_VOICE_SERVER_FRAME_TYPES = [
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
  "metrics",
  "archived",
  "error",
] as const;

type LiveVoiceServerFrameType = (typeof _LIVE_VOICE_SERVER_FRAME_TYPES)[number];

export const LiveVoiceProtocolErrorCode = {
  InvalidJson: "invalid_json",
  InvalidFrame: "invalid_frame",
  UnknownType: "unknown_type",
  MissingRequiredField: "missing_required_field",
  InvalidField: "invalid_field",
  InvalidAudioPayload: "invalid_audio_payload",
  /**
   * Session startup was rejected because the daemon cannot run both audio
   * legs (STT/TTS providers or credentials are unresolved). The error
   * `message` names the offending provider(s) and missing credential(s).
   */
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

type LiveVoiceParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: LiveVoiceProtocolError };

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

const LIVE_VOICE_TURN_DETECTION_MODES = ["manual", "server_vad"] as const;

export type LiveVoiceTurnDetectionMode =
  (typeof LIVE_VOICE_TURN_DETECTION_MODES)[number];

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
   * user's turn — the "pause before reply" the client exposes as a setting.
   * Absent falls back to the daemon `liveVoice.vad.silenceThresholdMs` config.
   * Only meaningful for `turnDetection: "server_vad"`. Bounded to
   * [{@link MIN_SILENCE_THRESHOLD_MS}, {@link MAX_SILENCE_THRESHOLD_MS}].
   */
  readonly silenceThresholdMs?: number;
  /**
   * Per-session override for the sustained speech (ms) required before the
   * user's speech interrupts the assistant mid-reply — the "interrupt
   * sensitivity" the client exposes as a setting (higher = harder to
   * interrupt; 0 disables the guard so barge-in is immediate). Absent falls
   * back to the daemon `liveVoice.vad.bargeInMinSpeechMs` config. Bounded to
   * [{@link MIN_BARGE_IN_MIN_SPEECH_MS}, {@link MAX_BARGE_IN_MIN_SPEECH_MS}].
   */
  readonly bargeInMinSpeechMs?: number;
}

/**
 * Bounds for the per-session turn-detection overrides carried on the start
 * frame. Kept deliberately wide — they only reject nonsensical values (a
 * sub-100 ms pause would end turns mid-word; a 10 s barge-in guard would make
 * the assistant uninterruptible). The daemon config defaults sit inside these.
 */
export const MIN_SILENCE_THRESHOLD_MS = 100;
export const MAX_SILENCE_THRESHOLD_MS = 5_000;
export const MIN_BARGE_IN_MIN_SPEECH_MS = 0;
export const MAX_BARGE_IN_MIN_SPEECH_MS = 3_000;

export interface LiveVoiceClientAudioFrame {
  readonly type: "audio";
  readonly dataBase64: string;
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
 * Mid-session tuning update: applies the same turn-detection knobs the start
 * frame carries to the *running* session, so the client can retune "pause
 * before reply" / "interrupt sensitivity" without reconnecting. Each field is
 * optional and independently applied; the same bounds as the start frame apply.
 * Only meaningful for `server_vad` sessions.
 */
export interface LiveVoiceClientUpdateConfigFrame {
  readonly type: "update_config";
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientAudioFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame;

interface LiveVoiceBinaryAudioFrame {
  readonly type: "binary_audio";
  readonly data: Uint8Array;
}

interface LiveVoiceServerFrameBase {
  readonly type: LiveVoiceServerFrameType;
  readonly seq: number;
}

export interface LiveVoiceReadyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "ready";
  readonly sessionId: string;
  readonly conversationId: string;
  /**
   * Echoes the turn-detection mode the session is actually running, so
   * clients can detect a daemon that ignored a requested mode. Absent
   * (older daemons) means "manual".
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
 * signal (the in-app analog of the phone stack's buffered-audio clear).
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
 * usable speech: it is dropped without an assistant turn and the client
 * should return to listening.
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

export interface LiveVoiceMetricsServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "metrics";
  readonly event?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly turnId: string;
  readonly metrics?: unknown;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly ttsFirstAudioMs: number | null;
  /** End-of-speech (utterance_end, or ptt_release in manual mode) to first TTS audio. */
  readonly roundTripMs: number | null;
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
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
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
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceTurnCancelledServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceErrorServerFrame;

type WithoutSeq<T extends LiveVoiceServerFrameBase> = Omit<T, "seq">;

export type LiveVoiceServerFramePayload =
  | WithoutSeq<LiveVoiceReadyServerFrame>
  | WithoutSeq<LiveVoiceBusyServerFrame>
  | WithoutSeq<LiveVoiceSpeechStartedServerFrame>
  | WithoutSeq<LiveVoiceUtteranceEndServerFrame>
  | WithoutSeq<LiveVoiceUtteranceDiscardedServerFrame>
  | WithoutSeq<LiveVoiceSttPartialServerFrame>
  | WithoutSeq<LiveVoiceSttFinalServerFrame>
  | WithoutSeq<LiveVoiceThinkingServerFrame>
  | WithoutSeq<LiveVoiceAssistantTextDeltaServerFrame>
  | WithoutSeq<LiveVoiceTtsAudioServerFrame>
  | WithoutSeq<LiveVoiceTtsDoneServerFrame>
  | WithoutSeq<LiveVoiceTurnCancelledServerFrame>
  | WithoutSeq<LiveVoiceMetricsServerFrame>
  | WithoutSeq<LiveVoiceArchivedServerFrame>
  | WithoutSeq<LiveVoiceErrorServerFrame>;

class LiveVoiceServerFrameSequencer {
  private seq: number;

  constructor(initialSeq = 0) {
    this.seq = initialSeq;
  }

  next(frame: LiveVoiceServerFramePayload): LiveVoiceServerFrame {
    this.seq += 1;
    return { ...frame, seq: this.seq } as LiveVoiceServerFrame;
  }

  get lastSeq(): number {
    return this.seq;
  }
}

export function createLiveVoiceServerFrameSequencer(
  initialSeq = 0,
): LiveVoiceServerFrameSequencer {
  return new LiveVoiceServerFrameSequencer(initialSeq);
}

export function parseLiveVoiceClientTextFrame(
  text: string,
): LiveVoiceParseResult<LiveVoiceClientFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return protocolError("invalid_json", "Live voice frame is not valid JSON");
  }

  return validateLiveVoiceClientFrame(parsed);
}

export function validateLiveVoiceClientFrame(
  value: unknown,
): LiveVoiceParseResult<LiveVoiceClientFrame> {
  if (!isRecord(value)) {
    return protocolError(
      "invalid_frame",
      "Live voice frame must be a JSON object",
    );
  }

  if (!("type" in value)) {
    return protocolError(
      "missing_required_field",
      "Live voice frame is missing required field type",
      "type",
    );
  }

  if (typeof value.type !== "string") {
    return protocolError(
      "invalid_field",
      "Live voice frame field type must be a string",
      "type",
    );
  }

  if (!isLiveVoiceClientFrameType(value.type)) {
    return protocolError(
      "unknown_type",
      `Unknown live voice client frame type: ${value.type}`,
      "type",
      value.type,
    );
  }

  switch (value.type) {
    case "start":
      return validateStartFrame(value);
    case "audio":
      return validateAudioFrame(value);
    case "ptt_release":
      return { ok: true, frame: { type: "ptt_release" } };
    case "interrupt":
      return { ok: true, frame: { type: "interrupt" } };
    case "end":
      return { ok: true, frame: { type: "end" } };
    case "update_config":
      return validateUpdateConfigFrame(value);
  }
}

function validateUpdateConfigFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientUpdateConfigFrame> {
  if (
    "silenceThresholdMs" in value &&
    !isIntInRange(
      value.silenceThresholdMs,
      MIN_SILENCE_THRESHOLD_MS,
      MAX_SILENCE_THRESHOLD_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `update_config field silenceThresholdMs must be an integer in [${MIN_SILENCE_THRESHOLD_MS}, ${MAX_SILENCE_THRESHOLD_MS}]`,
      "silenceThresholdMs",
      "update_config",
    );
  }

  if (
    "bargeInMinSpeechMs" in value &&
    !isIntInRange(
      value.bargeInMinSpeechMs,
      MIN_BARGE_IN_MIN_SPEECH_MS,
      MAX_BARGE_IN_MIN_SPEECH_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `update_config field bargeInMinSpeechMs must be an integer in [${MIN_BARGE_IN_MIN_SPEECH_MS}, ${MAX_BARGE_IN_MIN_SPEECH_MS}]`,
      "bargeInMinSpeechMs",
      "update_config",
    );
  }

  return {
    ok: true,
    frame: {
      type: "update_config",
      ...(typeof value.silenceThresholdMs === "number"
        ? { silenceThresholdMs: value.silenceThresholdMs }
        : {}),
      ...(typeof value.bargeInMinSpeechMs === "number"
        ? { bargeInMinSpeechMs: value.bargeInMinSpeechMs }
        : {}),
    },
  };
}

export function parseLiveVoiceBinaryAudioFrame(
  data: unknown,
): LiveVoiceParseResult<LiveVoiceBinaryAudioFrame> {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength === 0) {
      return invalidAudioPayload(
        "Binary audio frame is empty",
        "data",
        "binary_audio",
      );
    }
    return {
      ok: true,
      frame: { type: "binary_audio", data: new Uint8Array(data) },
    };
  }

  if (ArrayBuffer.isView(data)) {
    if (data.byteLength === 0) {
      return invalidAudioPayload(
        "Binary audio frame is empty",
        "data",
        "binary_audio",
      );
    }
    return {
      ok: true,
      frame: {
        type: "binary_audio",
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      },
    };
  }

  return invalidAudioPayload(
    "Binary audio frame must be ArrayBuffer data",
    "data",
    "binary_audio",
  );
}

function validateStartFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientStartFrame> {
  if (!("audio" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame is missing required field audio",
      "audio",
      "start",
    );
  }

  if (!isRecord(value.audio)) {
    return protocolError(
      "invalid_field",
      "start frame field audio must be an object",
      "audio",
      "start",
    );
  }

  const audio = value.audio;
  const audioConfig = validateAudioConfig(audio);
  if (!audioConfig.ok) return audioConfig;

  if ("conversationId" in value && !isNonEmptyString(value.conversationId)) {
    return protocolError(
      "invalid_field",
      "start frame field conversationId must be a non-empty string",
      "conversationId",
      "start",
    );
  }

  if (
    "turnDetection" in value &&
    !isLiveVoiceTurnDetectionMode(value.turnDetection)
  ) {
    return protocolError(
      "invalid_field",
      "start frame field turnDetection must be manual or server_vad",
      "turnDetection",
      "start",
    );
  }

  if (
    "silenceThresholdMs" in value &&
    !isIntInRange(
      value.silenceThresholdMs,
      MIN_SILENCE_THRESHOLD_MS,
      MAX_SILENCE_THRESHOLD_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `start frame field silenceThresholdMs must be an integer in [${MIN_SILENCE_THRESHOLD_MS}, ${MAX_SILENCE_THRESHOLD_MS}]`,
      "silenceThresholdMs",
      "start",
    );
  }

  if (
    "bargeInMinSpeechMs" in value &&
    !isIntInRange(
      value.bargeInMinSpeechMs,
      MIN_BARGE_IN_MIN_SPEECH_MS,
      MAX_BARGE_IN_MIN_SPEECH_MS,
    )
  ) {
    return protocolError(
      "invalid_field",
      `start frame field bargeInMinSpeechMs must be an integer in [${MIN_BARGE_IN_MIN_SPEECH_MS}, ${MAX_BARGE_IN_MIN_SPEECH_MS}]`,
      "bargeInMinSpeechMs",
      "start",
    );
  }

  return {
    ok: true,
    frame: {
      type: "start",
      ...(typeof value.conversationId === "string"
        ? { conversationId: value.conversationId }
        : {}),
      audio: audioConfig.frame,
      ...(isLiveVoiceTurnDetectionMode(value.turnDetection)
        ? { turnDetection: value.turnDetection }
        : {}),
      ...(typeof value.silenceThresholdMs === "number"
        ? { silenceThresholdMs: value.silenceThresholdMs }
        : {}),
      ...(typeof value.bargeInMinSpeechMs === "number"
        ? { bargeInMinSpeechMs: value.bargeInMinSpeechMs }
        : {}),
    },
  };
}

/** Whether `value` is an integer within the inclusive `[min, max]` range. */
function isIntInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validateAudioFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientAudioFrame> {
  if (!("dataBase64" in value)) {
    return protocolError(
      "missing_required_field",
      "audio frame is missing required field dataBase64",
      "dataBase64",
      "audio",
    );
  }

  if (typeof value.dataBase64 !== "string") {
    return invalidAudioPayload("audio frame dataBase64 must be a string");
  }

  if (!isValidBase64Payload(value.dataBase64)) {
    return invalidAudioPayload("audio frame dataBase64 is malformed");
  }

  return {
    ok: true,
    frame: { type: "audio", dataBase64: value.dataBase64 },
  };
}

function validateAudioConfig(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceAudioConfig> {
  if (!("mimeType" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field mimeType",
      "audio.mimeType",
      "start",
    );
  }

  if (value.mimeType !== "audio/pcm") {
    return protocolError(
      "invalid_field",
      "start frame audio.mimeType must be audio/pcm",
      "audio.mimeType",
      "start",
    );
  }

  if (!("sampleRate" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field sampleRate",
      "audio.sampleRate",
      "start",
    );
  }

  if (!isPositiveInteger(value.sampleRate)) {
    return protocolError(
      "invalid_field",
      "start frame audio.sampleRate must be a positive integer",
      "audio.sampleRate",
      "start",
    );
  }

  if (!("channels" in value)) {
    return protocolError(
      "missing_required_field",
      "start frame audio is missing required field channels",
      "audio.channels",
      "start",
    );
  }

  if (value.channels !== 1) {
    return protocolError(
      "invalid_field",
      "start frame audio.channels must be 1",
      "audio.channels",
      "start",
    );
  }

  return {
    ok: true,
    frame: {
      mimeType: "audio/pcm",
      sampleRate: value.sampleRate,
      channels: 1,
    },
  };
}

function isLiveVoiceClientFrameType(
  value: string,
): value is LiveVoiceClientFrameType {
  return (LIVE_VOICE_CLIENT_FRAME_TYPES as readonly string[]).includes(value);
}

function isLiveVoiceTurnDetectionMode(
  value: unknown,
): value is LiveVoiceTurnDetectionMode {
  return (
    typeof value === "string" &&
    (LIVE_VOICE_TURN_DETECTION_MODES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );
}

function invalidAudioPayload(
  message: string,
  field = "dataBase64",
  frameType = "audio",
): LiveVoiceParseResult<never> {
  return protocolError("invalid_audio_payload", message, field, frameType);
}

function protocolError<T = never>(
  code: LiveVoiceProtocolErrorCode,
  message: string,
  field?: string,
  frameType?: string,
): LiveVoiceParseResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
      ...(frameType ? { frameType } : {}),
    },
  };
}
