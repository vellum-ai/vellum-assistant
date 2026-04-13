/**
 * Strict type definitions for the Twilio Media Streams WebSocket protocol.
 *
 * Twilio sends JSON frames over a WebSocket connection for each active media
 * stream. Every frame has an `event` discriminator and a `streamSid` that
 * identifies the stream instance. This module defines the typed shapes for
 * each event and a validation function that rejects malformed frames
 * fail-fast rather than propagating bad data through the call pipeline.
 *
 * Reference: https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */

// ---------------------------------------------------------------------------
// Inbound events (Twilio -> us)
// ---------------------------------------------------------------------------

/**
 * Sent once when the media stream is established. Contains metadata about
 * the call and the audio encoding parameters.
 */
export interface MediaStreamStartEvent {
  event: "start";
  sequenceNumber: string;
  streamSid: string;
  start: {
    /** The Twilio Account SID. */
    accountSid: string;
    /** Stream SID (matches top-level streamSid). */
    streamSid: string;
    /** The Call SID for the call that initiated the stream. */
    callSid: string;
    /** Track label — "inbound" or "outbound". */
    tracks: string[];
    /** Custom parameters attached to the <Stream> TwiML instruction. */
    customParameters: Record<string, string>;
    /** Media format descriptor. */
    mediaFormat: {
      /** Audio encoding — typically "audio/x-mulaw". */
      encoding: string;
      /** Sample rate in Hz — typically 8000. */
      sampleRate: number;
      /** Number of audio channels — typically 1. */
      channels: number;
    };
  };
}

/**
 * Sent for each chunk of audio data from the caller. The payload is
 * base64-encoded mu-law audio at 8kHz mono.
 */
export interface MediaStreamMediaEvent {
  event: "media";
  sequenceNumber: string;
  streamSid: string;
  media: {
    /** Track label — "inbound" for caller audio. */
    track: string;
    /** Chunk index within the track (monotonically increasing). */
    chunk: string;
    /** Timestamp in milliseconds from the start of the stream. */
    timestamp: string;
    /** Base64-encoded audio payload. */
    payload: string;
  };
}

/**
 * Sent when a DTMF tone is detected on the call.
 */
export interface MediaStreamDtmfEvent {
  event: "dtmf";
  streamSid: string;
  sequenceNumber: string;
  dtmf: {
    /** The DTMF digit ("0"-"9", "*", "#"). */
    digit: string;
    /** Duration of the tone in milliseconds (optional). */
    duration?: string;
  };
}

/**
 * Sent when a previously requested mark is reached in the outbound audio
 * playback. Marks are used to synchronize server-side actions with the
 * point at which the caller hears specific audio.
 */
export interface MediaStreamMarkEvent {
  event: "mark";
  streamSid: string;
  sequenceNumber: string;
  mark: {
    /** The name assigned when the mark was sent. */
    name: string;
  };
}

/**
 * Sent when the media stream has ended (call hangup, stream closed, etc.).
 */
export interface MediaStreamStopEvent {
  event: "stop";
  streamSid: string;
  sequenceNumber: string;
  stop: {
    /** The Twilio Account SID. */
    accountSid: string;
    /** The Call SID. */
    callSid: string;
  };
}

/**
 * Discriminated union of all recognised inbound Twilio media stream events.
 */
export type MediaStreamEvent =
  | MediaStreamStartEvent
  | MediaStreamMediaEvent
  | MediaStreamDtmfEvent
  | MediaStreamMarkEvent
  | MediaStreamStopEvent;

// ---------------------------------------------------------------------------
// Outbound commands (us -> Twilio)
// ---------------------------------------------------------------------------

/**
 * Send raw audio to the caller. The `payload` must be base64-encoded audio
 * matching the negotiated encoding (typically mu-law 8kHz mono).
 */
export interface MediaStreamSendMediaCommand {
  event: "media";
  streamSid: string;
  media: {
    payload: string;
  };
}

/**
 * Insert a named mark into the outbound audio stream. Twilio will send a
 * `mark` event back when the caller reaches this point in playback.
 */
export interface MediaStreamSendMarkCommand {
  event: "mark";
  streamSid: string;
  mark: {
    name: string;
  };
}

/**
 * Clear any queued outbound audio. Useful for barge-in scenarios where the
 * caller interrupts the assistant.
 */
export interface MediaStreamClearCommand {
  event: "clear";
  streamSid: string;
}

/**
 * Discriminated union of all outbound commands we can send to Twilio.
 */
export type MediaStreamCommand =
  | MediaStreamSendMediaCommand
  | MediaStreamSendMarkCommand
  | MediaStreamClearCommand;
