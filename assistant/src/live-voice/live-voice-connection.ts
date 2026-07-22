/**
 * Transport-agnostic live voice connection — the importable entry point for
 * driving a single client's live voice session.
 *
 * A connection wraps one bidirectional audio transport (a WebSocket, a
 * WebRTC data channel, an in-process pipe — the caller decides). It owns the
 * per-connection framing state (the outbound sequence counter and the active
 * session id) and translates raw inbound messages into
 * {@link LiveVoiceSessionManager} calls, sending server frames back through
 * the caller-supplied {@link LiveVoiceFrameSender}.
 *
 * The manager is resolved from the process-wide singleton
 * ({@link getLiveVoiceSessionManager}), so every connection — the runtime
 * HTTP WebSocket and any plugin bringing its own transport — shares one
 * single-active-session lock. Callers therefore never construct or pass a
 * manager; they bring only a `send` callback.
 *
 * Typical wiring:
 *
 *     const connection = createLiveVoiceConnection({
 *       send: (frame) => socket.send(JSON.stringify(frame)),
 *     });
 *     socket.on("message", (msg) => void connection.handleMessage(msg));
 *     socket.on("close", () => connection.release());
 */

import { getLogger } from "../util/logger.js";
import { getLiveVoiceSessionManager } from "./live-voice-manager.js";
import type { LiveVoiceSessionManager } from "./live-voice-session-manager.js";
import type { LiveVoiceSessionCloseReason } from "./live-voice-session-manager.js";
import {
  type LiveVoiceClientFrame,
  type LiveVoiceProtocolError,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFrame,
  parseLiveVoiceBinaryAudioFrame,
  parseLiveVoiceClientTextFrame,
} from "./protocol.js";

const log = getLogger("live-voice-connection");

/**
 * Sends one fully-sequenced server frame to the client over the caller's
 * transport. The frame is a plain object; the caller is responsible for wire
 * encoding (e.g. `JSON.stringify` for a text WebSocket).
 */
export type LiveVoiceFrameSender = (frame: LiveVoiceServerFrame) => void;

export interface LiveVoiceConnection {
  /**
   * The active session id once a `start` frame has been accepted, else
   * `undefined`. Read-only — the connection assigns it on `start` and clears
   * it on `end`, teardown, or a session that the manager no longer knows.
   */
  readonly sessionId: string | undefined;
  /**
   * Handle one inbound transport message — a JSON text frame or a binary
   * audio chunk. Never rejects: protocol and handler failures are reported
   * back to the client as `error` frames.
   */
  handleMessage(message: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  /**
   * Release the session bound to this connection when the transport closes.
   * Idempotent — a no-op when no session is active.
   */
  release(reason?: LiveVoiceSessionCloseReason): void;
}

/** Create a live voice connection bound to the caller's `send` transport. */
export function createLiveVoiceConnection(options: {
  send: LiveVoiceFrameSender;
}): LiveVoiceConnection {
  return new LiveVoiceConnectionImpl(
    options.send,
    getLiveVoiceSessionManager(),
  );
}

class LiveVoiceConnectionImpl implements LiveVoiceConnection {
  private activeSessionId: string | undefined;
  private lastSeq = 0;

  constructor(
    private readonly send: LiveVoiceFrameSender,
    private readonly manager: LiveVoiceSessionManager,
  ) {}

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  async handleMessage(
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    try {
      if (typeof message === "string") {
        const result = parseLiveVoiceClientTextFrame(message);
        if (!result.ok) {
          this.sendError(result.error);
          return;
        }
        await this.dispatchClientFrame(result.frame);
        return;
      }

      const result = parseLiveVoiceBinaryAudioFrame(message);
      if (!result.ok) {
        this.sendError(result.error);
        return;
      }

      const sessionId = this.activeSessionId;
      if (!sessionId) {
        this.sendStateError("Live voice binary audio received before start");
        return;
      }

      const handled = await this.manager.handleBinaryAudio(
        sessionId,
        result.frame.data,
      );
      if (handled.status === "not_found") {
        this.activeSessionId = undefined;
        this.sendStateError("Live voice session is not active");
      }
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Live voice message handler failed",
      );
      this.sendError({
        code: LiveVoiceProtocolErrorCode.InvalidFrame,
        message: "Live voice frame handling failed",
      });
    }
  }

  release(reason: LiveVoiceSessionCloseReason = "transport_closed"): void {
    const sessionId = this.activeSessionId;
    this.activeSessionId = undefined;
    if (!sessionId) {
      return;
    }

    void this.manager.releaseSession(sessionId, reason).catch((err) => {
      log.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          sessionId,
        },
        "Failed to release live voice session",
      );
    });
  }

  private async dispatchClientFrame(
    frame: LiveVoiceClientFrame,
  ): Promise<void> {
    if (frame.type === "start") {
      if (this.activeSessionId) {
        // A session that failed after `ready` releases its manager slot
        // without a frame crossing this transport — heal the stale binding so
        // the client can retry on the same connection.
        if (this.manager.isSessionActive(this.activeSessionId)) {
          this.sendStateError("Live voice session already started");
          return;
        }
        this.activeSessionId = undefined;
      }

      const result = await this.manager.startSession(frame, {
        sendFrame: (serverFrame) => {
          this.sendFrame(serverFrame);
        },
      });
      if (result.status === "accepted") {
        this.activeSessionId = result.sessionId;
      }
      return;
    }

    const sessionId = this.activeSessionId;
    if (!sessionId) {
      this.sendStateError(
        `Live voice ${frame.type} frame received before start`,
      );
      return;
    }

    const handled = await this.manager.handleClientFrame(sessionId, frame);
    if (handled.status === "not_found") {
      this.activeSessionId = undefined;
      this.sendStateError("Live voice session is not active");
      return;
    }

    if (frame.type === "end") {
      this.activeSessionId = undefined;
    }
  }

  private sendStateError(message: string): void {
    this.sendError({
      code: LiveVoiceProtocolErrorCode.InvalidFrame,
      message,
    });
  }

  private sendError(
    error: Pick<LiveVoiceProtocolError, "code" | "message">,
  ): void {
    this.sendFrame({
      type: "error",
      seq: this.lastSeq + 1,
      code: error.code,
      message: error.message,
    });
  }

  private sendFrame(frame: LiveVoiceServerFrame): void {
    const seq = Math.max(this.lastSeq + 1, frame.seq);
    this.lastSeq = seq;
    this.send({ ...frame, seq });
  }
}
