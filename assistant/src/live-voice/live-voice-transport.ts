import { Buffer } from "node:buffer";

import type { CallTransport } from "../calls/call-transport.js";
import { errorMessage } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { extractSpeakableSegments } from "./live-voice-segments.js";
import type { LiveVoiceTtsStreamer } from "./live-voice-session.js";
import {
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

const log = getLogger("live-voice-transport");

export interface LiveVoiceCallTransportDeps {
  /**
   * Outbound frame sink. The session owns frame ordering (sequencer +
   * serialized socket writes); the transport only guarantees it calls
   * this in playback order.
   */
  sendFrame: (payload: LiveVoiceServerFramePayload) => Promise<unknown>;
  streamTtsAudio: LiveVoiceTtsStreamer;
  /** PCM sample rate requested from TTS and stamped on audio frames. */
  sampleRate: number;
  /** Returns the current assistant turn id, stamped on `tts_done`. */
  turnId: () => string;
  /** Invoked when the controller ends the session ([END_CALL], timers). */
  onSessionEnd: (reason?: string) => void;
}

/**
 * `CallTransport` implementation for in-app live-voice sessions.
 *
 * Consumes the call controller's token stream (`sendTextToken`), splits it
 * into speakable segments, and runs streaming TTS per segment on a
 * serialized queue — audio for segment N is fully emitted as `tts_audio`
 * frames before segment N+1 synthesis starts. An end-of-turn token
 * (`last: true`) force-flushes the remainder and emits `tts_done` after
 * the queue drains.
 *
 * Barge-in: `discardPendingText()` drops buffered text and aborts the
 * active and queued synthesis jobs so no further `tts_audio` frames from
 * the aborted turn reach the socket.
 */
export class LiveVoiceCallTransport implements CallTransport {
  private readonly deps: LiveVoiceCallTransportDeps;

  /** Accumulated token text awaiting a speakable segment boundary. */
  private textBuffer = "";

  /** Serialized TTS job chain — one segment synthesizes at a time. */
  private ttsQueue: Promise<void> = Promise.resolve();

  /** Abort handles for the active + queued jobs, cleared on barge-in. */
  private readonly pendingJobAborts = new Set<AbortController>();

  /**
   * One-shot audio-start signal armed by the call controller so it can
   * flip to `speaking` when real audio goes out (see
   * CallTransport.setAudioStartCallback). Fires on the first emitted
   * chunk, then disarms; the controller re-arms it as it streams tokens.
   */
  private audioStartCallback: (() => void) | null = null;

  /** Emitted assistant audio retained for per-turn archiving. */
  private assistantAudioChunks: Buffer[] = [];

  constructor(deps: LiveVoiceCallTransportDeps) {
    this.deps = deps;
  }

  // ── CallTransport interface ─────────────────────────────────────────

  sendTextToken(token: string, last: boolean): void {
    this.textBuffer += token;

    const { segments, remainder } = extractSpeakableSegments(
      this.textBuffer,
      last,
    );
    this.textBuffer = remainder;

    for (const segment of segments) {
      this.enqueueTtsSegment(segment);
    }

    if (last) {
      this.enqueueTtsDone(this.deps.turnId());
    }
  }

  sendPlayUrl(url: string): void {
    // Unreachable under the token-stream speech strategy: live-voice
    // sessions never resolve a synthesized-play TTS provider, so the
    // controller only speaks via sendTextToken. Kept to satisfy the
    // CallTransport interface.
    log.warn({ url }, "Live voice transport ignoring unexpected play URL");
  }

  endSession(reason?: string): void {
    this.deps.onSessionEnd(reason);
  }

  setAudioStartCallback(cb: (() => void) | null): void {
    this.audioStartCallback = cb;
  }

  discardPendingText(): void {
    this.textBuffer = "";
    const aborts = [...this.pendingJobAborts];
    this.pendingJobAborts.clear();
    for (const abort of aborts) {
      abort.abort();
    }
  }

  // ── Session surface ─────────────────────────────────────────────────

  /**
   * Drain the assistant audio emitted since the previous call. The
   * session consumes this once per turn for archiving.
   */
  collectAssistantAudio(): Buffer[] {
    const chunks = this.assistantAudioChunks;
    this.assistantAudioChunks = [];
    return chunks;
  }

  /**
   * Resolves when every TTS job enqueued so far has finished (audio and
   * `tts_done` frames handed to the sink). The session awaits this before
   * a server-initiated close so a queued goodbye is not cut off.
   */
  waitForTtsDrain(): Promise<void> {
    return this.ttsQueue;
  }

  // ── TTS queue ───────────────────────────────────────────────────────

  private enqueueTtsSegment(segment: string): void {
    const abort = this.registerJobAbort();
    this.enqueueJob(async () => {
      if (abort.signal.aborted) {
        return;
      }

      try {
        // The job awaits the chain before completing so every chunk frame
        // has been handed to the sink before the next queued job (and
        // ultimately tts_done) starts — backpressure, not frame ordering,
        // which the session's own outbound chain already guarantees. Each
        // chained send rechecks the abort so a barge-in also suppresses
        // chunks that were queued before discardPendingText ran.
        let frameChain: Promise<unknown> = Promise.resolve();
        await this.deps.streamTtsAudio({
          text: segment,
          signal: abort.signal,
          outputFormat: "pcm",
          sampleRate: this.deps.sampleRate,
          onAudioChunk: (chunk) => {
            if (abort.signal.aborted) {
              return;
            }
            this.assistantAudioChunks.push(
              Buffer.from(chunk.dataBase64, "base64"),
            );
            this.fireAudioStartCallback();
            frameChain = frameChain.then(() => {
              if (abort.signal.aborted) {
                return;
              }
              return this.deps.sendFrame({
                type: "tts_audio",
                mimeType: chunk.contentType,
                sampleRate: chunk.sampleRate,
                dataBase64: chunk.dataBase64,
              });
            });
          },
        });
        await frameChain;
      } catch (err) {
        if (abort.signal.aborted) {
          return;
        }
        await this.deps.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.TtsFailed,
          message: `Live voice TTS failed: ${errorMessage(err)}`,
        });
      } finally {
        this.pendingJobAborts.delete(abort);
      }
    });
  }

  private enqueueTtsDone(turnId: string): void {
    const abort = this.registerJobAbort();
    this.enqueueJob(async () => {
      try {
        if (abort.signal.aborted) {
          return;
        }
        await this.deps.sendFrame({ type: "tts_done", turnId });
      } finally {
        this.pendingJobAborts.delete(abort);
      }
    });
  }

  private registerJobAbort(): AbortController {
    const abort = new AbortController();
    this.pendingJobAborts.add(abort);
    return abort;
  }

  private enqueueJob(job: () => Promise<void>): void {
    this.ttsQueue = this.ttsQueue.then(job).catch(() => {
      // Job failures are reported as error frames inside the job;
      // transport failures are owned by the session. Keep draining.
    });
  }

  private fireAudioStartCallback(): void {
    const callback = this.audioStartCallback;
    if (!callback) {
      return;
    }
    this.audioStartCallback = null;
    callback();
  }
}
