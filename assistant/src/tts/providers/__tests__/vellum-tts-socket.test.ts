import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { VellumTtsSocketOptions } from "../vellum-tts-socket.js";
import { synthesizeOverVellumTtsSocket } from "../vellum-tts-socket.js";

const TEST_URL =
  "ws://gateway.test/v1/speech/tts/stream?key=tok&encoding=linear16&sample_rate=16000";

type WsEventType = "open" | "close" | "error" | "message";
type WsListener = (...args: unknown[]) => void;

/** Minimal mock WebSocket simulating the gateway speech relay. */
class MockWebSocket {
  readyState = 0;
  binaryType = "";
  sentData: (string | Uint8Array)[] = [];
  closeCalled = false;

  private listeners = new Map<WsEventType, WsListener[]>();

  addEventListener(type: WsEventType, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.sentData.push(data);
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = 3;
  }

  simulateOpen(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) {
      l();
    }
  }

  simulateMessage(data: unknown): void {
    for (const l of this.listeners.get("message") ?? []) {
      l({ data });
    }
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) {
      l({ code, reason });
    }
  }

  simulateError(err: unknown = new Error("boom")): void {
    for (const l of this.listeners.get("error") ?? []) {
      l(err);
    }
  }
}

function audioFrame(bytes: string): ArrayBuffer {
  const buf = Buffer.from(bytes);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function sentJson(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.sentData
    .filter((d): d is string => typeof d === "string")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

describe("synthesizeOverVellumTtsSocket", () => {
  let mockWs: MockWebSocket;
  let originalWebSocket: unknown;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(_url: string) {
        return mockWs;
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  function startSession(
    overrides: Partial<VellumTtsSocketOptions> = {},
  ): Promise<Buffer> {
    return synthesizeOverVellumTtsSocket({
      url: TEST_URL,
      text: "hello world",
      makeTimeoutError: (ms) => new Error(`timeout:${ms}`),
      makeStreamError: (detail) => new Error(`stream:${detail}`),
      makeEmptyError: () => new Error("empty"),
      makeRelayError: (code, detail) => new Error(`relay:${code}:${detail}`),
      ...overrides,
    });
  }

  test("sends Speak then Flush, resolves concatenated audio on Flushed", async () => {
    const chunks: Uint8Array[] = [];
    const session = startSession({ onChunk: (c) => chunks.push(c) });

    mockWs.simulateOpen();
    expect(sentJson(mockWs)).toEqual([
      { type: "Speak", text: "hello world" },
      { type: "Flush" },
    ]);
    expect(mockWs.binaryType).toBe("arraybuffer");

    mockWs.simulateMessage(audioFrame("aaa"));
    mockWs.simulateMessage(JSON.stringify({ type: "Metadata" }));
    mockWs.simulateMessage(audioFrame("bbb"));
    mockWs.simulateMessage(JSON.stringify({ type: "Flushed" }));

    const audio = await session;
    expect(audio.toString()).toBe("aaabbb");
    expect(chunks.map((c) => Buffer.from(c).toString())).toEqual([
      "aaa",
      "bbb",
    ]);
    // Close is sent after Flushed, then the socket is torn down.
    expect(sentJson(mockWs).at(-1)).toEqual({ type: "Close" });
    expect(mockWs.closeCalled).toBe(true);
  });

  test("splits long text into 2000-char Speak frames before one Flush", async () => {
    const text = "x".repeat(4500);
    const session = startSession({ text });

    mockWs.simulateOpen();
    const frames = sentJson(mockWs);
    expect(frames.map((f) => f.type)).toEqual([
      "Speak",
      "Speak",
      "Speak",
      "Flush",
    ]);
    expect(
      frames
        .slice(0, 3)
        .map((f) => (f.text as string).length)
        .reduce((a, b) => a + b, 0),
    ).toBe(4500);

    mockWs.simulateMessage(audioFrame("a"));
    mockWs.simulateMessage(JSON.stringify({ type: "Flushed" }));
    await session;
  });

  test("a velay_error frame fails via the relay-error factory", async () => {
    const session = startSession();
    mockWs.simulateOpen();

    mockWs.simulateMessage(
      JSON.stringify({
        type: "velay_error",
        code: "insufficient_balance",
        detail: "empty",
      }),
    );

    await expect(session).rejects.toThrow("relay:insufficient_balance:empty");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("abort sends Clear and Close for barge-in, rejects with the abort reason", async () => {
    const controller = new AbortController();
    const session = startSession({ signal: controller.signal });
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioFrame("partial"));

    controller.abort();

    await expect(session).rejects.toThrow(/aborted/i);
    const frames = sentJson(mockWs);
    expect(frames.at(-2)).toEqual({ type: "Clear" });
    expect(frames.at(-1)).toEqual({ type: "Close" });
    expect(mockWs.closeCalled).toBe(true);
  });

  test("close before Flushed fails via the stream-error factory", async () => {
    const session = startSession();
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioFrame("partial"));

    mockWs.simulateClose(1011, "upstream_error");

    await expect(session).rejects.toThrow(/stream:socket closed/);
  });

  test("Flushed with no audio fails via the empty-error factory", async () => {
    const session = startSession();
    mockWs.simulateOpen();
    mockWs.simulateMessage(JSON.stringify({ type: "Flushed" }));

    await expect(session).rejects.toThrow("empty");
  });

  test("typed-array binary frames are forwarded as chunks", async () => {
    const chunks: Uint8Array[] = [];
    const session = startSession({ onChunk: (c) => chunks.push(c) });
    mockWs.simulateOpen();

    mockWs.simulateMessage(new Uint8Array(Buffer.from("view")));
    mockWs.simulateMessage(JSON.stringify({ type: "Flushed" }));

    const audio = await session;
    expect(audio.toString()).toBe("view");
    expect(chunks).toHaveLength(1);
  });

  test("control frames do not collapse the first-chunk budget", async () => {
    // Deepgram sends Metadata immediately on connect; the stall budget must
    // stay on firstChunkTimeoutMs until actual audio arrives.
    const session = startSession({
      firstChunkTimeoutMs: 50,
      idleTimeoutMs: 1,
    });
    mockWs.simulateOpen();
    mockWs.simulateMessage(JSON.stringify({ type: "Metadata" }));

    // Idle budget (1ms) would have expired well within this window; the
    // first-chunk budget (50ms) has not.
    await new Promise((r) => setTimeout(r, 20));
    mockWs.simulateMessage(audioFrame("late"));
    mockWs.simulateMessage(JSON.stringify({ type: "Flushed" }));

    const audio = await session;
    expect(audio.toString()).toBe("late");
  });

  test("pre-aborted signal rejects without dialing frames", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = startSession({ signal: controller.signal });

    await expect(session).rejects.toThrow(/aborted/i);
    expect(mockWs.sentData).toHaveLength(0);
  });
});
