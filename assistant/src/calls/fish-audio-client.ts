import { encode, decode } from "@msgpack/msgpack";

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
    reference_id?: string;
    format?: string;
    sample_rate?: number;
    chunk_length?: number;
    normalize?: boolean;
    latency?: string;
    streaming?: boolean;
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
// FishAudioSession — manages a single WebSocket connection
// ---------------------------------------------------------------------------

interface PendingSynthesis {
  chunks: Uint8Array[];
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
}

export class FishAudioSession {
  private ws: WebSocket;
  private pending: PendingSynthesis | null = null;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.setupHandlers();
  }

  /**
   * Open a WebSocket connection to Fish Audio S2 and send the initial
   * StartEvent with the provided configuration.
   */
  static async create(config: FishAudioConfig): Promise<FishAudioSession> {
    const apiKey = await getSecureKeyAsync(
      credentialKey("fish-audio", "api_key"),
    );
    if (!apiKey) {
      throw new Error(
        "Fish Audio API key not configured. Store it via: assistant credentials set fish-audio api_key",
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
            model: "speech-01",
          },
        } as unknown as string[],
      );

      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        const startEvent: StartEvent = {
          event: "start",
          request: {
            reference_id: config.referenceId || undefined,
            format: config.format,
            chunk_length: config.chunkLength,
            streaming: true,
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
   * Sends a TextEvent followed by a FlushEvent, then collects AudioEvent
   * chunks until a FinishEvent is received.
   */
  synthesize(text: string): Promise<Buffer> {
    if (this.closed) {
      return Promise.reject(
        new Error("FishAudioSession is closed"),
      );
    }

    if (this.pending) {
      return Promise.reject(
        new Error(
          "A synthesis is already in progress. Wait for it to complete before starting another.",
        ),
      );
    }

    return new Promise<Buffer>((resolve, reject) => {
      this.pending = { chunks: [], resolve, reject };

      const textEvent: TextEvent = { event: "text", text };
      this.ws.send(encode(textEvent));

      const flushEvent: FlushEvent = { event: "flush" };
      this.ws.send(encode(flushEvent));

      log.debug({ textLength: text.length }, "Sent text for synthesis");
    });
  }

  /**
   * Close the WebSocket session gracefully.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

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
  // Internal message handling
  // -------------------------------------------------------------------------

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
        log.error(
          { err },
          "Failed to decode Fish Audio message",
        );
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
        log.warn(
          { code: ev.code, reason: ev.reason },
          "Fish Audio WebSocket closed with pending synthesis",
        );
        this.rejectPending(
          new Error(
            `Fish Audio WebSocket closed unexpectedly (code: ${ev.code})`,
          ),
        );
      }
    });
  }

  private handleMessage(msg: InboundEvent): void {
    switch (msg.event) {
      case "audio": {
        if (this.pending) {
          this.pending.chunks.push(msg.audio);
        }
        break;
      }
      case "finish": {
        if (this.pending) {
          const { chunks, resolve } = this.pending;
          this.pending = null;
          const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          log.debug(
            { reason: msg.reason, bytes: totalLength },
            "Synthesis complete",
          );
          resolve(Buffer.from(merged));
        }
        break;
      }
    }
  }

  private rejectPending(error: Error): void {
    if (this.pending) {
      const { reject } = this.pending;
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
