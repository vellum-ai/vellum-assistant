/**
 * A live-voice client that never opens a microphone.
 *
 * One instance drives one session. It opens the gateway WebSocket, sends
 * `start` with `textInput: true`, and from then on takes turns by typing them:
 * a `text` frame joins the pipeline at the point speech-to-text would have
 * handed over a finished transcript, so the reply streams back through the
 * same turn runner, the same segmented TTS, and the same barge-in as a spoken
 * one. Only the capture half is skipped.
 *
 * Modeled on `clients/web/src/domains/chat/voice/live-voice/live-voice-client.ts`
 * and deliberately narrower: no audio upload, no push-to-talk, no mid-session
 * config updates. After `end()` or a failure the instance is terminal.
 */

import {
  LIVE_VOICE_AUDIO_FORMAT,
  MAX_TEXT_TURN_CHARS,
  parseServerFrame,
  type LiveVoiceActivityFrame,
  type LiveVoiceAssistantTextDeltaFrame,
  type LiveVoiceReadyFrame,
  type LiveVoiceStartFrame,
  type LiveVoiceTtsAudioFrame,
} from "./protocol.js";

/** Fail the session if no `ready` frame arrives within this window. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface LiveVoiceClientEvents {
  /** The session is open. `textInput` says whether typed turns are accepted. */
  ready(frame: LiveVoiceReadyFrame): void;
  /** A chunk of the assistant's reply text, as the model produces it. */
  textDelta(frame: LiveVoiceAssistantTextDeltaFrame): void;
  /** A chunk of spoken audio. PCM16 mono at the frame's own sample rate. */
  audio(frame: LiveVoiceTtsAudioFrame): void;
  /** The turn's speech is fully sent. */
  turnDone(turnId: string): void;
  /** The turn was aborted; buffered audio for it must be dropped. */
  turnCancelled(turnId: string): void;
  /** A named piece of work the turn is doing ("" means idle again). */
  activity(frame: LiveVoiceActivityFrame): void;
  /** The daemon refused a typed turn. The session survives. */
  textTurnRejected(reason: "unsupported" | "busy", message: string): void;
  /** A recoverable mid-session error. The session survives. */
  warning(message: string): void;
  /** The session is over. `error` is set when it ended badly. */
  closed(error?: string): void;
}

type EventName = keyof LiveVoiceClientEvents;

export interface CliLiveVoiceClientOptions {
  readonly url: string;
  readonly token: string;
  /**
   * Where the credential goes. `header` is the gateway's `Authorization:
   * Bearer` (the local and self-hosted path); `query` means the URL already
   * carries the token velay reads, and no header is sent. Defaults to `header`
   * so existing callers keep the gateway behaviour.
   */
  readonly tokenTransport?: "header" | "query";
  readonly conversationId?: string;
  /** Override the socket factory (tests). */
  readonly webSocketFactory?: (url: string, token: string) => WebSocket;
  /** Override the connect timeout (tests). */
  readonly connectTimeoutMs?: number;
}

type SessionState = "idle" | "connecting" | "active" | "closed";

export class CliLiveVoiceClient {
  private state: SessionState = "idle";
  private ws: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private textInputSupported = false;
  private audioInputLive = true;

  private readonly options: CliLiveVoiceClientOptions;
  private readonly listeners = new Map<
    EventName,
    Set<(...a: never[]) => void>
  >();

  constructor(options: CliLiveVoiceClientOptions) {
    this.options = options;
  }

  on<E extends EventName>(event: E, handler: LiveVoiceClientEvents[E]): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (...a: never[]) => void);
    this.listeners.set(event, set);
  }

  private emit<E extends EventName>(
    event: E,
    ...args: Parameters<LiveVoiceClientEvents[E]>
  ): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  /** Whether this daemon accepts typed turns (set from the `ready` echo). */
  get supportsTextInput(): boolean {
    return this.textInputSupported;
  }

  /** Whether the session's speech-to-text leg came up. */
  get hasAudioInput(): boolean {
    return this.audioInputLive;
  }

  /**
   * Open the socket. Resolves once it is opening; readiness arrives as the
   * `ready` event, and failure as `closed` with an error.
   */
  connect(): void {
    if (this.state !== "idle") {
      return;
    }
    this.state = "connecting";

    let ws: WebSocket;
    try {
      ws = this.options.webSocketFactory
        ? this.options.webSocketFactory(this.options.url, this.options.token)
        : openAuthenticatedSocket(
            this.options.url,
            this.options.token,
            this.options.tokenTransport ?? "header",
          );
    } catch (err) {
      this.fail(
        err instanceof Error
          ? err.message
          : "Failed to open the live-voice WebSocket",
      );
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
    ws.onerror = () => this.fail("Live-voice WebSocket error");
    ws.onclose = (event: CloseEvent) => this.handleClose(event);

    this.connectTimer = setTimeout(() => {
      if (this.state === "connecting") {
        this.fail(
          `Live-voice connection timed out after ${this.connectTimeoutMs()}ms`,
        );
      }
    }, this.connectTimeoutMs());
  }

  /**
   * Take a turn by typing it. Returns whether the frame went out.
   *
   * False means the turn was not taken at all and the caller must say so: the
   * session is not active, the daemon predates typed turns, or the text is
   * empty or over the cap. A turn the daemon *receives* but refuses (it is
   * mid-reply) comes back later as `textTurnRejected`, not as false here.
   */
  sendText(text: string): boolean {
    if (this.state !== "active" || !this.textInputSupported) {
      return false;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_TURN_CHARS) {
      return false;
    }
    return this.trySend(JSON.stringify({ type: "text", text: trimmed }));
  }

  /** Cut off the assistant mid-reply. */
  interrupt(): void {
    if (this.state !== "active") {
      return;
    }
    this.trySend(JSON.stringify({ type: "interrupt" }));
  }

  /** End the session gracefully, then close the socket. Idempotent. */
  end(): void {
    if (this.state !== "connecting" && this.state !== "active") {
      return;
    }
    // Best-effort: trySend no-ops unless the socket is OPEN, so a quick cancel
    // during connect skips the (impossible) send and still closes cleanly.
    this.trySend(JSON.stringify({ type: "end" }));
    this.teardown();
    this.emit("closed", undefined);
  }

  private connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  private handleOpen(): void {
    if (this.state !== "connecting") {
      return;
    }
    const start: LiveVoiceStartFrame = {
      type: "start",
      audio: LIVE_VOICE_AUDIO_FORMAT,
      textInput: true,
      ...(this.options.conversationId
        ? { conversationId: this.options.conversationId }
        : {}),
    };
    this.trySend(JSON.stringify(start));
  }

  private handleMessage(event: MessageEvent): void {
    if (this.state === "closed") {
      return;
    }
    // Every server payload is JSON text; binary is not part of the contract.
    if (typeof event.data !== "string") {
      return;
    }
    const frame = parseServerFrame(event.data);
    switch (frame.type) {
      case "ready": {
        if (this.state !== "connecting") {
          return;
        }
        this.clearConnectTimer();
        this.state = "active";
        this.textInputSupported = frame.textInput === true;
        // Absent means yes: a daemon predating the field refuses any session it
        // cannot transcribe, so every session it readies can hear.
        this.audioInputLive = frame.audioInput !== false;
        this.emit("ready", frame);
        return;
      }
      case "busy":
        this.fail(
          "The assistant already has a voice session open " +
            `(${frame.activeSessionId}).`,
        );
        return;
      case "assistant_text_delta":
        this.emit("textDelta", frame);
        return;
      case "tts_audio":
        this.emit("audio", frame);
        return;
      case "tts_done":
        this.emit("turnDone", frame.turnId);
        return;
      case "turn_cancelled":
        this.emit("turnCancelled", frame.turnId);
        return;
      case "activity":
        this.emit("activity", frame);
        return;
      case "thinking":
        return;
      case "error": {
        // `frameType` names what the error is about. A typed turn's rejection
        // must not be filed anywhere else: `unknown_type` here is
        // byte-identical to the rejection an older daemon gives every optional
        // frame, and a `recoverable` refusal is a busy assistant rather than a
        // transient blip, so both would be misread by the generic paths below.
        if (frame.frameType === "text") {
          this.emit(
            "textTurnRejected",
            frame.code === "unknown_type" ? "unsupported" : "busy",
            frame.message,
          );
          return;
        }
        if (frame.recoverable === true && this.state === "active") {
          this.emit("warning", frame.message);
          return;
        }
        this.fail(frame.message);
        return;
      }
      case "unhandled":
      case "malformed":
        // Capture-side frames a mic-less session never acts on, and additions
        // from a newer daemon. Ignoring them is what keeps protocol growth
        // from breaking an older CLI.
        return;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "connecting") {
      this.fail(closeReason(event));
      return;
    }
    this.teardown();
    this.emit("closed", undefined);
  }

  private trySend(data: string): boolean {
    const ws = this.ws;
    // Sending on a CONNECTING socket throws, so guard on readyState rather
    // than on session state alone.
    if (ws && ws.readyState === 1) {
      ws.send(data);
      return true;
    }
    return false;
  }

  private fail(message: string): void {
    if (this.state === "closed") {
      return;
    }
    this.teardown();
    this.emit("closed", message);
  }

  private teardown(): void {
    this.state = "closed";
    this.clearConnectTimer();
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

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}

/**
 * Open the gateway socket with the guardian token in an `Authorization`
 * header.
 *
 * The gateway takes the credential either as a header or as a `?token=` query
 * parameter. The browser client has to use the query form, because `WebSocket`
 * there cannot set headers, but a CLI can and should: a query parameter lands in
 * process listings, shell history, and gateway access logs, and this token is
 * the bound guardian's.
 */
function openAuthenticatedSocket(
  url: string,
  token: string,
  transport: "header" | "query",
): WebSocket {
  // velay reads the credential from the query string and no headers at all,
  // and the URL it was given already carries it. Sending a bearer header there
  // would authenticate nothing and put a single-use token in a second place.
  if (transport === "query") {
    return new WebSocket(url) as WebSocket;
  }
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as string[]) as WebSocket;
}

function closeReason(event: CloseEvent): string {
  // 1008/1011 with no reason is what an upgrade rejected at the gateway looks
  // like by the time it reaches a WebSocket client: the 401/403 body never
  // survives the handshake. Name the likely cause rather than printing a bare
  // numeric code the user cannot act on.
  const detail = event.reason?.trim();
  if (detail) {
    return `Live-voice session closed before it opened: ${detail}`;
  }
  return (
    "Live-voice session closed before it opened " +
    `(code ${event.code}). The gateway may have rejected the credential: ` +
    "try 'vellum wake' to lease a fresh one."
  );
}
