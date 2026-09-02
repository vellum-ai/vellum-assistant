/**
 * Pure protocol helpers for Deepgram's Flux conversational speech API
 * (`wss://api.deepgram.com/v2/listen`).
 *
 * This module holds only pure functions: frame parsing and URL query
 * construction. It owns no socket, no timers, and no I/O, so the risky part
 * of the protocol (the wire shapes Deepgram controls) can be exercised
 * exhaustively in tests. The streaming transcriber wires these into a
 * WebSocket session.
 *
 * Flux differs from Deepgram's v1 live API in that its turn model, not the
 * caller's endpointing heuristics, decides when a turn ends. Frames are
 * mapped onto the daemon's {@link SttStreamServerEvent} contract so that a
 * consumer which ignores the turn-detection events still commits transcripts
 * from `partial` / `final` exactly as it does with any other provider.
 */

import type {
  SttErrorCategory,
  SttStreamServerErrorEvent,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { parseJsonSafe } from "../../util/json.js";
import { getLogger } from "../../util/logger.js";
import { isPlainObject } from "../../util/object.js";

const log = getLogger("deepgram-flux-frames");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Frame discriminators Deepgram emits on `/v2/listen`.
 *
 * `EagerEndOfTurn` and `TurnResumed` appear only when
 * `eager_eot_threshold` is set on the dialed URL. `Error` is a fatal frame:
 * Deepgram terminates the session after sending it.
 */
export type FluxFrameKind =
  | "Connected"
  | "TurnInfo"
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn"
  | "Error";

/**
 * A turn-state frame.
 *
 * Deepgram nests the turn state under `event` on `TurnInfo` frames
 * (`{ type: "TurnInfo", event: "EndOfTurn", ... }`) and also documents the
 * states as frame types in their own right. Both shapes are accepted:
 * `event` wins when present, otherwise `type` is the discriminator.
 */
export interface FluxTurnFrame {
  type: FluxFrameKind;
  /** Turn state carried by a `TurnInfo` frame. */
  event?: FluxFrameKind;
  request_id?: string;
  sequence_id?: number;
  /** Zero-based index of the turn within the session. */
  turn_index?: number;
  /** Start of the audio window this frame describes, in seconds. */
  audio_window_start?: number;
  /** End of the audio window this frame describes, in seconds. */
  audio_window_end?: number;
  /** Transcript for the turn so far. */
  transcript?: string;
  /** Flux's end-of-turn confidence in [0, 1]. */
  end_of_turn_confidence?: number;
}

/**
 * Fatal error frame. Deepgram closes the session immediately after sending
 * one, so it is the only diagnostic a caller ever gets for a provider-side
 * failure.
 */
export interface FluxErrorFrame {
  type: "Error";
  sequence_id?: number;
  /** Machine-readable identifier, e.g. `"INTERNAL_SERVER_ERROR"`. */
  code?: string;
  /** Prose explanation of the failure. */
  description?: string;
}

/**
 * A payload that has been confirmed to be an object but whose frame kind is
 * not yet known: the union of every field any documented frame can carry.
 */
type InboundFluxFrame = Partial<FluxTurnFrame> &
  Partial<Omit<FluxErrorFrame, "type">>;

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/**
 * Map one Flux frame onto zero or more daemon streaming events.
 *
 * Accepts either a JSON string (as delivered by the WebSocket) or an
 * already-parsed value. Unknown frame kinds, malformed JSON, and non-object
 * payloads yield an empty array and a debug log: Deepgram can add frame types
 * without breaking the session, so this never throws and never rejects a
 * stream over an unrecognized frame.
 *
 * Mapping:
 * - `Connected` emits nothing (session bookkeeping).
 * - `StartOfTurn` emits `turn-start`.
 * - `Update` and bare `TurnInfo` emit `partial`: an interim transcript
 *   refresh, since the commit comes from `EndOfTurn`.
 * - `EagerEndOfTurn` emits `eager-turn-end`, retracted by `TurnResumed` or
 *   confirmed by `EndOfTurn`.
 * - `TurnResumed` emits `turn-resumed`.
 * - `EndOfTurn` emits `final` followed by `turn-end`. The `final` comes first
 *   so a consumer that ignores turn events commits the transcript exactly as
 *   it does for a provider without turn detection.
 * - `Error` emits `error`. This frame is fatal and is the only place the
 *   provider's own diagnostic appears, so it is surfaced rather than dropped.
 *
 * `turn-start` and `turn-end` carry the frame's `turn_index` when Deepgram
 * sends one, which is what lets a consumer tell an end-of-turn for the turn
 * still in progress from one Deepgram has already superseded.
 */
export function parseFluxFrame(raw: unknown): SttStreamServerEvent[] {
  const frame = coerceFrame(raw);
  if (!frame) {
    return [];
  }

  const kind = readFrameKind(frame);
  const turnIndex = readNumber(frame.turn_index);
  switch (kind) {
    case "Connected":
      return [];
    case "StartOfTurn":
      return [
        {
          type: "turn-start",
          ...(turnIndex !== undefined ? { turnIndex } : {}),
        },
      ];
    case "Update":
    case "TurnInfo":
      return [{ type: "partial", text: readTranscript(frame) }];
    case "EagerEndOfTurn":
      return [{ type: "eager-turn-end", text: readTranscript(frame) }];
    case "TurnResumed":
      return [{ type: "turn-resumed" }];
    case "EndOfTurn": {
      const text = readTranscript(frame);
      const confidence = readNumber(frame.end_of_turn_confidence);
      return [
        { type: "final", text },
        {
          type: "turn-end",
          text,
          ...(confidence !== undefined ? { confidence } : {}),
          ...(turnIndex !== undefined ? { turnIndex } : {}),
        },
      ];
    }
    case "Error":
      return [readErrorEvent(frame)];
    default:
      log.debug({ kind }, "Ignoring unrecognized Deepgram Flux frame");
      return [];
  }
}

/**
 * Normalize an inbound payload into a frame object, or null when it is not
 * one. JSON strings are parsed; anything that is not a plain object (null,
 * arrays, primitives, unparseable text) is rejected.
 */
function coerceFrame(raw: unknown): InboundFluxFrame | null {
  const value = typeof raw === "string" ? parseJsonSafe(raw) : raw;
  if (!isPlainObject(value)) {
    log.debug("Dropped a Deepgram Flux payload that is not a frame object");
    return null;
  }
  return value as InboundFluxFrame;
}

/** The turn state a frame describes: `event` when present, else `type`. */
function readFrameKind(frame: InboundFluxFrame): string | undefined {
  if (typeof frame.event === "string") {
    return frame.event;
  }
  return typeof frame.type === "string" ? frame.type : undefined;
}

/** Trimmed transcript text, empty when the frame carries none. */
function readTranscript(frame: InboundFluxFrame): string {
  return typeof frame.transcript === "string" ? frame.transcript.trim() : "";
}

/**
 * Patterns that map a Flux error onto a normalized {@link SttErrorCategory},
 * tried in order. Anything unmatched stays `provider-error`.
 *
 * Deepgram documents only `INTERNAL_SERVER_ERROR` for Flux itself, so these
 * match the account-wide error vocabulary
 * (https://developers.deepgram.com/docs/errors) and mirror how
 * `DeepgramRealtimeTranscriber` separates auth and rate-limit failures from
 * everything else.
 *
 * The timeout pattern deliberately requires a `_TIMEOUT` suffix at a word
 * boundary so a configuration complaint about `eot_timeout_ms` is not
 * mistaken for a transport timeout.
 */
const FLUX_ERROR_CATEGORY_PATTERNS: ReadonlyArray<
  readonly [SttErrorCategory, RegExp]
> = [
  [
    "auth",
    /INVALID_AUTH|INSUFFICIENT_PERMISSIONS|UNAUTHORIZED|FORBIDDEN|INVALID CREDENTIALS|API KEY/,
  ],
  ["rate-limit", /TOO_MANY_REQUESTS|RATE[_ ]LIMIT|QUOTA/],
  ["timeout", /^TIMEOUT|_TIMEOUT\b|TIMED[_ ]OUT/],
  [
    "invalid-audio",
    /UNPROCESSABLE|CORRUPT|UNSUPPORTED|INVALID[_ ]AUDIO|BAD[_ ]AUDIO/,
  ],
];

/**
 * Turn a fatal `Error` frame into a stream `error` event, preserving the
 * provider's own `code` and `description` so the diagnostic survives all the
 * way to the caller. Deepgram closes the socket right after this frame, so
 * dropping it would leave a bare close as the only signal.
 */
function readErrorEvent(frame: InboundFluxFrame): SttStreamServerErrorEvent {
  const code = typeof frame.code === "string" ? frame.code.trim() : "";
  const description =
    typeof frame.description === "string" ? frame.description.trim() : "";

  const haystack = `${code} ${description}`.toUpperCase();
  const category =
    FLUX_ERROR_CATEGORY_PATTERNS.find(([, pattern]) =>
      pattern.test(haystack),
    )?.[0] ?? "provider-error";

  const detail = description || "no description provided";
  const message = code
    ? `Deepgram Flux error (${code}): ${detail}`
    : `Deepgram Flux error: ${detail}`;

  log.warn({ code, category }, "Deepgram Flux sent a fatal error frame");
  return { type: "error", category, message };
}

/** A finite number, or undefined for anything else. */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/**
 * Raw audio encodings Flux accepts. Containerized audio (WAV, Ogg) is
 * self-describing and needs neither `encoding` nor `sample_rate`.
 */
export type FluxEncoding =
  | "linear16"
  | "linear32"
  | "mulaw"
  | "alaw"
  | "opus"
  | "ogg-opus";

/** Inclusive bounds Deepgram enforces on `eot_threshold`. */
const EOT_THRESHOLD_RANGE = { min: 0.5, max: 0.9 } as const;

/**
 * Deepgram's server-side default for `eot_threshold`, applied when the
 * parameter is omitted. It is the ceiling `eager_eot_threshold` must respect
 * in that case, since the validation runs against the threshold actually in
 * force rather than the one we sent.
 */
const DEFAULT_EOT_THRESHOLD = 0.7;

/** Inclusive bounds Deepgram enforces on `eager_eot_threshold`. */
const EAGER_EOT_THRESHOLD_RANGE = { min: 0.3, max: 0.9 } as const;

/** Inclusive bounds Deepgram enforces on `eot_timeout_ms`. */
const EOT_TIMEOUT_MS_RANGE = { min: 500, max: 60_000 } as const;

export interface FluxQueryParamOptions {
  /**
   * Flux model to run, e.g. `"flux-general-en"`. Required when dialing
   * Deepgram directly. Omitted on the managed relay, which derives the model
   * from the spoken language and prices it before dialing, and rejects a
   * client-sent one.
   */
  model?: string;
  /**
   * Encoding of the raw audio being sent. Omit for containerized audio,
   * which carries its own format header.
   */
  encoding?: FluxEncoding;
  /**
   * Sample rate (Hz) of the raw audio. Required whenever {@link encoding} is
   * set. Flux accepts 8000, 16000, 24000, 44100, and 48000.
   */
  sampleRate?: number;
  /** End-of-turn confidence Flux must reach before committing a turn. */
  eotThreshold?: number;
  /**
   * Confidence at which Flux starts speculating a turn has ended. Leaving it
   * undefined omits the parameter, which is what keeps Deepgram from emitting
   * `EagerEndOfTurn` / `TurnResumed` frames at all.
   */
  eagerEotThreshold?: number;
  /** Silence (ms) after which Flux force-ends a turn. */
  eotTimeoutMs?: number;
  /**
   * Language hint for the multilingual model. Meaningless on the English
   * model, and omitted entirely for code-switching, which is what asks Flux
   * to detect the language itself.
   */
  languageHint?: string;
}

/**
 * Build the query string for Flux's `/v2/listen` endpoint (no leading `?`).
 *
 * Every optional parameter is omitted when undefined rather than sent with a
 * default, because Deepgram's own defaults are the intended behavior and
 * omitting `eager_eot_threshold` is what disables eager turn-end speculation.
 * Thresholds are clamped to the ranges Deepgram accepts so an out-of-range
 * value degrades to the nearest legal one instead of failing the handshake.
 *
 * Deepgram additionally rejects a request whose `eager_eot_threshold` exceeds
 * its `eot_threshold`
 * (https://developers.deepgram.com/docs/flux/configuration#validation-rules),
 * so after each threshold is clamped to its own range the eager value is
 * clamped down again to the EOT threshold in force (the one being sent, or
 * Deepgram's {@link DEFAULT_EOT_THRESHOLD} when none is). Clamping keeps a
 * misconfigured pair from failing the whole session; the adjustment is logged
 * at debug when it fires.
 */
/** Flux's English model, and its multilingual sibling. */
const FLUX_MODEL_ENGLISH = "flux-general-en";
const FLUX_MODEL_MULTILINGUAL = "flux-general-multi";

/**
 * Languages the multilingual Flux model serves, as base subtags.
 *
 * Deepgram documents this roster for `flux-general-multi`; anything outside it
 * has no model to run on.
 */
/**
 * Exported so the provider catalog can report it. A client deciding whether to
 * offer turn detection needs the same roster, and copying it there would make
 * a third place to keep in step with this one and the relay's.
 */
export const FLUX_MULTILINGUAL_SUBTAGS: ReadonlySet<string> = new Set([
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "nl",
  "pt",
  "ru",
]);

/** The code that asks Flux to detect and code-switch rather than be told. */
const FLUX_CODE_SWITCHING = "multi";

/**
 * The model and optional hint a spoken language selects.
 *
 * Deliberately the same mapping the managed relay applies server-side, so a
 * language means the same thing whether Flux is reached with your own key or
 * through the platform. Without it a BYOK session pins the English model and
 * returns English-sounding nonsense for every other language, which is
 * invisible from the transcript alone.
 *
 * Returns null when the language has no Flux model, leaving the caller to
 * refuse rather than transcribe the wrong thing.
 */
export function fluxModelForLanguage(
  language: string | undefined,
): { model: string; languageHint?: string } | null {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) {
    return { model: FLUX_MODEL_ENGLISH };
  }
  if (normalized === FLUX_CODE_SWITCHING) {
    return { model: FLUX_MODEL_MULTILINGUAL };
  }
  const base = normalized.split("-")[0] ?? normalized;
  if (!FLUX_MULTILINGUAL_SUBTAGS.has(base)) {
    return null;
  }
  if (base === "en") {
    return { model: FLUX_MODEL_ENGLISH };
  }
  return { model: FLUX_MODEL_MULTILINGUAL, languageHint: base };
}

export function buildFluxQueryParams(opts: FluxQueryParamOptions): string {
  const params = new URLSearchParams();
  if (opts.model !== undefined) {
    params.set("model", opts.model);
  }

  if (opts.languageHint !== undefined) {
    params.set("language_hint", opts.languageHint);
  }

  if (opts.encoding !== undefined) {
    params.set("encoding", opts.encoding);
  }
  const sampleRate = readNumber(opts.sampleRate);
  if (sampleRate !== undefined) {
    params.set("sample_rate", String(Math.round(sampleRate)));
  }

  const eotThreshold = clamp(opts.eotThreshold, EOT_THRESHOLD_RANGE);
  if (eotThreshold !== undefined) {
    params.set("eot_threshold", String(eotThreshold));
  }

  let eagerEotThreshold = clamp(
    opts.eagerEotThreshold,
    EAGER_EOT_THRESHOLD_RANGE,
  );
  const eagerCeiling = eotThreshold ?? DEFAULT_EOT_THRESHOLD;
  if (eagerEotThreshold !== undefined && eagerEotThreshold > eagerCeiling) {
    log.debug(
      {
        requested: opts.eagerEotThreshold,
        clampedTo: eagerCeiling,
        eotThreshold: eagerCeiling,
        usingDefaultEotThreshold: eotThreshold === undefined,
      },
      "Clamped Deepgram Flux eager_eot_threshold down to eot_threshold",
    );
    eagerEotThreshold = eagerCeiling;
  }
  if (eagerEotThreshold !== undefined) {
    params.set("eager_eot_threshold", String(eagerEotThreshold));
  }

  const eotTimeoutMs = clamp(opts.eotTimeoutMs, EOT_TIMEOUT_MS_RANGE);
  if (eotTimeoutMs !== undefined) {
    params.set("eot_timeout_ms", String(Math.round(eotTimeoutMs)));
  }

  return params.toString();
}

/** Clamp a finite number into an inclusive range; undefined passes through. */
function clamp(
  value: number | undefined,
  range: { min: number; max: number },
): number | undefined {
  const numeric = readNumber(value);
  if (numeric === undefined) {
    return undefined;
  }
  return Math.min(Math.max(numeric, range.min), range.max);
}
