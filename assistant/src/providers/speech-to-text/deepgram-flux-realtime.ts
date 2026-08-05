/**
 * Deepgram Flux realtime streaming STT adapter (`wss://api.deepgram.com/v2/listen`).
 *
 * Flux is Deepgram's conversational speech API: the model itself decides where
 * a turn ends, so this adapter carries no endpointing heuristics of its own.
 * It owns the socket lifecycle (connect, keepalive, teardown) and delegates
 * every inbound transcript frame to {@link parseFluxFrame}, the pure protocol
 * module, which maps Flux's wire shapes onto the daemon's
 * {@link SttStreamServerEvent} contract.
 *
 * Lifecycle:
 * 1. {@link start} opens the WebSocket and resolves once it is established.
 * 2. {@link sendAudio} forwards raw audio with a backpressure guard.
 * 3. {@link stop} sends `CloseStream` and waits for Flux to flush the turn
 *    in progress before closing.
 * 4. The `onEvent` callback receives `partial`, `final`, the four
 *    turn-detection events, `error`, and finally `closed`.
 *
 * There is deliberately **no `finalizeUtterance`**. Flux owns turn
 * boundaries, so there is nothing for a caller to flush mid-stream; leaving
 * the optional method off makes callers feature-detect and fall back to
 * {@link stop}, which is the correct semantics for this provider.
 *
 * Error handling mirrors `deepgram-realtime.ts`: socket closes and errors map
 * onto {@link SttErrorCategory} values (`auth`, `rate-limit`, `timeout`,
 * `provider-error`), in-session failures surface as `error` events, and
 * teardown always emits `closed`.
 */

import { getConfig } from "../../config/loader.js";
import type {
  StreamingTranscriber,
  SttErrorCategory,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { SttError } from "../../stt/types.js";
import { parseJsonSafe } from "../../util/json.js";
import { getLogger } from "../../util/logger.js";
import { isPlainObject } from "../../util/object.js";
import type { FluxEncoding } from "./deepgram-flux-frames.js";
import {
  buildFluxQueryParams,
  parseFluxFrame,
} from "./deepgram-flux-frames.js";

const log = getLogger("deepgram-flux-realtime");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WS_BASE_URL = "wss://api.deepgram.com";

/** Flux lives on the v2 listen route; the v1 route speaks a different protocol. */
const FLUX_PATH = "/v2/listen";

/** Timeout (ms) for the WebSocket handshake before {@link start} rejects. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Inactivity timeout (ms). If audio has been sent but Flux says nothing back
 * for this long, the adapter closes with a `timeout` error. A stream with no
 * audio awaiting a response (mic gated while the assistant speaks) is
 * legitimately silent and never times out.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Interval (ms) between `KeepAlive` control frames. Deepgram closes a socket
 * that carries no audio for ~10s, and raw silence does not reset that timer —
 * only the explicit control message does.
 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 5_000;

/** Outbound buffer ceiling (bytes) before {@link sendAudio} drops frames. */
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MiB

/** Grace (ms) after `CloseStream` before the socket is force-closed. */
const CLOSE_GRACE_MS = 5_000;

/** Default raw-audio encoding: clients send linear16 PCM. */
const DEFAULT_ENCODING: FluxEncoding = "linear16";

/** Default sample rate (Hz) when the client negotiates none. */
const DEFAULT_SAMPLE_RATE = 16_000;

/** Bytes per sample of mono linear16 PCM. */
const LINEAR16_BYTES_PER_SAMPLE = 2;

/**
 * Chunk duration Deepgram recommends for Flux. Logged alongside the observed
 * duration so a runbook can compare the two without instrumenting capture.
 */
const RECOMMENDED_CHUNK_MS = 80;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepgramFluxRealtimeOptions {
  /** Flux model. Defaults to `liveVoice.flux.model`. */
  model?: string;
  /** End-of-turn confidence. Defaults to `liveVoice.flux.eotThreshold`. */
  eotThreshold?: number;
  /**
   * Eager end-of-turn confidence. Defaults to
   * `liveVoice.flux.eagerEotThreshold`, which is unset by default — and
   * leaving it unset is what stops Deepgram emitting `EagerEndOfTurn` /
   * `TurnResumed` at all.
   */
  eagerEotThreshold?: number;
  /** Force-end silence (ms). Defaults to `liveVoice.flux.eotTimeoutMs`. */
  eotTimeoutMs?: number;
  /** Audio sample rate in Hz (default: 16000). */
  sampleRate?: number;
  /** Raw audio encoding (default: linear16). */
  encoding?: FluxEncoding;
  /** Override the WebSocket base URL (proxies, on-prem). */
  baseUrl?: string;
  /** Connect timeout in milliseconds. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Inactivity timeout in milliseconds. Default: 30_000. */
  inactivityTimeoutMs?: number;
  /**
   * Interval (ms) between `KeepAlive` control frames. Default: 5_000. Set to
   * 0 to disable (tests only — Deepgram closes silent sockets after ~10s).
   */
  keepaliveIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural WebSocket interface so tests can substitute a mock
 * without depending on Bun's global WebSocket type at the type level.
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
 * Deepgram Flux streaming transcriber.
 *
 * Implements the daemon {@link StreamingTranscriber} contract on top of
 * Deepgram's conversational `/v2/listen` WebSocket API.
 */
export class DeepgramFluxRealtimeTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram-flux" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly eotThreshold: number | undefined;
  private readonly eagerEotThreshold: number | undefined;
  private readonly eotTimeoutMs: number | undefined;
  private readonly sampleRate: number;
  private readonly encoding: FluxEncoding;
  private readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;

  /** The live WebSocket connection, set during start(). */
  private ws: WsLike | null = null;

  /** Callback for emitting events to the session orchestrator. */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  /** Whether the session has been fully closed. */
  private closed = false;

  /** Whether stop() has been called. */
  private stopping = false;

  /** Whether the per-session chunk-cadence line has already been logged. */
  private chunkCadenceLogged = false;

  /** Inactivity timer handle. */
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * When the first audio frame went out after the last inbound provider
   * message; null while nothing is owed a response. The inactivity watchdog
   * only rules "hung" while this is set — Flux says nothing during silence,
   * so inbound quiet alone is not evidence of a hang.
   */
  private awaitingResponseSinceMs: number | null = null;

  /** Close grace timer handle. */
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Periodic `KeepAlive` timer. */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(apiKey: string, options: DeepgramFluxRealtimeOptions = {}) {
    // Tuning comes from `liveVoice.flux` so the spike has one place to turn
    // the dials; explicit options win for callers that already know better.
    const flux = getConfig().liveVoice.flux;

    this.apiKey = apiKey;
    this.model = options.model ?? flux.model;
    this.eotThreshold = options.eotThreshold ?? flux.eotThreshold;
    this.eagerEotThreshold =
      options.eagerEotThreshold ?? flux.eagerEotThreshold;
    this.eotTimeoutMs = options.eotTimeoutMs ?? flux.eotTimeoutMs;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.encoding = options.encoding ?? DEFAULT_ENCODING;
    this.baseUrl = (options.baseUrl ?? DEFAULT_WS_BASE_URL).replace(/\/+$/, "");
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.inactivityTimeoutMs =
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.keepaliveIntervalMs =
      options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  }

  // ── StreamingTranscriber interface ──────────────────────────────────

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.ws) {
      throw new Error("DeepgramFluxRealtimeTranscriber: start() called twice");
    }
    this.onEvent = onEvent;

    const url = this.buildWebSocketUrl();
    log.info({ url }, "Opening Deepgram Flux session");

    const ws = this.createWebSocket(url);
    this.ws = ws;

    // Wait for the WebSocket to open or fail. Failures reject as SttError so
    // the caller gets the same normalized category an in-session failure
    // would carry — a bad key is an `auth` problem whether it lands during
    // the handshake or after it.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const connectTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.forceClose();
        reject(
          new SttError("timeout", "Deepgram Flux realtime connect timeout"),
        );
      }, this.connectTimeoutMs);

      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        resolve();
      };

      const onError = (ev: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        reject(
          new SttError(
            "provider-error",
            `Deepgram Flux realtime connect error: ${describeSocketEvent(ev)}`,
          ),
        );
      };

      const onClose = (ev: { code: number; reason: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        reject(
          new SttError(
            closeCodeCategory(ev.code),
            `Deepgram Flux WebSocket closed before open (code=${ev.code}, reason=${ev.reason})`,
          ),
        );
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });

    // Socket is open — attach the handlers for the active session lifetime.
    this.attachSessionHandlers(ws);
    this.resetInactivityTimer();
    this.startKeepaliveTimer();

    log.info({ model: this.model }, "Deepgram Flux session opened");
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    if (this.closed || this.stopping) {
      return;
    }

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      return;
    }

    // Backpressure check — drop frames rather than grow the outbound buffer
    // without bound when the network cannot keep up with the audio rate.
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      log.warn(
        { bufferedAmount: ws.bufferedAmount },
        "Deepgram Flux backpressure: dropping audio frame",
      );
      return;
    }

    ws.send(new Uint8Array(audio));
    this.awaitingResponseSinceMs ??= Date.now();
    this.logChunkCadenceOnce(audio.byteLength);
  }

  stop(): void {
    if (this.closed || this.stopping) {
      return;
    }
    this.stopping = true;

    log.info("Stopping Deepgram Flux session");

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      this.emitClosedAndCleanup();
      return;
    }

    // `CloseStream` tells Flux to finish the turn in progress and answer
    // before it terminates the socket.
    try {
      ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      this.emitClosedAndCleanup();
      return;
    }

    this.closeGraceTimer = setTimeout(() => {
      log.warn("Deepgram Flux close grace timeout — forcing close");
      this.emitClosedAndCleanup();
    }, CLOSE_GRACE_MS);
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────

  /**
   * Create a WebSocket instance. Factored out for test mockability.
   *
   * The key travels in the `Authorization: Token` header — Flux needs no
   * query auth, so no URL ever carries the credential and nothing here needs
   * redacting before it reaches a log.
   */
  private createWebSocket(url: string): WsLike {
    const WebSocketCtor = (
      globalThis as unknown as {
        WebSocket: new (
          url: string,
          options?: { headers?: Record<string, string> },
        ) => WsLike;
      }
    ).WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new Error("global WebSocket is not available in this runtime");
    }
    return new WebSocketCtor(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
  }

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
   * Normalize one inbound Flux frame into daemon events.
   *
   * Everything except the `Configure*` acknowledgements goes straight to
   * {@link parseFluxFrame} — the wire shapes live there, not here.
   */
  private handleProviderMessage(data: unknown): void {
    if (this.closed) {
      return;
    }

    this.resetInactivityTimer();

    const raw =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : null;
    if (raw === null) {
      // Unexpected binary format — ignore.
      return;
    }

    const frame = parseJsonSafe(raw);
    if (!isPlainObject(frame)) {
      log.debug("Dropped a Deepgram Flux payload that is not a frame object");
      return;
    }

    if (this.handleConfigureAck(frame)) {
      return;
    }

    for (const event of parseFluxFrame(frame)) {
      this.emitEvent(event);
    }
  }

  /**
   * Absorb the acknowledgements for a mid-stream `Configure`, returning true
   * when the frame was one. This adapter is the layer that knows whether a
   * `Configure` is in flight, so the two frames are handled here rather than
   * in the pure parser.
   *
   * Neither becomes a stream event. `ConfigureSuccess` echoes the
   * configuration actually in force, which is the cheapest confirmation that
   * the thresholds we clamped are the ones Deepgram is using — worth a debug
   * line, nothing more. `ConfigureFailure` leaves the stream running on the
   * previous settings, so raising an `error` event would tear down a session
   * that is still perfectly usable.
   */
  private handleConfigureAck(frame: Record<string, unknown>): boolean {
    if (frame.type === "ConfigureSuccess") {
      log.debug(
        {
          thresholds: frame.thresholds,
          keyterms: frame.keyterms,
          languageHints: frame.language_hints,
        },
        "Deepgram Flux accepted a Configure — thresholds now in force",
      );
      return true;
    }

    if (frame.type === "ConfigureFailure") {
      log.warn(
        {
          code: frame.code,
          description: frame.description,
          sequenceId: frame.sequence_id,
        },
        "Deepgram Flux rejected a Configure — the session continues at its previous settings",
      );
      return true;
    }

    return false;
  }

  /** Handle provider-side WebSocket close. */
  private handleProviderClose(code: number, reason: string): void {
    if (this.closed) {
      return;
    }

    // Normal close (1000) or going-away (1001) after stop() is expected.
    if (this.stopping && (code === 1000 || code === 1001)) {
      log.info({ code, reason }, "Deepgram Flux session closed normally");
      this.emitClosedAndCleanup();
      return;
    }

    log.warn({ code, reason }, "Deepgram Flux session closed unexpectedly");

    this.emitEvent({
      type: "error",
      category: closeCodeCategory(code),
      message: `Deepgram Flux WebSocket closed (code=${code}, reason=${reason})`,
    });
    this.emitClosedAndCleanup();
  }

  /** Handle provider-side WebSocket error. */
  private handleProviderError(ev: unknown): void {
    if (this.closed) {
      return;
    }

    const message = describeSocketEvent(ev);
    log.error({ error: message }, "Deepgram Flux WebSocket error");

    this.emitEvent({
      type: "error",
      category: "provider-error",
      message: `Deepgram Flux WebSocket error: ${message}`,
    });
    this.emitClosedAndCleanup();
  }

  // ── Event emission & cleanup ────────────────────────────────────────

  /**
   * Emit a server event to the session orchestrator. Swallows listener errors
   * so a bad consumer cannot tear down the adapter.
   */
  private emitEvent(event: SttStreamServerEvent): void {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event);
    } catch (err) {
      log.warn({ error: err }, "Listener error in Deepgram Flux adapter");
    }
  }

  /**
   * Log the observed audio chunk duration once per session, next to the
   * cadence Deepgram recommends for Flux. Capture cadence is a client
   * concern; this only makes it measurable from the daemon side.
   */
  private logChunkCadenceOnce(byteLength: number): void {
    if (this.chunkCadenceLogged) {
      return;
    }
    this.chunkCadenceLogged = true;

    // Only linear16 has a byte length that maps to a duration without
    // decoding the payload.
    const observedChunkMs =
      this.encoding === "linear16" && this.sampleRate > 0
        ? Math.round(
            (byteLength / LINEAR16_BYTES_PER_SAMPLE / this.sampleRate) * 1_000,
          )
        : undefined;

    log.debug(
      {
        byteLength,
        sampleRate: this.sampleRate,
        encoding: this.encoding,
        observedChunkMs,
        recommendedChunkMs: RECOMMENDED_CHUNK_MS,
      },
      "Deepgram Flux audio chunk cadence",
    );
  }

  /**
   * Emit `closed` and release every resource. Idempotent — safe to call from
   * any teardown path.
   */
  private emitClosedAndCleanup(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.clearTimers();
    this.forceClose();

    this.emitEvent({ type: "closed" });
    this.onEvent = null;
  }

  /** Force-close the WebSocket without emitting events. */
  private forceClose(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      return;
    }

    try {
      ws.close();
    } catch {
      // Best effort — already closed sockets may throw.
    }
  }

  private clearTimers(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.closeGraceTimer !== null) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = null;
    }
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Start the periodic keepalive. A `KeepAlive` control frame is the only
   * thing that resets Deepgram's server-side inactivity timer while the
   * stream carries silence — raw silent PCM does not count.
   */
  private startKeepaliveTimer(): void {
    if (this.closed || this.stopping || this.keepaliveIntervalMs <= 0) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || this.stopping) {
        return;
      }
      const ws = this.ws;
      if (!ws || ws.readyState !== WS_OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch (err) {
        log.warn({ err }, "Deepgram Flux KeepAlive send failed");
      }
    }, this.keepaliveIntervalMs);
  }

  /**
   * Reset the inactivity watchdog on inbound provider messages. Not reset on
   * outbound audio — continuous audio from the caller must not mask a silent
   * provider.
   */
  private resetInactivityTimer(): void {
    this.awaitingResponseSinceMs = null;
    this.armInactivityTimer(this.inactivityTimeoutMs);
  }

  /**
   * (Re)arm the inactivity watchdog. On fire it only rules "hung" when audio
   * has been awaiting a response for a full timeout window; otherwise the
   * stream is merely idle and the timer re-arms for the remainder.
   */
  private armInactivityTimer(delayMs: number): void {
    if (this.closed || this.stopping) {
      return;
    }

    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      if (this.closed) {
        return;
      }

      const since = this.awaitingResponseSinceMs;
      if (since === null) {
        this.armInactivityTimer(this.inactivityTimeoutMs);
        return;
      }
      const waitedMs = Date.now() - since;
      if (waitedMs < this.inactivityTimeoutMs) {
        this.armInactivityTimer(this.inactivityTimeoutMs - waitedMs);
        return;
      }

      log.warn("Deepgram Flux inactivity timeout");
      this.emitEvent({
        type: "error",
        category: "timeout",
        message: "Deepgram Flux session timed out due to inactivity",
      });
      this.emitClosedAndCleanup();
    }, delayMs);
  }

  // ── URL construction ────────────────────────────────────────────────

  /**
   * Build the Flux WebSocket URL. Query construction (including threshold
   * clamping and omitting `eager_eot_threshold` when unset) belongs to
   * {@link buildFluxQueryParams}.
   */
  private buildWebSocketUrl(): string {
    const query = buildFluxQueryParams({
      model: this.model,
      encoding: this.encoding,
      sampleRate: this.sampleRate,
      eotThreshold: this.eotThreshold,
      eagerEotThreshold: this.eagerEotThreshold,
      eotTimeoutMs: this.eotTimeoutMs,
    });
    return `${this.baseUrl}${FLUX_PATH}?${query}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a WebSocket close code onto a normalized STT error category, matching
 * how `DeepgramRealtimeTranscriber` classifies the same codes: 1008 (policy
 * violation) and 4001 are how Deepgram rejects credentials, and 1013 (try
 * again later) is how it sheds load.
 */
function closeCodeCategory(code: number): SttErrorCategory {
  if (code === 1008 || code === 4001) {
    return "auth";
  }
  if (code === 1013) {
    return "rate-limit";
  }
  return "provider-error";
}

/** Best-effort human-readable text for a WebSocket error event. */
function describeSocketEvent(ev: unknown): string {
  if (ev instanceof Error) {
    return ev.message;
  }
  if (typeof ev === "object" && ev !== null && "message" in ev) {
    return String((ev as { message: unknown }).message);
  }
  return "WebSocket error";
}
