import { describe, expect, test } from "bun:test";

import {
  LiveVoiceChannelClient,
  type LiveVoiceChannelClientClosed,
  type LiveVoiceChannelClientError,
  type LiveVoiceWebSocketCloseEvent,
  type LiveVoiceWebSocketConstructor,
  type LiveVoiceWebSocketMessageEvent,
  type LiveVoiceWebSocketOptions,
} from "../lib/live-voice/channel-client.js";

type FakeListener = (event?: unknown) => void;

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: (string | ArrayBuffer | Uint8Array)[] = [];
  readonly listeners = new Map<string, Set<FakeListener>>();
  readyState = 0;
  binaryType = "";
  closeCalls = 0;

  constructor(
    readonly url: string | URL,
    readonly options?: LiveVoiceWebSocketOptions,
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(data: unknown): void {
    this.emit("message", { data } satisfies LiveVoiceWebSocketMessageEvent);
  }

  remoteClose(code: number, reason: string): void {
    this.readyState = 3;
    this.emit("close", {
      code,
      reason,
    } satisfies LiveVoiceWebSocketCloseEvent);
  }

  error(): void {
    this.emit("error");
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeClient(options?: {
  url?: string;
  headers?: Readonly<Record<string, string>>;
  connectTimeoutMs?: number;
}): { client: LiveVoiceChannelClient; socket: () => FakeWebSocket } {
  FakeWebSocket.instances.length = 0;
  const client = new LiveVoiceChannelClient({
    url: options?.url ?? "ws://127.0.0.1:7830/v1/live-voice",
    headers: options?.headers,
    connectTimeoutMs: options?.connectTimeoutMs,
    webSocketConstructor:
      FakeWebSocket as unknown as LiveVoiceWebSocketConstructor,
  });
  return {
    client,
    socket: () => {
      const socket = FakeWebSocket.instances[0];
      if (!socket) {
        throw new Error("Expected a WebSocket");
      }
      return socket;
    },
  };
}

function readyFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ready",
    seq: 1,
    sessionId: "session-123",
    conversationId: "conversation-123",
    ...overrides,
  });
}

describe("live-voice channel client", () => {
  test("constructs a direct socket with Bun headers", () => {
    const { client, socket } = makeClient({
      headers: { Authorization: "Bearer guardian-secret" },
    });
    client.connect();

    expect(String(socket().url)).toBe("ws://127.0.0.1:7830/v1/live-voice");
    expect(socket().options).toEqual({
      headers: { Authorization: "Bearer guardian-secret" },
    });
    client.close();
  });

  test("sends the typed CLI start frame first", () => {
    const { client, socket } = makeClient();
    client.connect({
      conversationId: "conversation-123",
      turnDetection: "server_vad",
      silenceThresholdMs: 750,
      bargeInMinSpeechMs: 250,
    });
    socket().open();

    expect(socket().sent).toHaveLength(1);
    expect(JSON.parse(String(socket().sent[0]))).toEqual({
      type: "start",
      audio: {
        mimeType: "audio/pcm",
        sampleRate: 16_000,
        channels: 1,
      },
      sourceInterface: "cli",
      conversationId: "conversation-123",
      turnDetection: "server_vad",
      silenceThresholdMs: 750,
      bargeInMinSpeechMs: 250,
    });
    client.close();
  });

  test("preserves raw PCM binary identity", () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    socket().message(readyFrame());

    const pcm = new Uint8Array([1, 2, 3, 4]);
    client.sendAudio(pcm);

    expect(socket().sent[1]).toBe(pcm);
    client.close();
  });

  test("sends controls in call order", () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    socket().message(readyFrame());

    client.pttRelease();
    client.interrupt();
    client.updateConfig({
      silenceThresholdMs: 800,
      bargeInMinSpeechMs: 300,
    });
    client.end();

    expect(
      socket()
        .sent.slice(1)
        .map((frame) => JSON.parse(String(frame))),
    ).toEqual([
      { type: "ptt_release" },
      { type: "interrupt" },
      {
        type: "update_config",
        silenceThresholdMs: 800,
        bargeInMinSpeechMs: 300,
      },
      { type: "end" },
    ]);
  });

  test("can request end while keeping the socket open for release confirmation", () => {
    const { client, socket } = makeClient();
    const frames: string[] = [];
    client.on("frame", (frame) => {
      frames.push(frame.type);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());

    client.requestEnd();
    client.requestEnd();

    expect(JSON.parse(String(socket().sent.at(-1)))).toEqual({
      type: "end",
    });
    expect(
      socket().sent.filter(
        (frame) =>
          typeof frame === "string" && JSON.parse(frame).type === "end",
      ),
    ).toHaveLength(1);
    expect(socket().closeCalls).toBe(0);

    socket().message(
      JSON.stringify({
        type: "metrics",
        seq: 2,
        event: "session_ended",
        sessionId: "session-123",
        turnId: "session",
        sttMs: null,
        llmFirstDeltaMs: null,
        ttsFirstAudioMs: null,
        totalMs: 0,
      }),
    );
    expect(frames).toEqual(["metrics"]);
    client.close();
  });

  test("does not send audio or controls before ready", () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();

    client.sendAudio(new Uint8Array([1, 2]));
    client.pttRelease();
    client.interrupt();
    client.updateConfig({ silenceThresholdMs: 500 });

    expect(socket().sent).toHaveLength(1);
    client.close();
  });

  test("surfaces ready and forwards server frames in arrival order", () => {
    const { client, socket } = makeClient();
    const events: string[] = [];
    client.on("ready", (frame) => {
      events.push(`ready:${frame.sessionId}`);
    });
    client.on("frame", (frame) => {
      events.push(`${frame.type}:${frame.seq}`);
    });
    client.connect();
    socket().open();

    socket().message(readyFrame());
    socket().message(
      JSON.stringify({ type: "thinking", seq: 2, turnId: "turn-123" }),
    );
    socket().message(
      JSON.stringify({
        type: "tts_done",
        seq: 3,
        turnId: "turn-123",
      }),
    );

    expect(events).toEqual(["ready:session-123", "thinking:2", "tts_done:3"]);
    client.close();
  });

  test("surfaces busy metadata and closes without stealing the session", () => {
    const { client, socket } = makeClient();
    const busyIds: string[] = [];
    const closed: LiveVoiceChannelClientClosed[] = [];
    client.on("busy", (frame) => {
      busyIds.push(frame.activeSessionId);
    });
    client.on("closed", (event) => {
      closed.push(event);
    });
    client.connect();
    socket().open();
    socket().message(
      JSON.stringify({
        type: "busy",
        seq: 2,
        activeSessionId: "other-session",
      }),
    );

    expect(busyIds).toEqual(["other-session"]);
    expect(closed).toEqual([
      {
        code: null,
        reason: "client closed",
        retryable: false,
      },
    ]);
    expect(socket().sent).toHaveLength(1);
  });

  test("ignores unknown future and unexpected binary server frames", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    const frames: string[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.on("frame", (frame) => {
      frames.push(frame.type);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());

    socket().message(
      JSON.stringify({ type: "future_frame", seq: 2, value: true }),
    );
    socket().message(new Uint8Array([1, 2, 3]));
    socket().message(
      JSON.stringify({ type: "thinking", seq: 3, turnId: "turn-123" }),
    );

    expect(errors).toEqual([]);
    expect(frames).toEqual(["thinking"]);
    client.close();
  });

  test("fails malformed JSON as a protocol error", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().open();
    socket().message("{not-json");

    expect(errors).toEqual([
      {
        reason: "protocol-error",
        code: "invalid_json",
        message: "Live voice server frame is not valid JSON",
      },
    ]);
    expect(socket().closeCalls).toBe(1);
  });

  test("keeps the socket alive after a recoverable server error", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());
    socket().message(
      JSON.stringify({
        type: "error",
        seq: 2,
        code: "temporary_failure",
        message: "Try again",
        recoverable: true,
      }),
    );
    client.pttRelease();

    expect(errors).toEqual([
      {
        reason: "protocol-error",
        code: "temporary_failure",
        message: "Try again",
        recoverable: true,
      },
    ]);
    expect(socket().closeCalls).toBe(0);
    expect(JSON.parse(String(socket().sent.at(-1)))).toEqual({
      type: "ptt_release",
    });
    client.close();
  });

  test("latches off unsupported update_config without ending the session", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());
    client.updateConfig({ silenceThresholdMs: 500 });
    socket().message(
      JSON.stringify({
        type: "error",
        seq: 2,
        code: "unknown_type",
        message: "Unknown frame",
      }),
    );
    client.updateConfig({ silenceThresholdMs: 600 });
    client.pttRelease();

    expect(errors).toEqual([]);
    expect(
      socket()
        .sent.slice(1)
        .map((frame) => JSON.parse(String(frame))),
    ).toEqual([
      { type: "update_config", silenceThresholdMs: 500 },
      { type: "ptt_release" },
    ]);
    client.close();
  });

  test("times out when ready does not arrive", async () => {
    const { client, socket } = makeClient({ connectTimeoutMs: 5 });
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().open();

    await Bun.sleep(15);

    expect(errors).toEqual([
      {
        reason: "timeout",
        message: "Live voice did not become ready within 5ms.",
      },
    ]);
    expect(socket().closeCalls).toBe(1);
  });

  test("classifies 1012 and 1013 closes as retryable", () => {
    for (const code of [1012, 1013]) {
      const { client, socket } = makeClient();
      const closed: LiveVoiceChannelClientClosed[] = [];
      client.on("closed", (event) => {
        closed.push(event);
      });
      client.connect();
      socket().open();
      socket().message(readyFrame());
      socket().remoteClose(code, "try again later");

      expect(closed).toEqual([
        {
          code,
          reason: "try again later",
          retryable: true,
        },
      ]);
    }
  });

  test("forwards retryable pre-ready closes without a terminal error", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    const closed: LiveVoiceChannelClientClosed[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.on("closed", (event) => {
      closed.push(event);
    });
    client.connect();
    socket().remoteClose(1013, "tunnel unavailable");

    expect(errors).toEqual([]);
    expect(closed).toEqual([
      {
        code: 1013,
        reason: "tunnel unavailable",
        retryable: true,
      },
    ]);
  });

  test("fails a non-retryable pre-ready close", () => {
    const { client, socket } = makeClient();
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().remoteClose(1006, "abnormal");

    expect(errors).toEqual([
      {
        reason: "connection-failed",
        message: "The live-voice WebSocket closed before it became ready.",
      },
    ]);
  });

  test("makes end and close idempotent in every state", () => {
    const idle = makeClient().client;
    const idleClosed: LiveVoiceChannelClientClosed[] = [];
    idle.on("closed", (event) => {
      idleClosed.push(event);
    });
    idle.end();
    idle.end();
    idle.close();
    expect(idleClosed).toHaveLength(1);

    const active = makeClient();
    const activeClosed: LiveVoiceChannelClientClosed[] = [];
    active.client.on("closed", (event) => {
      activeClosed.push(event);
    });
    active.client.connect();
    active.socket().open();
    active.socket().message(readyFrame());
    active.client.end();
    active.client.end();
    active.client.close();
    expect(activeClosed).toHaveLength(1);
    expect(active.socket().closeCalls).toBe(1);
    expect(
      active
        .socket()
        .sent.filter(
          (frame) =>
            typeof frame === "string" && JSON.parse(frame).type === "end",
        ),
    ).toHaveLength(1);
  });

  test("redacts query and header credentials from surfaced errors", () => {
    const token = "single-use secret";
    const guardian = "guardian-secret";
    const { client, socket } = makeClient({
      url: `wss://velay.example.com/assistant-123/v1/live-voice?token=${encodeURIComponent(token)}`,
      headers: { Authorization: `Bearer ${guardian}` },
    });
    const errors: LiveVoiceChannelClientError[] = [];
    client.on("error", (error) => {
      errors.push(error);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());
    socket().message(
      JSON.stringify({
        type: "error",
        seq: 2,
        code: "server_error",
        message: `failed ${token} ${encodeURIComponent(token)} ${token.replaceAll(" ", "+")} ${guardian}`,
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain(token);
    expect(errors[0]?.message).not.toContain(encodeURIComponent(token));
    expect(errors[0]?.message).not.toContain(token.replaceAll(" ", "+"));
    expect(errors[0]?.message).not.toContain(guardian);
  });

  test("removes listeners and ignores late events after teardown", () => {
    const { client, socket } = makeClient();
    const frames: string[] = [];
    client.on("frame", (frame) => {
      frames.push(frame.type);
    });
    client.connect();
    socket().open();
    socket().message(readyFrame());
    client.close();
    socket().message(
      JSON.stringify({ type: "thinking", seq: 2, turnId: "turn-123" }),
    );
    socket().remoteClose(1013, "late");

    expect(frames).toEqual([]);
    expect(
      [...socket().listeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
  });
});
