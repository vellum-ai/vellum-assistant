import type { AssistantConnection } from "../types.js";

/**
 * Loose shape of the messages the daemon publishes over `GET /v1/events`.
 * The daemon's `ServerMessage` discriminated union has dozens of arms;
 * the HUD only needs a handful, so we model the rest as `Record<string,
 * unknown>` and let consumers narrow on the discriminator.
 */
export interface GatewayServerMessage {
  readonly type: string;
  readonly conversationId?: string;
  readonly text?: string;
  readonly delta?: string;
  readonly content?: string;
  readonly role?: "user" | "assistant" | "system";
  readonly messageId?: string;
  readonly [key: string]: unknown;
}

export interface GatewayEventEnvelope {
  readonly conversationId?: string;
  readonly message?: GatewayServerMessage;
}

export interface GatewayEventStreamHandlers {
  onEvent(event: GatewayEventEnvelope): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const SSE_INTERFACE_ID = "tauri";

export class GatewayEventStream {
  private readonly connection: AssistantConnection;
  private readonly handlers: GatewayEventStreamHandlers;
  private abort: AbortController | null = null;
  private retryAttempt = 0;
  private stopped = false;

  constructor(
    connection: AssistantConnection,
    handlers: GatewayEventStreamHandlers,
  ) {
    this.connection = connection;
    this.handlers = handlers;
  }

  start(): void {
    if (this.stopped) return;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.retryAttempt = 0;
      } catch (error) {
        if (this.stopped) return;
        this.handlers.onError?.(error);
        const delay =
          RECONNECT_BACKOFF_MS[
            Math.min(this.retryAttempt, RECONNECT_BACKOFF_MS.length - 1)
          ];
        this.retryAttempt += 1;
        await sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    this.abort = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "X-Vellum-Interface-Id": SSE_INTERFACE_ID,
    };
    if (this.connection.bearerToken) {
      headers["Authorization"] = `Bearer ${this.connection.bearerToken}`;
    }

    const url = `${this.connection.httpBaseUrl}/v1/events`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: this.abort.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }

    this.handlers.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          this.processFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processFrame(frame: string): void {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      try {
        const parsed = JSON.parse(payload) as GatewayEventEnvelope;
        this.handlers.onEvent(parsed);
      } catch {
        // Heartbeats and malformed frames are silently dropped.
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
