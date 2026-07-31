import type {
  LiveVoiceBusyServerFrame,
  LiveVoiceClientControlFrame,
  LiveVoiceClientStartFrame,
  LiveVoiceClientUpdateConfigFrame,
  LiveVoiceErrorServerFrame,
  LiveVoiceReadyServerFrame,
  LiveVoiceServerFrame,
  LiveVoiceTurnDetectionMode,
} from "@vellumai/service-contracts/live-voice";
import {
  LIVE_VOICE_AUDIO_FORMAT,
  parseLiveVoiceServerFrame,
} from "@vellumai/service-contracts/live-voice";

const CONNECT_TIMEOUT_MS = 10_000;
const WEB_SOCKET_OPEN = 1;

export const RETRYABLE_LIVE_VOICE_CLOSE_CODES: ReadonlySet<number> = new Set([
  1012, 1013,
]);

export interface LiveVoiceWebSocketOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LiveVoiceWebSocketMessageEvent {
  readonly data: unknown;
}

export interface LiveVoiceWebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface LiveVoiceWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: LiveVoiceWebSocketMessageEvent) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: LiveVoiceWebSocketCloseEvent) => void,
  ): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: LiveVoiceWebSocketMessageEvent) => void,
  ): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(
    type: "close",
    listener: (event: LiveVoiceWebSocketCloseEvent) => void,
  ): void;
}

export type LiveVoiceWebSocketConstructor = new (
  url: string | URL,
  options?: LiveVoiceWebSocketOptions,
) => LiveVoiceWebSocketLike;

export type LiveVoiceChannelClientErrorReason =
  | "connection-failed"
  | "protocol-error"
  | "timeout";

export interface LiveVoiceChannelClientError {
  readonly reason: LiveVoiceChannelClientErrorReason;
  readonly code?: string;
  readonly message: string;
  readonly recoverable?: boolean;
}

export interface LiveVoiceChannelClientClosed {
  readonly code: number | null;
  readonly reason: string;
  readonly retryable: boolean;
}

type ForwardedLiveVoiceServerFrame = Exclude<
  LiveVoiceServerFrame,
  | LiveVoiceReadyServerFrame
  | LiveVoiceBusyServerFrame
  | LiveVoiceErrorServerFrame
>;

export interface LiveVoiceChannelClientEventMap {
  ready: LiveVoiceReadyServerFrame;
  busy: LiveVoiceBusyServerFrame;
  frame: ForwardedLiveVoiceServerFrame;
  error: LiveVoiceChannelClientError;
  closed: LiveVoiceChannelClientClosed;
}

export type LiveVoiceChannelClientEventName =
  keyof LiveVoiceChannelClientEventMap;

export type LiveVoiceChannelClientEventHandler<
  EventName extends LiveVoiceChannelClientEventName,
> = (payload: LiveVoiceChannelClientEventMap[EventName]) => void;

export interface LiveVoiceChannelClientOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly webSocketConstructor?: LiveVoiceWebSocketConstructor;
  readonly connectTimeoutMs?: number;
}

export interface LiveVoiceChannelConnectOptions {
  readonly conversationId?: string;
  readonly turnDetection?: LiveVoiceTurnDetectionMode;
  readonly silenceThresholdMs?: number;
  readonly bargeInMinSpeechMs?: number;
}

type SessionState = "idle" | "connecting" | "active" | "closed";

export class LiveVoiceChannelClient {
  private readonly webSocketConstructor: LiveVoiceWebSocketConstructor;
  private readonly connectTimeoutMs: number;
  private readonly sensitiveValues: readonly string[];

  private state: SessionState = "idle";
  private webSocket: LiveVoiceWebSocketLike | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private closeEmitted = false;
  private configUpdatesUnsupported = false;
  private sentConfigUpdate = false;
  private pendingConnectOptions: LiveVoiceChannelConnectOptions = {};

  private readonly listeners: {
    [EventName in LiveVoiceChannelClientEventName]: Set<
      LiveVoiceChannelClientEventHandler<EventName>
    >;
  } = {
    ready: new Set(),
    busy: new Set(),
    frame: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(private readonly options: LiveVoiceChannelClientOptions) {
    this.webSocketConstructor =
      options.webSocketConstructor ??
      (WebSocket as unknown as LiveVoiceWebSocketConstructor);
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.sensitiveValues = collectSensitiveValues(options.url, options.headers);
  }

  on<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    handler: LiveVoiceChannelClientEventHandler<EventName>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  connect(options: LiveVoiceChannelConnectOptions = {}): void {
    if (this.state !== "idle") {
      return;
    }
    this.state = "connecting";
    this.pendingConnectOptions = options;

    let webSocket: LiveVoiceWebSocketLike;
    try {
      webSocket = new this.webSocketConstructor(
        this.options.url,
        this.options.headers ? { headers: this.options.headers } : undefined,
      );
    } catch {
      this.fail(
        "connection-failed",
        "Failed to open the live-voice WebSocket.",
      );
      return;
    }

    this.webSocket = webSocket;
    webSocket.binaryType = "arraybuffer";
    webSocket.addEventListener("open", this.handleOpen);
    webSocket.addEventListener("message", this.handleMessage);
    webSocket.addEventListener("error", this.handleError);
    webSocket.addEventListener("close", this.handleClose);

    this.connectTimeout = setTimeout(() => {
      if (this.state === "connecting") {
        this.fail(
          "timeout",
          `Live voice did not become ready within ${this.connectTimeoutMs}ms.`,
        );
      }
    }, this.connectTimeoutMs);
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    if (this.state !== "active") {
      return;
    }
    this.trySend(pcm);
  }

  pttRelease(): void {
    this.sendControlFrame({ type: "ptt_release" });
  }

  interrupt(): void {
    this.sendControlFrame({ type: "interrupt" });
  }

  updateConfig(config: Omit<LiveVoiceClientUpdateConfigFrame, "type">): void {
    if (this.state !== "active" || this.configUpdatesUnsupported) {
      return;
    }
    const frame: LiveVoiceClientUpdateConfigFrame = {
      type: "update_config",
      ...config,
    };
    this.sentConfigUpdate = true;
    this.trySend(JSON.stringify(frame));
  }

  end(): void {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "connecting" || this.state === "active") {
      this.trySend(
        JSON.stringify({
          type: "end",
        } satisfies LiveVoiceClientControlFrame),
      );
    }
    this.close();
  }

  close(): void {
    if (this.state === "closed") {
      return;
    }
    this.teardown();
    this.emitClosed({
      code: null,
      reason: "client closed",
      retryable: false,
    });
  }

  private readonly handleOpen = (): void => {
    if (this.state !== "connecting") {
      return;
    }
    const options = this.pendingConnectOptions;
    const startFrame: LiveVoiceClientStartFrame = {
      type: "start",
      audio: LIVE_VOICE_AUDIO_FORMAT,
      sourceInterface: "cli",
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : {}),
      ...(options.turnDetection
        ? { turnDetection: options.turnDetection }
        : {}),
      ...(options.silenceThresholdMs !== undefined
        ? { silenceThresholdMs: options.silenceThresholdMs }
        : {}),
      ...(options.bargeInMinSpeechMs !== undefined
        ? { bargeInMinSpeechMs: options.bargeInMinSpeechMs }
        : {}),
    };
    this.trySend(JSON.stringify(startFrame));
  };

  private readonly handleMessage = (
    event: LiveVoiceWebSocketMessageEvent,
  ): void => {
    if (this.state === "closed" || typeof event.data !== "string") {
      return;
    }

    const frame = parseLiveVoiceServerFrame(event.data);
    if (frame.type === "unknown_frame") {
      return;
    }
    if (frame.type === "ready") {
      if (this.state !== "connecting") {
        return;
      }
      this.clearConnectTimeout();
      this.state = "active";
      this.emit("ready", frame);
      return;
    }
    if (frame.type === "busy") {
      this.emit("busy", frame);
      this.close();
      return;
    }
    if (frame.type === "error") {
      if (
        frame.code === "unknown_type" &&
        this.state === "active" &&
        this.sentConfigUpdate
      ) {
        this.configUpdatesUnsupported = true;
        return;
      }
      if (
        "recoverable" in frame &&
        frame.recoverable === true &&
        this.state === "active"
      ) {
        this.emit("error", {
          reason: "protocol-error",
          code: frame.code,
          message: this.redact(frame.message),
          recoverable: true,
        });
        return;
      }
      this.fail("protocol-error", this.redact(frame.message), frame.code);
      return;
    }

    this.emit("frame", frame);
  };

  private readonly handleError = (): void => {
    this.fail(
      "connection-failed",
      "The live-voice WebSocket encountered an error.",
    );
  };

  private readonly handleClose = (
    event: LiveVoiceWebSocketCloseEvent,
  ): void => {
    if (this.state === "closed") {
      return;
    }
    const retryable = RETRYABLE_LIVE_VOICE_CLOSE_CODES.has(event.code);
    if (this.state === "connecting" && !retryable) {
      this.fail(
        "connection-failed",
        "The live-voice WebSocket closed before it became ready.",
      );
      return;
    }

    this.teardown(false);
    this.emitClosed({
      code: event.code,
      reason: this.redact(event.reason),
      retryable,
    });
  };

  private sendControlFrame(frame: LiveVoiceClientControlFrame): void {
    if (this.state !== "active") {
      return;
    }
    this.trySend(JSON.stringify(frame));
  }

  private trySend(data: string | ArrayBuffer | Uint8Array): void {
    if (this.webSocket && this.webSocket.readyState === WEB_SOCKET_OPEN) {
      this.webSocket.send(data);
    }
  }

  private fail(
    reason: LiveVoiceChannelClientErrorReason,
    message: string,
    code?: string,
  ): void {
    if (this.state === "closed") {
      return;
    }
    const safeMessage = this.redact(message);
    this.teardown();
    this.emit("error", {
      reason,
      message: safeMessage,
      ...(code ? { code } : {}),
    });
    this.emitClosed({
      code: null,
      reason: safeMessage,
      retryable: false,
    });
  }

  private teardown(closeSocket = true): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    this.clearConnectTimeout();

    const webSocket = this.webSocket;
    this.webSocket = null;
    if (!webSocket) {
      return;
    }
    webSocket.removeEventListener("open", this.handleOpen);
    webSocket.removeEventListener("message", this.handleMessage);
    webSocket.removeEventListener("error", this.handleError);
    webSocket.removeEventListener("close", this.handleClose);
    if (closeSocket) {
      webSocket.close();
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private emit<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    payload: LiveVoiceChannelClientEventMap[EventName],
  ): void {
    for (const handler of this.listeners[event]) {
      handler(payload);
    }
  }

  private emitClosed(payload: LiveVoiceChannelClientClosed): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.emit("closed", payload);
    for (const listeners of Object.values(this.listeners)) {
      listeners.clear();
    }
  }

  private redact(value: string): string {
    let redacted = value;
    for (const sensitiveValue of this.sensitiveValues) {
      redacted = redacted.replaceAll(sensitiveValue, "[REDACTED]");
    }
    return redacted;
  }
}

function collectSensitiveValues(
  rawUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
): string[] {
  const values = new Set<string>();
  try {
    const url = new URL(rawUrl);
    for (const [name, value] of url.searchParams) {
      if (
        value &&
        (name.toLowerCase() === "token" || name.toLowerCase().includes("key"))
      ) {
        values.add(value);
        values.add(encodeURIComponent(value));
        values.add(
          new URLSearchParams({ value }).toString().slice("value=".length),
        );
      }
    }
  } catch {
    // URL validation belongs to the connection resolver.
  }

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      name.toLowerCase() === "authorization" ||
      name.toLowerCase().includes("token")
    ) {
      values.add(value);
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (bearer?.[1]) {
        values.add(bearer[1]);
        values.add(encodeURIComponent(bearer[1]));
      }
    }
  }
  return [...values].filter((value) => value.length > 0);
}
