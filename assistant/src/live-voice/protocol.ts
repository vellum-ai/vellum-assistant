import { type ClientOs, parseClientOs } from "../channels/types.js";

const LIVE_VOICE_CLIENT_FRAME_TYPES = [
  "start",
  "audio",
  "ptt_release",
  "interrupt",
  "end",
  "update_config",
  "attach_image",
  "text",
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
  /**
   * The client has a text input affordance, so it can take a turn without the
   * microphone (see {@link LiveVoiceClientTextTurnFrame}).
   *
   * Load-bearing at startup, not just a feature announcement: a session whose
   * speech-to-text leg has no working credential is normally rejected outright
   * (`credentials_unavailable`), because a session that cannot hear is a
   * session that cannot be used. A client that can type is the exception: for
   * it, a missing STT leg is degradation rather than failure, so the session
   * starts text-only and says so on `ready` via `audioInput: false`.
   *
   * Absent means false: a client that predates the field has no way to take a
   * turn without the microphone, so a broken STT leg must still fail its
   * session rather than open one it cannot speak into.
   */
  readonly textInput?: boolean;
  /**
   * Which client opened the session. Absent from clients that predate the
   * field, in which case the originating client is simply unknown.
   *
   * A {@link ClientOs}, not an `InterfaceId`, and deliberately so: the iOS and
   * macOS apps run the same web bundle over the same transport, so the thing
   * that actually differs between them is the OS surface. `ClientOs` is also
   * the vocabulary that is barred by contract from answering transport
   * questions (see `channels/types.ts`), which is the invariant wanted here:
   * this value is **analytics only**. It rides the voice turn's telemetry
   * `client` bag (see `voice-session-bridge.ts`) and never reaches
   * `userMessageInterface`, which feeds `resolveChannelCapabilities` and is
   * load-bearing for what a voice turn may do.
   */
  readonly client?: ClientOs;
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

/**
 * Longest typed turn accepted on a `text` frame.
 *
 * Generous next to anything a person says in one breath, and far below what
 * would make the reply unspeakable. The cap exists so a socket tuned for 50 ms
 * audio frames cannot be handed a whole document to synthesize.
 */
export const MAX_TEXT_TURN_CHARS = 4_000;

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

/**
 * A photo the user took mid-call, already uploaded over the normal attachment
 * route (`POST /v1/assistants/{id}/attachments`). Only the resulting id
 * travels here.
 *
 * The bytes deliberately do not: the upload endpoint already normalizes HEIF,
 * caps size, and stores the blob, and routing an image through this socket
 * would duplicate all of it on a transport tuned for 50 ms audio frames.
 *
 * The id is *parked*, not dispatched. It rides the next turn's own user
 * message (see {@link LiveVoiceSession}'s pending-attachment handling), so the
 * photo and the words spoken about it are one message rather than two, which
 * is what lets "what's this?" resolve, and what keeps the image attached to the
 * newest user message, the only one a context-overflow retry preserves media on
 * (`conversation-media-retry.ts`).
 */
export interface LiveVoiceClientAttachImageFrame {
  readonly type: "attach_image";
  readonly attachmentId: string;
}

/**
 * A user turn the client already has as text, taken without the microphone.
 *
 * The session runs it through the same pipeline a spoken turn takes, joining
 * at the point STT would have handed over a finished transcript: same turn
 * runner, same streaming TTS, same barge-in and progress narration. Only the
 * capture half is skipped, so the reply is spoken exactly as it would be for
 * speech.
 *
 * Deliberately not routed through `processMessage` into the conversation the
 * session owns. That path diverges from the voice one in ways that have
 * already produced their own bug class (missing user_message_echo, an
 * unpersisted conversation row, missing trustContext), and a typed turn that
 * behaved differently from a spoken one would reintroduce all of it.
 *
 * Accepted at any point in a session, not only as its first turn. A user
 * whose microphone stops working mid-session types the rest of the
 * conversation; a client with no microphone at all (see the start frame's
 * `textInput`) types every turn.
 */
export interface LiveVoiceClientTextTurnFrame {
  readonly type: "text";
  readonly text: string;
  /**
   * Marks the turn as an internal instruction rather than something the user
   * typed. The row still persists and still drives the turn, so the model
   * sees it, but it is suppressed from the transcript: no live echo, and
   * `/messages` filters it after a reload.
   *
   * For machine signals the user never wrote, such as the greeting that opens
   * a voice session. A turn the user actually typed leaves it unset.
   *
   * Optional, and a daemon that does not understand it simply persists the
   * turn visibly, so a client cannot tell from the frame alone whether it was
   * honored.
   */
  readonly hidden?: boolean;
}

export type LiveVoiceClientFrame =
  | LiveVoiceClientStartFrame
  | LiveVoiceClientAudioFrame
  | LiveVoiceClientPttReleaseFrame
  | LiveVoiceClientInterruptFrame
  | LiveVoiceClientEndFrame
  | LiveVoiceClientUpdateConfigFrame
  | LiveVoiceClientAttachImageFrame
  | LiveVoiceClientTextTurnFrame;

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
  /**
   * Whether this daemon will accept `text` frames on the session. Absent
   * (older daemons) means no, which is what lets a client that asked for
   * `textInput` fall back rather than type into a socket that would answer
   * every typed turn with an `unknown_type` error.
   */
  readonly textInput?: boolean;
  /**
   * Whether the session's speech-to-text leg is live. Absent means yes, which
   * is the only thing an older daemon can have meant: it rejects a session it
   * cannot transcribe, so every session it readies can hear.
   *
   * False is reachable only for a client that declared `textInput`, and tells
   * it to present the session as typed rather than draw a microphone that
   * will never hear anything.
   */
  readonly audioInput?: boolean;
}

/**
 * Where the session holding the daemon's single live-voice slot is running,
 * as much of it as the daemon knows.
 *
 * Display only: it is what lets a client refused a session say where the one
 * that blocked it is. Nothing routes, authorizes, or decides capability on
 * it, and every field is optional, so a holder that names neither its surface
 * nor a conversation is simply less specific.
 */
export interface LiveVoiceSessionHolder {
  /**
   * The OS surface the holder is running on, from its `start` frame. A
   * {@link ClientOs} carries no transport meaning by contract (see
   * `channels/types.ts`), which is exactly right for a label: it says which
   * device the user should go looking on, and answers nothing else.
   */
  readonly client?: ClientOs;
  /** The conversation the holder is talking in, once it has one. */
  readonly conversationId?: string;
}

export interface LiveVoiceBusyServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "busy";
  readonly activeSessionId: string;
  /**
   * Absent from daemons that predate it, and from a holder that revealed
   * neither field, so a client must degrade to the unspecific copy rather
   * than assume.
   */
  readonly holder?: LiveVoiceSessionHolder;
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

/**
 * What the assistant is doing inside a turn, as one short user-facing line.
 *
 * Exists because a live-voice turn can go silent for a long time while it
 * works, and the surfaces that show the session (the iOS Live Activity, and
 * the room) can otherwise only say "Thinking...". The label is composed here
 * rather than by each surface for the same reason phase wording is composed
 * once: the Live Activity has two independent drivers (this socket and an APNs
 * push the daemon dispatches), they must carry identical content, and the only
 * way to guarantee that is for both to be handed the same string.
 *
 * An empty `label` means "no current activity", which is what a turn's end
 * sends. Emitted only on change, never per tool result.
 */
export interface LiveVoiceActivityServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "activity";
  readonly turnId: string;
  readonly label: string;
  /**
   * The confirmation this turn is blocked on, when the label describes a wait
   * rather than work in flight. Absent otherwise.
   *
   * It travels so that a surface outside the app — the Live Activity's
   * Approve/Deny buttons — can answer the request it was drawn against rather
   * than whatever is pending by the time the press lands. Content on a Lock
   * Screen can be seconds old, and a decision is the one thing that must not
   * be re-pointed when it is: the id lets a client drop a press aimed at a
   * request already answered, timed out, or superseded.
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
   * when the endpoint decider was consulted (otherwise the field is absent,
   * keeping frames unchanged).
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
  readonly code: LiveVoiceProtocolErrorCode;
  readonly message: string;
  /**
   * The client frame this error is about, when the failure was a parse or
   * validation failure of a specific frame. Absent otherwise, and absent from
   * daemons predating the field.
   *
   * It exists so an `unknown_type` is attributable. A client that sends more
   * than one optional frame (today: `update_config` and `attach_image`) gets
   * the same code for either, and without this has to assume which one was
   * refused. The wrong assumption is silent in both directions: settings stop
   * applying for a session, or a photo the user watched themselves take is
   * dropped with nothing said.
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
  | WithoutSeq<LiveVoiceActivityServerFrame>
  | WithoutSeq<LiveVoiceAssistantTextDeltaServerFrame>
  | WithoutSeq<LiveVoiceTtsAudioServerFrame>
  | WithoutSeq<LiveVoiceTtsDoneServerFrame>
  | WithoutSeq<LiveVoiceTurnCancelledServerFrame>
  | WithoutSeq<LiveVoiceMinimizeRoomServerFrame>
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
    case "attach_image":
      return validateAttachImageFrame(value);
    case "text":
      return validateTextTurnFrame(value);
  }
}

function validateTextTurnFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientTextTurnFrame> {
  if (!("text" in value)) {
    return protocolError(
      "missing_required_field",
      "text frame is missing required field text",
      "text",
      "text",
    );
  }

  if (typeof value.text !== "string") {
    return protocolError(
      "invalid_field",
      "text frame field text must be a string",
      "text",
      "text",
    );
  }

  // Trimmed before the emptiness check, so a frame carrying only whitespace is
  // rejected here rather than reaching the session as a turn with nothing in
  // it. The trimmed value is what travels, so the turn the session runs is the
  // one that was validated.
  const text = value.text.trim();

  if (text.length === 0) {
    return protocolError(
      "invalid_field",
      "text frame field text must not be empty",
      "text",
      "text",
    );
  }

  if (text.length > MAX_TEXT_TURN_CHARS) {
    return protocolError(
      "invalid_field",
      `text frame field text must be at most ${MAX_TEXT_TURN_CHARS} characters`,
      "text",
      "text",
    );
  }

  if ("hidden" in value && typeof value.hidden !== "boolean") {
    return protocolError(
      "invalid_field",
      "text frame field hidden must be a boolean",
      "hidden",
      "text",
    );
  }

  return {
    ok: true,
    frame: {
      type: "text",
      text,
      ...(value.hidden === true ? { hidden: true } : {}),
    },
  };
}

function validateAttachImageFrame(
  value: Record<string, unknown>,
): LiveVoiceParseResult<LiveVoiceClientAttachImageFrame> {
  if (!("attachmentId" in value)) {
    return protocolError(
      "missing_required_field",
      "attach_image frame is missing required field attachmentId",
      "attachmentId",
      "attach_image",
    );
  }

  if (!isNonEmptyString(value.attachmentId)) {
    return protocolError(
      "invalid_field",
      "attach_image frame field attachmentId must be a non-empty string",
      "attachmentId",
      "attach_image",
    );
  }

  return {
    ok: true,
    frame: { type: "attach_image", attachmentId: value.attachmentId },
  };
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

  if ("textInput" in value && typeof value.textInput !== "boolean") {
    return protocolError(
      "invalid_field",
      "start frame field textInput must be a boolean",
      "textInput",
      "start",
    );
  }

  // An unrecognized client is dropped rather than rejected: the field is an
  // analytics dimension, and failing a session's startup over it would trade a
  // gap in a chart for a user who cannot talk to their assistant.
  const client = parseClientOs(value.client);

  return {
    ok: true,
    frame: {
      type: "start",
      ...(typeof value.conversationId === "string"
        ? { conversationId: value.conversationId }
        : {}),
      ...(client ? { client } : {}),
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
      ...(value.textInput === true ? { textInput: true } : {}),
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
