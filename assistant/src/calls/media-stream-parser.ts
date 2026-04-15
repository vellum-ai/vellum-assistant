/**
 * Strict parser/validator for inbound Twilio Media Stream WebSocket frames.
 *
 * Every frame arriving on the media-stream WebSocket is raw JSON. This module
 * parses the JSON, validates its shape against the protocol types defined in
 * `media-stream-protocol.ts`, and returns a discriminated result so callers
 * can branch on success/failure without try/catch.
 *
 * Design decisions:
 * - Fail-fast: malformed frames are rejected immediately with a structured
 *   error rather than propagated as partial data. This keeps downstream
 *   consumers (turn detector, STT session) free from defensive null checks.
 * - No logging: the parser is a pure function. Callers decide how to log
 *   rejected frames (warn, debug, metric, etc.).
 * - No dependencies on runtime singletons so the parser is trivially
 *   testable in isolation.
 */

import type {
  MediaStreamDtmfEvent,
  MediaStreamEvent,
  MediaStreamMarkEvent,
  MediaStreamMediaEvent,
  MediaStreamStartEvent,
  MediaStreamStopEvent,
} from "./media-stream-protocol.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; event: MediaStreamEvent }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

// ---------------------------------------------------------------------------
// Per-event validators
// ---------------------------------------------------------------------------

function validateStart(raw: Record<string, unknown>): ParseResult {
  if (!isString(raw.sequenceNumber)) {
    return { ok: false, error: "start: missing or invalid sequenceNumber" };
  }
  if (!isString(raw.streamSid)) {
    return { ok: false, error: "start: missing or invalid streamSid" };
  }

  const start = raw.start;
  if (!isRecord(start)) {
    return { ok: false, error: "start: missing or invalid start object" };
  }
  if (!isString(start.accountSid)) {
    return { ok: false, error: "start: missing start.accountSid" };
  }
  if (!isString(start.streamSid)) {
    return { ok: false, error: "start: missing start.streamSid" };
  }
  if (!isString(start.callSid)) {
    return { ok: false, error: "start: missing start.callSid" };
  }
  if (!isStringArray(start.tracks)) {
    return { ok: false, error: "start: missing or invalid start.tracks" };
  }

  // customParameters can be missing; default to empty object
  const customParameters = isRecord(start.customParameters)
    ? (start.customParameters as Record<string, string>)
    : {};

  // mediaFormat is required
  const mf = start.mediaFormat;
  if (!isRecord(mf)) {
    return { ok: false, error: "start: missing start.mediaFormat" };
  }
  if (!isString(mf.encoding)) {
    return { ok: false, error: "start: missing mediaFormat.encoding" };
  }
  if (typeof mf.sampleRate !== "number") {
    return { ok: false, error: "start: missing mediaFormat.sampleRate" };
  }
  if (typeof mf.channels !== "number") {
    return { ok: false, error: "start: missing mediaFormat.channels" };
  }

  const event: MediaStreamStartEvent = {
    event: "start",
    sequenceNumber: raw.sequenceNumber as string,
    streamSid: raw.streamSid as string,
    start: {
      accountSid: start.accountSid as string,
      streamSid: start.streamSid as string,
      callSid: start.callSid as string,
      tracks: start.tracks as string[],
      customParameters,
      mediaFormat: {
        encoding: mf.encoding as string,
        sampleRate: mf.sampleRate as number,
        channels: mf.channels as number,
      },
    },
  };
  return { ok: true, event };
}

function validateMedia(raw: Record<string, unknown>): ParseResult {
  if (!isString(raw.sequenceNumber)) {
    return { ok: false, error: "media: missing or invalid sequenceNumber" };
  }
  if (!isString(raw.streamSid)) {
    return { ok: false, error: "media: missing or invalid streamSid" };
  }

  const media = raw.media;
  if (!isRecord(media)) {
    return { ok: false, error: "media: missing or invalid media object" };
  }
  if (!isString(media.track)) {
    return { ok: false, error: "media: missing media.track" };
  }
  if (!isString(media.chunk)) {
    return { ok: false, error: "media: missing media.chunk" };
  }
  if (!isString(media.timestamp)) {
    return { ok: false, error: "media: missing media.timestamp" };
  }
  if (!isString(media.payload)) {
    return { ok: false, error: "media: missing media.payload" };
  }

  const event: MediaStreamMediaEvent = {
    event: "media",
    sequenceNumber: raw.sequenceNumber as string,
    streamSid: raw.streamSid as string,
    media: {
      track: media.track as string,
      chunk: media.chunk as string,
      timestamp: media.timestamp as string,
      payload: media.payload as string,
    },
  };
  return { ok: true, event };
}

function validateDtmf(raw: Record<string, unknown>): ParseResult {
  if (!isString(raw.sequenceNumber)) {
    return { ok: false, error: "dtmf: missing or invalid sequenceNumber" };
  }
  if (!isString(raw.streamSid)) {
    return { ok: false, error: "dtmf: missing or invalid streamSid" };
  }

  const dtmf = raw.dtmf;
  if (!isRecord(dtmf)) {
    return { ok: false, error: "dtmf: missing or invalid dtmf object" };
  }
  if (!isString(dtmf.digit)) {
    return { ok: false, error: "dtmf: missing dtmf.digit" };
  }

  const event: MediaStreamDtmfEvent = {
    event: "dtmf",
    streamSid: raw.streamSid as string,
    sequenceNumber: raw.sequenceNumber as string,
    dtmf: {
      digit: dtmf.digit as string,
      ...(isString(dtmf.duration) ? { duration: dtmf.duration as string } : {}),
    },
  };
  return { ok: true, event };
}

function validateMark(raw: Record<string, unknown>): ParseResult {
  if (!isString(raw.sequenceNumber)) {
    return { ok: false, error: "mark: missing or invalid sequenceNumber" };
  }
  if (!isString(raw.streamSid)) {
    return { ok: false, error: "mark: missing or invalid streamSid" };
  }

  const mark = raw.mark;
  if (!isRecord(mark)) {
    return { ok: false, error: "mark: missing or invalid mark object" };
  }
  if (!isString(mark.name)) {
    return { ok: false, error: "mark: missing mark.name" };
  }

  const event: MediaStreamMarkEvent = {
    event: "mark",
    streamSid: raw.streamSid as string,
    sequenceNumber: raw.sequenceNumber as string,
    mark: {
      name: mark.name as string,
    },
  };
  return { ok: true, event };
}

function validateStop(raw: Record<string, unknown>): ParseResult {
  if (!isString(raw.sequenceNumber)) {
    return { ok: false, error: "stop: missing or invalid sequenceNumber" };
  }
  if (!isString(raw.streamSid)) {
    return { ok: false, error: "stop: missing or invalid streamSid" };
  }

  const stop = raw.stop;
  if (!isRecord(stop)) {
    return { ok: false, error: "stop: missing or invalid stop object" };
  }
  if (!isString(stop.accountSid)) {
    return { ok: false, error: "stop: missing stop.accountSid" };
  }
  if (!isString(stop.callSid)) {
    return { ok: false, error: "stop: missing stop.callSid" };
  }

  const event: MediaStreamStopEvent = {
    event: "stop",
    streamSid: raw.streamSid as string,
    sequenceNumber: raw.sequenceNumber as string,
    stop: {
      accountSid: stop.accountSid as string,
      callSid: stop.callSid as string,
    },
  };
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Known inbound event types from the Twilio Media Stream protocol.
 * Any event whose `event` field is not in this set is treated as
 * unrecognised and rejected.
 */
const KNOWN_EVENTS = new Set(["start", "media", "dtmf", "mark", "stop"]);

/**
 * Parse and validate a raw WebSocket message string into a typed
 * {@link MediaStreamEvent}.
 *
 * Returns `{ ok: true, event }` on success or `{ ok: false, error }`
 * with a human-readable reason on failure. Callers decide whether to
 * log, metric, or ignore rejected frames.
 */
export function parseMediaStreamFrame(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "Frame is not a JSON object" };
  }

  const eventType = parsed.event;
  if (!isString(eventType)) {
    return { ok: false, error: "Missing or non-string 'event' field" };
  }

  if (!KNOWN_EVENTS.has(eventType)) {
    return { ok: false, error: `Unrecognised event type: "${eventType}"` };
  }

  switch (eventType) {
    case "start":
      return validateStart(parsed);
    case "media":
      return validateMedia(parsed);
    case "dtmf":
      return validateDtmf(parsed);
    case "mark":
      return validateMark(parsed);
    case "stop":
      return validateStop(parsed);
    default:
      return { ok: false, error: `Unrecognised event type: "${eventType}"` };
  }
}
