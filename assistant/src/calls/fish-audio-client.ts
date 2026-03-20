import { decode, encode } from "@msgpack/msgpack";

import type { FishAudioConfig } from "../config/schemas/fish-audio.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("fish-audio-client");

// ---------------------------------------------------------------------------
// Fish Audio S2 WebSocket MessagePack protocol types
// ---------------------------------------------------------------------------

interface StartEvent {
  event: "start";
  request: {
    text?: string;
    reference_id?: string;
    format?: string;
    sample_rate?: number;
    mp3_bitrate?: number;
    chunk_length?: number;
    normalize?: boolean;
    latency?: string;
    prosody?: { speed?: number; volume?: number };
  };
}

interface TextEvent {
  event: "text";
  text: string;
}

interface FlushEvent {
  event: "flush";
}

interface StopEvent {
  event: "stop";
}

interface AudioEvent {
  event: "audio";
  audio: Uint8Array;
}

interface FinishEvent {
  event: "finish";
  reason: string;
}

type InboundEvent = AudioEvent | FinishEvent;

// ---------------------------------------------------------------------------
// FishAudioSession — persistent session for an entire call
// ---------------------------------------------------------------------------

/**
 * Fish Audio S2 streams audio chunks after receiving text + flush, but does
 * NOT send a FinishEvent until a StopEvent is sent (which terminates the
 * session). To keep a single session alive across multiple sentences, we
 * detect synthesis completion by an idle timeout: once the first audio chunk
 * arrives, if no more chunks arrive within IDLE_TIMEOUT_MS we consider that
 * sentence done. A separate FIRST_CHUNK_TIMEOUT_MS guards against the server
 * never responding at all.
 */
const IDLE_TIMEOUT_MS = 800;
const FIRST_CHUNK_TIMEOUT_MS = 10_000;

interface PendingSynthesis {
  chunks: Uint8Array[];
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
  firstChunkReceived: boolean;
}

export class FishAudioSession {
  private ws: WebSocket;
  private pending: PendingSynthesis | null = null;
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.setupHandlers();
  }

  /**
   * Open a WebSocket connection to Fish Audio S2 and send the initial
   * StartEvent with the provided configuration. The session stays alive
   * for multiple synthesize() calls until close() is called.
   */
  static async create(config: FishAudioConfig): Promise<FishAudioSession> {
    const apiKey = await getSecureKeyAsync(
      credentialKey("fish-audio", "api_key"),
    );
    if (!apiKey) {
      throw new Error(
        "Fish Audio API key not configured. Store it via: assistant credentials set --service fish-audio --field api_key <key>",
      );
    }

    return new Promise<FishAudioSession>((resolve, reject) => {
      // Bun's WebSocket supports headers in its options object, but the
      // constructor overload may not be visible when lib.dom types are
      // loaded. Cast through unknown to use the Bun-specific signature.
      const ws = new WebSocket(
        "wss://api.fish.audio/v1/tts/live",
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            model: "s1",
          },
        } as unknown as string[],
      );

      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        const startEvent: StartEvent = {
          event: "start",
          request: {
            text: "",
            reference_id: config.referenceId || undefined,
            format: config.format,
            mp3_bitrate: 192,
            chunk_length: config.chunkLength,
            latency: "balanced",
            prosody:
              config.speed !== 1.0 ? { speed: config.speed } : undefined,
          },
        };

        ws.send(encode(startEvent));
        log.info(
          { referenceId: config.referenceId, format: config.format },
          "Fish Audio session started",
        );

        const session = new FishAudioSession(ws);
        resolve(session);
      });

      ws.addEventListener("error", (ev) => {
        const errorMsg =
          ev instanceof ErrorEvent ? ev.message : "WebSocket connection failed";
        reject(new Error(`Fish Audio WebSocket error: ${errorMsg}`));
      });
    });
  }

  /**
   * Send text for synthesis and wait for the complete audio response.
   * Sends TextEvent + FlushEvent, then collects AudioEvent chunks until
   * an idle timeout (no new chunks for IDLE_TIMEOUT_MS) indicates the
   * server has finished streaming audio for this text. The session remains
   * alive for subsequent calls.
   */
  synthesize(text: string): Promise<Buffer> {
    if (this.closed) {
      return Promise.reject(new Error("FishAudioSession is closed"));
    }

    if (this.pending) {
      return Promise.reject(
        new Error(
          "A synthesis is already in progress. Wait for it to complete before starting another.",
        ),
      );
    }

    return new Promise<Buffer>((resolve, reject) => {
      this.pending = {
        chunks: [],
        resolve,
        reject,
        idleTimer: null,
        firstChunkReceived: false,
      };

      const textEvent: TextEvent = { event: "text", text };
      this.ws.send(encode(textEvent));

      const flushEvent: FlushEvent = { event: "flush" };
      this.ws.send(encode(flushEvent));

      // Start a long initial timer — if no audio chunk arrives at all
      // within FIRST_CHUNK_TIMEOUT_MS, reject. Once the first chunk
      // arrives, we switch to the shorter idle timeout.
      this.pending.idleTimer = setTimeout(() => {
        if (this.pending && !this.pending.firstChunkReceived) {
          this.rejectPending(
            new Error("Fish Audio did not respond with audio within timeout"),
          );
        }
      }, FIRST_CHUNK_TIMEOUT_MS);

      log.debug({ textLength: text.length }, "Sent text+flush for synthesis");
    });
  }

  /**
   * Close the WebSocket session gracefully.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.clearIdleTimer();

    // If there's a pending synthesis, resolve it with whatever we have
    // rather than rejecting — the audio collected so far is still usable.
    if (this.pending) {
      this.resolvePending();
    }

    try {
      const closeEvent: StopEvent = { event: "stop" };
      this.ws.send(encode(closeEvent));
    } catch {
      // WebSocket may already be closed
    }

    this.ws.close();
    log.debug("Fish Audio session closed");
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private resetIdleTimer(): void {
    if (this.pending?.idleTimer) {
      clearTimeout(this.pending.idleTimer);
    }
    if (this.pending) {
      this.pending.idleTimer = setTimeout(() => {
        // No audio chunk received within the idle window — synthesis is done.
        this.resolvePending();
      }, IDLE_TIMEOUT_MS);
    }
  }

  private clearIdleTimer(): void {
    if (this.pending?.idleTimer) {
      clearTimeout(this.pending.idleTimer);
      this.pending.idleTimer = null;
    }
  }

  private resolvePending(): void {
    if (!this.pending) return;
    const { chunks, resolve } = this.pending;
    this.clearIdleTimer();
    this.pending = null;
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    log.debug({ bytes: totalLength }, "Synthesis complete (idle timeout)");
    resolve(Buffer.from(merged));
  }

  private setupHandlers(): void {
    this.ws.addEventListener("message", (ev) => {
      try {
        const data =
          ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : new Uint8Array(ev.data as ArrayBuffer);

        const decoded = decode(data) as InboundEvent;
        this.handleMessage(decoded);
      } catch (err) {
        log.error({ err }, "Failed to decode Fish Audio message");
        this.rejectPending(
          new Error(
            `Failed to decode Fish Audio message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    this.ws.addEventListener("error", (ev) => {
      const errorMsg =
        ev instanceof ErrorEvent ? ev.message : "WebSocket error";
      log.error({ error: errorMsg }, "Fish Audio WebSocket error");
      this.rejectPending(new Error(`Fish Audio WebSocket error: ${errorMsg}`));
    });

    this.ws.addEventListener("close", (ev) => {
      this.closed = true;
      if (this.pending) {
        // If we have audio chunks, resolve with what we have rather than
        // rejecting — partial audio is better than no audio.
        if (this.pending.chunks.length > 0) {
          log.warn(
            { code: ev.code },
            "Fish Audio WebSocket closed with buffered audio — resolving with partial data",
          );
          this.resolvePending();
        } else {
          log.warn(
            { code: ev.code, reason: ev.reason },
            "Fish Audio WebSocket closed with pending synthesis (no audio)",
          );
          this.rejectPending(
            new Error(
              `Fish Audio WebSocket closed unexpectedly (code: ${ev.code})`,
            ),
          );
        }
      }
    });
  }

  private handleMessage(msg: InboundEvent): void {
    switch (msg.event) {
      case "audio": {
        if (this.pending) {
          this.pending.chunks.push(msg.audio);
          this.pending.firstChunkReceived = true;
          // Reset idle timer — more audio may follow. The first chunk
          // cancels the initial FIRST_CHUNK_TIMEOUT and switches to the
          // shorter IDLE_TIMEOUT for inter-chunk gaps.
          this.resetIdleTimer();
        }
        break;
      }
      case "finish": {
        // FinishEvent arrives after StopEvent (session teardown). In
        // persistent-session mode we don't send stop between sentences,
        // so this only fires during close(). Resolve if still pending.
        this.resolvePending();
        break;
      }
    }
  }

  private rejectPending(error: Error): void {
    if (this.pending) {
      const { reject } = this.pending;
      this.clearIdleTimer();
      this.pending = null;
      reject(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Synthesize text to audio using Fish Audio S2 in a single call.
 * Opens a session, synthesizes the text, and closes the session.
 */
export async function synthesizeWithFishAudio(
  text: string,
  config: FishAudioConfig,
): Promise<Buffer> {
  const session = await FishAudioSession.create(config);
  try {
    return await session.synthesize(text);
  } finally {
    session.close();
  }
}
