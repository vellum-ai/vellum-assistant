/**
 * Output adapter for media-stream call egress.
 *
 * Implements the {@link CallTransport} interface so the call controller
 * can send synthesized audio and lifecycle signals through a Twilio Media
 * Stream WebSocket connection.
 *
 * The media-stream transport operates on raw audio frames:
 *
 * - `sendTextToken()` — Accumulates text tokens, extracts complete
 *   speakable segments as they form, and synthesizes each segment via
 *   the configured TTS provider, transcoding the resulting audio to
 *   mu-law 8 kHz media frames for Twilio. On `last: true` the remaining
 *   text is flushed as a final segment followed by an end-of-turn mark.
 *   An empty token with `last: true` sends only the mark.
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

import { extractSpeakableSegments } from "../tts/speakable-segments.js";
import { getLogger } from "../util/logger.js";
import type { CallTransport } from "./call-transport.js";
import {
  chunkMulawToBase64Frames,
  MULAW_FRAME_SIZE,
  pcm16ToMulaw,
  resamplePcm16,
} from "./media-stream-audio-transcode.js";
import type {
  MediaStreamClearCommand,
  MediaStreamSendMarkCommand,
  MediaStreamSendMediaCommand,
} from "./media-stream-protocol.js";

const log = getLogger("media-stream-output");

/** Twilio media streams consume 8 kHz mono mu-law. */
const TELEPHONY_SAMPLE_RATE_HZ = 8000;

/**
 * PCM sample rate requested from streaming-capable providers. Deterministic
 * across providers (ElevenLabs maps the hint to `pcm_16000`; fish-audio
 * honours it directly), so the incremental transcode can hard-wire its
 * downsample ratio to the telephony rate.
 */
const STREAMING_PCM_SAMPLE_RATE_HZ = 16_000;

/**
 * Keep every `factor`-th 16-bit LE sample. Cheap decimation (no anti-alias
 * filter) for rates that are integer multiples of the telephony rate; also
 * extracts the left channel from interleaved stereo when factor is 2.
 */
function decimatePcm16(pcm: Buffer, factor: number): Buffer {
  const sampleCount = Math.floor(pcm.length / 2);
  const outCount = Math.floor(sampleCount / factor);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    out[i * 2] = pcm[i * factor * 2];
    out[i * 2 + 1] = pcm[i * factor * 2 + 1];
  }
  return out;
}

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

  /**
   * Text accumulated from sendTextToken calls that has not yet formed a
   * complete speakable segment.
   */
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
   * One-shot callback fired when the next batch of audio frames is
   * actually sent to Twilio. Armed by the call controller so it can
   * flip to `speaking` only when real outbound audio starts. Cleared
   * by the playback flush (barge-in) so a wiped queue never fires a
   * stale signal.
   */
  private audioStartCallback: (() => void) | null = null;

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
   * Accumulate text tokens for TTS synthesis. Each complete speakable
   * segment (sentence or newline-bounded line) is queued for synthesis
   * as soon as it forms, so speech starts before the turn completes.
   * When `last` is true, the remaining text is force-flushed as a final
   * segment.
   *
   * An empty token with `last: true` signals end-of-turn without TTS:
   * a mark is sent so the session transitions from "assistant speaking"
   * to "caller speaking".
   */
  sendTextToken(token: string, last: boolean): void {
    if (this.state === "closed") {
      return;
    }

    this.textBuffer += token;

    const { segments, remainder } = extractSpeakableSegments(
      this.textBuffer,
      last,
    );
    this.textBuffer = remainder;
    for (const segment of segments) {
      this.enqueuePlayback({ type: "synthesize", text: segment });
    }

    if (last) {
      // Always send an end-of-turn mark so the media-stream server
      // can detect turn boundaries.
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
   * Arm a one-shot audio-start signal. The callback fires when the next
   * batch of audio frames is sent to Twilio, then disarms. Pass `null`
   * to disarm.
   */
  setAudioStartCallback(cb: (() => void) | null): void {
    this.audioStartCallback = cb;
  }

  /**
   * Discard accumulated text that has not yet been queued for synthesis.
   * The call controller invokes this when it aborts an in-flight turn so
   * the aborted turn's unsent text cannot leak into the next turn.
   */
  discardPendingText(): void {
    this.textBuffer = "";
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
   *
   * Text still accumulating for an in-flight LLM turn (`textBuffer`) is
   * preserved: a barge-in signal that the controller ignores (turn still
   * processing, no audio yet) must not truncate the pending response.
   * The controller discards that text via {@link discardPendingText}
   * when it actually aborts the turn.
   */
  clearAudio(): void {
    if (this.state === "closed") return;

    // Flush our internal playback queue and abort in-flight work.
    this.flushPlaybackQueue();

    // Send the Twilio clear command to flush Twilio's outbound buffer.
    this.sendClearCommand();
  }

  /**
   * Flush only Twilio's outbound audio buffer, leaving the internal
   * playback queue and any in-flight synthesis untouched.
   *
   * Used for rejected barge-ins (no turn to abort): frames are pushed
   * to Twilio as fast as they are produced, so a completed turn's tail
   * can still be playing long after the controller went idle — this
   * stops that talk-over, while speech that has not reached Twilio yet
   * (initial greeting, setup handoff prompt) survives to play after.
   */
  clearBufferedAudio(): void {
    if (this.state === "closed") return;
    this.sendClearCommand();
  }

  private sendClearCommand(): void {
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
   * playback version so any stale async work is discarded, and disarms
   * the pending audio-start signal so flushed items never fire it.
   *
   * Deliberately preserves `textBuffer`: text still accumulating for an
   * in-flight LLM turn is owned by the call controller, which discards
   * it via {@link discardPendingText} only when the turn is aborted.
   */
  private flushPlaybackQueue(): void {
    this.playbackQueue.length = 0;
    this.playbackVersion++;
    this.audioStartCallback = null;
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
   * Send an array of pre-encoded base64 audio frames to Twilio. Fires
   * the one-shot audio-start signal before the first frame goes out.
   */
  private sendFrames(frames: string[]): void {
    if (frames.length === 0) return;
    const audioStartCallback = this.audioStartCallback;
    if (audioStartCallback) {
      this.audioStartCallback = null;
      audioStartCallback();
    }
    for (const frame of frames) {
      this.sendAudioPayload(frame);
    }
  }

  /**
   * Synthesize text via the TTS provider and send resulting audio as
   * mu-law frames. PCM-capable providers are transcoded incrementally —
   * each streamed chunk becomes frames as it arrives — while other
   * providers accumulate into the whole-buffer conversion path. Falls
   * back to a silent frame if synthesis fails.
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
      const { provider, audioFormat } = await resolveCallTtsProvider({
        preferWav: true,
      });
      if (!provider) {
        log.warn(
          { streamSid: this.streamSid },
          "No TTS provider available for media-stream synthesis",
        );
        return;
      }

      if (version !== this.playbackVersion || this.isClosed()) {
        return;
      }

      const { synthesizeAndEmit } = await import("../tts/synthesis-stream.js");
      const isCurrent = (): boolean =>
        version === this.playbackVersion && !this.isClosed();

      // PCM-capable providers honour `outputFormat: "pcm"` at the requested
      // sample rate, so their chunks can be transcoded to mu-law frames as
      // they arrive. Other providers accumulate below and go through the
      // whole-buffer content-type sniffing path.
      const streamsPcm = provider.capabilities.supportedFormats.includes("pcm");
      const bufferedChunks: Buffer[] = [];

      // Chunk boundaries can split a 16-bit sample or a decimation pair;
      // the unprocessable tail (< 4 bytes) carries into the next chunk so
      // sample alignment and decimation phase stay stable across chunks.
      let pcmCarry: Buffer | undefined;
      // Mu-law bytes short of a whole 20 ms frame, carried likewise.
      let mulawCarry: Buffer = Buffer.alloc(0);

      const sendMulaw = (mulaw: Buffer, flushPartialFrame: boolean): void => {
        mulawCarry =
          mulawCarry.length > 0 ? Buffer.concat([mulawCarry, mulaw]) : mulaw;
        const sendableBytes = flushPartialFrame
          ? mulawCarry.length
          : mulawCarry.length - (mulawCarry.length % MULAW_FRAME_SIZE);
        if (sendableBytes === 0) {
          return;
        }
        const frames = chunkMulawToBase64Frames(
          mulawCarry.subarray(0, sendableBytes),
        );
        mulawCarry = mulawCarry.subarray(sendableBytes);
        this.sendFrames(frames);
      };

      // Synthesize the text. Request PCM output so the media-stream
      // transport receives raw samples it can transcode to mu-law.
      // Providers that support it (e.g. ElevenLabs pcm_16000) will
      // return raw PCM; others fall back to their default format and
      // the content-type sniffing below handles the mismatch.
      const result = await synthesizeAndEmit({
        provider,
        text,
        useCase: "phone-call",
        outputFormat: "pcm",
        sampleRateHz: STREAMING_PCM_SAMPLE_RATE_HZ,
        signal: abortController.signal,
        isCurrent,
        onChunk: (chunk) => {
          if (!streamsPcm) {
            bufferedChunks.push(chunk.audio);
            return;
          }
          if (!isCurrent()) {
            return;
          }
          const combined = pcmCarry
            ? Buffer.concat([pcmCarry, chunk.audio])
            : chunk.audio;
          // 4 bytes = two 16 kHz samples = one 8 kHz output sample.
          const usableBytes = combined.length & ~3;
          pcmCarry =
            usableBytes < combined.length
              ? combined.subarray(usableBytes)
              : undefined;
          if (usableBytes === 0) {
            return;
          }
          const pcm8k = this.pcm16ToTelephonyRate(
            combined.subarray(0, usableBytes),
            STREAMING_PCM_SAMPLE_RATE_HZ,
          );
          sendMulaw(pcm16ToMulaw(pcm8k), false);
        },
      });

      if (!isCurrent()) {
        return;
      }

      if (streamsPcm) {
        if (pcmCarry) {
          // A sub-sample tail is malformed provider output; decimation
          // would drop it anyway.
          log.debug(
            { streamSid: this.streamSid, carryBytes: pcmCarry.length },
            "Dropping sub-sample tail from PCM16 TTS stream",
          );
        }
        // Flush the final partial frame — the whole-buffer path sends a
        // short trailing frame the same way.
        sendMulaw(Buffer.alloc(0), true);
        return;
      }

      // A stopped stream means partial audio; never send a truncated buffer.
      if (result.stopped) {
        return;
      }

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
      const frames = this.audioBufferToFrames(
        Buffer.concat(bufferedChunks),
        actualFormat,
      );
      if (!isCurrent()) {
        return;
      }

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
   *   raw PCM data from the WAV container, converts it to 8 kHz using the
   *   fmt-chunk sample rate, and converts to mu-law.
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
      // Extract raw PCM from the WAV container, honoring the fmt-chunk
      // sample rate. Assumes the canonical 44-byte header (fmt chunk at
      // fixed offsets) — non-canonical RIFF layouts are not walked.
      const channels = audio.readUInt16LE(22);
      const sampleRate = audio.readUInt32LE(24);
      const bitsPerSample = audio.readUInt16LE(34);
      let pcmData: Buffer = audio.subarray(44);
      if (pcmData.length < 2) return [];

      if (bitsPerSample !== 16 || channels > 2 || channels === 0) {
        // Limitation: only 16-bit mono/stereo PCM is decoded here.
        log.warn(
          { streamSid: this.streamSid, channels, bitsPerSample },
          "WAV is not 16-bit mono/stereo PCM — playback may be degraded",
        );
      }
      if (channels === 2) {
        // Interleaved stereo: keep the left channel.
        pcmData = decimatePcm16(pcmData, 2);
      }

      const pcm8k = this.pcm16ToTelephonyRate(pcmData, sampleRate);
      const mulawBuffer = pcm16ToMulaw(pcm8k);
      return chunkMulawToBase64Frames(mulawBuffer);
    }

    // When the declared format is "wav" but the RIFF check failed, the
    // bytes might be either:
    // (a) Raw PCM stored under audio/wav content-type (when
    //     outputFormat: "pcm" is used with createStreamingEntry("wav"))
    // (b) Compressed audio (mp3/opus) from a provider that ignores
    //     outputFormat (e.g. Fish Audio defaults to mp3)
    //
    // Sniff magic bytes to distinguish: mp3 frames start with 0xFF sync
    // byte or ID3 tag (0x49 0x44 0x33); Ogg/opus starts with "OggS".
    // Anything else is assumed to be raw PCM.
    if (format === "wav") {
      const isMp3 =
        audio.length >= 2 &&
        ((audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) || // MPEG sync
          (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33)); // ID3
      const isOgg =
        audio.length >= 4 &&
        audio[0] === 0x4f && // O
        audio[1] === 0x67 && // g
        audio[2] === 0x67 && // g
        audio[3] === 0x53; // S

      if (isMp3 || isOgg) {
        log.warn(
          {
            streamSid: this.streamSid,
            declaredFormat: format,
            detectedFormat: isMp3 ? "mp3" : "opus",
            audioBytes: audio.length,
          },
          "Declared format is WAV but bytes are compressed — returning silence",
        );
        return [];
      }

      log.debug(
        { streamSid: this.streamSid, audioBytes: audio.length },
        "Declared format is WAV but no RIFF header — treating as raw PCM",
      );
    }

    // Raw PCM (e.g. from ElevenLabs pcm_16000, or WAV-declared content
    // that is actually headerless PCM): convert directly to mu-law.
    // ElevenLabs pcm_16000 produces 16-bit signed LE at 16 kHz. Twilio
    // needs 8 kHz mu-law, so we downsample by taking every other sample.
    if (format === "pcm" || format === "wav") {
      if (audio.length < 2) return [];
      // Headerless PCM carries no declared rate; assume the 16 kHz that
      // ElevenLabs pcm_16000 produces and downsample to 8 kHz.
      const downsampled = decimatePcm16(audio, 2);
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

  /**
   * Convert PCM16 LE at the given sample rate to the 8 kHz telephony
   * rate. Integer multiples of 8 kHz use cheap decimation; other rates
   * (e.g. Fish Audio's 44.1 kHz WAV default) use linear-interpolation
   * resampling. Unparseable rates fall back to the historical 8 kHz
   * assumption with a warning.
   */
  private pcm16ToTelephonyRate(pcm: Buffer, sampleRate: number): Buffer {
    if (sampleRate === TELEPHONY_SAMPLE_RATE_HZ) return pcm;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      log.warn(
        { streamSid: this.streamSid, sampleRate },
        "Unparseable WAV sample rate — assuming 8 kHz",
      );
      return pcm;
    }
    if (sampleRate % TELEPHONY_SAMPLE_RATE_HZ === 0) {
      return decimatePcm16(pcm, sampleRate / TELEPHONY_SAMPLE_RATE_HZ);
    }
    return resamplePcm16(pcm, sampleRate, TELEPHONY_SAMPLE_RATE_HZ);
  }
}
