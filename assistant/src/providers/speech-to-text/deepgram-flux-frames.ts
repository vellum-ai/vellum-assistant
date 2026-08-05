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

import type { SttStreamServerEvent } from "../../stt/types.js";
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
 * `eager_eot_threshold` is set on the dialed URL.
 */
export type FluxFrameKind =
  | "Connected"
  | "TurnInfo"
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

/** A single word within a Flux turn frame, with timings and confidence. */
export interface FluxWord {
  /** The recognized word. */
  word?: string;
  /** Per-word recognition confidence in [0, 1]. */
  confidence?: number;
  /** Word start offset in seconds from the beginning of the stream. */
  start?: number;
  /** Word end offset in seconds from the beginning of the stream. */
  end?: number;
}

/** Session-established frame, sent once after the socket opens. */
export interface FluxConnectedFrame {
  type: "Connected";
  request_id?: string;
  sequence_id?: number;
}

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
  /** Per-word timings and confidences backing {@link transcript}. */
  words?: FluxWord[];
  /** Flux's end-of-turn confidence in [0, 1]. */
  end_of_turn_confidence?: number;
}

export type FluxFrame = FluxConnectedFrame | FluxTurnFrame;

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
 */
export function parseFluxFrame(raw: unknown): SttStreamServerEvent[] {
  const frame = coerceFrame(raw);
  if (!frame) {
    return [];
  }

  const kind = readFrameKind(frame);
  switch (kind) {
    case "Connected":
      return [];
    case "StartOfTurn":
      return [{ type: "turn-start" }];
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
        },
      ];
    }
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
function coerceFrame(raw: unknown): Partial<FluxTurnFrame> | null {
  const value = typeof raw === "string" ? parseJsonSafe(raw) : raw;
  if (!isPlainObject(value)) {
    log.debug("Dropped a Deepgram Flux payload that is not a frame object");
    return null;
  }
  return value as Partial<FluxTurnFrame>;
}

/** The turn state a frame describes: `event` when present, else `type`. */
function readFrameKind(frame: Partial<FluxTurnFrame>): string | undefined {
  if (typeof frame.event === "string") {
    return frame.event;
  }
  return typeof frame.type === "string" ? frame.type : undefined;
}

/** Trimmed transcript text, empty when the frame carries none. */
function readTranscript(frame: Partial<FluxTurnFrame>): string {
  return typeof frame.transcript === "string" ? frame.transcript.trim() : "";
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

/** Inclusive bounds Deepgram enforces on `eager_eot_threshold`. */
const EAGER_EOT_THRESHOLD_RANGE = { min: 0.3, max: 0.9 } as const;

/** Inclusive bounds Deepgram enforces on `eot_timeout_ms`. */
const EOT_TIMEOUT_MS_RANGE = { min: 500, max: 60_000 } as const;

export interface FluxQueryParamOptions {
  /** Flux model to run, e.g. `"flux-general-en"`. Required by Deepgram. */
  model: string;
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
   * Language hints for the multilingual model. Repeatable: each entry is sent
   * as its own `language_hint` parameter. Ignored by monolingual models.
   */
  languageHint?: string | string[];
}

/**
 * Build the query string for Flux's `/v2/listen` endpoint (no leading `?`).
 *
 * Every optional parameter is omitted when undefined rather than sent with a
 * default, because Deepgram's own defaults are the intended behavior and
 * omitting `eager_eot_threshold` is what disables eager turn-end speculation.
 * Thresholds are clamped to the ranges Deepgram accepts so an out-of-range
 * value degrades to the nearest legal one instead of failing the handshake.
 */
export function buildFluxQueryParams(opts: FluxQueryParamOptions): string {
  const params = new URLSearchParams();
  params.set("model", opts.model);

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

  const eagerEotThreshold = clamp(
    opts.eagerEotThreshold,
    EAGER_EOT_THRESHOLD_RANGE,
  );
  if (eagerEotThreshold !== undefined) {
    params.set("eager_eot_threshold", String(eagerEotThreshold));
  }

  const eotTimeoutMs = clamp(opts.eotTimeoutMs, EOT_TIMEOUT_MS_RANGE);
  if (eotTimeoutMs !== undefined) {
    params.set("eot_timeout_ms", String(Math.round(eotTimeoutMs)));
  }

  const hints = opts.languageHint;
  for (const hint of typeof hints === "string" ? [hints] : (hints ?? [])) {
    if (hint) {
      params.append("language_hint", hint);
    }
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
