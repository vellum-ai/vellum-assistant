/**
 * Runtime STT stream session orchestrator.
 *
 * Manages the lifecycle of a single streaming transcription session between
 * a client WebSocket connection and a provider-specific streaming adapter.
 * The orchestrator accepts client events (`audio`, `stop`), routes audio
 * frames to the resolved {@link StreamingTranscriber}, and emits normalized
 * server events (`partial`, `final`, `error`, `closed`) back over the same
 * WebSocket connection with per-session ordering guarantees.
 *
 * Session lifecycle:
 * 1. Client opens a WebSocket to `/v1/stt/stream` with `provider` and
 *    `mimeType` query parameters.
 * 2. The orchestrator resolves a {@link StreamingTranscriber} via
 *    `resolveStreamingTranscriber()` and starts the provider session.
 * 3. The client sends `audio` frames (binary or base64-encoded JSON) and
 *    a `stop` event when recording is complete.
 * 4. The provider emits `partial` and `final` transcript events which the
 *    orchestrator forwards to the client as JSON frames.
 * 5. The session closes deterministically on client disconnect, `stop`
 *    event, idle timeout, or runtime shutdown.
 *
 * Error handling:
 * - Unsupported providers fail gracefully with a structured `error` event
 *   followed by `closed`, without crashing the socket.
 * - Provider errors are caught and forwarded as `error` events.
 * - An idle timeout fires if no client messages arrive within a
 *   configurable window.
 */

import { getLogger } from "../util/logger.js";
import type { StreamingTranscriber, SttStreamServerEvent } from "./types.js";

const log = getLogger("stt-stream-session");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default idle timeout (ms). If no client message (audio or stop) arrives
 * within this window after the session starts, the session is torn down.
 * This prevents leaked sessions when a client silently disconnects without
 * sending a WebSocket close frame.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SessionState =
  /** Session created, waiting for provider start to complete. */
  | "initializing"
  /** Provider started, accepting audio frames. */
  | "active"
  /** Client sent stop, waiting for provider to flush finals. */
  | "stopping"
  /** Session fully closed (terminal state). */
  | "closed";

// ---------------------------------------------------------------------------
// WebSocket interface
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket send interface so the orchestrator can be tested
 * without depending on Bun's full ServerWebSocket type.
 */
export interface SttStreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SttStreamSessionOptions {
  /** Override idle timeout for testing. */
  idleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Session class
// ---------------------------------------------------------------------------

/**
 * Manages a single streaming STT session.
 *
 * Created by the WebSocket `open` handler in `http-server.ts` and destroyed
 * on close or timeout. Each session owns exactly one
 * {@link StreamingTranscriber} instance.
 */
export class SttStreamSession {
  private state: SessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private readonly ws: SttStreamSocket;
  private readonly provider: string;
  private readonly mimeType: string;
  private readonly idleTimeoutMs: number;

  /** Sequence counter for per-session ordering guarantees. */
  private seq = 0;

  /** Idle timer handle — reset on every inbound client message. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    ws: SttStreamSocket,
    provider: string,
    mimeType: string,
    options: SttStreamSessionOptions = {},
  ) {
    this.ws = ws;
    this.provider = provider;
    this.mimeType = mimeType;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Initialize the session by resolving and starting the streaming
   * transcriber. Sends a `ready` event on success or an `error` + `closed`
   * pair on failure.
   *
   * The `resolveTranscriber` parameter is injected so tests can provide
   * mock transcribers without importing the full resolve.ts module (which
   * pulls in config, secure-keys, etc.).
   */
  async start(
    resolveTranscriber: () => Promise<StreamingTranscriber | null>,
  ): Promise<void> {
    if (this.state !== "initializing") {
      log.warn(
        { state: this.state },
        "SttStreamSession.start() called in non-initializing state",
      );
      return;
    }

    try {
      const transcriber = await resolveTranscriber();

      // Guard: session may have been closed while resolveTranscriber() was
      // in flight (e.g. client disconnect). Abort startup to avoid leaking
      // a provider stream with no live socket.
      // Note: Use isClosed to defeat TypeScript control-flow narrowing —
      // the compiler narrows `this.state` to "initializing" after the
      // guard at the top of start(), but handleClose() can mutate it
      // concurrently during the await.
      if (this.isClosed) {
        if (transcriber) {
          try {
            transcriber.stop();
          } catch {
            // Best effort cleanup of the just-resolved transcriber.
          }
        }
        return;
      }

      if (!transcriber) {
        log.info(
          { provider: this.provider },
          "Streaming transcriber unavailable for provider",
        );
        this.sendEvent({
          type: "error",
          category: "provider-error",
          message: `Streaming transcription is not supported for provider "${this.provider}". Supported providers: deepgram, google-gemini.`,
        });
        this.sendEvent({ type: "closed" });
        this.state = "closed";
        this.closeSocket(1000, "unsupported provider");
        return;
      }

      this.transcriber = transcriber;

      await transcriber.start((event: SttStreamServerEvent) => {
        this.handleTranscriberEvent(event);
      });

      // Guard: session may have been closed while transcriber.start() was
      // in flight. If so, stop the transcriber and bail out.
      if (this.isClosed) {
        try {
          transcriber.stop();
        } catch {
          // Best effort cleanup.
        }
        this.transcriber = null;
        return;
      }

      this.state = "active";
      this.resetIdleTimer();

      // `ready` is intentionally sent via sendJson() rather than sendEvent().
      // It is a session lifecycle signal — not a content event — so it lives
      // outside the sequenced (seq-numbered) event stream.  The client already
      // handles `ready` without a `seq` field; all subsequent content events
      // (partial, final, error, closed) go through sendEvent() which assigns
      // monotonic seq numbers for ordering guarantees.
      this.sendJson({ type: "ready", provider: transcriber.providerId });

      log.info(
        { provider: transcriber.providerId },
        "STT stream session started",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { provider: this.provider, error: message },
        "Failed to start STT stream session",
      );
      this.sendEvent({
        type: "error",
        category: "provider-error",
        message: `Failed to start streaming session: ${message}`,
      });
      this.sendEvent({ type: "closed" });
      this.state = "closed";
      this.closeSocket(1011, "provider start failed");
    }
  }

  /**
   * Handle an inbound WebSocket message (text frame).
   *
   * Parses the message as a client event and routes to the appropriate
   * handler. Binary frames containing raw audio are handled by
   * {@link handleBinaryAudio}.
   */
  handleMessage(raw: string): void {
    if (this.state === "closed") return;

    this.resetIdleTimer();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON — ignore silently. Could be a malformed frame.
      log.debug("STT stream: dropped non-JSON text frame");
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const event = parsed as {
      type?: string;
      audio?: string;
      mimeType?: string;
    };
    switch (event.type) {
      case "audio": {
        if (this.state !== "active") {
          log.debug(
            { state: this.state },
            "STT stream: dropped audio event in non-active state",
          );
          return;
        }
        // Audio data may be base64-encoded in a JSON text frame.
        if (typeof event.audio === "string") {
          const buffer = Buffer.from(event.audio, "base64");
          const mime = event.mimeType ?? this.mimeType;
          this.transcriber?.sendAudio(buffer, mime);
        }
        return;
      }
      case "stop": {
        this.handleStop();
        return;
      }
      default: {
        log.debug(
          { type: event.type },
          "STT stream: dropped unknown event type",
        );
        return;
      }
    }
  }

  /**
   * Handle a binary WebSocket message (raw audio bytes).
   *
   * This path is used when the client sends audio as binary WebSocket
   * frames rather than base64-encoded JSON.
   */
  handleBinaryAudio(data: Buffer | ArrayBuffer | Uint8Array): void {
    if (this.state !== "active") return;

    this.resetIdleTimer();

    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);

    this.transcriber?.sendAudio(buffer, this.mimeType);
  }

  /**
   * Handle WebSocket close (client disconnected or transport error).
   * Tears down the provider session and cleans up resources.
   */
  handleClose(code: number, reason?: string): void {
    if (this.state === "closed") return;

    log.info(
      { provider: this.provider, code, reason },
      "STT stream WebSocket closed",
    );

    this.teardown();
  }

  /**
   * Forcibly destroy the session. Called during runtime shutdown to
   * ensure deterministic cleanup of all active sessions.
   */
  destroy(): void {
    if (this.state === "closed") return;

    log.info({ provider: this.provider }, "STT stream session destroyed");
    this.teardown();
  }

  /**
   * Whether the session is in a terminal state.
   */
  get isClosed(): boolean {
    return this.state === "closed";
  }

  // ── Internal handlers ──────────────────────────────────────────────

  /**
   * Handle the client `stop` event. Signals the transcriber to stop
   * and waits for it to flush remaining finals.
   */
  private handleStop(): void {
    if (this.state !== "active") {
      log.debug(
        { state: this.state },
        "STT stream: stop event in non-active state",
      );
      return;
    }

    this.state = "stopping";
    this.clearIdleTimer();

    try {
      this.transcriber?.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, "Error calling transcriber.stop()");
      // Force teardown if stop() throws.
      this.sendEvent({
        type: "error",
        category: "provider-error",
        message: `Error stopping transcriber: ${message}`,
      });
      this.sendEvent({ type: "closed" });
      this.state = "closed";
      this.closeSocket(1011, "stop failed");
    }
  }

  /**
   * Handle events emitted by the streaming transcriber.
   */
  private handleTranscriberEvent(event: SttStreamServerEvent): void {
    if (this.state === "closed") return;

    this.sendEvent(event);

    // When the transcriber emits `closed`, the session is done.
    if (event.type === "closed") {
      this.state = "closed";
      this.clearIdleTimer();
      this.closeSocket(1000, "session complete");
    }
  }

  // ── Event emission ─────────────────────────────────────────────────

  /**
   * Send a normalized server event with a monotonic sequence number.
   */
  private sendEvent(event: SttStreamServerEvent): void {
    this.sendJson({ ...event, seq: this.seq++ });
  }

  /**
   * Send a JSON object over the WebSocket. Swallows send errors to
   * prevent cascading failures.
   */
  private sendJson(data: Record<string, unknown>): void {
    try {
      this.ws.send(JSON.stringify(data));
    } catch (err) {
      log.debug(
        { error: err instanceof Error ? err.message : String(err) },
        "STT stream: failed to send WebSocket frame",
      );
    }
  }

  // ── Idle timer ─────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    if (this.state === "closed" || this.state === "stopping") return;

    this.idleTimer = setTimeout(() => {
      if (this.state === "closed") return;

      log.warn({ provider: this.provider }, "STT stream session idle timeout");
      this.sendEvent({
        type: "error",
        category: "timeout",
        message: "STT stream session timed out due to inactivity",
      });
      this.sendEvent({ type: "closed" });
      this.teardown();
      // Close the WebSocket transport so the connection does not linger
      // indefinitely (runtime sockets use idleTimeout: 0).
      this.closeSocket(1000, "idle timeout");
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────

  /**
   * Clean up all resources (timers, transcriber, socket).
   * Idempotent — safe to call multiple times.
   */
  private teardown(): void {
    if (this.state === "closed") return;
    this.state = "closed";

    this.clearIdleTimer();

    // Stop the transcriber if it is still running. The stop() call may
    // trigger additional events, but since state is already "closed"
    // they will be dropped by handleTranscriberEvent().
    if (this.transcriber) {
      try {
        this.transcriber.stop();
      } catch {
        // Best effort — the transcriber may already be closed.
      }
      this.transcriber = null;
    }
  }

  /**
   * Close the WebSocket connection. Best-effort — already-closed sockets
   * may throw.
   */
  private closeSocket(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // Already closed — swallow.
    }
  }
}

// ---------------------------------------------------------------------------
// Active session registry
// ---------------------------------------------------------------------------

/**
 * Map of active STT stream sessions, keyed by a session identifier derived
 * from the WebSocket connection. Used by the runtime HTTP server to track
 * sessions for graceful shutdown.
 */
export const activeSttStreamSessions = new Map<string, SttStreamSession>();
