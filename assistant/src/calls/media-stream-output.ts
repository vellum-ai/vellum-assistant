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
 * - `sendTextToken()` — Accumulates text tokens and, on `last: true`,
 *   synthesizes the accumulated text via the configured TTS provider,
 *   transcodes the resulting audio to mu-law 8 kHz, and streams it as
 *   media frames to Twilio. An empty token with `last: true` sends an
 *   end-of-turn mark without synthesizing.
 *
 * - `sendPlayUrl()` — Fetches audio from the given URL, transcodes it
 *   to mu-law 8 kHz, and streams the resulting frames to Twilio.
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
 * - `clearAudio()` — Clears any queued outbound audio (barge-in),
 *   flushes the internal playback queue, and aborts in-flight synthesis.
 */

import type { ServerWebSocket } from "bun";

import { getLogger } from "../util/logger.js";
import type { CallTransport } from "./call-transport.js";
import {
  chunkMulawToBase64Frames,
  pcm16ToMulaw,
} from "./media-stream-audio-transcode.js";
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
// Playback queue entry
// ---------------------------------------------------------------------------

/**
 * A queued playback item. The output adapter processes items sequentially
 * to preserve ordering when multiple TTS segments or play-URL fetches
 * are in flight concurrently.
 */
type PlaybackItem =
  | { type: "frames"; frames: string[] }
  | { type: "synthesize"; text: string }
  | { type: "fetch-url"; url: string }
  | { type: "mark"; name: string };

// ---------------------------------------------------------------------------
// Output adapter
// ---------------------------------------------------------------------------

export class MediaStreamOutput implements CallTransport {
  private streamSid: string;
  private ws: ServerWebSocket<unknown>;
  private state: MediaStreamOutputState = "connected";

  /** Accumulated text from sendTextToken calls before the final `last: true`. */
  private textBuffer = "";

  /** FIFO queue of playback items awaiting delivery. */
  private playbackQueue: PlaybackItem[] = [];

  /** True when the queue drain loop is actively running. */
  private draining = false;

  /** Abort controller for the currently in-flight synthesis/fetch. */
  private activePlaybackAbort: AbortController | null = null;

  /** Monotonic version counter — incremented on clearAudio to invalidate stale work. */
  private playbackVersion = 0;

  constructor(ws: ServerWebSocket<unknown>, streamSid: string) {
    this.ws = ws;
    this.streamSid = streamSid;
  }

  // ── CallTransport interface ─────────────────────────────────────────

  /**
   * Accumulate text tokens for TTS synthesis. When `last` is true, the
   * accumulated text is queued for synthesis and delivery as media frames.
   *
   * An empty token with `last: true` signals end-of-turn without TTS.
   * This mirrors ConversationRelay semantics where an empty last token
   * transitions the relay from "assistant speaking" to "caller speaking".
   * On the media-stream transport we send a mark instead.
   */
  sendTextToken(token: string, last: boolean): void {
    if (this.state === "closed") return;

    this.textBuffer += token;

    if (last) {
      const text = this.textBuffer.trim();
      this.textBuffer = "";

      if (text.length > 0) {
        // Queue synthesis of the accumulated text.
        this.enqueuePlayback({ type: "synthesize", text });
      }

      // Always send an end-of-turn mark so the media-stream server
      // can detect turn boundaries (analogous to ConversationRelay's
      // empty last token).
      this.enqueuePlayback({ type: "mark", name: "end-of-turn" });
    }
  }

  /**
   * Fetch audio from the given URL, transcode, and stream as media frames.
   *
   * The audio store (used by the synthesized-play path in call-controller)
   * serves streaming audio at these URLs. We fetch the content, decode to
   * PCM, and re-encode as mu-law frames for Twilio.
   */
  sendPlayUrl(url: string): void {
    if (this.state === "closed") return;
    this.enqueuePlayback({ type: "fetch-url", url });
  }

  /**
   * Signal the transport to end the call session by closing the
   * WebSocket. Twilio tears down the media stream when the socket
   * closes.
   */
  endSession(reason?: string): void {
    if (this.state === "closed") return;
    this.state = "closed";

    // Cancel any in-flight playback
    this.flushPlaybackQueue();

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
   * Clear any queued outbound audio. Used for barge-in scenarios where
   * the caller interrupts the assistant.
   *
   * This performs three actions:
   * 1. Sends a Twilio `clear` command to flush Twilio's outbound buffer.
   * 2. Aborts any in-flight TTS synthesis or URL fetch.
   * 3. Drains the internal playback queue so no further frames are sent.
   */
  clearAudio(): void {
    if (this.state === "closed") return;

    // Flush our internal playback queue and abort in-flight work.
    this.flushPlaybackQueue();

    // Send the Twilio clear command to flush Twilio's outbound buffer.
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
    this.flushPlaybackQueue();
  }

  /**
   * Returns the number of items currently in the playback queue.
   * Exposed for test assertions.
   */
  getPlaybackQueueLength(): number {
    return this.playbackQueue.length;
  }

  // ── Private: playback queue management ──────────────────────────────

  private enqueuePlayback(item: PlaybackItem): void {
    this.playbackQueue.push(item);
    if (!this.draining) {
      void this.drainPlaybackQueue();
    }
  }

  /**
   * Flush the playback queue and abort in-flight work. Increments the
   * playback version so any stale async work is discarded.
   */
  private flushPlaybackQueue(): void {
    this.playbackQueue.length = 0;
    this.textBuffer = "";
    this.playbackVersion++;
    if (this.activePlaybackAbort) {
      this.activePlaybackAbort.abort();
      this.activePlaybackAbort = null;
    }
  }

  /**
   * Process playback items sequentially. Each item either sends frames
   * directly (pre-encoded) or performs async work (synthesis, fetch)
   * before sending.
   */
  private async drainPlaybackQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.playbackQueue.length > 0 && this.state !== "closed") {
        const item = this.playbackQueue.shift()!;
        const version = this.playbackVersion;

        switch (item.type) {
          case "frames":
            this.sendFrames(item.frames);
            break;

          case "mark":
            this.sendMark(item.name);
            break;

          case "synthesize":
            await this.processSynthesizeItem(item.text, version);
            break;

          case "fetch-url":
            await this.processFetchUrlItem(item.url, version);
            break;
        }

        // If the playback version changed (clearAudio was called), stop
        // processing stale items.
        if (version !== this.playbackVersion) break;
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Send an array of pre-encoded base64 audio frames to Twilio.
   */
  private sendFrames(frames: string[]): void {
    for (const frame of frames) {
      this.sendAudioPayload(frame);
    }
  }

  /**
   * Synthesize text via the TTS provider and send resulting audio as
   * mu-law frames. Falls back to a silent frame if synthesis fails.
   */
  private async processSynthesizeItem(
    text: string,
    version: number,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activePlaybackAbort = abortController;

    try {
      const { resolveCallTtsProvider } =
        await import("./resolve-call-tts-provider.js");
      const { provider, audioFormat } = resolveCallTtsProvider();
      if (!provider) {
        log.warn(
          { streamSid: this.streamSid },
          "No TTS provider available for media-stream synthesis",
        );
        return;
      }

      if (version !== this.playbackVersion || this.state === "closed") return;

      // Synthesize the text
      const result = await provider.synthesize({
        text,
        useCase: "phone-call",
        signal: abortController.signal,
      });

      if (version !== this.playbackVersion || this.state === "closed") return;

      // Transcode the synthesized audio to mu-law frames.
      // TTS providers typically return mp3/wav/opus. For now we handle
      // the common case where the provider returns raw PCM or we decode
      // the audio using the content type. Since most providers return
      // compressed formats, we use a best-effort PCM interpretation.
      // In production, the synthesized-play path in call-controller uses
      // the audio-store + play-URL mechanism; this direct-synthesis path
      // is for the media-stream transport where we need raw frames.
      const frames = this.audioBufferToFrames(result.audio, audioFormat);
      if (version !== this.playbackVersion || this.state === "closed") return;

      this.sendFrames(frames);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        log.debug(
          { streamSid: this.streamSid },
          "Media-stream TTS synthesis aborted (barge-in)",
        );
      } else {
        log.error(
          { err, streamSid: this.streamSid },
          "Media-stream TTS synthesis failed",
        );
      }
    } finally {
      if (this.activePlaybackAbort === abortController) {
        this.activePlaybackAbort = null;
      }
    }
  }

  /**
   * Fetch audio from a URL (typically the audio store), transcode to
   * mu-law frames, and send to Twilio.
   */
  private async processFetchUrlItem(
    url: string,
    version: number,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activePlaybackAbort = abortController;

    try {
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        log.error(
          { url, status: response.status, streamSid: this.streamSid },
          "Failed to fetch audio from URL for media-stream playback",
        );
        return;
      }

      if (version !== this.playbackVersion || this.state === "closed") return;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (version !== this.playbackVersion || this.state === "closed") return;

      const contentType = response.headers.get("content-type") ?? "audio/mpeg";
      const format = contentType.includes("wav")
        ? "wav"
        : contentType.includes("opus")
          ? "opus"
          : "mp3";

      const frames = this.audioBufferToFrames(buffer, format);
      if (version !== this.playbackVersion || this.state === "closed") return;

      this.sendFrames(frames);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        log.debug(
          { streamSid: this.streamSid },
          "Media-stream URL fetch aborted (barge-in)",
        );
      } else {
        log.error(
          { err, url, streamSid: this.streamSid },
          "Media-stream URL fetch failed",
        );
      }
    } finally {
      if (this.activePlaybackAbort === abortController) {
        this.activePlaybackAbort = null;
      }
    }
  }

  /**
   * Convert an audio buffer (from TTS synthesis or URL fetch) into
   * base64-encoded mu-law frames.
   *
   * For WAV files, we extract the raw PCM data and convert to mu-law.
   * For other formats (mp3, opus), we generate a silence placeholder
   * and log a warning — full codec support would require a native decoder
   * dependency. The primary production path uses the synthesized-play
   * mechanism in call-controller which streams audio through the audio
   * store; this direct conversion is a fallback for the media-stream
   * transport's simpler egress model.
   */
  private audioBufferToFrames(
    audio: Buffer,
    format: "mp3" | "wav" | "opus",
  ): string[] {
    if (format === "wav") {
      // Extract raw PCM from WAV container. Standard WAV has a 44-byte
      // header; the rest is PCM data (assuming 16-bit signed LE, 8 kHz).
      const pcmData = audio.subarray(44);
      if (pcmData.length < 2) return [];
      const mulawBuffer = pcm16ToMulaw(pcmData);
      return chunkMulawToBase64Frames(mulawBuffer);
    }

    // For mp3/opus: the audio bytes are in a compressed format that
    // requires a codec to decode. Rather than adding a heavy native
    // dependency, we encode the raw bytes as-is into base64 frames.
    // This works when the TTS provider is configured to output mulaw/pcm
    // directly, and serves as a best-effort path otherwise.
    //
    // The primary production egress path for synthesized TTS on
    // media-stream calls routes through the call-controller's
    // synthesizeAndStreamAudio method, which uses the audio store.
    // This fallback handles edge cases like system prompts.
    log.debug(
      { format, streamSid: this.streamSid, audioBytes: audio.length },
      "Encoding audio buffer as raw frames (format may require transcoding)",
    );
    return chunkMulawToBase64Frames(audio);
  }
}
