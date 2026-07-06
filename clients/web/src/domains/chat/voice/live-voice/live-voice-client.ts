/**
 * Browser live-voice channel client (WebSocket transport).
 *
 * One instance drives
 * one live-voice session: it resolves the transport URL (cloud velay token or
 * self-hosted gateway + actor token, via {@link resolveLiveVoiceWsUrl}), opens
 * the WebSocket, sends the `start` frame on open, streams microphone PCM as
 * binary frames, and dispatches parsed server frames as typed events.
 *
 * Wire contract (see `protocol.ts`, ported from
 * `assistant/src/live-voice/protocol.ts`):
 * - `start` / `ptt_release` / `interrupt` / `end` go out as JSON **text** frames.
 * - Audio chunks go out as raw **binary** frames (PCM bytes) — there is no
 *   `audio` client frame on the web side.
 * - Every inbound server frame is JSON text and is parsed via
 *   {@link parseServerFrame}.
 *
 * Connection handshake mirrors the macOS client: a ~10s connect timeout fails
 * the session if no `ready` frame arrives, and a server `busy` frame is handled
 * distinctly from `error`.
 */

import { resolveLiveVoiceWsUrl } from "@/domains/chat/voice/live-voice/connection";
import {
  type LiveVoiceArchivedServerFrame,
  type LiveVoiceAssistantTextDeltaServerFrame,
  type LiveVoiceBusyServerFrame,
  type LiveVoiceClientStartFrame,
  LIVE_VOICE_AUDIO_FORMAT,
  type LiveVoiceMetricsServerFrame,
  type LiveVoiceReadyServerFrame,
  type LiveVoiceSpeechStartedServerFrame,
  type LiveVoiceSttFinalServerFrame,
  type LiveVoiceSttPartialServerFrame,
  type LiveVoiceThinkingServerFrame,
  type LiveVoiceTtsAudioServerFrame,
  type LiveVoiceTtsDoneServerFrame,
  type LiveVoiceTurnCancelledServerFrame,
  type LiveVoiceTurnDetectionMode,
  type LiveVoiceUtteranceDiscardedServerFrame,
  type LiveVoiceUtteranceEndServerFrame,
  parseServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";

/** Fail the session if no `ready` frame arrives within this window. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Reason a live-voice session failed, surfaced via the `error` event. */
export type LiveVoiceClientErrorReason =
  | "connection-failed"
  | "protocol-error"
  | "timeout";

export interface LiveVoiceClientError {
  readonly reason: LiveVoiceClientErrorReason;
  /** Protocol error code from the server `error` frame, when applicable. */
  readonly code?: string;
  readonly message: string;
  /**
   * True when the server marked the error recoverable and the transport was
   * kept open — the session is still live. Absent means the client tore down.
   */
  readonly recoverable?: boolean;
}

/**
 * Typed event payloads. Names map 1:1 to the server frame types (camelCased),
 * plus `closed` for transport teardown. Frame `seq` is preserved so consumers
 * can order or dedupe.
 */
export interface LiveVoiceClientEventMap {
  ready: LiveVoiceReadyServerFrame;
  /** Server VAD detected user speech — stop local TTS playback immediately. */
  speechStarted: LiveVoiceSpeechStartedServerFrame;
  /** Server VAD closed the utterance; transcription begins. */
  utteranceEnd: LiveVoiceUtteranceEndServerFrame;
  /** The closed utterance had no usable speech — return to listening. */
  utteranceDiscarded: LiveVoiceUtteranceDiscardedServerFrame;
  sttPartial: LiveVoiceSttPartialServerFrame;
  sttFinal: LiveVoiceSttFinalServerFrame;
  thinking: LiveVoiceThinkingServerFrame;
  assistantTextDelta: LiveVoiceAssistantTextDeltaServerFrame;
  ttsAudio: LiveVoiceTtsAudioServerFrame;
  ttsDone: LiveVoiceTtsDoneServerFrame;
  /** Barge-in aborted the turn — drop buffered tts_audio; no tts_done follows. */
  turnCancelled: LiveVoiceTurnCancelledServerFrame;
  metrics: LiveVoiceMetricsServerFrame;
  archived: LiveVoiceArchivedServerFrame;
  busy: LiveVoiceBusyServerFrame;
  error: LiveVoiceClientError;
  /** Fired exactly once when the transport closes (clean or otherwise). */
  closed: void;
}

export type LiveVoiceClientEventName = keyof LiveVoiceClientEventMap;

export type LiveVoiceClientEventHandler<E extends LiveVoiceClientEventName> = (
  payload: LiveVoiceClientEventMap[E],
) => void;

export interface LiveVoiceConnectArgs {
  assistantId: string;
  /** Optional conversation to attach the session to. */
  conversationId?: string;
  /**
   * Turn-detection mode sent on the `start` frame. Omitted means "manual"
   * (push-to-talk).
   */
  turnDetection?: LiveVoiceTurnDetectionMode;
}

/** Factory so tests can inject a mock WebSocket. Defaults to the global. */
export type WebSocketFactory = (url: string) => WebSocket;

export interface LiveVoiceChannelClientOptions {
  /** Override the WebSocket constructor (tests). */
  webSocketFactory?: WebSocketFactory;
  /** Override the connect timeout (tests). */
  connectTimeoutMs?: number;
}

type SessionState = "idle" | "connecting" | "active" | "closed";

/**
 * Browser live-voice WebSocket client. Create one instance per session; after
 * `close()`/`end()`/failure the instance is terminal and must not be reused.
 */
export class LiveVoiceChannelClient {
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;

  private state: SessionState = "idle";
  private ws: WebSocket | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private conversationId: string | undefined;
  private turnDetection: LiveVoiceTurnDetectionMode | undefined;

  private readonly listeners: {
    [E in LiveVoiceClientEventName]: Set<LiveVoiceClientEventHandler<E>>;
  } = {
    ready: new Set(),
    speechStarted: new Set(),
    utteranceEnd: new Set(),
    utteranceDiscarded: new Set(),
    sttPartial: new Set(),
    sttFinal: new Set(),
    thinking: new Set(),
    assistantTextDelta: new Set(),
    ttsAudio: new Set(),
    ttsDone: new Set(),
    turnCancelled: new Set(),
    metrics: new Set(),
    archived: new Set(),
    busy: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(options: LiveVoiceChannelClientOptions = {}) {
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /**
   * Subscribe to a typed event. Returns an unsubscribe function.
   */
  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: LiveVoiceClientEventHandler<E>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  private emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.listeners[event]) {
      handler(payload);
    }
  }

  /**
   * Resolve the transport URL (cloud velay token or self-hosted gateway +
   * actor token), open the WebSocket, and send the `start` frame on open.
   * Resolves once the socket is opening; session readiness is signalled via the
   * `ready` event (or `error` / `busy` if it never arrives).
   */
  async connect({
    assistantId,
    conversationId,
    turnDetection,
  }: LiveVoiceConnectArgs): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "connecting";
    this.conversationId = conversationId;
    this.turnDetection = turnDetection;

    let url: string;
    try {
      url = await resolveLiveVoiceWsUrl({ assistantId, conversationId });
    } catch (err) {
      this.fail(
        "connection-failed",
        messageOf(err, "Failed to start live-voice session"),
      );
      return;
    }
    // A late close()/end() during the await must abort the connect.
    if (this.state !== "connecting") return;

    let ws: WebSocket;
    try {
      ws = this.webSocketFactory(url);
    } catch (err) {
      this.fail("connection-failed", messageOf(err, "Failed to open live-voice WebSocket"));
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => this.handleOpen();
    ws.onmessage = (event) => this.handleMessage(event);
    ws.onerror = () =>
      this.fail("connection-failed", "Live-voice WebSocket error");
    ws.onclose = () => this.handleClose();

    this.connectTimeout = setTimeout(() => {
      if (this.state === "connecting") {
        this.fail("timeout", `Live-voice connection timed out after ${this.connectTimeoutMs}ms`);
      }
    }, this.connectTimeoutMs);
  }

  /** Send a binary PCM audio frame. No-op unless the session is active. */
  sendAudio(pcm: ArrayBuffer): void {
    if (this.state !== "active") return;
    this.trySend(pcm);
  }

  /** Mark the current push-to-talk segment as released. */
  pttRelease(): void {
    this.sendControlFrame("ptt_release");
  }

  /** Interrupt assistant speech for barge-in. */
  interrupt(): void {
    this.sendControlFrame("interrupt");
  }

  /**
   * End the session gracefully: best-effort send `end`, then always close the
   * socket. A quick-cancel while still CONNECTING simply skips the (impossible)
   * `end` send and resolves as a clean close rather than a timeout failure.
   */
  end(): void {
    if (this.state !== "connecting" && this.state !== "active") return;
    // Only the `end` frame is meaningful here, and it's strictly best-effort:
    // trySend() no-ops unless the socket is OPEN, so this never throws while the
    // socket is still CONNECTING. close() is reached unconditionally below.
    this.trySend(JSON.stringify({ type: "end" }));
    this.close();
  }

  /** Close the WebSocket immediately. Idempotent. */
  close(): void {
    if (this.state === "closed") return;
    this.teardown();
    this.emit("closed", undefined);
  }

  private handleOpen(): void {
    if (this.state !== "connecting" || !this.ws) return;
    const startFrame: LiveVoiceClientStartFrame = {
      type: "start",
      audio: LIVE_VOICE_AUDIO_FORMAT,
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      ...(this.turnDetection ? { turnDetection: this.turnDetection } : {}),
    };
    this.trySend(JSON.stringify(startFrame));
  }

  private handleMessage(event: MessageEvent): void {
    if (this.state === "closed") return;
    // Inbound audio (if any) arrives as binary; the wire protocol carries all
    // server payloads as JSON text, so binary frames are not expected. Ignore
    // them rather than mis-parsing bytes as JSON.
    if (typeof event.data !== "string") return;

    const frame = parseServerFrame(event.data);
    switch (frame.type) {
      case "ready":
        if (this.state !== "connecting") return;
        this.clearConnectTimeout();
        this.state = "active";
        this.emit("ready", frame);
        return;
      case "busy":
        this.emit("busy", frame);
        this.close();
        return;
      case "speech_started":
        this.emit("speechStarted", frame);
        return;
      case "utterance_end":
        this.emit("utteranceEnd", frame);
        return;
      case "utterance_discarded":
        this.emit("utteranceDiscarded", frame);
        return;
      case "stt_partial":
        this.emit("sttPartial", frame);
        return;
      case "stt_final":
        this.emit("sttFinal", frame);
        return;
      case "thinking":
        this.emit("thinking", frame);
        return;
      case "assistant_text_delta":
        this.emit("assistantTextDelta", frame);
        return;
      case "tts_audio":
        this.emit("ttsAudio", frame);
        return;
      case "tts_done":
        this.emit("ttsDone", frame);
        return;
      case "turn_cancelled":
        this.emit("turnCancelled", frame);
        return;
      case "metrics":
        this.emit("metrics", frame);
        return;
      case "archived":
        this.emit("archived", frame);
        return;
      case "error":
        // A recoverable mid-session error leaves the transport open; the
        // session controller decides whether the session survives. (`in`
        // narrows past LiveVoiceInvalidJsonFrame, which is never recoverable.)
        if (
          "recoverable" in frame &&
          frame.recoverable === true &&
          this.state === "active"
        ) {
          this.emit("error", {
            reason: "protocol-error",
            code: frame.code,
            message: frame.message,
            recoverable: true,
          });
          return;
        }
        this.fail("protocol-error", frame.message, frame.code);
        return;
      case "unknown_frame":
        // Frame types from a newer server than this client. Ignore so
        // protocol additions never kill older clients.
        console.warn(
          `live-voice: ignoring unknown server frame type "${frame.frameType}"`,
        );
        return;
    }
  }

  private handleClose(): void {
    if (this.state === "closed") return;
    // An unexpected transport close before `ready` is a connection failure;
    // otherwise it's a clean teardown.
    if (this.state === "connecting") {
      this.fail("connection-failed", "Live-voice WebSocket closed before ready");
      return;
    }
    this.teardown();
    this.emit("closed", undefined);
  }

  private sendControlFrame(type: "ptt_release" | "interrupt"): void {
    if (this.state !== "active") return;
    this.trySend(JSON.stringify({ type }));
  }

  /**
   * Best-effort send: only writes to the socket when it is actually OPEN.
   * Calling `send()` on a CONNECTING (or CLOSING/CLOSED) WebSocket throws
   * `InvalidStateError` in browsers, so guarding on `readyState` keeps a
   * quick-cancel during connect (and any late send) from throwing.
   */
  private trySend(data: string | ArrayBuffer): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  private fail(
    reason: LiveVoiceClientErrorReason,
    message: string,
    code?: string,
  ): void {
    if (this.state === "closed") return;
    this.teardown();
    this.emit("error", { reason, message, ...(code ? { code } : {}) });
    this.emit("closed", undefined);
  }

  private teardown(): void {
    this.state = "closed";
    this.clearConnectTimeout();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
