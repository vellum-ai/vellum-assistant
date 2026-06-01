import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import {
  buildLiveVoiceWebSocketUrl,
  LiveVoiceChannelClient,
  type LiveVoiceChannelEvent,
  type LiveVoiceChannelFailure,
  type LiveVoiceWebSocketLike,
} from "@/domains/voice/live-voice/live-voice-channel-client";
import {
  base64ToPcm16,
  pcm16ToBase64,
} from "@/domains/voice/live-voice/protocol";

// Mock the gateway-session module so we never touch localStorage from
// tests. Lint rule `no-restricted-syntax` blocks writing tokens to
// localStorage, and mocking lets us drive `getGatewayToken()` directly.
let mockToken: string | null = "test-token";
// Indirection so individual tests can override token acquisition (e.g.
// simulate a refresh failure) without re-mocking the whole module.
let ensureGatewayTokenImpl: () => Promise<string> = async () => mockToken ?? "";
mock.module("@/lib/auth/gateway-session", () => ({
  getGatewayToken: () => mockToken,
  clearGatewayToken: () => {
    mockToken = null;
  },
  isGatewayAuthEnabled: () => true,
  isGatewayAuthMode: () => mockToken !== null,
  ensureGatewayToken: () => ensureGatewayTokenImpl(),
  getLocalTokenUrl: () => undefined,
}));

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface SentRecord {
  data: string | ArrayBufferLike | ArrayBufferView | Blob;
}

class MockWebSocket implements LiveVoiceWebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState: number = MockWebSocket.CONNECTING;

  onopen: ((this: LiveVoiceWebSocketLike, ev: Event) => unknown) | null = null;
  onclose:
    | ((this: LiveVoiceWebSocketLike, ev: CloseEvent) => unknown)
    | null = null;
  onerror: ((this: LiveVoiceWebSocketLike, ev: Event) => unknown) | null = null;
  onmessage:
    | ((this: LiveVoiceWebSocketLike, ev: MessageEvent) => unknown)
    | null = null;

  readonly sent: SentRecord[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.sent.push({ data });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = MockWebSocket.CLOSED;
  }

  // -------- Test helpers --------

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.call(this, new Event("open"));
  }

  emitText(payload: string): void {
    this.onmessage?.call(this, new MessageEvent("message", { data: payload }));
  }

  emitJson(frame: Record<string, unknown>): void {
    this.emitText(JSON.stringify(frame));
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(
      this,
      new CloseEvent("close", { code, reason, wasClean: code === 1000 }),
    );
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let originalWebSocket: unknown;

beforeEach(() => {
  MockWebSocket.instances = [];
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  mockToken = "test-token";
  ensureGatewayTokenImpl = async () => mockToken ?? "";
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  mockToken = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLiveVoiceWebSocketUrl", () => {
  test("uses window.origin and ws scheme for http origin", () => {
    const url = buildLiveVoiceWebSocketUrl("abc");
    expect(url.startsWith("ws://localhost:3000/v1/live-voice?token=abc")).toBe(
      true,
    );
  });

  test("url-encodes the token", () => {
    const url = buildLiveVoiceWebSocketUrl("a/b+c=");
    expect(url).toContain(`token=${encodeURIComponent("a/b+c=")}`);
  });
});

describe("LiveVoiceChannelClient", () => {
  test("start sends the encoded start frame after the WS opens", async () => {
    const client = new LiveVoiceChannelClient();
    const onEvent = mock((_e: LiveVoiceChannelEvent) => {});
    const onFailure = mock((_f: LiveVoiceChannelFailure) => {});

    await client.start({
      conversationId: "conv-1",
      onEvent,
      onFailure,
    });

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws!.binaryType).toBe("arraybuffer");
    expect(client.getState()).toBe("connecting");

    ws!.emitOpen();

    expect(ws!.sent.length).toBe(1);
    expect(typeof ws!.sent[0]!.data).toBe("string");
    const decoded = JSON.parse(ws!.sent[0]!.data as string) as Record<
      string,
      unknown
    >;
    expect(decoded).toEqual({
      type: "start",
      conversationId: "conv-1",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
    });

    client.close();
  });

  test("ready server frame transitions state to active and fires onEvent", async () => {
    const client = new LiveVoiceChannelClient();
    const onEvent = mock((_e: LiveVoiceChannelEvent) => {});
    const onFailure = mock((_f: LiveVoiceChannelFailure) => {});

    await client.start({ onEvent, onFailure });
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();

    ws.emitJson({
      type: "ready",
      seq: 0,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });

    expect(client.getState()).toBe("active");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toEqual({
      type: "ready",
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
    expect(onFailure).not.toHaveBeenCalled();

    client.close();
  });

  test("sendAudio writes binary while active and drops otherwise", async () => {
    const client = new LiveVoiceChannelClient();
    await client.start({ onEvent: () => {}, onFailure: () => {} });
    const ws = MockWebSocket.instances[0]!;

    const samples = new Int16Array([1, -2, 3, -4]);

    // While connecting, sendAudio is dropped.
    client.sendAudio(samples);
    expect(ws.sent.length).toBe(0);

    ws.emitOpen();
    // The start frame is now the first sent item.
    expect(ws.sent.length).toBe(1);

    ws.emitJson({
      type: "ready",
      seq: 0,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
    expect(client.getState()).toBe("active");

    client.sendAudio(samples);
    expect(ws.sent.length).toBe(2);
    const binary = ws.sent[1]!.data;
    expect(ArrayBuffer.isView(binary)).toBe(true);
    expect((binary as ArrayBufferView).byteLength).toBe(samples.byteLength);

    // Also accepts ArrayBuffer directly.
    const buf = new ArrayBuffer(8);
    client.sendAudio(buf);
    expect(ws.sent.length).toBe(3);
    expect(ws.sent[2]!.data).toBe(buf);

    client.close();

    // After close, sendAudio is a no-op.
    client.sendAudio(samples);
    expect(ws.sent.length).toBe(3);
  });

  test("connection timeout fires onFailure(timeout)", async () => {
    // Capture timeout callbacks by intercepting setTimeout. We only
    // trigger the *first* registered callback (the 10s connection
    // timeout); other callbacks fall through to the real timer so
    // `await client.start(...)` still resolves normally.
    const realSetTimeout = globalThis.setTimeout;
    const captured: Array<() => void> = [];
    const stub = ((handler: TimerHandler, ms?: number) => {
      if (typeof handler === "function" && ms === 10_000) {
        captured.push(handler as () => void);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout;
    globalThis.setTimeout = stub;

    try {
      const client = new LiveVoiceChannelClient();
      const failures: LiveVoiceChannelFailure[] = [];

      await client.start({
        onEvent: () => {},
        onFailure: (f) => failures.push(f),
      });
      const ws = MockWebSocket.instances[0]!;
      ws.emitOpen();
      // Do NOT emit `ready`; manually fire the captured 10s timeout.
      expect(captured.length).toBe(1);
      captured[0]!();

      expect(failures.length).toBe(1);
      expect(failures[0]).toEqual({
        type: "timeout",
        message: "ready frame not received",
      });
      expect(client.getState()).toBe("closed");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("protocol-error server frame fires onFailure(protocolError)", async () => {
    const client = new LiveVoiceChannelClient();
    const failures: LiveVoiceChannelFailure[] = [];

    await client.start({
      onEvent: () => {},
      onFailure: (f) => failures.push(f),
    });
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "ready",
      seq: 0,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
    ws.emitJson({
      type: "error",
      seq: 1,
      code: "invalid_frame",
      message: "oops",
    });

    expect(failures.length).toBe(1);
    expect(failures[0]).toEqual({
      type: "protocolError",
      code: "invalid_frame",
      message: "oops",
    });
    expect(client.getState()).toBe("closed");
  });

  test("end then close are idempotent", async () => {
    // Patch setTimeout so the 1s end-grace timer fires immediately and
    // the connection-timeout (10s) registration becomes a no-op.
    const realSetTimeout = globalThis.setTimeout;
    const stub = ((handler: TimerHandler, ms?: number) => {
      if (typeof handler === "function" && (ms === 1_000 || ms === 10_000)) {
        if (ms === 1_000) (handler as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout;
    globalThis.setTimeout = stub;

    try {
      const client = new LiveVoiceChannelClient();
      await client.start({ onEvent: () => {}, onFailure: () => {} });
      const ws = MockWebSocket.instances[0]!;
      ws.emitOpen();
      ws.emitJson({
        type: "ready",
        seq: 0,
        sessionId: "sess-1",
        conversationId: "conv-1",
      });

      const endPromise = client.end();
      // The "end" control frame should have been sent.
      const sentTypes = ws.sent.map((s) => {
        try {
          return JSON.parse(s.data as string).type as string;
        } catch {
          return null;
        }
      });
      expect(sentTypes).toContain("end");

      await endPromise;
      expect(client.getState()).toBe("closed");
      expect(ws.closeCalls.length).toBe(1);

      // Subsequent end() and close() must be no-ops.
      await client.end();
      client.close();
      expect(ws.closeCalls.length).toBe(1);
      expect(client.getState()).toBe("closed");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("tts_audio frame decodes base64 and surfaces as ttsAudio with Uint8Array", async () => {
    const client = new LiveVoiceChannelClient();
    const events: LiveVoiceChannelEvent[] = [];

    await client.start({
      onEvent: (e) => events.push(e),
      onFailure: () => {},
    });
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "ready",
      seq: 0,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });

    const pcm = new Int16Array([100, -200, 300, -400, 500, -600]);
    const dataBase64 = pcm16ToBase64(pcm);

    ws.emitJson({
      type: "tts_audio",
      seq: 1,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64,
    });

    const ttsEvent = events.find(
      (e): e is Extract<LiveVoiceChannelEvent, { type: "ttsAudio" }> =>
        e.type === "ttsAudio",
    );
    expect(ttsEvent).toBeDefined();
    expect(ttsEvent!.mimeType).toBe("audio/pcm");
    expect(ttsEvent!.sampleRate).toBe(24000);
    expect(ttsEvent!.pcm).toBeInstanceOf(Uint8Array);
    expect(ttsEvent!.pcm.byteLength).toBe(pcm.byteLength);

    // Round-trip: decode the surfaced Uint8Array back into Int16 samples.
    const roundTripped = new Int16Array(
      ttsEvent!.pcm.buffer,
      ttsEvent!.pcm.byteOffset,
      ttsEvent!.pcm.byteLength / 2,
    );
    expect(Array.from(roundTripped)).toEqual(Array.from(pcm));
    // Sanity-check the helper too.
    expect(Array.from(base64ToPcm16(dataBase64))).toEqual(Array.from(pcm));

    client.close();
  });

  test("gateway token acquisition failure fails fast", async () => {
    // `ensureGatewayToken` rejecting models an expired/unprimed session
    // that couldn't be refreshed — voice no longer reads a bare cached
    // token, it acquires on demand like the rest of the app.
    const restore = ensureGatewayTokenImpl;
    ensureGatewayTokenImpl = async () => {
      throw new Error("token request failed");
    };
    try {
      const client = new LiveVoiceChannelClient();
      const failures: LiveVoiceChannelFailure[] = [];

      await client.start({
        onEvent: () => {},
        onFailure: (f) => failures.push(f),
      });

      expect(failures.length).toBe(1);
      expect(failures[0]).toEqual({
        type: "connectionFailed",
        message:
          "Couldn't authenticate the voice session — refresh the page and try again.",
      });
      expect(client.getState()).toBe("closed");
      expect(MockWebSocket.instances.length).toBe(0);
    } finally {
      ensureGatewayTokenImpl = restore;
    }
  });

  test("end() resolves even when teardown clears the grace timer first", async () => {
    // Patch setTimeout so the 1 s end-grace timer never fires on its
    // own (we want to drive teardown manually). The 10 s connection
    // timeout is also a no-op so `start()` resolves cleanly.
    const realSetTimeout = globalThis.setTimeout;
    const stub = ((handler: TimerHandler, ms?: number) => {
      if (typeof handler === "function" && (ms === 1_000 || ms === 10_000)) {
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout;
    globalThis.setTimeout = stub;

    try {
      const client = new LiveVoiceChannelClient();
      await client.start({ onEvent: () => {}, onFailure: () => {} });
      const ws = MockWebSocket.instances[0]!;
      ws.emitOpen();
      ws.emitJson({
        type: "ready",
        seq: 0,
        sessionId: "sess-1",
        conversationId: "conv-1",
      });
      expect(client.getState()).toBe("active");

      // Kick off end() but don't await it — the grace timer is
      // stubbed to never fire, so end() is parked on the Promise.
      const endPromise = client.end();
      expect(client.getState()).toBe("ending");

      // Force teardown via a WS abnormal close before the grace timer
      // fires. handleClose -> teardown clears the grace timer; before
      // the fix this orphans the resolver and end() would hang.
      ws.emitClose(1006, "abnormal");

      // The awaited end() must now resolve rather than hang.
      await endPromise;
      expect(client.getState()).toBe("closed");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("busy server frame fires onFailure(busy)", async () => {
    const client = new LiveVoiceChannelClient();
    const failures: LiveVoiceChannelFailure[] = [];

    await client.start({
      onEvent: () => {},
      onFailure: (f) => failures.push(f),
    });
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({ type: "busy", seq: 0, activeSessionId: "other-sess" });

    expect(failures).toEqual([
      { type: "busy", activeSessionId: "other-sess" },
    ]);
    expect(client.getState()).toBe("closed");
  });
});
