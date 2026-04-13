/**
 * Output adapter for media-stream call egress.
 *
 * Implements the {@link CallTransport} interface so the call controller
 * can send synthesized audio and lifecycle signals through a Twilio Media
 * Stream WebSocket connection.
 *
 * Unlike the ConversationRelay transport which sends text tokens for
 * Twilio's built-in TTS, the media-stream transport operates on raw
 * audio frames:
 *
 * - `sendTextToken()` — For the media-stream path, text tokens are
 *   a no-op placeholder. In a fully-wired media-stream stack the
 *   controller would synthesize audio and call `sendAudioPayload()`
 *   instead. The no-op keeps the transport contract satisfied while
 *   the media-stream path is dark.
 *
 * - `sendPlayUrl()` — Similarly a no-op in the current dark path.
 *   A fully-wired stack would fetch the audio from the URL and stream
 *   it as media frames.
 *
 * - `endSession()` — Closes the underlying WebSocket, which triggers
 *   Twilio to tear down the media stream and (eventually) the call.
 *
 * - `sendAudioPayload()` — Sends a base64-encoded audio frame to
 *   Twilio for playback on the caller's channel.
 *
 * - `sendMark()` — Inserts a named mark into the outbound audio
 *   pipeline. Twilio will echo it back as a `mark` event once the
 *   caller reaches that point in playback.
 *
 * - `clearAudio()` — Clears any queued outbound audio (barge-in).
 *
 * This module is integration-neutral and not wired to any production
 * call setup path. It exists behind a dark path for testing only.
 */

import type { ServerWebSocket } from "bun";

import { getLogger } from "../util/logger.js";
import type { CallTransport } from "./call-transport.js";
import type {
  MediaStreamClearCommand,
  MediaStreamSendMarkCommand,
  MediaStreamSendMediaCommand,
} from "./media-stream-protocol.js";

const log = getLogger("media-stream-output");

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type MediaStreamOutputState = "connected" | "closed";

// ---------------------------------------------------------------------------
// Output adapter
// ---------------------------------------------------------------------------

export class MediaStreamOutput implements CallTransport {
  private streamSid: string;
  private ws: ServerWebSocket<unknown>;
  private state: MediaStreamOutputState = "connected";

  constructor(ws: ServerWebSocket<unknown>, streamSid: string) {
    this.ws = ws;
    this.streamSid = streamSid;
  }

  // ── CallTransport interface ─────────────────────────────────────────

  /**
   * No-op for the media-stream dark path. In a fully-wired stack, text
   * would be synthesized to audio frames and sent via `sendAudioPayload()`.
   */
  sendTextToken(_token: string, _last: boolean): void {
    // Intentional no-op: media-stream transport does not support
    // text-to-TTS passthrough. The controller's synthesized-play
    // codepath should be used instead.
  }

  /**
   * No-op for the media-stream dark path. In a fully-wired stack, the
   * audio at the URL would be fetched, transcoded, and streamed as
   * media frames.
   */
  sendPlayUrl(_url: string): void {
    // Intentional no-op: media-stream transport does not support
    // play-URL passthrough.
  }

  /**
   * Signal the transport to end the call session by closing the
   * WebSocket. Twilio tears down the media stream when the socket
   * closes.
   */
  endSession(reason?: string): void {
    if (this.state === "closed") return;
    this.state = "closed";

    log.info(
      { streamSid: this.streamSid, reason },
      "Media stream output ending session",
    );

    try {
      this.ws.close(1000, reason ?? "session-ended");
    } catch (err) {
      log.warn(
        { err, streamSid: this.streamSid },
        "Failed to close media-stream WebSocket",
      );
    }
  }

  /**
   * Return the current connection-level state. The controller uses this
   * to suppress silence nudges during guardian wait states.
   */
  getConnectionState(): string {
    return this.state;
  }

  // ── Media-stream specific methods ───────────────────────────────────

  /**
   * Send a base64-encoded audio frame to Twilio for playback.
   */
  sendAudioPayload(base64Payload: string): void {
    if (this.state === "closed") return;

    const command: MediaStreamSendMediaCommand = {
      event: "media",
      streamSid: this.streamSid,
      media: {
        payload: base64Payload,
      },
    };

    try {
      this.ws.send(JSON.stringify(command));
    } catch (err) {
      log.error(
        { err, streamSid: this.streamSid },
        "Failed to send audio payload",
      );
    }
  }

  /**
   * Insert a named mark into the outbound audio stream. Twilio echoes
   * back a `mark` event when the caller reaches this point in playback.
   */
  sendMark(name: string): void {
    if (this.state === "closed") return;

    const command: MediaStreamSendMarkCommand = {
      event: "mark",
      streamSid: this.streamSid,
      mark: { name },
    };

    try {
      this.ws.send(JSON.stringify(command));
    } catch (err) {
      log.error(
        { err, streamSid: this.streamSid },
        "Failed to send mark command",
      );
    }
  }

  /**
   * Clear any queued outbound audio. Useful for barge-in scenarios
   * where the caller interrupts the assistant.
   */
  clearAudio(): void {
    if (this.state === "closed") return;

    const command: MediaStreamClearCommand = {
      event: "clear",
      streamSid: this.streamSid,
    };

    try {
      this.ws.send(JSON.stringify(command));
    } catch (err) {
      log.error(
        { err, streamSid: this.streamSid },
        "Failed to send clear command",
      );
    }
  }

  /**
   * Update the stream SID (e.g. after receiving the `start` event).
   */
  setStreamSid(streamSid: string): void {
    this.streamSid = streamSid;
  }

  /**
   * Get the current stream SID.
   */
  getStreamSid(): string {
    return this.streamSid;
  }

  /**
   * Mark the output as closed without sending a close frame.
   * Used when the WebSocket is already closed by the remote side.
   */
  markClosed(): void {
    this.state = "closed";
  }
}
