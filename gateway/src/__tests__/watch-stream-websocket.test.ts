import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { setVelayBridgeAuthHeader } from "../velay/bridge-auth.js";
import type { WatchStreamSocketData } from "../http/routes/watch-stream-websocket.js";

/** The bound guardian's actor principal, which `mintEdgeToken` defaults to. */
const GUARDIAN_PRINCIPAL = "test-user";

/** The bound guardian's platform user id, for the velay-attested path. */
const VELAY_USER_ID = "11111111-1111-1111-1111-111111111111";

// Watch is a guardian-only surface, so the upgrade pins the caller to the
// binding. Both lookups are mocked BEFORE the module under test is imported,
// the way `live-voice-websocket.test.ts` does it, so the pin is testable
// without gateway DB state.
let mockFindVellumGuardian = mock(
  async (): Promise<{ principalId: string } | null> => ({
    principalId: GUARDIAN_PRINCIPAL,
  }),
);
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: () => mockFindVellumGuardian(),
}));

let mockReadCredential = mock(
  async (_key: string): Promise<string | undefined> => VELAY_USER_ID,
);
mock.module("../credential-reader.js", () => ({
  readCredential: (key: string) => mockReadCredential(key),
}));

const { createWatchStreamWebsocketHandler, getWatchStreamWebsocketHandlers } =
  await import("../http/routes/watch-stream-websocket.js");

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

beforeEach(() => {
  mockFindVellumGuardian = mock(async () => ({
    principalId: GUARDIAN_PRINCIPAL,
  }));
  mockReadCredential = mock(async (_key: string) => VELAY_USER_ID);
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
});

describe("createWatchStreamWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when the token query parameter is valid", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData(server)).toMatchObject({
      wsType: "watch-stream",
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });
  });

  test("upgrades when the Authorization header is valid", async () => {
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

    expect(await handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("carries an explicit conversation and host client through", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=conv-1&clientId=host-1`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handler(req, server);

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
  test("reads blank optional parameters as absent", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=%20&clientId=`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handler(req, server);

    const data = upgradedData(server);
    expect(data.conversationId).toBeUndefined();
    expect(data.clientId).toBeUndefined();
  });

  test("returns 401 when no token is provided", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when the token is invalid", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?token=bad-token&mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * The client-facing half of the proxy takes actors and nothing else. A
   * service credential reaching it would open a user's microphone stream on a
   * token minted for machine to machine traffic.
   */
  test("returns 401 for a service token, which has no actor principal", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintServiceEdgeToken()}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 400 when mimeType is missing", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(400);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(426);
  });

  test("returns 500 when the Bun upgrade fails", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false);
    const res = await handler(req, server);

    expect(res!.status).toBe(500);
  });

  test("allows an unauthenticated upgrade when auth is disabled (dev bypass)", async () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();

    expect(await handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("still requires mimeType when auth is disabled", async () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request("http://localhost:7830/v1/watch/stream", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The guardian pin
// ---------------------------------------------------------------------------

/**
 * Watch reads the owner's screen, and the daemon resolves whose screen from
 * the guardian binding rather than from the request. A non-guardian actor who
 * gets past this upgrade therefore does not observe their own screen: they
 * observe the guardian's. The proxy also replaces the caller's identity with a
 * service token upstream, so the daemon cannot tell the difference. This
 * upgrade is the only place that actor can be refused.
 */
describe("createWatchStreamWebsocketHandler: the guardian pin", () => {
  const upgrade = async (token: string) => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${token}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    return { res: await handler(req, server), server };
  };

  test("admits the bound guardian", async () => {
    const { res, server } = await upgrade(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  /** The finding: a valid token that belongs to somebody else. */
  test("refuses a valid actor token that is not the bound guardian", async () => {
    const { res, server } = await upgrade(mintEdgeToken("someone-else"));

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("refuses when no guardian binding exists", async () => {
    mockFindVellumGuardian = mock(async () => null);

    const { res, server } = await upgrade(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * A lookup that throws leaves the answer unknown. Reporting that as
   * "forbidden" would misread a database problem as a permission one.
   */
  test("answers 503 when the binding lookup fails", async () => {
    mockFindVellumGuardian = mock(async () => {
      throw new Error("db down");
    });

    const { res, server } = await upgrade(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(503);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});

/**
 * The managed path, where velay validated the browser's token and injected the
 * caller. The attestation proves the caller is *a* platform user who traversed
 * velay, not that they are this assistant's guardian, so it is cross-checked
 * against the stored `platform_user_id`.
 */
describe("createWatchStreamWebsocketHandler: velay-attested managed auth", () => {
  const VELAY_ORG_ID = "22222222-2222-2222-2222-222222222222";

  const managedUpgrade = async ({
    userId = VELAY_USER_ID,
    actor = "user",
    orgId = VELAY_ORG_ID as string | null,
    bridgeProof = true,
    token,
    managed = true,
  }: {
    userId?: string;
    actor?: string;
    orgId?: string | null;
    bridgeProof?: boolean;
    token?: string;
    managed?: boolean;
  }) => {
    if (managed) {
      process.env.IS_PLATFORM = "true";
    } else {
      delete process.env.IS_PLATFORM;
    }
    const headers = new Headers({
      upgrade: "websocket",
      "x-velay-user-id": userId,
      "x-velay-actor": actor,
    });
    if (orgId !== null) {
      headers.set("x-velay-org-id", orgId);
    }
    if (bridgeProof) {
      setVelayBridgeAuthHeader(headers);
    }
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const query = token ? `&token=${token}` : "";
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?mimeType=audio/pcm${query}`,
      { headers },
    );
    const server = makeFakeServer();
    return { res: await handler(req, server), server };
  };

  test("admits an attested caller who is the bound guardian", async () => {
    const { res, server } = await managedUpgrade({});

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("refuses an attested caller who is not the bound guardian", async () => {
    mockReadCredential = mock(
      async () => "99999999-9999-9999-9999-999999999999",
    );

    const { res, server } = await managedUpgrade({});

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("refuses when this assistant has no platform user stored", async () => {
    mockReadCredential = mock(async () => undefined);

    const { res } = await managedUpgrade({});

    expect(res!.status).toBe(403);
  });

  test("answers 503 when the platform user lookup fails", async () => {
    mockReadCredential = mock(async () => {
      throw new Error("credential store down");
    });

    const { res } = await managedUpgrade({});

    expect(res!.status).toBe(503);
  });

  /**
   * A direct request to a reachable gateway can spoof the header names. It
   * cannot know the process-local bridge proof, which is what says the request
   * really arrived through this gateway's own loopback bridge.
   */
  test("ignores spoofed velay headers with no bridge proof", async () => {
    const { res, server } = await managedUpgrade({ bridgeProof: false });

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("falls through to the token path on an incomplete attestation", async () => {
    const { res, server } = await managedUpgrade({
      orgId: null,
      token: mintEdgeToken(GUARDIAN_PRINCIPAL),
    });

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  /** Falling through must not fall past the pin. */
  test("still pins the token path in managed mode", async () => {
    const { res } = await managedUpgrade({
      actor: "service",
      token: mintEdgeToken("someone-else"),
    });

    expect(res!.status).toBe(403);
  });

  test("does not trust velay headers outside managed mode", async () => {
    const { res, server } = await managedUpgrade({ managed: false });

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
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

  test("open initializes the pending message buffer", async () => {
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
  test("message buffers frames that arrive before upstream connects", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = [];

    handlers.message(ws as never, "narration-frame");

    expect(ws.data.pendingMessages).toContain("narration-frame");
  });

  test("message closes the socket rather than buffering without bound", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs();
    ws.data.pendingMessages = new Array(100).fill("x");

    handlers.message(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("message forwards straight through once upstream is open", async () => {
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

  test("close releases the buffer and closes upstream with the same code", async () => {
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

  test("close is safe when upstream is already gone", async () => {
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
