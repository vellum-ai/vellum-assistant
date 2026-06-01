/**
 * Browser live-voice channel client (WebSocket transport).
 *
 * Web-app counterpart to the macOS `LiveVoiceChannelClient`
 * (`clients/shared/Network/LiveVoiceChannelClient.swift`). One instance drives
 * one live-voice session: it mints a short-lived velay token, opens the velay
 * WebSocket, sends the `start` frame on open, streams microphone PCM as binary
 * frames, and dispatches parsed server frames as typed events.
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

import {
  buildLiveVoiceWsUrl,
  mintLiveVoiceToken,
} from "@/domains/voice/live-voice/connection";
import {
  type LiveVoiceArchivedServerFrame,
  type LiveVoiceAssistantTextDeltaServerFrame,
  type LiveVoiceBusyServerFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceMetricsServerFrame,
  type LiveVoiceReadyServerFrame,
  type LiveVoiceSttFinalServerFrame,
  type LiveVoiceSttPartialServerFrame,
  type LiveVoiceThinkingServerFrame,
  type LiveVoiceTtsAudioServerFrame,
  type LiveVoiceTtsDoneServerFrame,
  parseServerFrame,
} from "@/domains/voice/live-voice/protocol";

/** Audio shape sent in the `start` frame — matches the runtime contract. */
const START_AUDIO_CONFIG: LiveVoiceClientStartFrame["audio"] = {
  mimeType: "audio/pcm",
  sampleRate: 16000,
  channels: 1,
};

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
}

/**
 * Typed event payloads. Names map 1:1 to the server frame types (camelCased),
 * plus `closed` for transport teardown. Frame `seq` is preserved so consumers
 * can order or dedupe.
 */
export interface LiveVoiceClientEventMap {
  ready: LiveVoiceReadyServerFrame;
  sttPartial: LiveVoiceSttPartialServerFrame;
  sttFinal: LiveVoiceSttFinalServerFrame;
  thinking: LiveVoiceThinkingServerFrame;
  assistantTextDelta: LiveVoiceAssistantTextDeltaServerFrame;
  ttsAudio: LiveVoiceTtsAudioServerFrame;
  ttsDone: LiveVoiceTtsDoneServerFrame;
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

  private readonly listeners: {
    [E in LiveVoiceClientEventName]: Set<LiveVoiceClientEventHandler<E>>;
  } = {
    ready: new Set(),
    sttPartial: new Set(),
    sttFinal: new Set(),
    thinking: new Set(),
    assistantTextDelta: new Set(),
    ttsAudio: new Set(),
    ttsDone: new Set(),
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
   * Mint a token, open the velay WebSocket, and send the `start` frame on open.
   * Resolves once the socket is opening; session readiness is signalled via the
   * `ready` event (or `error` / `busy` if it never arrives).
   */
  async connect({
    assistantId,
    conversationId,
  }: LiveVoiceConnectArgs): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "connecting";
    this.conversationId = conversationId;

    let token: string;
    try {
      ({ token } = await mintLiveVoiceToken(assistantId));
    } catch (err) {
      this.fail("connection-failed", messageOf(err, "Failed to mint live-voice token"));
      return;
    }
    // A late close()/end() during the await must abort the connect.
    if (this.state !== "connecting") return;

    const url = buildLiveVoiceWsUrl({ assistantId, conversationId, token });

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
    if (this.state !== "active" || !this.ws) return;
    this.ws.send(pcm);
  }

  /** Mark the current push-to-talk segment as released. */
  pttRelease(): void {
    this.sendControlFrame("ptt_release");
  }

  /** Interrupt assistant speech for barge-in. */
  interrupt(): void {
    this.sendControlFrame("interrupt");
  }

  /** End the session gracefully: send `end`, then close the socket. */
  end(): void {
    if (this.state !== "connecting" && this.state !== "active") return;
    this.sendControlFrame("end");
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
      audio: START_AUDIO_CONFIG,
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
    };
    this.ws.send(JSON.stringify(startFrame));
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
      case "metrics":
        this.emit("metrics", frame);
        return;
      case "archived":
        this.emit("archived", frame);
        return;
      case "error":
        this.fail("protocol-error", frame.message, frame.code);
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

  private sendControlFrame(type: "ptt_release" | "interrupt" | "end"): void {
    if (this.state !== "active" && !(type === "end" && this.state === "connecting")) {
      return;
    }
    this.ws?.send(JSON.stringify({ type }));
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
