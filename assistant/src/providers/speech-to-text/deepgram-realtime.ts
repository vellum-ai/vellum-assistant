/**
 * Deepgram realtime streaming STT adapter.
 *
 * Opens a WebSocket session against Deepgram's live transcription endpoint
 * (`/v1/listen`), forwards PCM audio frames from the caller, and normalizes
 * Deepgram's streaming response payloads (`is_final`, `speech_final`,
 * endpointing metadata) into the daemon's {@link SttStreamServerEvent}
 * contract with stable partial/final semantics.
 *
 * Lifecycle:
 * 1. {@link start} opens the WebSocket and resolves once the connection is
 *    established.
 * 2. {@link sendAudio} forwards audio chunks over the open socket with
 *    backpressure-safe bufferedAmount checks.
 * 3. {@link stop} sends the Deepgram `CloseStream` message and waits for
 *    the provider to flush any remaining finals before closing.
 * 4. The `onEvent` callback receives `partial`, `final`, `error`, and
 *    `closed` events throughout the session lifetime.
 *
 * Error handling:
 * - Provider WebSocket errors and unexpected closes are mapped to
 *   {@link SttStreamServerErrorEvent} with appropriate categories.
 * - A configurable inactivity timeout fires a `closed` event if the
 *   provider stops sending data mid-session.
 * - All timers and listeners are cleaned up on close to prevent leaks.
 */

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("deepgram-realtime");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WS_BASE_URL = "wss://api.deepgram.com";
const DEFAULT_MODEL = "nova-2";

/**
 * Default timeout (ms) for the WebSocket connection handshake.
 * If the socket does not reach OPEN within this window, start() rejects.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Default inactivity timeout (ms). If no message is received from Deepgram
 * for this duration after the session is open, the adapter closes with a
 * timeout error. This guards against provider-side hangs.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Maximum WebSocket bufferedAmount (bytes) before sendAudio applies
 * backpressure by dropping frames. This prevents unbounded memory growth
 * if the network or provider cannot keep up with the audio rate.
 */
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MiB

/**
 * Grace period (ms) after sending CloseStream before we force-close
 * the WebSocket. Gives Deepgram time to flush any remaining finals.
 */
const CLOSE_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepgramRealtimeOptions {
  /** Deepgram model to use (default: "nova-2"). */
  model?: string;
  /** BCP-47 language code (e.g. "en", "es"). Omitted by default (auto-detect). */
  language?: string;
  /** Enable Deepgram smart formatting (punctuation, numerals, etc.). Default: true. */
  smartFormatting?: boolean;
  /** Enable interim (partial) results. Default: true. */
  interimResults?: boolean;
  /** Enable utterance end detection (endpointing). Default: true. */
  utteranceEndMs?: number;
  /** Override the Deepgram WebSocket base URL (useful for proxies or on-prem). */
  baseUrl?: string;
  /** Connect timeout in milliseconds. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Inactivity timeout in milliseconds. Default: 30_000. */
  inactivityTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Deepgram streaming response types (subset relevant to transcript events)
// ---------------------------------------------------------------------------

/** A single transcript alternative within a Deepgram streaming response. */
interface DeepgramStreamAlternative {
  transcript?: string;
  confidence?: number;
}

/** A channel within a Deepgram streaming response. */
interface DeepgramStreamChannel {
  alternatives?: DeepgramStreamAlternative[];
}

/**
 * The top-level Deepgram streaming response frame.
 *
 * Key fields for event normalization:
 * - `is_final` — true when the transcript for this audio segment is committed
 *   and will not be revised. When false, the transcript is interim (partial).
 * - `speech_final` — true when Deepgram's endpointing detects a natural
 *   speech pause. Combined with `is_final`, this signals a committed utterance
 *   boundary. We emit a `final` event only when `is_final` is true.
 * - `type` — `"Results"` for transcript frames, `"Metadata"` for session info,
 *   `"UtteranceEnd"` for endpointing signals.
 */
interface DeepgramStreamResponse {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: DeepgramStreamChannel;
  channel_index?: number[];
  /** Duration of the audio segment in seconds. */
  duration?: number;
  /** Start offset of the audio segment in seconds. */
  start?: number;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural WebSocket interface so we can test without depending
 * on Bun's global WebSocket type at the type level.
 */
interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | ArrayBufferLike | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
  removeEventListener(type: string, listener: unknown): void;
}

const WS_OPEN = 1;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * Deepgram realtime streaming transcriber.
 *
 * Implements the daemon {@link StreamingTranscriber} contract on top of
 * Deepgram's live transcription WebSocket API.
 */
export class DeepgramRealtimeTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly smartFormatting: boolean;
  private readonly interimResults: boolean;
  private readonly utteranceEndMs: number | undefined;
  private readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;

  /** The live WebSocket connection, set during start(). */
  private ws: WsLike | null = null;

  /** Callback for emitting events to the session orchestrator. */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  /** Whether the session has been fully closed. */
  private closed = false;

  /** Whether stop() has been called. */
  private stopping = false;

  /** Inactivity timer handle. */
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  /** Close grace timer handle. */
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(apiKey: string, options: DeepgramRealtimeOptions = {}) {
    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.language = options.language;
    this.smartFormatting = options.smartFormatting ?? true;
    this.interimResults = options.interimResults ?? true;
    this.utteranceEndMs = options.utteranceEndMs;
    this.baseUrl = (options.baseUrl ?? DEFAULT_WS_BASE_URL).replace(/\/+$/, "");
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.inactivityTimeoutMs =
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  }

  // ── StreamingTranscriber interface ──────────────────────────────────

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.ws) {
      throw new Error("DeepgramRealtimeTranscriber: start() called twice");
    }
    this.onEvent = onEvent;

    const url = this.buildWebSocketUrl();
    log.info(
      { url: url.replace(/token=.*/, "token=***") },
      "Opening Deepgram realtime session",
    );

    const ws = this.createWebSocket(url);
    this.ws = ws;

    // Wait for the WebSocket to open or fail.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.forceClose();
        reject(new Error("Deepgram realtime connect timeout"));
      }, this.connectTimeoutMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        resolve();
      };

      const onError = (ev: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        const msg =
          ev instanceof Error
            ? ev.message
            : typeof ev === "object" && ev !== null && "message" in ev
              ? String((ev as { message: unknown }).message)
              : "WebSocket error during connect";
        reject(new Error(`Deepgram realtime connect error: ${msg}`));
      };

      const onClose = (ev: { code: number; reason: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(
          new Error(
            `Deepgram WebSocket closed before open (code=${ev.code}, reason=${ev.reason})`,
          ),
        );
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });

    // Socket is now open — attach the message/close/error handlers for
    // the active session lifetime.
    this.attachSessionHandlers(ws);
    this.resetInactivityTimer();

    log.info("Deepgram realtime session opened");
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    if (this.closed || this.stopping) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;

    // Backpressure check — drop frames if the outbound buffer is too full
    // to prevent unbounded memory growth.
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      log.warn(
        { bufferedAmount: ws.bufferedAmount },
        "Deepgram realtime backpressure: dropping audio frame",
      );
      return;
    }

    // Deepgram's live endpoint accepts raw audio bytes on the WebSocket.
    ws.send(new Uint8Array(audio));
    this.resetInactivityTimer();
  }

  stop(): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;

    log.info("Stopping Deepgram realtime session");

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      this.emitClosedAndCleanup();
      return;
    }

    // Send the Deepgram CloseStream message to signal end-of-audio.
    // The provider may flush remaining finals before closing.
    try {
      ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      // If the send fails, force-close immediately.
      this.emitClosedAndCleanup();
      return;
    }

    // Start a grace timer — if the provider doesn't close within the
    // grace window, we force-close to prevent session leaks.
    this.closeGraceTimer = setTimeout(() => {
      log.warn("Deepgram realtime close grace timeout — forcing close");
      this.emitClosedAndCleanup();
    }, CLOSE_GRACE_MS);
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────

  /**
   * Create a WebSocket instance. Factored out for test mockability.
   */
  private createWebSocket(url: string): WsLike {
    const WebSocketCtor: new (url: string) => WsLike = (
      globalThis as unknown as { WebSocket: new (url: string) => WsLike }
    ).WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new Error("global WebSocket is not available in this runtime");
    }
    return new WebSocketCtor(url);
  }

  /**
   * Attach session-lifetime handlers (message, close, error) to the
   * opened WebSocket. These handlers drive the event normalization
   * pipeline.
   */
  private attachSessionHandlers(ws: WsLike): void {
    ws.addEventListener("message", (ev: { data: unknown }) => {
      this.handleProviderMessage(ev.data);
    });

    ws.addEventListener("close", (ev: { code: number; reason: string }) => {
      this.handleProviderClose(ev.code, ev.reason);
    });

    ws.addEventListener("error", (ev: unknown) => {
      this.handleProviderError(ev);
    });
  }

  // ── Provider message handling ───────────────────────────────────────

  /**
   * Parse and normalize a Deepgram streaming response into daemon events.
   */
  private handleProviderMessage(data: unknown): void {
    if (this.closed) return;

    this.resetInactivityTimer();

    let raw: string;
    if (typeof data === "string") {
      raw = data;
    } else if (data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(data);
    } else {
      // Unexpected binary format — ignore.
      return;
    }

    let frame: DeepgramStreamResponse;
    try {
      frame = JSON.parse(raw) as DeepgramStreamResponse;
    } catch {
      log.debug("Dropped non-JSON Deepgram frame");
      return;
    }

    if (!frame || typeof frame !== "object") return;

    // Deepgram uses `type: "Results"` for transcript frames.
    if (frame.type === "Results") {
      this.handleTranscriptFrame(frame);
      return;
    }

    // `UtteranceEnd` is an endpointing signal — no transcript text, but
    // it confirms the previous is_final segment is a natural boundary.
    // We don't need to emit an additional event since we already emit
    // finals on is_final=true.
    if (frame.type === "UtteranceEnd") {
      log.debug("Received UtteranceEnd signal");
      return;
    }

    // Metadata and other frame types are informational — no action needed.
  }

  /**
   * Normalize a Deepgram `Results` frame into partial or final events.
   *
   * Deepgram semantics:
   * - `is_final: false` — interim transcript, may be revised.
   * - `is_final: true` — committed transcript for this segment.
   * - `speech_final: true` — endpointing detected a pause; combined with
   *   `is_final: true`, this marks a natural utterance boundary.
   *
   * We emit:
   * - `partial` for `is_final: false` frames (if interim results enabled).
   * - `final` for `is_final: true` frames.
   */
  private handleTranscriptFrame(frame: DeepgramStreamResponse): void {
    const transcript = frame.channel?.alternatives?.[0]?.transcript;

    // Extract text, defaulting to empty string for silence segments.
    const text = typeof transcript === "string" ? transcript.trim() : "";

    if (frame.is_final) {
      // Committed transcript — emit as final.
      this.emitEvent({ type: "final", text });
    } else if (this.interimResults) {
      // Interim transcript — emit as partial.
      this.emitEvent({ type: "partial", text });
    }
  }

  /**
   * Handle provider-side WebSocket close.
   */
  private handleProviderClose(code: number, reason: string): void {
    if (this.closed) return;

    // Normal close (1000) or going-away (1001) after stop() is expected.
    if (this.stopping && (code === 1000 || code === 1001)) {
      log.info({ code, reason }, "Deepgram realtime session closed normally");
      this.emitClosedAndCleanup();
      return;
    }

    // Unexpected close — map to an error event.
    log.warn({ code, reason }, "Deepgram realtime session closed unexpectedly");

    const category =
      code === 1008 || code === 4001
        ? ("auth" as const)
        : code === 1013
          ? ("rate-limit" as const)
          : ("provider-error" as const);

    this.emitEvent({
      type: "error",
      category,
      message: `Deepgram WebSocket closed (code=${code}, reason=${reason})`,
    });
    this.emitClosedAndCleanup();
  }

  /**
   * Handle provider-side WebSocket error.
   */
  private handleProviderError(ev: unknown): void {
    if (this.closed) return;

    const message =
      ev instanceof Error
        ? ev.message
        : typeof ev === "object" && ev !== null && "message" in ev
          ? String((ev as { message: unknown }).message)
          : "WebSocket error";

    log.error({ error: ev }, "Deepgram realtime WebSocket error");

    this.emitEvent({
      type: "error",
      category: "provider-error",
      message: `Deepgram WebSocket error: ${message}`,
    });
    this.emitClosedAndCleanup();
  }

  // ── Event emission & cleanup ────────────────────────────────────────

  /**
   * Emit a server event to the session orchestrator. Swallows listener
   * errors to prevent tearing down the adapter.
   */
  private emitEvent(event: SttStreamServerEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      log.warn({ error: err }, "Listener error in Deepgram realtime adapter");
    }
  }

  /**
   * Emit a `closed` event and clean up all resources (timers, WebSocket).
   * Idempotent — safe to call multiple times.
   */
  private emitClosedAndCleanup(): void {
    if (this.closed) return;
    this.closed = true;

    this.clearTimers();
    this.forceClose();

    this.emitEvent({ type: "closed" });
    this.onEvent = null;
  }

  /**
   * Force-close the WebSocket without emitting events. Used during
   * cleanup and timeout paths.
   */
  private forceClose(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    try {
      ws.close();
    } catch {
      // Best effort — already closed sockets may throw.
    }
  }

  /**
   * Clear all active timers.
   */
  private clearTimers(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.closeGraceTimer !== null) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = null;
    }
  }

  /**
   * Reset the inactivity timer. Called on every outbound audio send and
   * inbound provider message to track session liveness.
   */
  private resetInactivityTimer(): void {
    if (this.closed || this.stopping) return;

    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      if (this.closed) return;

      log.warn("Deepgram realtime inactivity timeout");
      this.emitEvent({
        type: "error",
        category: "timeout",
        message: "Deepgram realtime session timed out due to inactivity",
      });
      this.emitClosedAndCleanup();
    }, this.inactivityTimeoutMs);
  }

  // ── URL construction ────────────────────────────────────────────────

  /**
   * Build the Deepgram live transcription WebSocket URL with query params.
   *
   * Authentication is done via the `token` query parameter per Deepgram's
   * WebSocket auth scheme.
   */
  private buildWebSocketUrl(): string {
    const params = new URLSearchParams();
    params.set("model", this.model);
    params.set("token", this.apiKey);

    if (this.language) {
      params.set("language", this.language);
    }
    if (this.smartFormatting) {
      params.set("smart_format", "true");
    }
    if (this.interimResults) {
      params.set("interim_results", "true");
    }
    if (this.utteranceEndMs !== undefined) {
      params.set("utterance_end_ms", String(this.utteranceEndMs));
    }

    // Enable punctuation for cleaner transcript output.
    params.set("punctuate", "true");

    // Request linear16 PCM encoding — clients send raw PCM.
    params.set("encoding", "linear16");
    params.set("sample_rate", "16000");
    params.set("channels", "1");

    return `${this.baseUrl}/v1/listen?${params.toString()}`;
  }
}
