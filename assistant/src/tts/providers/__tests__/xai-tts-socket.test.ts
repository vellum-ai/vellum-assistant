import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { XaiTtsSocketOptions } from "../xai-tts-socket.js";
import { synthesizeOverXaiTtsSocket } from "../xai-tts-socket.js";

const TEST_API_KEY = "xai-test-key-for-tts";
const TEST_URL =
  "wss://api.x.ai/v1/tts?language=auto&voice=eve&codec=pcm&sample_rate=16000";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsEventType = "open" | "close" | "error" | "message";
type WsListener = (...args: unknown[]) => void;

/**
 * Minimal mock WebSocket simulating the xAI TTS endpoint. Tests drive
 * behavior via helper methods (`simulateOpen`, `simulateMessage`, …).
 */
class MockWebSocket {
  readyState = 0; // CONNECTING

  /** All data sent via `.send()`. */
  sentData: (string | Uint8Array)[] = [];

  /** Whether `.close()` was called. */
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
    this.readyState = 3; // CLOSED
  }

  // ── Test helpers ──────────────────────────────────────────────────

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    for (const l of this.listeners.get("open") ?? []) l();
  }

  simulateMessage(data: unknown): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) l({ code, reason });
  }

  simulateError(err: unknown = new Error("boom")): void {
    for (const l of this.listeners.get("error") ?? []) l(err);
  }
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function audioDeltaFrame(bytes: string): string {
  return JSON.stringify({
    type: "audio.delta",
    delta: Buffer.from(bytes).toString("base64"),
  });
}

const AUDIO_DONE_FRAME = JSON.stringify({
  type: "audio.done",
  trace_id: "trace-1",
});

function errorFrame(message: string): string {
  return JSON.stringify({ type: "error", message });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("synthesizeOverXaiTtsSocket", () => {
  let mockWs: MockWebSocket;
  let constructorCalls: {
    url: string;
    options?: { headers?: Record<string, string> };
  }[];
  let originalWebSocket: unknown;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    constructorCalls = [];
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;

    const ws = mockWs;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(
        url: string,
        options?: { headers?: Record<string, string> },
      ) {
        constructorCalls.push({ url, options });
        return ws;
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  function makeOptions(
    overrides: Partial<XaiTtsSocketOptions> = {},
  ): XaiTtsSocketOptions {
    return {
      url: TEST_URL,
      apiKey: TEST_API_KEY,
      text: "Hello world",
      connectTimeoutMs: 1_000,
      firstChunkTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      makeTimeoutError: (timeoutMs) => new Error(`timed out after ${timeoutMs}ms`),
      makeStreamError: (detail) => new Error(`stream failed: ${detail}`),
      makeEmptyError: () => new Error("empty audio"),
      ...overrides,
    };
  }

  /** Frames sent by the session, parsed as JSON. */
  function sentFrames(): { type?: string; delta?: string }[] {
    return mockWs.sentData.map((d) => JSON.parse(d as string));
  }

  // ── Connect + text framing ─────────────────────────────────────────

  test("passes the exact URL and Authorization header to the constructor", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioDeltaFrame("pcm"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);
    await promise;

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]!.url).toBe(TEST_URL);
    expect(constructorCalls[0]!.options?.headers?.Authorization).toBe(
      `Bearer ${TEST_API_KEY}`,
    );
  });

  test("sends text.delta then text.done after open", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions({ text: "Hi there" }));
    mockWs.simulateOpen();

    expect(sentFrames()).toEqual([
      { type: "text.delta", delta: "Hi there" },
      { type: "text.done" },
    ]);

    mockWs.simulateMessage(audioDeltaFrame("pcm"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);
    await promise;
  });

  test("splits >15,000-char text into multiple text.delta frames before one text.done", async () => {
    const text = "a".repeat(15_000) + "b".repeat(500);
    const promise = synthesizeOverXaiTtsSocket(makeOptions({ text }));
    mockWs.simulateOpen();

    const frames = sentFrames();
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ type: "text.delta", delta: "a".repeat(15_000) });
    expect(frames[1]).toEqual({ type: "text.delta", delta: "b".repeat(500) });
    expect(frames[2]).toEqual({ type: "text.done" });

    mockWs.simulateMessage(audioDeltaFrame("pcm"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);
    await promise;
  });

  // ── Audio streaming ────────────────────────────────────────────────

  test("decodes audio.delta frames in order and resolves with the concatenation", async () => {
    const received: Buffer[] = [];
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ onChunk: (chunk) => received.push(Buffer.from(chunk)) }),
    );
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioDeltaFrame("chunk-1"));
    mockWs.simulateMessage(audioDeltaFrame("chunk-2"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);

    const audio = await promise;
    expect(received.map((c) => c.toString())).toEqual(["chunk-1", "chunk-2"]);
    expect(audio.toString()).toBe("chunk-1chunk-2");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("skips zero-length audio deltas without invoking onChunk", async () => {
    const received: Buffer[] = [];
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ onChunk: (chunk) => received.push(Buffer.from(chunk)) }),
    );
    mockWs.simulateOpen();
    mockWs.simulateMessage(JSON.stringify({ type: "audio.delta", delta: "" }));
    mockWs.simulateMessage(audioDeltaFrame("real"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);

    const audio = await promise;
    expect(received.map((c) => c.toString())).toEqual(["real"]);
    expect(audio.toString()).toBe("real");
  });

  test("ignores unparseable frames and unknown frame types", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateMessage("not-json{");
    mockWs.simulateMessage(JSON.stringify({ type: "something.else" }));
    mockWs.simulateMessage(audioDeltaFrame("pcm"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);

    const audio = await promise;
    expect(audio.toString()).toBe("pcm");
  });

  // ── Timeouts ───────────────────────────────────────────────────────

  test("rejects via makeTimeoutError when the socket never opens", async () => {
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ connectTimeoutMs: 20 }),
    );
    await expect(promise).rejects.toThrow("timed out after 20ms");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("rejects via makeTimeoutError when no server frame arrives after text.done", async () => {
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ firstChunkTimeoutMs: 20 }),
    );
    mockWs.simulateOpen();
    await expect(promise).rejects.toThrow("timed out after 20ms");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("rejects via makeTimeoutError when the stream goes idle mid-utterance", async () => {
    const received: Buffer[] = [];
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({
        idleTimeoutMs: 20,
        onChunk: (chunk) => received.push(Buffer.from(chunk)),
      }),
    );
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioDeltaFrame("only-chunk"));

    await expect(promise).rejects.toThrow("timed out after 20ms");
    expect(received.map((c) => c.toString())).toEqual(["only-chunk"]);
    expect(mockWs.closeCalled).toBe(true);
  });

  // ── Protocol + transport errors ────────────────────────────────────

  test("rejects via makeStreamError on an error frame", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateMessage(errorFrame("voice not found"));

    await expect(promise).rejects.toThrow("stream failed: voice not found");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("rejects via makeStreamError on unexpected close before audio.done", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateClose(1006, "abnormal closure");

    await expect(promise).rejects.toThrow(/1006/);
  });

  test("rejects via makeStreamError on a socket error event", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateError(new Error("connection reset"));

    await expect(promise).rejects.toThrow("stream failed: connection reset");
    expect(mockWs.closeCalled).toBe(true);
  });

  test("rejects via makeEmptyError when audio.done arrives with no audio bytes", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateMessage(AUDIO_DONE_FRAME);

    await expect(promise).rejects.toThrow("empty audio");
    expect(mockWs.closeCalled).toBe(true);
  });

  // ── Abort ──────────────────────────────────────────────────────────

  test("abort mid-stream rejects with AbortError and closes the socket", async () => {
    const controller = new AbortController();
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ signal: controller.signal }),
    );
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioDeltaFrame("partial"));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(mockWs.closeCalled).toBe(true);
  });

  test("pre-aborted signal rejects immediately without constructing a socket", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = synthesizeOverXaiTtsSocket(
      makeOptions({ signal: controller.signal }),
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(constructorCalls).toHaveLength(0);
  });

  // ── Settle guard ───────────────────────────────────────────────────

  test("error frame after audio.done does not double-settle", async () => {
    const promise = synthesizeOverXaiTtsSocket(makeOptions());
    mockWs.simulateOpen();
    mockWs.simulateMessage(audioDeltaFrame("pcm"));
    mockWs.simulateMessage(AUDIO_DONE_FRAME);
    mockWs.simulateMessage(errorFrame("late error"));
    mockWs.simulateClose(1000, "");

    const audio = await promise;
    expect(audio.toString()).toBe("pcm");
  });
});
