/**
 * Live voice WebSocket protocol — TypeScript types and frame codecs for
 * the web client.
 *
 * Mirrors the public surface of `assistant/src/live-voice/protocol.ts`
 * (the runtime) and the Swift reference at
 * `clients/shared/Network/LiveVoiceChannelClient.swift`.
 *
 * The runtime parses *client* frames; the web client parses *server*
 * frames — the validator shapes are structurally identical, the union
 * direction is just inverted.
 *
 * Pure TypeScript: no DOM, no React, no Node-specific APIs. Uses
 * `btoa` / `atob` and `Uint8Array` (not `Buffer`) so the module works
 * in browsers, Capacitor WebViews, and Bun's test runner.
 */

// ---------------------------------------------------------------------------
// Frame type tables
// ---------------------------------------------------------------------------

const LIVE_VOICE_SERVER_FRAME_TYPES = [
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

type LiveVoiceServerFrameType =
  (typeof LIVE_VOICE_SERVER_FRAME_TYPES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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

type LiveVoiceParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: LiveVoiceProtocolError };

// ---------------------------------------------------------------------------
// Audio config
// ---------------------------------------------------------------------------

export interface LiveVoiceAudioConfig {
  readonly mimeType: "audio/pcm";
  readonly sampleRate: number;
  readonly channels: 1;
}

/**
 * The canonical 16 kHz mono PCM config used by the web and macOS
 * clients. Matches `LiveVoiceChannelAudioFormat.pcm16kMono` in
 * `LiveVoiceChannelClient.swift`.
 */
export const LIVE_VOICE_AUDIO_PCM16K_MONO: LiveVoiceAudioConfig = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
};

// ---------------------------------------------------------------------------
// Client frames (web -> server)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Server frames (server -> web)
// ---------------------------------------------------------------------------

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

export interface LiveVoiceSttPartialServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "stt_partial";
  readonly text: string;
}

export interface LiveVoiceSttFinalServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "stt_final";
  readonly text: string;
}

export interface LiveVoiceThinkingServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "thinking";
  readonly turnId: string;
}

export interface LiveVoiceAssistantTextDeltaServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "assistant_text_delta";
  readonly text: string;
}

export interface LiveVoiceTtsAudioServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "tts_audio";
  readonly mimeType: string;
  readonly sampleRate: number;
  readonly dataBase64: string;
}

export interface LiveVoiceTtsDoneServerFrame
  extends LiveVoiceServerFrameBase {
  readonly type: "tts_done";
  readonly turnId: string;
}

export interface LiveVoiceMetricsServerFrame
  extends LiveVoiceServerFrameBase {
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

export interface LiveVoiceArchivedServerFrame
  extends LiveVoiceServerFrameBase {
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

// ---------------------------------------------------------------------------
// Binary audio frame (TTS audio)
// ---------------------------------------------------------------------------

export interface LiveVoiceServerBinaryAudioFrame {
  readonly type: "binary_audio";
  readonly data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Client frame encoders
// ---------------------------------------------------------------------------

/**
 * Encode the JSON `start` frame the web client sends after the
 * WebSocket opens. Mirrors `LiveVoiceChannelClient.encodeStartFrame` in
 * the Swift client.
 */
export function encodeClientStartFrame(opts: {
  conversationId?: string;
  audio: LiveVoiceAudioConfig;
}): string {
  const frame: LiveVoiceClientStartFrame = {
    type: "start",
    ...(opts.conversationId !== undefined
      ? { conversationId: opts.conversationId }
      : {}),
    audio: opts.audio,
  };
  return JSON.stringify(frame);
}

/**
 * Encode a JSON control frame (`ptt_release`, `interrupt`, `end`).
 * Mirrors `LiveVoiceChannelClient.encodeControlFrame` in the Swift
 * client.
 */
export function encodeClientControlFrame(
  type: "ptt_release" | "interrupt" | "end",
): string {
  return JSON.stringify({ type });
}

// ---------------------------------------------------------------------------
// Server frame parsers
// ---------------------------------------------------------------------------

export function parseServerTextFrame(
  text: string,
): LiveVoiceParseResult<LiveVoiceServerFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return protocolError("invalid_json", "Live voice frame is not valid JSON");
  }
  return validateServerFrame(parsed);
}

export function parseServerBinaryFrame(
  data: unknown,
): LiveVoiceParseResult<LiveVoiceServerBinaryAudioFrame> {
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

function validateServerFrame(
  value: unknown,
): LiveVoiceParseResult<LiveVoiceServerFrame> {
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

  if (!isLiveVoiceServerFrameType(value.type)) {
    return protocolError(
      "unknown_type",
      `Unknown live voice server frame type: ${value.type}`,
      "type",
      value.type,
    );
  }

  const seqResult = validateSeq(value, value.type);
  if (!seqResult.ok) return seqResult;
  const seq = seqResult.value;

  switch (value.type) {
    case "ready":
      return validateReadyFrame(value, seq);
    case "busy":
      return validateBusyFrame(value, seq);
    case "stt_partial":
      return validateTextFieldFrame(value, "stt_partial", seq);
    case "stt_final":
      return validateTextFieldFrame(value, "stt_final", seq);
    case "thinking":
      return validateTurnIdFrame(value, "thinking", seq);
    case "assistant_text_delta":
      return validateTextFieldFrame(value, "assistant_text_delta", seq);
    case "tts_audio":
      return validateTtsAudioFrame(value, seq);
    case "tts_done":
      return validateTurnIdFrame(value, "tts_done", seq);
    case "metrics":
      return validateMetricsFrame(value, seq);
    case "archived":
      return validateArchivedFrame(value, seq);
    case "error":
      return validateErrorFrame(value, seq);
  }
}

function validateSeq(
  value: Record<string, unknown>,
  frameType: string,
): { ok: true; value: number } | { ok: false; error: LiveVoiceProtocolError } {
  if (!("seq" in value)) {
    return {
      ok: false,
      error: {
        code: "missing_required_field",
        message: `${frameType} frame is missing required field seq`,
        field: "seq",
        frameType,
      },
    };
  }
  if (!isNonNegativeInteger(value.seq)) {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        message: `${frameType} frame field seq must be a non-negative integer`,
        field: "seq",
        frameType,
      },
    };
  }
  return { ok: true, value: value.seq };
}

function validateReadyFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceReadyServerFrame> {
  const sessionId = requireString(value, "sessionId", "ready");
  if (!sessionId.ok) return sessionId;
  const conversationId = requireString(value, "conversationId", "ready");
  if (!conversationId.ok) return conversationId;
  return {
    ok: true,
    frame: {
      type: "ready",
      seq,
      sessionId: sessionId.value,
      conversationId: conversationId.value,
    },
  };
}

function validateBusyFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceBusyServerFrame> {
  const activeSessionId = requireString(value, "activeSessionId", "busy");
  if (!activeSessionId.ok) return activeSessionId;
  return {
    ok: true,
    frame: { type: "busy", seq, activeSessionId: activeSessionId.value },
  };
}

function validateTextFieldFrame<
  T extends "stt_partial" | "stt_final" | "assistant_text_delta",
>(
  value: Record<string, unknown>,
  type: T,
  seq: number,
): LiveVoiceParseResult<
  Extract<LiveVoiceServerFrame, { readonly type: T }>
> {
  const text = requireString(value, "text", type);
  if (!text.ok) return text;
  return {
    ok: true,
    frame: { type, seq, text: text.value } as Extract<
      LiveVoiceServerFrame,
      { readonly type: T }
    >,
  };
}

function validateTurnIdFrame<T extends "thinking" | "tts_done">(
  value: Record<string, unknown>,
  type: T,
  seq: number,
): LiveVoiceParseResult<
  Extract<LiveVoiceServerFrame, { readonly type: T }>
> {
  const turnId = requireString(value, "turnId", type);
  if (!turnId.ok) return turnId;
  return {
    ok: true,
    frame: { type, seq, turnId: turnId.value } as Extract<
      LiveVoiceServerFrame,
      { readonly type: T }
    >,
  };
}

function validateTtsAudioFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceTtsAudioServerFrame> {
  const mimeType = requireString(value, "mimeType", "tts_audio");
  if (!mimeType.ok) return mimeType;
  if (!("sampleRate" in value)) {
    return protocolError(
      "missing_required_field",
      "tts_audio frame is missing required field sampleRate",
      "sampleRate",
      "tts_audio",
    );
  }
  if (!isPositiveInteger(value.sampleRate)) {
    return protocolError(
      "invalid_field",
      "tts_audio frame field sampleRate must be a positive integer",
      "sampleRate",
      "tts_audio",
    );
  }
  if (!("dataBase64" in value)) {
    return protocolError(
      "missing_required_field",
      "tts_audio frame is missing required field dataBase64",
      "dataBase64",
      "tts_audio",
    );
  }
  if (typeof value.dataBase64 !== "string") {
    return invalidAudioPayload(
      "tts_audio frame dataBase64 must be a string",
      "dataBase64",
      "tts_audio",
    );
  }
  if (!isValidBase64Payload(value.dataBase64)) {
    return invalidAudioPayload(
      "tts_audio frame dataBase64 is malformed",
      "dataBase64",
      "tts_audio",
    );
  }
  return {
    ok: true,
    frame: {
      type: "tts_audio",
      seq,
      mimeType: mimeType.value,
      sampleRate: value.sampleRate,
      dataBase64: value.dataBase64,
    },
  };
}

function validateMetricsFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceMetricsServerFrame> {
  const turnId = requireString(value, "turnId", "metrics");
  if (!turnId.ok) return turnId;
  const sttMs = requireNullableInteger(value, "sttMs", "metrics");
  if (!sttMs.ok) return sttMs;
  const llmFirstDeltaMs = requireNullableInteger(
    value,
    "llmFirstDeltaMs",
    "metrics",
  );
  if (!llmFirstDeltaMs.ok) return llmFirstDeltaMs;
  const ttsFirstAudioMs = requireNullableInteger(
    value,
    "ttsFirstAudioMs",
    "metrics",
  );
  if (!ttsFirstAudioMs.ok) return ttsFirstAudioMs;
  const totalMs = requireNullableInteger(value, "totalMs", "metrics");
  if (!totalMs.ok) return totalMs;

  return {
    ok: true,
    frame: {
      type: "metrics",
      seq,
      turnId: turnId.value,
      sttMs: sttMs.value,
      llmFirstDeltaMs: llmFirstDeltaMs.value,
      ttsFirstAudioMs: ttsFirstAudioMs.value,
      totalMs: totalMs.value,
      ...(typeof value.event === "string" ? { event: value.event } : {}),
      ...(typeof value.sessionId === "string"
        ? { sessionId: value.sessionId }
        : {}),
      ...(typeof value.conversationId === "string"
        ? { conversationId: value.conversationId }
        : {}),
      ...("metrics" in value ? { metrics: value.metrics } : {}),
    },
  };
}

function validateArchivedFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceArchivedServerFrame> {
  const conversationId = requireString(value, "conversationId", "archived");
  if (!conversationId.ok) return conversationId;
  const sessionId = requireString(value, "sessionId", "archived");
  if (!sessionId.ok) return sessionId;

  let warning: LiveVoiceArchivedServerFrame["warning"];
  if ("warning" in value && value.warning !== undefined) {
    if (!isRecord(value.warning)) {
      return protocolError(
        "invalid_field",
        "archived frame field warning must be an object",
        "warning",
        "archived",
      );
    }
    const code = requireString(value.warning, "code", "archived.warning");
    if (!code.ok) return code;
    const message = requireString(
      value.warning,
      "message",
      "archived.warning",
    );
    if (!message.ok) return message;
    warning = { code: code.value, message: message.value };
  }

  let attachmentIds: string[] | undefined;
  if ("attachmentIds" in value && value.attachmentIds !== undefined) {
    if (
      !Array.isArray(value.attachmentIds) ||
      !value.attachmentIds.every((id): id is string => typeof id === "string")
    ) {
      return protocolError(
        "invalid_field",
        "archived frame field attachmentIds must be an array of strings",
        "attachmentIds",
        "archived",
      );
    }
    attachmentIds = value.attachmentIds;
  }

  let role: "user" | "assistant" | undefined;
  if ("role" in value && value.role !== undefined) {
    if (value.role !== "user" && value.role !== "assistant") {
      return protocolError(
        "invalid_field",
        "archived frame field role must be 'user' or 'assistant'",
        "role",
        "archived",
      );
    }
    role = value.role;
  }

  return {
    ok: true,
    frame: {
      type: "archived",
      seq,
      conversationId: conversationId.value,
      sessionId: sessionId.value,
      ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(typeof value.attachmentId === "string"
        ? { attachmentId: value.attachmentId }
        : {}),
      ...(attachmentIds !== undefined ? { attachmentIds } : {}),
      ...(warning !== undefined ? { warning } : {}),
    },
  };
}

function validateErrorFrame(
  value: Record<string, unknown>,
  seq: number,
): LiveVoiceParseResult<LiveVoiceErrorServerFrame> {
  const code = requireString(value, "code", "error");
  if (!code.ok) return code;
  if (!isLiveVoiceProtocolErrorCode(code.value)) {
    return protocolError(
      "invalid_field",
      `error frame field code must be a known protocol error code`,
      "code",
      "error",
    );
  }
  const message = requireString(value, "message", "error");
  if (!message.ok) return message;
  return {
    ok: true,
    frame: {
      type: "error",
      seq,
      code: code.value,
      message: message.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Base64 PCM helpers
// ---------------------------------------------------------------------------

// Process bytes in chunks to avoid `Maximum call stack size exceeded`
// when spreading large arrays into String.fromCharCode. 32 KiB stays
// well under all browser limits.
const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Encode a PCM16 audio buffer to base64.
 *
 * Operates on the underlying byte view (little-endian on every platform
 * we target). The input is treated as a contiguous byte stream — the
 * caller is responsible for sample-rate and channel layout metadata
 * (which travels in the JSON `start` frame).
 */
export function pcm16ToBase64(view: Int16Array): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Decode a base64 PCM16 audio buffer into an `Int16Array`.
 *
 * Throws if the base64 string has an odd byte length (malformed PCM16
 * data) so callers don't silently truncate samples.
 */
export function base64ToPcm16(b64: string): Int16Array {
  if (b64.length === 0) return new Int16Array(0);
  const binary = atob(b64);
  const length = binary.length;
  if (length % 2 !== 0) {
    throw new Error("base64ToPcm16: payload byte length must be even");
  }
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, length / 2);
}

// ---------------------------------------------------------------------------
// Helpers (validation primitives + error constructors)
// ---------------------------------------------------------------------------

function requireString(
  value: Record<string, unknown>,
  field: string,
  frameType: string,
):
  | { ok: true; value: string }
  | { ok: false; error: LiveVoiceProtocolError } {
  if (!(field in value)) {
    return {
      ok: false,
      error: {
        code: "missing_required_field",
        message: `${frameType} frame is missing required field ${field}`,
        field,
        frameType,
      },
    };
  }
  if (typeof value[field] !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        message: `${frameType} frame field ${field} must be a string`,
        field,
        frameType,
      },
    };
  }
  return { ok: true, value: value[field] };
}

function requireNullableInteger(
  value: Record<string, unknown>,
  field: string,
  frameType: string,
):
  | { ok: true; value: number | null }
  | { ok: false; error: LiveVoiceProtocolError } {
  if (!(field in value)) {
    return {
      ok: false,
      error: {
        code: "missing_required_field",
        message: `${frameType} frame is missing required field ${field}`,
        field,
        frameType,
      },
    };
  }
  const v = value[field];
  if (v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isSafeInteger(v)) {
    return { ok: true, value: v };
  }
  return {
    ok: false,
    error: {
      code: "invalid_field",
      message: `${frameType} frame field ${field} must be an integer or null`,
      field,
      frameType,
    },
  };
}

function isLiveVoiceServerFrameType(
  value: string,
): value is LiveVoiceServerFrameType {
  return (LIVE_VOICE_SERVER_FRAME_TYPES as readonly string[]).includes(value);
}

function isLiveVoiceProtocolErrorCode(
  value: string,
): value is LiveVoiceProtocolErrorCode {
  return (
    Object.values(LiveVoiceProtocolErrorCode) as readonly string[]
  ).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
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

