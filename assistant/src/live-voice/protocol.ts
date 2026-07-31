import { isInterfaceId } from "@vellumai/service-contracts/channels";
import {
  LIVE_VOICE_TURN_DETECTION_MODES,
  type LiveVoiceAudioConfig,
  type LiveVoiceClientControlFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceClientUpdateConfigFrame,
  type LiveVoiceLegacyBase64AudioFrame,
  type LiveVoiceProtocolError,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFrame,
  type LiveVoiceServerFramePayload,
  type LiveVoiceTurnDetectionMode,
  MAX_BARGE_IN_MIN_SPEECH_MS,
  MAX_SILENCE_THRESHOLD_MS,
  MIN_BARGE_IN_MIN_SPEECH_MS,
  MIN_SILENCE_THRESHOLD_MS,
} from "@vellumai/service-contracts/live-voice";

export * from "@vellumai/service-contracts/live-voice";

type LiveVoiceParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: LiveVoiceProtocolError };

export type LiveVoiceClientAudioFrame = LiveVoiceLegacyBase64AudioFrame;

export type LiveVoiceClientFrame =
  | LiveVoiceClientControlFrame
  | LiveVoiceLegacyBase64AudioFrame;

interface LiveVoiceBinaryAudioFrame {
  readonly type: "binary_audio";
  readonly data: Uint8Array;
}

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
    default:
      return protocolError(
        "unknown_type",
        `Unknown live voice client frame type: ${value.type}`,
        "type",
        value.type,
      );
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
  if (!audioConfig.ok) {
    return audioConfig;
  }

  if ("conversationId" in value && !isNonEmptyString(value.conversationId)) {
    return protocolError(
      "invalid_field",
      "start frame field conversationId must be a non-empty string",
      "conversationId",
      "start",
    );
  }

  if ("sourceInterface" in value && !isInterfaceId(value.sourceInterface)) {
    return protocolError(
      "invalid_field",
      "start frame field sourceInterface must be a canonical interface identifier",
      "sourceInterface",
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
      ...(isInterfaceId(value.sourceInterface)
        ? { sourceInterface: value.sourceInterface }
        : {}),
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
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
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
