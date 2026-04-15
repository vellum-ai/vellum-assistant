import { describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  createSttStreamWebsocketHandler,
  getSttStreamWebsocketHandlers,
  type SttStreamSocketData,
} from "../http/routes/stt-stream-websocket.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid actor edge JWT for STT stream auth. */
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

// ---------------------------------------------------------------------------
// createSttStreamWebsocketHandler — upgrade handler tests
// ---------------------------------------------------------------------------

describe("createSttStreamWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when token query parameter is valid and required params present", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("upgrades when Authorization header is valid", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when no token is provided", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when token is invalid", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?token=bad-token&provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 for service tokens (requires actor principal)", () => {
    const serviceToken = mintServiceEdgeToken();
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${serviceToken}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("upgrades successfully when provider is omitted (config-authoritative)", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);

    // Verify provider is undefined in socket data
    const upgradeCall = (server.upgrade as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    const opts = upgradeCall[1] as { data: SttStreamSocketData };
    expect(opts.data.provider).toBeUndefined();
    expect(opts.data.mimeType).toBe("audio/webm");
  });

  test("returns 400 when mimeType is missing", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("returns 400 when mimeType is missing and provider is also missing", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("returns 426 when upgrade header is not websocket", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(426);
  });

  test("returns 500 when Bun.serve upgrade fails", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false); // upgrade returns false
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(500);
  });

  test("allows unauthenticated upgrade when auth is disabled (dev bypass)", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("upgrades when auth is disabled and provider is omitted", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when auth is disabled but mimeType is missing", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("passes sampleRate to socket data when provided", () => {
    const config = makeConfig();
    const handler = createSttStreamWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    handler(req, server);

    const upgradeCall = (server.upgrade as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    const opts = upgradeCall[1] as { data: SttStreamSocketData };
    expect(opts.data.provider).toBe("deepgram");
    expect(opts.data.mimeType).toBe("audio/webm");
    expect(opts.data.sampleRate).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// getSttStreamWebsocketHandlers — WS lifecycle tests
// ---------------------------------------------------------------------------

describe("getSttStreamWebsocketHandlers", () => {
  function createFakeDownstreamWs(data: Partial<SttStreamSocketData> = {}) {
    const sent: (string | Uint8Array)[] = [];
    const closes: { code: number; reason: string }[] = [];
    const fullData: SttStreamSocketData = {
      wsType: "stt-stream",
      config: makeConfig(),
      provider: "deepgram",
      mimeType: "audio/webm",
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

  test("open handler initializes pending messages buffer", () => {
    const handlers = getSttStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();

    // The open handler creates a WebSocket to upstream which will fail in test,
    // but pendingMessages should be initialized before that happens.
    try {
      handlers.open(ws as never);
    } catch {
      // WebSocket constructor may throw in test environment
    }

    expect(ws.data.pendingMessages).toBeDefined();
  });

  test("message handler buffers messages when upstream is not connected", () => {
    const handlers = getSttStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = [];

    handlers.message(ws as never, "test-audio-frame");

    expect(ws.data.pendingMessages).toContain("test-audio-frame");
  });

  test("message handler closes connection on buffer overflow", () => {
    const handlers = getSttStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = new Array(100).fill("x"); // At MAX_PENDING_MESSAGES

    handlers.message(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("close handler cleans up pending messages and closes upstream", () => {
    const handlers = getSttStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = ["some-data"];

    const fakeUpstream = {
      readyState: WebSocket.OPEN,
      close: mock(() => {}),
    };
    ws.data.upstream = fakeUpstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(fakeUpstream.close).toHaveBeenCalledWith(1000, "normal");
  });

  test("close handler is safe when upstream is already closed", () => {
    const handlers = getSttStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();

    const fakeUpstream = {
      readyState: WebSocket.CLOSED,
      close: mock(() => {}),
    };
    ws.data.upstream = fakeUpstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(fakeUpstream.close).not.toHaveBeenCalled();
  });
});
