/**
 * LiveVoiceChannelClient — WebSocket transport + frame dispatch for the
 * live voice channel.
 *
 * TypeScript port of
 * `clients/shared/Network/LiveVoiceChannelClient.swift`.
 *
 * Owns a single `WebSocket` to `/v1/live-voice`, authenticated via the
 * gateway edge JWT (acquired/refreshed through `ensureGatewayToken()`
 * from `apps/web/src/lib/auth/gateway-session.ts`). Sends the JSON `start`
 * frame after `open`, arms a 10 s ready-handshake timeout, normalizes
 * incoming text/binary frames into a `LiveVoiceChannelEvent`
 * discriminated union, and surfaces failures via
 * `LiveVoiceChannelFailure`.
 *
 * Create a new instance for each session — `end()` and `close()` both
 * transition state to `closed` and are idempotent.
 */

import {
  base64ToPcm16,
  encodeClientControlFrame,
  encodeClientStartFrame,
  LIVE_VOICE_AUDIO_PCM16K_MONO,
  parseServerBinaryFrame,
  parseServerTextFrame,
  type LiveVoiceAudioConfig,
  type LiveVoiceMetricsServerFrame,
  type LiveVoiceServerFrame,
} from "@/domains/voice/live-voice/protocol";
import { ensureGatewayToken, getLocalTokenUrl } from "@/lib/auth/gateway-session";
import { getLocalGatewayUrl, isLocalMode } from "@/lib/local-mode";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Internal lifecycle state. Mirrors `LiveVoiceChannelSessionState`. */
export type LiveVoiceChannelSessionState =
  | "idle"
  | "connecting"
  | "active"
  | "ending"
  | "closed";

/** Normalized server events. Mirrors the Swift `LiveVoiceChannelEvent` enum. */
export type LiveVoiceChannelEvent =
  | { type: "ready"; sessionId: string; conversationId: string }
  | { type: "sttPartial"; text: string; seq: number }
  | { type: "sttFinal"; text: string; seq: number }
  | { type: "thinking"; turnId: string }
  | { type: "assistantTextDelta"; text: string; seq: number }
  | {
      type: "ttsAudio";
      pcm: Uint8Array;
      mimeType: string;
      sampleRate: number;
      seq: number;
    }
  | { type: "ttsDone"; turnId: string }
  | { type: "metrics"; metrics: LiveVoiceChannelMetrics }
  | { type: "archived"; conversationId: string; sessionId: string };

/** Turn-level latency metrics. Mirrors the Swift `LiveVoiceChannelMetrics`. */
export interface LiveVoiceChannelMetrics {
  readonly turnId: string;
  readonly sttMs: number | null;
  readonly llmFirstDeltaMs: number | null;
  readonly ttsFirstAudioMs: number | null;
  readonly totalMs: number | null;
}

/** Failure modes surfaced via `onFailure`. Mirrors `LiveVoiceChannelFailure`. */
export type LiveVoiceChannelFailure =
  | { type: "connectionFailed"; message: string }
  | { type: "connectionRejected"; statusCode: number | null }
  | { type: "protocolError"; code: string; message: string }
  | { type: "busy"; activeSessionId: string }
  | { type: "timeout"; message: string }
  | { type: "abnormalClosure"; code: number; reason: string | null };

export interface LiveVoiceChannelStartOptions {
  conversationId?: string;
  audioFormat?: LiveVoiceAudioConfig;
  onEvent: (event: LiveVoiceChannelEvent) => void;
  onFailure: (failure: LiveVoiceChannelFailure) => void;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket surface (for DI in tests)
// ---------------------------------------------------------------------------

/**
 * Subset of the DOM `WebSocket` interface the client depends on. Tests
 * supply a mock via `globalThis.WebSocket = MockWebSocket`.
 */
export interface LiveVoiceWebSocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((this: LiveVoiceWebSocketLike, ev: Event) => unknown) | null;
  onclose:
    | ((this: LiveVoiceWebSocketLike, ev: CloseEvent) => unknown)
    | null;
  onerror: ((this: LiveVoiceWebSocketLike, ev: Event) => unknown) | null;
  onmessage:
    | ((this: LiveVoiceWebSocketLike, ev: MessageEvent) => unknown)
    | null;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
}

type WebSocketCtor = new (url: string) => LiveVoiceWebSocketLike;

const CONNECTION_TIMEOUT_MS = 10_000;
const END_GRACE_MS = 1_000;
const NORMAL_CLOSURE = 1000;

/**
 * User-facing message when the gateway edge JWT can't be acquired or
 * refreshed (e.g. the session lapsed and re-acquisition failed). Shown
 * under the overlay's "Connection failed" heading — actionable, unlike
 * the previous raw internal "missing gateway token".
 */
const GATEWAY_AUTH_FAILED_MESSAGE =
  "Couldn't authenticate the voice session — refresh the page and try again.";

// ---------------------------------------------------------------------------
// LiveVoiceChannelClient
// ---------------------------------------------------------------------------

export class LiveVoiceChannelClient {
  private state: LiveVoiceChannelSessionState = "idle";
  private ws: LiveVoiceWebSocketLike | null = null;
  private connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private endGraceTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /**
   * Resolver for the Promise returned by `end()` while the 1 s grace
   * timer is pending. Tracked separately from the timer so that
   * `teardown()` (called by `close()`, `handleError()`, or a server
   * failure) can resolve any awaited `end()` before clearing the
   * timer — otherwise the caller hangs indefinitely.
   */
  private pendingEndResolver: (() => void) | null = null;
  private onEvent: ((event: LiveVoiceChannelEvent) => void) | null = null;
  private onFailure:
    | ((failure: LiveVoiceChannelFailure) => void)
    | null = null;

  /** Current state. Exposed for tests. */
  getState(): LiveVoiceChannelSessionState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(options: LiveVoiceChannelStartOptions): Promise<void> {
    if (this.state !== "idle") return;

    const audio = options.audioFormat ?? LIVE_VOICE_AUDIO_PCM16K_MONO;
    this.onEvent = options.onEvent;
    this.onFailure = options.onFailure;
    this.state = "connecting";

    // Acquire (or refresh) the gateway edge JWT on demand. Mirrors the
    // rest of the app's auth path (`ensureGatewayToken` in auth-store /
    // `primeLocalGatewayConnection`): a valid cached token is returned
    // as-is, otherwise a fresh one is fetched from the gateway. Voice
    // previously only *read* the cached token via `getGatewayToken()`
    // and hard-failed with "missing gateway token" when it was expired
    // or not yet primed — the one surface that didn't self-heal.
    let token: string;
    try {
      token = await ensureGatewayToken(getLocalTokenUrl());
    } catch {
      this.fail({
        type: "connectionFailed",
        message: GATEWAY_AUTH_FAILED_MESSAGE,
      });
      return;
    }
    // `end()`/`close()` may have torn the session down while awaiting
    // token acquisition — don't open a socket for a dead session.
    if (this.state !== "connecting") return;
    if (!token) {
      this.fail({
        type: "connectionFailed",
        message: GATEWAY_AUTH_FAILED_MESSAGE,
      });
      return;
    }

    const url = buildLiveVoiceWebSocketUrl(token);
    const Ctor = resolveWebSocketCtor();
    if (!Ctor) {
      this.fail({
        type: "connectionFailed",
        message: "WebSocket is not available in this environment",
      });
      return;
    }

    let ws: LiveVoiceWebSocketLike;
    try {
      ws = new Ctor(url);
    } catch (err) {
      this.fail({
        type: "connectionFailed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => this.handleOpen(options.conversationId, audio);
    ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
    ws.onerror = () => this.handleError();
    ws.onclose = (event: CloseEvent) => this.handleClose(event);

    this.connectionTimeoutId = setTimeout(() => {
      this.connectionTimeoutId = null;
      if (this.state === "connecting") {
        this.fail({
          type: "timeout",
          message: "ready frame not received",
        });
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  sendAudio(data: ArrayBuffer | Int16Array): void {
    if (this.state !== "active" || !this.ws) return;
    const payload: ArrayBuffer | ArrayBufferView =
      data instanceof Int16Array
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : data;
    try {
      this.ws.send(payload);
    } catch (err) {
      this.fail({
        type: "connectionFailed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  releasePushToTalk(): void {
    this.sendControlFrame("ptt_release", ["active"]);
  }

  interrupt(): void {
    this.sendControlFrame("interrupt", ["active"]);
  }

  async end(): Promise<void> {
    if (this.state !== "connecting" && this.state !== "active") return;
    this.state = "ending";
    this.sendControlFrame("end", ["ending"]);

    await new Promise<void>((resolve) => {
      // Track the resolver alongside the timer so `teardown()` can
      // resolve this Promise even if it cancels the grace timer first
      // (e.g. a concurrent `close()` or a WS error during the grace
      // window). Without this, `await client.end()` would hang.
      this.pendingEndResolver = resolve;
      this.endGraceTimeoutId = setTimeout(() => {
        this.endGraceTimeoutId = null;
        this.pendingEndResolver = null;
        resolve();
      }, END_GRACE_MS);
    });

    this.teardown(null, NORMAL_CLOSURE);
  }

  close(): void {
    if (this.state === "closed") return;
    this.teardown(null, NORMAL_CLOSURE);
  }

  // -------------------------------------------------------------------------
  // WebSocket event handlers
  // -------------------------------------------------------------------------

  private handleOpen(
    conversationId: string | undefined,
    audioFormat: LiveVoiceAudioConfig,
  ): void {
    if (!this.ws || this.state !== "connecting") return;
    try {
      this.ws.send(encodeClientStartFrame({ conversationId, audio: audioFormat }));
    } catch (err) {
      this.fail({
        type: "connectionFailed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (this.state === "closed") return;
    const data: unknown = event.data;

    if (typeof data === "string") {
      const result = parseServerTextFrame(data);
      if (!result.ok) {
        this.fail({
          type: "protocolError",
          code: result.error.code,
          message: result.error.message,
        });
        return;
      }
      this.dispatchServerFrame(result.frame);
      return;
    }

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const result = parseServerBinaryFrame(data);
      if (!result.ok) {
        this.fail({
          type: "protocolError",
          code: result.error.code,
          message: result.error.message,
        });
        return;
      }
      // Binary frames are not part of the current server protocol surface;
      // we accept them silently to stay forwards-compatible.
      return;
    }

    // Blob fallback: browsers normally honor `binaryType = "arraybuffer"`,
    // but treat any other payload shape as a protocol violation.
    this.fail({
      type: "protocolError",
      code: "invalid_frame",
      message: "Unsupported WebSocket frame payload",
    });
  }

  private handleError(): void {
    if (this.state === "closed" || this.state === "ending") return;
    this.fail({
      type: "connectionFailed",
      message: "WebSocket error",
    });
  }

  private handleClose(event: CloseEvent): void {
    if (this.state === "closed") return;
    if (event.code === NORMAL_CLOSURE || event.code === 0) {
      this.teardown(null, NORMAL_CLOSURE);
      return;
    }
    this.teardown(
      {
        type: "abnormalClosure",
        code: event.code,
        reason: event.reason ? event.reason : null,
      },
      NORMAL_CLOSURE,
    );
  }

  // -------------------------------------------------------------------------
  // Server frame dispatch
  // -------------------------------------------------------------------------

  private dispatchServerFrame(frame: LiveVoiceServerFrame): void {
    switch (frame.type) {
      case "ready":
        if (this.state !== "connecting") return;
        this.cancelConnectionTimeout();
        this.state = "active";
        this.onEvent?.({
          type: "ready",
          sessionId: frame.sessionId,
          conversationId: frame.conversationId,
        });
        return;
      case "busy":
        this.fail({
          type: "busy",
          activeSessionId: frame.activeSessionId,
        });
        return;
      case "stt_partial":
        this.onEvent?.({ type: "sttPartial", text: frame.text, seq: frame.seq });
        return;
      case "stt_final":
        this.onEvent?.({ type: "sttFinal", text: frame.text, seq: frame.seq });
        return;
      case "thinking":
        this.onEvent?.({ type: "thinking", turnId: frame.turnId });
        return;
      case "assistant_text_delta":
        this.onEvent?.({
          type: "assistantTextDelta",
          text: frame.text,
          seq: frame.seq,
        });
        return;
      case "tts_audio": {
        let pcm: Uint8Array;
        try {
          const samples = base64ToPcm16(frame.dataBase64);
          pcm = new Uint8Array(
            samples.buffer,
            samples.byteOffset,
            samples.byteLength,
          );
        } catch (err) {
          this.fail({
            type: "protocolError",
            code: "invalid_audio_payload",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        this.onEvent?.({
          type: "ttsAudio",
          pcm,
          mimeType: frame.mimeType,
          sampleRate: frame.sampleRate,
          seq: frame.seq,
        });
        return;
      }
      case "tts_done":
        this.onEvent?.({ type: "ttsDone", turnId: frame.turnId });
        return;
      case "metrics":
        this.onEvent?.({
          type: "metrics",
          metrics: toMetrics(frame),
        });
        return;
      case "archived":
        this.onEvent?.({
          type: "archived",
          conversationId: frame.conversationId,
          sessionId: frame.sessionId,
        });
        return;
      case "error":
        this.fail({
          type: "protocolError",
          code: frame.code,
          message: frame.message,
        });
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sendControlFrame(
    type: "ptt_release" | "interrupt" | "end",
    allowedStates: ReadonlyArray<LiveVoiceChannelSessionState>,
  ): void {
    if (!allowedStates.includes(this.state) || !this.ws) return;
    try {
      this.ws.send(encodeClientControlFrame(type));
    } catch (err) {
      if (this.state !== "closed") {
        this.fail({
          type: "connectionFailed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private fail(failure: LiveVoiceChannelFailure): void {
    this.teardown(failure, NORMAL_CLOSURE);
  }

  private teardown(
    failure: LiveVoiceChannelFailure | null,
    closeCode: number,
  ): void {
    if (this.state === "closed") return;
    this.state = "closed";

    this.cancelConnectionTimeout();
    // If `end()` is currently awaiting the 1 s grace timer, resolve
    // its Promise *before* clearing the timer. Otherwise the awaited
    // `client.end()` would hang when a concurrent `close()` or error
    // path tears the client down during the grace window.
    if (this.pendingEndResolver !== null) {
      const resolve = this.pendingEndResolver;
      this.pendingEndResolver = null;
      resolve();
    }
    if (this.endGraceTimeoutId !== null) {
      clearTimeout(this.endGraceTimeoutId);
      this.endGraceTimeoutId = null;
    }

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(closeCode);
      } catch {
        // ignore — close is best-effort
      }
    }

    const failureCallback = this.onFailure;
    this.onEvent = null;
    this.onFailure = null;
    if (failure) failureCallback?.(failure);
  }

  private cancelConnectionTimeout(): void {
    if (this.connectionTimeoutId !== null) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the live voice WebSocket URL with the gateway edge JWT
 * embedded as a `token` query parameter. Mirrors
 * `GatewayHTTPClient.buildWebSocketRequest` in the Swift client:
 * converts `http(s)://` to `ws(s)://`.
 *
 * In local mode, the proxy URL from `getLocalGatewayUrl()` is a
 * relative path (e.g. `/assistant/__gateway/7830`) — we resolve it
 * against `window.location.origin` before swapping schemes. In
 * platform mode, the SPA is served from the same origin as the
 * gateway, so we use `window.location.origin` directly.
 *
 * Exported for tests.
 */
export function buildLiveVoiceWebSocketUrl(token: string): string {
  const base = resolveGatewayBaseUrl();
  const path = "/v1/live-voice";
  const query = `?token=${encodeURIComponent(token)}`;
  const url = new URL(`${base}${path}${query}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

function resolveGatewayBaseUrl(): string {
  if (isLocalMode()) {
    const localGateway = getLocalGatewayUrl();
    if (localGateway) {
      // The local proxy URL is a relative path served by the Vite dev
      // middleware on the same origin as the SPA. Resolve it against
      // window.location.origin so the URL parser can swap http→ws.
      if (localGateway.startsWith("http://") || localGateway.startsWith("https://")) {
        return localGateway;
      }
      return `${window.location.origin}${localGateway}`;
    }
  }
  return window.location.origin;
}

function resolveWebSocketCtor(): WebSocketCtor | null {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  return typeof ctor === "function" ? ctor : null;
}

function toMetrics(
  frame: LiveVoiceMetricsServerFrame,
): LiveVoiceChannelMetrics {
  return {
    turnId: frame.turnId,
    sttMs: frame.sttMs,
    llmFirstDeltaMs: frame.llmFirstDeltaMs,
    ttsFirstAudioMs: frame.ttsFirstAudioMs,
    totalMs: frame.totalMs,
  };
}
