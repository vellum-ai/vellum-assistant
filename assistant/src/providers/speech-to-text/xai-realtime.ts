/**
 * xAI realtime streaming STT adapter.
 *
 * Opens a WebSocket session against xAI's live transcription endpoint
 * (`wss://api.x.ai/v1/stt`), forwards PCM audio frames from the caller,
 * and normalizes xAI's streaming response payloads (`transcript.partial`
 * with `is_final`, `transcript.done`, `error`) into the daemon's
 * {@link SttStreamServerEvent} contract with stable partial/final semantics.
 *
 * Lifecycle:
 * 1. {@link start} opens the WebSocket and resolves once the connection
 *    is established.
 * 2. {@link sendAudio} forwards audio chunks over the open socket with
 *    backpressure-safe bufferedAmount checks.
 * 3. {@link stop} sends the xAI `{"type":"audio.done"}` JSON text frame
 *    and waits for the provider to flush any remaining finals before
 *    closing.
 * 4. The `onEvent` callback receives `partial`, `final`, `error`, and
 *    `closed` events throughout the session lifetime.
 *
 * Error handling:
 * - Provider WebSocket errors and unexpected closes are mapped to
 *   {@link SttStreamServerErrorEvent} with appropriate categories.
 * - A configurable inactivity timeout fires a `closed` event if the
 *   provider stops sending data mid-session.
 * - xAI `error` frames are surfaced without tearing down the session —
 *   per the protocol, the socket stays open after an error frame.
 * - All timers and listeners are cleaned up on close to prevent leaks.
 */

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("xai-realtime");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WS_URL = "wss://api.x.ai/v1/stt";

/**
 * Default timeout (ms) for the WebSocket connection handshake.
 * If the socket does not reach OPEN within this window, start() rejects.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Default inactivity timeout (ms). If no message is received from xAI
 * for this duration after the session is open, the adapter closes with
 * a timeout error. This guards against provider-side hangs.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Maximum WebSocket bufferedAmount (bytes) before sendAudio applies
 * backpressure by dropping frames. This prevents unbounded memory growth
 * if the network or provider cannot keep up with the audio rate.
 */
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MiB

/**
 * Grace period (ms) after sending the `audio.done` frame before we
 * force-close the WebSocket. Gives xAI time to flush any remaining
 * finals / `transcript.done`.
 */
const CLOSE_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface XAIRealtimeOptions {
  /** Audio sample rate in Hz (default: 16000). */
  sampleRate?: number;
  /** Audio encoding. Default: "pcm" (signed 16-bit LE). */
  encoding?: "pcm" | "mulaw" | "alaw";
  /** Enable interim (partial) results. Default: true. */
  interimResults?: boolean;
  /** BCP-47 language code (e.g. "en", "es"). Omitted by default. */
  language?: string;
  /**
   * Enable xAI speaker diarization. Default: false.
   *
   * When `true`, the adapter appends `diarize=true` to the xAI live URL
   * so xAI attaches a `speaker` integer to each word. The adapter
   * aggregates per-segment speakers (mode, with first-word tiebreaker)
   * into a single `speakerLabel` emitted on `partial` / `final` events.
   */
  diarize?: boolean;
  /** Override the xAI WebSocket base URL (useful for proxies or testing). */
  baseUrl?: string;
  /** Connect timeout in milliseconds. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Inactivity timeout in milliseconds. Default: 30_000. */
  inactivityTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// xAI streaming response types (subset relevant to transcript events)
// ---------------------------------------------------------------------------

/**
 * A single word within an xAI streaming transcript frame. When
 * diarization is enabled, each word carries a numeric `speaker` tag
 * identifying the detected speaker turn — stable within a session
 * but opaque (xAI has no real-world identity).
 */
interface XAIStreamWord {
  word?: string;
  speaker?: number;
  start?: number;
  end?: number;
}

/**
 * An xAI streaming response frame.
 *
 * Frame types:
 * - `transcript.created` — session ready signal (informational).
 * - `transcript.partial` — interim or interim-final transcript.
 *    - `is_final: false` — interim transcript, may be revised.
 *    - `is_final: true` — committed transcript for this segment.
 * - `transcript.done` — end-of-channel committed transcript.
 * - `error` — provider-reported error (socket stays open).
 */
interface XAIStreamFrame {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  text?: string;
  /** Per-word info when diarization is enabled. */
  words?: XAIStreamWord[];
  /** Present on `error` frames. */
  message?: string;
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
 * xAI realtime streaming transcriber.
 *
 * Implements the daemon {@link StreamingTranscriber} contract on top of
 * xAI's live transcription WebSocket API (`wss://api.x.ai/v1/stt`).
 */
export class XAIRealtimeTranscriber implements StreamingTranscriber {
  readonly providerId = "xai" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly apiKey: string;
  private readonly sampleRate: number;
  private readonly encoding: "pcm" | "mulaw" | "alaw";
  private readonly interimResults: boolean;
  private readonly language: string | undefined;
  private readonly diarize: boolean;
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

  constructor(apiKey: string, options: XAIRealtimeOptions = {}) {
    this.apiKey = apiKey;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.encoding = options.encoding ?? "pcm";
    this.interimResults = options.interimResults ?? true;
    this.language = options.language;
    this.diarize = options.diarize ?? false;
    this.baseUrl = options.baseUrl ?? DEFAULT_WS_URL;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.inactivityTimeoutMs =
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  }

  // ── StreamingTranscriber interface ──────────────────────────────────

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.ws) {
      throw new Error("XAIRealtimeTranscriber: start() called twice");
    }
    this.onEvent = onEvent;

    const url = this.buildWebSocketUrl();
    log.info({ url }, "Opening xAI realtime session");

    const ws = this.createWebSocket(url);
    this.ws = ws;

    // Attach the session-lifetime handlers (message, close, error)
    // BEFORE awaiting the handshake. Gating on `settled` lets the
    // handlers route to handshake-settle paths while the handshake is
    // in flight, then to the normal session paths afterwards. This
    // closes the narrow window in which a close/error/message could
    // fire between WS open and the await resuming — with separate
    // connect-phase vs session-phase listeners those events would
    // otherwise have no handler attached.
    //
    // The xAI realtime protocol also requires waiting for
    // `transcript.created` before the session is ready to accept
    // audio. Resolving on WS `open` alone would mean early sendAudio()
    // calls could be silently dropped by the provider, losing the
    // first utterance. start() therefore defers resolution until
    // either `transcript.created` arrives or the handshake budget
    // expires.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.forceClose();
        reject(new Error("xAI realtime connect timeout"));
      }, this.connectTimeoutMs);

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        resolve();
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        // Null out this.ws (via forceClose) so the instance can be
        // reused for a retry. Without this, a subsequent start() call
        // would throw "start() called twice" even though no session
        // was ever established.
        this.forceClose();
        reject(err);
      };

      // `open` is informational — we wait for `transcript.created` to
      // consider the handshake complete. The listener detaches itself
      // after firing so the listener map settles at the shape
      // session-lifetime handlers expect.
      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
      };
      ws.addEventListener("open", onOpen);

      ws.addEventListener("message", (ev: { data: unknown }) => {
        if (!settled) {
          if (tryParseHandshakeFrame(ev.data)?.type === "transcript.created") {
            settleResolve();
            return;
          }
          // Any other pre-handshake frame flows through normal routing;
          // per xAI protocol these shouldn't occur before
          // `transcript.created` but we handle them conservatively.
          this.handleProviderMessage(ev.data);
          return;
        }
        this.handleProviderMessage(ev.data);
      });

      ws.addEventListener("close", (ev: { code: number; reason: string }) => {
        if (!settled) {
          // 401 / 403 on connect arrive as WebSocket close codes 4001 /
          // 4003 in most runtimes (or 1008 policy-violation in others).
          // We surface the underlying code in the message — callers
          // that need granular auth handling can branch on the
          // rejection text.
          settleReject(
            new Error(
              `xAI WebSocket closed before handshake (code=${ev.code}, reason=${ev.reason})`,
            ),
          );
          return;
        }
        this.handleProviderClose(ev.code, ev.reason);
      });

      ws.addEventListener("error", (ev: unknown) => {
        if (!settled) {
          const msg =
            ev instanceof Error
              ? ev.message
              : typeof ev === "object" && ev !== null && "message" in ev
                ? String((ev as { message: unknown }).message)
                : "WebSocket error during connect";
          settleReject(new Error(`xAI realtime connect error: ${msg}`));
          return;
        }
        this.handleProviderError(ev);
      });
    });

    this.resetInactivityTimer();

    log.info("xAI realtime session opened");
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    if (this.closed || this.stopping) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;

    // Backpressure check — drop frames if the outbound buffer is too
    // full to prevent unbounded memory growth.
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      log.warn(
        { bufferedAmount: ws.bufferedAmount },
        "xAI realtime backpressure: dropping audio frame",
      );
      return;
    }

    // xAI's live endpoint accepts raw audio bytes on the WebSocket. We
    // forward the caller's buffer as-is — no transcoding.
    ws.send(new Uint8Array(audio));
  }

  stop(): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;

    // Cancel the inactivity timer immediately. If it were left running,
    // it could fire inside the CLOSE_GRACE window (waiting on xAI to
    // flush finals after `audio.done`) and spuriously emit a
    // `{type:"error", category:"timeout"}` event on an intentional stop.
    // The inactivity callback also double-checks `this.stopping` as a
    // safety net against any future code path that re-arms the timer
    // after stop() runs.
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    log.info("Stopping xAI realtime session");

    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      this.emitClosedAndCleanup();
      return;
    }

    // Send xAI's end-of-audio signal as a JSON text frame (NOT binary).
    // The provider may flush remaining finals / emit `transcript.done`
    // before closing.
    try {
      ws.send(JSON.stringify({ type: "audio.done" }));
    } catch {
      // If the send fails, force-close immediately.
      this.emitClosedAndCleanup();
      return;
    }

    // Start a grace timer — if the provider doesn't close within the
    // grace window, we force-close to prevent session leaks.
    this.closeGraceTimer = setTimeout(() => {
      log.warn("xAI realtime close grace timeout — forcing close");
      this.emitClosedAndCleanup();
    }, CLOSE_GRACE_MS);
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────

  /**
   * Create a WebSocket instance. Factored out for test mockability.
   *
   * Passes the xAI API key via the `Authorization: Bearer <key>` header.
   * Bun's WebSocket constructor supports a second `options` argument
   * with custom headers, unlike the browser WebSocket API.
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
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }

  // ── Provider message handling ───────────────────────────────────────

  /**
   * Parse and normalize an xAI streaming response into daemon events.
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

    let frame: XAIStreamFrame;
    try {
      frame = JSON.parse(raw) as XAIStreamFrame;
    } catch {
      log.debug("Dropped non-JSON xAI frame");
      return;
    }

    if (!frame || typeof frame !== "object") return;

    switch (frame.type) {
      case "transcript.created":
        // Informational ready signal — no event emitted.
        return;

      case "transcript.partial":
        this.handleTranscriptFrame(frame);
        return;

      case "transcript.done":
        this.handleTranscriptDoneFrame(frame);
        return;

      case "error":
        this.handleProviderErrorFrame(frame);
        return;

      default:
        // Unknown frame types are informational — ignored.
        return;
    }
  }

  /**
   * Normalize an xAI `transcript.partial` frame into partial or final
   * events.
   *
   * xAI semantics:
   * - `is_final: false` — interim transcript, may be revised.
   * - `is_final: true` — committed transcript for this segment.
   *
   * When {@link XAIRealtimeOptions.diarize} is enabled, the frame also
   * carries per-word speaker tags in `words[].speaker`. We derive a
   * single per-chunk `speakerLabel` by picking the dominant speaker
   * across the words — see {@link extractSpeakerLabel}.
   */
  private handleTranscriptFrame(frame: XAIStreamFrame): void {
    const text = typeof frame.text === "string" ? frame.text.trim() : "";
    const speakerLabel = this.diarize
      ? extractSpeakerLabel(frame.words)
      : undefined;

    if (frame.is_final) {
      this.emitEvent({
        type: "final",
        text,
        ...(speakerLabel !== undefined ? { speakerLabel } : {}),
      });
    } else if (this.interimResults) {
      this.emitEvent({
        type: "partial",
        text,
        ...(speakerLabel !== undefined ? { speakerLabel } : {}),
      });
    }
  }

  /**
   * Normalize an xAI `transcript.done` frame into a final event. xAI
   * emits one `transcript.done` per channel when multichannel is
   * enabled; for single-channel sessions there is typically one per
   * utterance boundary.
   */
  private handleTranscriptDoneFrame(frame: XAIStreamFrame): void {
    const text = typeof frame.text === "string" ? frame.text.trim() : "";
    const speakerLabel = this.diarize
      ? extractSpeakerLabel(frame.words)
      : undefined;

    this.emitEvent({
      type: "final",
      text,
      ...(speakerLabel !== undefined ? { speakerLabel } : {}),
    });
  }

  /**
   * Handle an xAI `error` frame. Per the xAI protocol the socket stays
   * open after an error frame is emitted, so we surface the error to
   * the caller but do NOT tear down the session.
   */
  private handleProviderErrorFrame(frame: XAIStreamFrame): void {
    const message =
      typeof frame.message === "string" ? frame.message : "xAI error frame";
    log.warn({ message }, "xAI realtime provider error frame");
    this.emitEvent({
      type: "error",
      category: "provider-error",
      message,
    });
  }

  /**
   * Handle provider-side WebSocket close.
   */
  private handleProviderClose(code: number, reason: string): void {
    if (this.closed) return;

    // Normal close (1000) or going-away (1001) after stop() is expected.
    if (this.stopping && (code === 1000 || code === 1001)) {
      log.info({ code, reason }, "xAI realtime session closed normally");
      this.emitClosedAndCleanup();
      return;
    }

    // Unexpected close — map to an error event.
    log.warn({ code, reason }, "xAI realtime session closed unexpectedly");

    const category =
      code === 1008 || code === 4001 || code === 4003
        ? ("auth" as const)
        : code === 1013
          ? ("rate-limit" as const)
          : ("provider-error" as const);

    this.emitEvent({
      type: "error",
      category,
      message: `xAI WebSocket closed (code=${code}, reason=${reason})`,
    });
    this.emitClosedAndCleanup();
  }

  /**
   * Handle provider-side WebSocket error (transport-level failure).
   */
  private handleProviderError(ev: unknown): void {
    if (this.closed) return;

    const message =
      ev instanceof Error
        ? ev.message
        : typeof ev === "object" && ev !== null && "message" in ev
          ? String((ev as { message: unknown }).message)
          : "WebSocket error";

    log.error({ error: ev }, "xAI realtime WebSocket error");

    this.emitEvent({
      type: "error",
      category: "provider-error",
      message: `xAI WebSocket error: ${message}`,
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
      log.warn({ error: err }, "Listener error in xAI realtime adapter");
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
   * Reset the inactivity timer. Called on inbound provider messages to
   * detect provider-side hangs. Not reset on outbound audio sends —
   * continuous audio from the caller must not mask a silent provider.
   */
  private resetInactivityTimer(): void {
    if (this.closed || this.stopping) return;

    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      // Belt-and-suspenders guard: stop() clears this timer before the
      // CLOSE_GRACE window starts, but if a future refactor re-arms it
      // or forgets to clear it, this check prevents the inactivity
      // callback from emitting a timeout error during an intentional stop.
      if (this.closed || this.stopping) return;

      log.warn("xAI realtime inactivity timeout");
      this.emitEvent({
        type: "error",
        category: "timeout",
        message: "xAI realtime session timed out due to inactivity",
      });
      this.emitClosedAndCleanup();
    }, this.inactivityTimeoutMs);
  }

  // ── URL construction ────────────────────────────────────────────────

  /**
   * Build the xAI live transcription WebSocket URL with query params.
   *
   * Audio format and feature flags are passed as query parameters.
   * Authentication is handled separately via the `Authorization: Bearer`
   * header in {@link createWebSocket}.
   */
  private buildWebSocketUrl(): string {
    const params = new URLSearchParams();
    params.set("sample_rate", String(this.sampleRate));
    params.set("encoding", this.encoding);
    if (this.interimResults) {
      params.set("interim_results", "true");
    }
    if (this.language) {
      params.set("language", this.language);
    }
    if (this.diarize) {
      params.set("diarize", "true");
    }
    return `${this.baseUrl}?${params.toString()}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort parse of an inbound frame during the handshake window.
 * Returns `undefined` on parse failure — callers fall back to normal
 * message routing. Kept separate from {@link XAIRealtimeTranscriber}
 * so the handshake gate doesn't drag in the full event-emission path.
 */
function tryParseHandshakeFrame(data: unknown): XAIStreamFrame | undefined {
  let raw: string;
  if (typeof data === "string") {
    raw = data;
  } else if (data instanceof ArrayBuffer) {
    raw = new TextDecoder().decode(data);
  } else {
    return undefined;
  }
  try {
    const frame = JSON.parse(raw) as XAIStreamFrame;
    if (frame && typeof frame === "object") return frame;
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Derive a single `speakerLabel` for a diarized chunk.
 *
 * xAI attaches per-word speaker tags in the `words` array when
 * `diarize=true`. We pick the most-frequent per-word speaker across
 * the chunk; on ties we fall back to the first word's speaker so
 * short segments where the endpointer didn't cleanly break between
 * turns still attribute deterministically.
 *
 * Returns `undefined` when no speaker information is available — the
 * resolver treats unlabeled chunks the same as a non-diarizing
 * provider.
 *
 * The returned label is `String(speaker)` (e.g. `"0"`) to match the
 * Deepgram adapter's output format, keeping consumer code
 * provider-agnostic.
 */
function extractSpeakerLabel(
  words: XAIStreamWord[] | undefined,
): string | undefined {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const counts = new Map<number, number>();
  let firstSpeaker: number | undefined;
  for (const word of words) {
    if (typeof word.speaker !== "number") continue;
    if (firstSpeaker === undefined) firstSpeaker = word.speaker;
    counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  }
  if (counts.size === 0 || firstSpeaker === undefined) return undefined;
  // Pick the most common speaker; on ties, prefer the first-word
  // speaker.
  let bestSpeaker = firstSpeaker;
  let bestCount = counts.get(firstSpeaker) ?? 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      bestSpeaker = speaker;
      bestCount = count;
    }
  }
  return String(bestSpeaker);
}
