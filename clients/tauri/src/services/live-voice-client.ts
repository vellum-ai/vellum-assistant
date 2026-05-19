import type { AssistantConnection } from "../types.js";

/**
 * Subset of the assistant's live-voice protocol that the HUD speaks.
 * The full protocol lives at `assistant/src/live-voice/protocol.ts` —
 * we duplicate the wire shape rather than importing it because the
 * Tauri app is its own TypeScript project and does not link against
 * the daemon source.
 */
export type LiveVoiceClientFrame =
  | {
      readonly type: "start";
      readonly conversationId?: string;
      readonly sourceChannel?: "vellum";
      readonly sourceInterface?: "tauri";
      readonly audio: {
        readonly mimeType: "audio/pcm";
        readonly sampleRate: number;
        readonly channels: 1;
      };
    }
  | { readonly type: "audio"; readonly dataBase64: string }
  | { readonly type: "ptt_release" }
  | { readonly type: "interrupt" }
  | { readonly type: "end" };

export interface LiveVoiceServerFrame {
  readonly type: string;
  readonly seq?: number;
  readonly text?: string;
  readonly turnId?: string;
  readonly mimeType?: string;
  readonly sampleRate?: number;
  readonly dataBase64?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface LiveVoiceClientOptions {
  readonly sampleRate: number;
  readonly conversationKey?: string;
  readonly onFrame: (frame: LiveVoiceServerFrame) => void;
  readonly onOpen?: () => void;
  readonly onClose?: (event: CloseEvent) => void;
  readonly onError?: (error: unknown) => void;
}

export class LiveVoiceClient {
  private readonly connection: AssistantConnection;
  private readonly options: LiveVoiceClientOptions;
  private socket: WebSocket | null = null;
  private started = false;

  constructor(
    connection: AssistantConnection,
    options: LiveVoiceClientOptions,
  ) {
    this.connection = connection;
    this.options = options;
  }

  /** Opens the underlying WebSocket. Resolves once the start frame is sent. */
  async open(): Promise<void> {
    if (this.socket) return;

    const url = this.connection.bearerToken
      ? `${this.connection.wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(this.connection.bearerToken)}`
      : `${this.connection.wsBaseUrl}/v1/live-voice`;

    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Socket missing after construction"));
        return;
      }
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this.socket.addEventListener("open", () => {
        this.options.onOpen?.();
        resolveOnce();
      }, { once: true });
      this.socket.addEventListener("error", (event) => {
        this.options.onError?.(event);
        rejectOnce(
          new Error(
            "Unable to connect to live voice service. Verify Eli is running and reachable.",
          ),
        );
      }, { once: true });
      this.socket.addEventListener("close", (event) => {
        if (settled) return;
        const reason =
          event.reason && event.reason.trim().length > 0
            ? ` (${event.reason})`
            : "";
        rejectOnce(
          new Error(
            `Live voice socket closed before startup (code ${event.code})${reason}.`,
          ),
        );
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener("close", (event) => {
      this.options.onClose?.(event);
      this.socket = null;
      this.started = false;
    });
  }

  /**
   * Send the live-voice `start` frame. Call this once after the wake word
   * has been detected (or PTT pressed) — the daemon only opens an
   * active turn after receiving a `start` frame.
   */
  start(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("LiveVoiceClient.start() requires an open socket");
    }
    if (this.started) return;
    const frame: LiveVoiceClientFrame = {
      type: "start",
      conversationId: this.options.conversationKey ?? "default:vellum:handoff",
      sourceChannel: "vellum",
      sourceInterface: "tauri",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: this.options.sampleRate,
        channels: 1,
      },
    };
    this.sendJson(frame);
    this.started = true;
  }

  /** Push raw int16 PCM samples. Encodes to base64 for the JSON frame. */
  sendAudio(samples: Int16Array): void {
    if (!this.started) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const dataBase64 = encodeInt16ToBase64(samples);
    this.sendJson({ type: "audio", dataBase64 });
  }

  /** Tell the daemon the user is done speaking. */
  pttRelease(): void {
    if (!this.started) return;
    this.sendJson({ type: "ptt_release" });
    // After release the server is no longer accepting audio for this turn.
    // Close the client-side audio gate immediately so any late mic callbacks
    // from the browser audio pipeline are dropped locally.
    this.started = false;
  }

  /** Cancel current TTS playback / interrupt the assistant. */
  interrupt(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.sendJson({ type: "interrupt" });
  }

  end(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.sendJson({ type: "end" });
    this.started = false;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.started = false;
  }

  private sendJson(frame: LiveVoiceClientFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private handleMessage(data: ArrayBuffer | string): void {
    if (typeof data !== "string") return;
    try {
      const parsed = JSON.parse(data) as LiveVoiceServerFrame;
      this.options.onFrame(parsed);
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}

const BASE64_CHUNK_SAMPLES = 4096;

function encodeInt16ToBase64(samples: Int16Array): string {
  // Encode int16 little-endian PCM into base64. The byte buffer must be a
  // contiguous Uint8Array view to read raw bytes for btoa-style encoding.
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SAMPLES) {
    const slice = bytes.subarray(i, i + BASE64_CHUNK_SAMPLES);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
