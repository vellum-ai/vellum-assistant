const LIVE_VOICE_CLIENT_FRAME_TYPES = [
  "start",
  "audio",
  "ptt_release",
  "interrupt",
  "end",
] as const;

export type LiveVoiceClientFrameType =
  (typeof LIVE_VOICE_CLIENT_FRAME_TYPES)[number];

const _LIVE_VOICE_SERVER_FRAME_TYPES = [
  "ready",
  "busy",
  "stt_partial",
  "stt_final",
  "thinking",
  "assistant_text_delta",
  "tts_audio",
  "tts_done",
  "metrics",
  "archived",
  "error",
] as const;

export type LiveVoiceServerFrameType =
  (typeof _LIVE_VOICE_SERVER_FRAME_TYPES)[number];

export const LiveVoiceProtocolErrorCode = {
  InvalidJson: "invalid_json",
  InvalidFrame: "invalid_frame",
  UnknownType: "unknown_type",
  MissingRequiredField: "missing_required_field",
  InvalidField: "invalid_field",
  InvalidAudioPayload: "invalid_audio_payload",
} as const;

export type LiveVoiceProtocolErrorCode =
  (typeof LiveVoiceProtocolErrorCode)[keyof typeof LiveVoiceProtocolErrorCode];

export interface LiveVoiceProtocolError {
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly frameType?: string;
}

export type LiveVoiceParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: LiveVoiceProtocolError };

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

export interface LiveVoiceClientStartFrame {
  readonly type: "start";
  readonly conversationId?: string;
  readonly audio: LiveVoiceAudioConfig;
}

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

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientAudioFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame;

export interface LiveVoiceBinaryAudioFrame {
  readonly type: "binary_audio";
  readonly data: Uint8Array;
}

export interface LiveVoiceServerFrameBase {
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
}

export type LiveVoiceServerFrame =
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceSttPartialServerFrame
  | LiveVoiceSttFinalServerFrame
  | LiveVoiceThinkingServerFrame
  | LiveVoiceAssistantTextDeltaServerFrame
  | LiveVoiceTtsAudioServerFrame
  | LiveVoiceTtsDoneServerFrame
  | LiveVoiceMetricsServerFrame
  | LiveVoiceArchivedServerFrame
  | LiveVoiceErrorServerFrame;

type WithoutSeq<T extends LiveVoiceServerFrameBase> = Omit<T, "seq">;

export type LiveVoiceServerFramePayload =
  | WithoutSeq<LiveVoiceReadyServerFrame>
  | WithoutSeq<LiveVoiceBusyServerFrame>
  | WithoutSeq<LiveVoiceSttPartialServerFrame>
  | WithoutSeq<LiveVoiceSttFinalServerFrame>
  | WithoutSeq<LiveVoiceThinkingServerFrame>
  | WithoutSeq<LiveVoiceAssistantTextDeltaServerFrame>
  | WithoutSeq<LiveVoiceTtsAudioServerFrame>
  | WithoutSeq<LiveVoiceTtsDoneServerFrame>
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
  }
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

  return {
    ok: true,
    frame: {
      type: "start",
      ...(typeof value.conversationId === "string"
        ? { conversationId: value.conversationId }
        : {}),
      audio: audioConfig.frame,
    },
  };
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
