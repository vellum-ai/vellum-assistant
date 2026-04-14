import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  createTwilioMediaWebsocketHandler,
  extractMediaStreamMetadata,
  getMediaStreamWebsocketHandlers,
} from "../http/routes/twilio-media-websocket.js";

// ---------------------------------------------------------------------------
// Auth setup — initialize signing key so JWT minting/validation works
// ---------------------------------------------------------------------------

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid edge JWT (aud=vellum-gateway) for test requests. */
function mintEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

// ---------------------------------------------------------------------------
// Preserve WebSocket readyState constants so mocking the constructor
// does not clobber the static values the source code compares against.
// ---------------------------------------------------------------------------
const WS_CONNECTING = WebSocket.CONNECTING; // 0
const WS_OPEN = WebSocket.OPEN; // 1
const WS_CLOSED = WebSocket.CLOSED; // 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

/**
 * Lightweight fake that mimics a Bun ServerWebSocket for the media-stream handler.
 * Tracks sent messages, close calls, and exposes `.data` for handler use.
 */
function createFakeDownstreamWs(data: Record<string, unknown> = {}) {
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    data,
    sent,
    closes,
    send: mock((msg: string | Uint8Array) => {
      sent.push(msg);
    }),
    close: mock((code?: number, reason?: string) => {
      closes.push({ code: code ?? 1000, reason: reason ?? "" });
    }),
  };
}

/**
 * Minimal fake WebSocket that stores addEventListener listeners so tests
 * can fire events synchronously, and tracks send / close calls.
 */
function createFakeUpstreamWs() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sent: unknown[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  return {
    readyState: WS_CONNECTING as number,
    sent,
    closes,
    listeners,
    addEventListener: mock(
      (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
      },
    ),
    send: mock((msg: unknown) => {
      sent.push(msg);
    }),
    close: mock((code?: number, reason?: string) => {
      closes.push({ code, reason });
    }),
    /** Simulate firing an event on this fake socket. */
    emit(event: string, detail: unknown = {}) {
      for (const cb of listeners[event] ?? []) {
        cb(detail);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata extraction tests
// ---------------------------------------------------------------------------

describe("extractMediaStreamMetadata", () => {
  test("extracts callSessionId and token from path segments", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream/sess-42/my-token",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("sess-42");
    expect(result.token).toBe("my-token");
  });

  test("extracts callSessionId from path when token is absent", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream/sess-42",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("sess-42");
    expect(result.token).toBeNull();
  });

  test("decodes percent-encoded path segments", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream/s%26id%3D1/tok%2Fen",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("s&id=1");
    expect(result.token).toBe("tok/en");
  });

  test("falls back to query parameters when path has no segments", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream?callSessionId=qs-1&token=qs-tok",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("qs-1");
    expect(result.token).toBe("qs-tok");
  });

  test("returns nulls when neither path nor query provides metadata", () => {
    const url = new URL("http://localhost:7830/webhooks/twilio/media-stream");
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBeNull();
    expect(result.token).toBeNull();
  });

  test("falls back to query params on malformed percent-encoding in path", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream/%E0%A4%A/tok?callSessionId=qs-fallback&token=qs-tok",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("qs-fallback");
    expect(result.token).toBe("qs-tok");
  });

  test("path segments take priority over query parameters", () => {
    const url = new URL(
      "http://localhost:7830/webhooks/twilio/media-stream/path-sess/path-tok?callSessionId=query-sess&token=query-tok",
    );
    const result = extractMediaStreamMetadata(url);
    expect(result.callSessionId).toBe("path-sess");
    expect(result.token).toBe("path-tok");
  });
});

// ---------------------------------------------------------------------------
// Upgrade handler tests
// ---------------------------------------------------------------------------

describe("createTwilioMediaWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("returns 400 when callSessionId is missing from both path and query", () => {
    const handler = createTwilioMediaWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/media-stream",
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("succeeds with path-based callSessionId and token", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/webhooks/twilio/media-stream/sess-42/${TEST_TOKEN}`,
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);

    const call = (fakeServer.upgrade as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    expect(call[0]).toBe(req);
    const upgradeData = (
      call[1] as {
        data: {
          wsType: string;
          callSessionId: string;
          assistantRuntimeBaseUrl: string;
        };
      }
    ).data;
    expect(upgradeData.wsType).toBe("twilio-media-stream");
    expect(upgradeData.callSessionId).toBe("sess-42");
    expect(upgradeData.assistantRuntimeBaseUrl).toBe(
      config.assistantRuntimeBaseUrl,
    );
  });

  test("legacy: succeeds with query-based callSessionId and token", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/webhooks/twilio/media-stream?callSessionId=sess-42&token=${TEST_TOKEN}`,
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);

    const call = (fakeServer.upgrade as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    const upgradeData = (
      call[1] as {
        data: { callSessionId: string };
      }
    ).data;
    expect(upgradeData.callSessionId).toBe("sess-42");
  });

  test("calls server.upgrade when Authorization header provides valid token", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/media-stream/sess-42",
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 500 when server.upgrade fails", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/webhooks/twilio/media-stream/sess-1/${TEST_TOKEN}`,
    );
    const fakeServer = {
      upgrade: mock(() => false),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(500);
  });

  // --- Auth tests ---

  test("returns 401 when no token provided via path, query, or header", () => {
    const handler = createTwilioMediaWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/media-stream/sess-1",
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when token is missing from legacy query request", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/media-stream?callSessionId=sess-1",
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when path-based token is invalid", () => {
    const config = makeConfig({});
    const handler = createTwilioMediaWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/webhooks/twilio/media-stream/sess-1/wrong-token",
    );
    const fakeServer = {
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WebSocket handler tests
// ---------------------------------------------------------------------------

describe("getMediaStreamWebsocketHandlers", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let fakeUpstream: ReturnType<typeof createFakeUpstreamWs>;
  let handlers: ReturnType<typeof getMediaStreamWebsocketHandlers>;

  beforeEach(() => {
    fakeUpstream = createFakeUpstreamWs();
    // Replace global WebSocket constructor so `open` handler creates our fake.
    // Copy static readyState constants so the source code's comparisons
    // against WebSocket.OPEN / WebSocket.CONNECTING work correctly.
    const MockWS = mock(() => fakeUpstream);
    Object.assign(MockWS, {
      CONNECTING: WS_CONNECTING,
      OPEN: WS_OPEN,
      CLOSING: 2,
      CLOSED: WS_CLOSED,
    });
    globalThis.WebSocket = MockWS as unknown as typeof WebSocket;
    handlers = getMediaStreamWebsocketHandlers();
  });

  // Restore after each file-level describe to avoid leaking
  afterAll(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  // --- open handler ---------------------------------------------------------

  test("open initializes pendingMessages buffer", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    expect(ws.data.pendingMessages).toEqual([]);
  });

  test("open creates upstream WebSocket to correct URL", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "s&id=1",
      assistantRuntimeBaseUrl: "http://runtime:8000",
    });
    handlers.open(ws as never);

    const ctorCall = (
      globalThis.WebSocket as unknown as ReturnType<typeof mock>
    ).mock.calls[0] as unknown[];
    const url = ctorCall[0] as string;
    // The URL includes a service JWT token parameter for runtime auth
    expect(url).toStartWith(
      "ws://runtime:8000/v1/calls/media-stream?callSessionId=s%26id%3D1&token=",
    );
  });

  // --- message buffering before upstream open --------------------------------

  test("buffers downstream messages while upstream is CONNECTING", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    // Upstream is still CONNECTING
    fakeUpstream.readyState = WS_CONNECTING;

    handlers.message(ws as never, "msg-1");
    handlers.message(ws as never, "msg-2");

    expect(ws.data.pendingMessages).toEqual(["msg-1", "msg-2"]);
    expect(fakeUpstream.sent).toHaveLength(0);
  });

  test("flushes buffered messages on upstream open", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    // Buffer a couple of messages while CONNECTING
    handlers.message(ws as never, "msg-a");
    handlers.message(ws as never, "msg-b");

    // Simulate upstream open event
    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");

    // Buffered messages should have been flushed to upstream
    expect(fakeUpstream.sent).toEqual(["msg-a", "msg-b"]);
    // Buffer should be cleared
    expect(ws.data.pendingMessages).toBeUndefined();
  });

  test("forwards downstream messages directly when upstream is OPEN", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    // Mark upstream as OPEN
    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");

    handlers.message(ws as never, "direct-msg");

    expect(fakeUpstream.sent).toContain("direct-msg");
  });

  // --- buffer overflow -------------------------------------------------------

  test("closes downstream with 1008 on buffer overflow", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    // Fill the buffer to capacity (MAX_PENDING_MESSAGES = 100)
    for (let i = 0; i < 100; i++) {
      handlers.message(ws as never, `msg-${i}`);
    }

    // One more should trigger overflow
    handlers.message(ws as never, "overflow");

    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0].code).toBe(1008);
    expect(ws.closes[0].reason).toBe("Buffer overflow");
  });

  // --- downstream close while upstream is CONNECTING -------------------------

  test("downstream close while upstream is CONNECTING closes upstream and clears buffer", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    // Buffer some messages
    handlers.message(ws as never, "pending-1");

    // Downstream closes before upstream opens
    fakeUpstream.readyState = WS_CONNECTING;
    handlers.close(ws as never, 1000, "client gone");

    // Buffer should be cleared
    expect(ws.data.pendingMessages).toBeUndefined();
    // Upstream should be closed
    expect(fakeUpstream.closes).toHaveLength(1);
    expect(fakeUpstream.closes[0].code).toBe(1000);
    expect(fakeUpstream.closes[0].reason).toBe("client gone");
  });

  // --- upstream close propagation --------------------------------------------

  test("upstream close event propagates to downstream close", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    fakeUpstream.emit("close", { code: 1001, reason: "going away" });

    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0].code).toBe(1001);
    expect(ws.closes[0].reason).toBe("going away");
  });

  // --- upstream error propagation --------------------------------------------

  test("upstream error event closes downstream with 1011", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    fakeUpstream.emit("error", new Event("error"));

    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0].code).toBe(1011);
    expect(ws.closes[0].reason).toBe("Upstream error");
  });

  // --- upstream message forwarding -------------------------------------------

  test("upstream message is forwarded to downstream (string)", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    fakeUpstream.emit("message", { data: "hello from runtime" });

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe("hello from runtime");
  });

  test("upstream binary message is forwarded to downstream as Uint8Array", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    const buf = new ArrayBuffer(4);
    fakeUpstream.emit("message", { data: buf });

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
  });

  // --- downstream close with OPEN upstream -----------------------------------

  test("downstream close with OPEN upstream closes upstream", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    fakeUpstream.readyState = WS_OPEN;

    handlers.close(ws as never, 1000, "normal");

    expect(fakeUpstream.closes).toHaveLength(1);
    expect(fakeUpstream.closes[0].code).toBe(1000);
    expect(fakeUpstream.closes[0].reason).toBe("normal");
  });

  // --- downstream close with already-closed upstream -------------------------

  test("downstream close does not call upstream.close when upstream is already CLOSED", () => {
    const ws = createFakeDownstreamWs({
      wsType: "twilio-media-stream",
      callSessionId: "sess-1",
      assistantRuntimeBaseUrl: "http://localhost:7821",
    });
    handlers.open(ws as never);

    fakeUpstream.readyState = WS_CLOSED;

    handlers.close(ws as never, 1000, "done");

    expect(fakeUpstream.closes).toHaveLength(0);
  });
});
