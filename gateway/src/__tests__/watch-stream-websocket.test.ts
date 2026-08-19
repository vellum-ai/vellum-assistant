import { describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  createWatchStreamWebsocketHandler,
  getWatchStreamWebsocketHandlers,
  type WatchStreamSocketData,
} from "../http/routes/watch-stream-websocket.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid actor edge JWT for watch stream auth. */
function mintEdgeToken(actorPrincipalId: string = "test-user"): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: `actor:test-assistant:${actorPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

/** Mint a service-style token (no actor principal). */
function mintServiceEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
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
  } as GatewayConfig;
}

function makeFakeServer(upgradeResult: boolean = true) {
  return {
    requestIP: mock(() => ({
      address: "127.0.0.1",
      family: "IPv4",
      port: 54000,
    })),
    upgrade: mock(() => upgradeResult),
  } as unknown as import("bun").Server<unknown>;
}

/** The socket data the handler asked Bun to attach to the upgraded socket. */
function upgradedData(
  server: import("bun").Server<unknown>,
): WatchStreamSocketData {
  const call = (server.upgrade as ReturnType<typeof mock>).mock
    .calls[0] as unknown[];
  return (call[1] as { data: WatchStreamSocketData }).data;
}

// ---------------------------------------------------------------------------
// createWatchStreamWebsocketHandler: upgrade handler tests
// ---------------------------------------------------------------------------

describe("createWatchStreamWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when the token query parameter is valid", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData(server)).toMatchObject({
      wsType: "watch-stream",
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });
  });

  test("upgrades when the Authorization header is valid", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const server = makeFakeServer();

    expect(handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("carries an explicit conversation and host client through", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=conv-1&clientId=host-1`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    handler(req, server);

    expect(upgradedData(server)).toMatchObject({
      conversationId: "conv-1",
      clientId: "host-1",
    });
  });

  /**
   * A session with no conversation named is the companion surface's Watch,
   * which starts a session rather than joining a thread. Blank has to read the
   * same as absent, or the runtime would be handed an empty id to file against.
   */
  test("reads blank optional parameters as absent", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=%20&clientId=`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    handler(req, server);

    const data = upgradedData(server);
    expect(data.conversationId).toBeUndefined();
    expect(data.clientId).toBeUndefined();
  });

  test("returns 401 when no token is provided", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when the token is invalid", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?token=bad-token&mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * The client-facing half of the proxy takes actors and nothing else. A
   * service credential reaching it would open a user's microphone stream on a
   * token minted for machine to machine traffic.
   */
  test("returns 401 for a service token, which has no actor principal", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintServiceEdgeToken()}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 400 when mimeType is missing", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(400);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 426 when the request is not a WebSocket upgrade", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(426);
  });

  test("returns 500 when the Bun upgrade fails", () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false);
    const res = handler(req, server);

    expect(res!.status).toBe(500);
  });

  test("allows an unauthenticated upgrade when auth is disabled (dev bypass)", () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();

    expect(handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("still requires mimeType when auth is disabled", () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request("http://localhost:7830/v1/watch/stream", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res!.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// getWatchStreamWebsocketHandlers: WS lifecycle tests
// ---------------------------------------------------------------------------

describe("getWatchStreamWebsocketHandlers", () => {
  function createFakeDownstreamWs(data: Partial<WatchStreamSocketData> = {}) {
    const sent: (string | Uint8Array)[] = [];
    const closes: { code: number; reason: string }[] = [];
    const fullData: WatchStreamSocketData = {
      wsType: "watch-stream",
      config: makeConfig(),
      mimeType: "audio/pcm",
      sampleRate: 16000,
      ...data,
    };
    return {
      data: fullData,
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

  test("open initializes the pending message buffer", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();

    // Dialing upstream fails in a test process; the buffer is set up first.
    try {
      handlers.open(ws as never);
    } catch {
      // The WebSocket constructor may throw here.
    }

    expect(ws.data.pendingMessages).toBeDefined();
  });

  /**
   * The client starts sending the moment its own socket opens, which is before
   * this proxy has an upstream to send to. The first fraction of a second of
   * narration is exactly the part a transcriber needs.
   */
  test("message buffers frames that arrive before upstream connects", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = [];

    handlers.message(ws as never, "narration-frame");

    expect(ws.data.pendingMessages).toContain("narration-frame");
  });

  test("message closes the socket rather than buffering without bound", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = new Array(100).fill("x");

    handlers.message(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("message forwards straight through once upstream is open", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = [];
    const upstream = {
      readyState: WebSocket.OPEN,
      send: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.message(ws as never, "narration-frame");

    expect(upstream.send).toHaveBeenCalledWith("narration-frame");
    expect(ws.data.pendingMessages).toEqual([]);
  });

  test("close releases the buffer and closes upstream with the same code", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = ["some-data"];
    const upstream = {
      readyState: WebSocket.OPEN,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(upstream.close).toHaveBeenCalledWith(1000, "normal");
  });

  test("close is safe when upstream is already gone", () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    const upstream = {
      readyState: WebSocket.CLOSED,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(upstream.close).not.toHaveBeenCalled();
  });
});
