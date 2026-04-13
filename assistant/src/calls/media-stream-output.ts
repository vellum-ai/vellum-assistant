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

  /**
   * The media-stream transport requires WAV (PCM) audio because its
   * mu-law transcoder cannot decode compressed formats (mp3, opus).
   */
  readonly requiresWavAudio = true;

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

  /**
   * Runtime check for closed state. Used instead of direct property access
   * in async methods because TypeScript's control flow analysis cannot
   * track that `this.state` may change between `await` points.
   */
  private isClosed(): boolean {
    return this.state === "closed";
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
      while (this.playbackQueue.length > 0 && !this.isClosed()) {
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
      // If items were enqueued during a version-mismatch break (e.g. the
      // end-of-turn mark from handleInterrupt after clearAudio), restart
      // draining so they are not stranded.
      if (this.playbackQueue.length > 0 && !this.isClosed()) {
        void this.drainPlaybackQueue();
      }
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
      // Request WAV so audioBufferToFrames gets PCM it can transcode
      // to mu-law. Compressed formats (mp3, opus) would be sent as raw
      // bytes and produce garbled audio.
      const { provider, audioFormat } = resolveCallTtsProvider({
        preferWav: true,
      });
      if (!provider) {
        log.warn(
          { streamSid: this.streamSid },
          "No TTS provider available for media-stream synthesis",
        );
        return;
      }

      if (version !== this.playbackVersion || this.isClosed()) return;

      // Synthesize the text. Request PCM output so the media-stream
      // transport receives raw samples it can transcode to mu-law.
      // Providers that support it (e.g. ElevenLabs pcm_16000) will
      // return raw PCM; others fall back to their default format and
      // the content-type sniffing below handles the mismatch.
      const result = await provider.synthesize({
        text,
        useCase: "phone-call",
        outputFormat: "pcm",
        signal: abortController.signal,
      });

      if (version !== this.playbackVersion || this.isClosed()) return;

      // Derive the format from the provider's actual content type rather
      // than the declared audioFormat. The declared format may not match
      // reality (e.g. preferWav requests WAV but the provider returns mp3).
      // audioBufferToFrames also sniffs magic bytes as a safety net.
      const actualFormat: "mp3" | "wav" | "opus" | "pcm" =
        result.contentType.includes("wav") ||
        result.contentType.includes("x-wav")
          ? "wav"
          : result.contentType.includes("opus")
            ? "opus"
            : result.contentType.includes("mpeg") ||
                result.contentType.includes("mp3")
              ? "mp3"
              : result.contentType.includes("pcm") ||
                  result.contentType.includes("x-raw")
                ? "pcm"
                : audioFormat; // fall back to declared format for unknown types
      const frames = this.audioBufferToFrames(result.audio, actualFormat);
      if (version !== this.playbackVersion || this.isClosed()) return;

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

      if (version !== this.playbackVersion || this.isClosed()) return;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (version !== this.playbackVersion || this.isClosed()) return;

      const contentType = response.headers.get("content-type") ?? "audio/mpeg";
      const format: "mp3" | "wav" | "opus" | "pcm" = contentType.includes("wav")
        ? "wav"
        : contentType.includes("opus")
          ? "opus"
          : contentType.includes("pcm") || contentType.includes("x-raw")
            ? "pcm"
            : "mp3";

      const frames = this.audioBufferToFrames(buffer, format);
      if (version !== this.playbackVersion || this.isClosed()) return;

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
   * Rather than trusting the declared `format` parameter (which may not
   * match the actual bytes — e.g. when a provider is asked for WAV but
   * returns mp3), this method **sniffs the magic bytes** to detect the
   * real format:
   *
   * - **WAV** (`RIFF` header, bytes `0x52 0x49 0x46 0x46`): extracts
   *   raw PCM data from the WAV container and converts to mu-law.
   * - **PCM** (raw 16-bit signed LE at a known sample rate): converts
   *   directly to mu-law, downsampling from 16 kHz to 8 kHz if needed.
   * - **Compressed formats** (mp3, opus): cannot be decoded in this
   *   path — returns empty frames (silence) with a warning. Compressed
   *   formats require the audio-store playback path (`sendPlayUrl`)
   *   for correct transcoding. Silence is preferable to garbled audio.
   */
  private audioBufferToFrames(
    audio: Buffer,
    format: "mp3" | "wav" | "opus" | "pcm",
  ): string[] {
    // Sniff the actual bytes rather than trusting the declared format.
    // WAV files always start with the ASCII magic "RIFF" (0x52494646).
    const isWav =
      audio.length >= 44 &&
      audio[0] === 0x52 && // R
      audio[1] === 0x49 && // I
      audio[2] === 0x46 && // F
      audio[3] === 0x46; // F

    if (isWav) {
      // Extract raw PCM from WAV container. Standard WAV has a 44-byte
      // header; the rest is PCM data (assuming 16-bit signed LE, 8 kHz).
      const pcmData = audio.subarray(44);
      if (pcmData.length < 2) return [];
      const mulawBuffer = pcm16ToMulaw(pcmData);
      return chunkMulawToBase64Frames(mulawBuffer);
    }

    // Raw PCM (e.g. from ElevenLabs pcm_16000): convert directly to mu-law.
    // ElevenLabs pcm_16000 produces 16-bit signed LE at 16 kHz. Twilio
    // needs 8 kHz mu-law, so we downsample by taking every other sample.
    if (format === "pcm") {
      if (audio.length < 2) return [];
      // Downsample 16 kHz -> 8 kHz by taking every other sample.
      // Each sample is 2 bytes (16-bit LE), so we step by 4 bytes.
      const sampleCount = Math.floor(audio.length / 2);
      const downsampledCount = Math.floor(sampleCount / 2);
      const downsampled = Buffer.alloc(downsampledCount * 2);
      for (let i = 0; i < downsampledCount; i++) {
        // Copy every other 16-bit sample
        downsampled[i * 2] = audio[i * 4];
        downsampled[i * 2 + 1] = audio[i * 4 + 1];
      }
      const mulawBuffer = pcm16ToMulaw(downsampled);
      return chunkMulawToBase64Frames(mulawBuffer);
    }

    // Compressed formats (mp3, opus) cannot be decoded in this direct
    // synthesis path. Rather than passing compressed bytes through as
    // raw mu-law frames (which produces garbled audio), return empty
    // frames (silence). The caller should use the audio-store playback
    // path (sendPlayUrl) which handles transcoding correctly.
    if (format === "mp3" || format === "opus") {
      log.warn(
        {
          streamSid: this.streamSid,
          format,
          audioBytes: audio.length,
        },
        "Compressed audio format cannot be transcoded to mu-law in the direct synthesis path — " +
          "returning silence. Use the audio-store playback path (sendPlayUrl) for correct transcoding.",
      );
      return [];
    }

    // Unknown format — log a warning and attempt raw passthrough. This
    // is a last-resort fallback; callers should ensure they request a
    // format that this transport can handle (WAV or raw PCM).
    log.warn(
      {
        streamSid: this.streamSid,
        declaredFormat: format,
        audioBytes: audio.length,
        headerHex: audio.subarray(0, 4).toString("hex"),
      },
      "Unrecognized audio format — attempting raw passthrough (may produce garbled audio)",
    );
    return chunkMulawToBase64Frames(audio);
  }
}
