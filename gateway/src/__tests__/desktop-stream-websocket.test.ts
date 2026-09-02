import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { setVelayBridgeAuthHeader } from "../velay/bridge-auth.js";
import type { DesktopStreamSocketData } from "../http/routes/desktop-stream-websocket.js";

/** The bound guardian's actor principal, which `mintEdgeToken` defaults to. */
const GUARDIAN_PRINCIPAL = "test-user";

/** The bound guardian's platform user id, for the velay-attested path. */
const VELAY_USER_ID = "11111111-1111-1111-1111-111111111111";

// The desktop is a guardian-only surface, so the upgrade pins the caller to
// the binding. Both lookups are mocked BEFORE the module under test is
// imported, the way the watch stream's tests do it.
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

const {
  createDesktopStreamWebsocketHandler,
  getDesktopStreamWebsocketHandlers,
} = await import("../http/routes/desktop-stream-websocket.js");

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid actor edge JWT for desktop stream auth. */
function mintEdgeToken(actorPrincipalId: string = GUARDIAN_PRINCIPAL): string {
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
): DesktopStreamSocketData {
  const call = (server.upgrade as ReturnType<typeof mock>).mock
    .calls[0] as unknown[];
  return (call[1] as { data: DesktopStreamSocketData }).data;
}

beforeEach(() => {
  mockFindVellumGuardian = mock(async () => ({
    principalId: GUARDIAN_PRINCIPAL,
  }));
  mockReadCredential = mock(async (_key: string) => VELAY_USER_ID);
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
});

// ---------------------------------------------------------------------------
// createDesktopStreamWebsocketHandler: upgrade handler tests
// ---------------------------------------------------------------------------

describe("createDesktopStreamWebsocketHandler", () => {
  const upgrade = async (
    url: string,
    init: RequestInit = { headers: { upgrade: "websocket" } },
    config = makeConfig(),
    upgradeResult = true,
  ) => {
    const handler = createDesktopStreamWebsocketHandler(config);
    const server = makeFakeServer(upgradeResult);
    return { res: await handler(new Request(url, init), server), server };
  };

  test("upgrades when the token query parameter is valid", async () => {
    const { res, server } = await upgrade(
      `http://localhost:7830/v1/desktop/stream?token=${mintEdgeToken()}`,
    );

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData(server)).toMatchObject({ wsType: "desktop-stream" });
  });

  test("upgrades when the Authorization header is valid", async () => {
    const { res, server } = await upgrade(
      "http://localhost:7830/v1/desktop/stream",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${mintEdgeToken()}`,
        },
      },
    );

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when no token is provided", async () => {
    const { res, server } = await upgrade(
      "http://localhost:7830/v1/desktop/stream",
    );

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when the token is invalid", async () => {
    const { res, server } = await upgrade(
      "http://localhost:7830/v1/desktop/stream?token=bad-token",
    );

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * The client-facing half of the proxy takes actors and nothing else. A
   * service credential reaching it would hand the pod's desktop to a token
   * minted for machine to machine traffic.
   */
  test("returns 401 for a service token, which has no actor principal", async () => {
    const { res, server } = await upgrade(
      `http://localhost:7830/v1/desktop/stream?token=${mintServiceEdgeToken()}`,
    );

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const { res, server } = await upgrade(
      `http://localhost:7830/v1/desktop/stream?token=${mintEdgeToken()}`,
      {},
    );

    expect(res!.status).toBe(426);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 500 when the Bun upgrade fails", async () => {
    const { res } = await upgrade(
      `http://localhost:7830/v1/desktop/stream?token=${mintEdgeToken()}`,
      { headers: { upgrade: "websocket" } },
      makeConfig(),
      false,
    );

    expect(res!.status).toBe(500);
  });

  test("allows an unauthenticated upgrade when auth is disabled (dev bypass)", async () => {
    const { res, server } = await upgrade(
      "http://localhost:7830/v1/desktop/stream",
      { headers: { upgrade: "websocket" } },
      makeConfig({ runtimeProxyRequireAuth: false }),
    );

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The guardian pin
// ---------------------------------------------------------------------------

/**
 * The proxy replaces the caller's identity with a service token upstream, so
 * the runtime cannot tell one actor from another: whoever this upgrade admits
 * gets the pod's desktop. This is the only place a non-guardian can be
 * refused.
 */
describe("createDesktopStreamWebsocketHandler: the guardian pin", () => {
  const upgrade = async (token: string) => {
    const handler = createDesktopStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/desktop/stream?token=${token}`,
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
describe("createDesktopStreamWebsocketHandler: velay-attested managed auth", () => {
  const VELAY_ORG_ID = "22222222-2222-2222-2222-222222222222";

  const managedUpgrade = async ({
    userId = VELAY_USER_ID,
    bridgeProof = true,
    token,
    managed = true,
  }: {
    userId?: string;
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
      "x-velay-org-id": VELAY_ORG_ID,
      "x-velay-actor": "user",
    });
    if (bridgeProof) {
      setVelayBridgeAuthHeader(headers);
    }
    const handler = createDesktopStreamWebsocketHandler(makeConfig());
    const query = token ? `?token=${token}` : "";
    const req = new Request(`http://localhost:7830/v1/desktop/stream${query}`, {
      headers,
    });
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

  /** Falling through must not fall past the pin. */
  test("still pins the token path in managed mode", async () => {
    const { res } = await managedUpgrade({
      bridgeProof: false,
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
// getDesktopStreamWebsocketHandlers: the byte pipe, against a real upstream
// ---------------------------------------------------------------------------

/**
 * RFB is a binary protocol, and noVNC reads the socket as RFB and nothing
 * else, so these run the pump against a real loopback WebSocket server posing
 * as the runtime: bytes have to arrive byte-identical in both directions, and
 * the runtime's close code has to arrive as itself.
 */
describe("getDesktopStreamWebsocketHandlers", () => {
  type FakeRuntime = {
    server: ReturnType<typeof Bun.serve>;
    received: Uint8Array[];
    /** Resolves with the upstream socket once the pump has dialed in. */
    connected: Promise<import("bun").ServerWebSocket<unknown>>;
    upgradeUrl: () => URL | undefined;
  };

  /** A loopback server that records what it is sent and echoes a banner. */
  function startFakeRuntime(banner?: Uint8Array): FakeRuntime {
    const received: Uint8Array[] = [];
    let upgradeUrl: URL | undefined;
    let resolveConnected!: (ws: import("bun").ServerWebSocket<unknown>) => void;
    const connected = new Promise<import("bun").ServerWebSocket<unknown>>(
      (resolve) => {
        resolveConnected = resolve;
      },
    );
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        upgradeUrl = new URL(req.url);
        if (srv.upgrade(req)) {
          return undefined as never;
        }
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          if (banner) {
            ws.send(banner);
          }
          resolveConnected(ws);
        },
        message(_ws, message) {
          received.push(
            typeof message === "string"
              ? new TextEncoder().encode(message)
              : new Uint8Array(message),
          );
        },
        close() {},
      },
    });
    return { server, received, connected, upgradeUrl: () => upgradeUrl };
  }

  function createFakeDownstreamWs(runtime: FakeRuntime) {
    const sent: (string | Uint8Array)[] = [];
    const closes: { code: number; reason: string }[] = [];
    const data: DesktopStreamSocketData = {
      wsType: "desktop-stream",
      config: makeConfig({
        assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
      }),
    };
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

  /** Poll until `predicate` holds, so the tests need no fixed sleeps. */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for condition");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** The RFB version banner, the first thing a VNC server sends. */
  const RFB_BANNER = new TextEncoder().encode("RFB 003.008\n");

  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  test("dials the runtime's /v1/desktop/stream with a service token and nothing else", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs(runtime);

    handlers.open(ws as never);
    await runtime.connected;

    const url = runtime.upgradeUrl()!;
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  test("delivers the runtime's bytes downstream byte-identical", async () => {
    runtime = startFakeRuntime(RFB_BANNER);
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs(runtime);

    handlers.open(ws as never);
    await waitFor(() => ws.sent.length > 0);

    const frame = ws.sent[0]!;
    expect(typeof frame).not.toBe("string");
    expect(Array.from(frame as Uint8Array)).toEqual(Array.from(RFB_BANNER));
  });

  test("delivers the viewer's bytes upstream byte-identical, including frames sent before the dial completes", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs(runtime);
    // Every byte value, so a text-vs-binary or encoding slip cannot hide.
    const early = new Uint8Array(256).map((_, i) => i);
    const late = new Uint8Array([0xff, 0x00, 0x7f, 0x80]);

    handlers.open(ws as never);
    handlers.message(ws as never, early);
    await runtime.connected;
    await waitFor(() => runtime.received.length === 1);
    handlers.message(ws as never, late);
    await waitFor(() => runtime.received.length === 2);

    expect(Array.from(runtime.received[0]!)).toEqual(Array.from(early));
    expect(Array.from(runtime.received[1]!)).toEqual(Array.from(late));
  });

  test("propagates the runtime's close code downstream verbatim", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs(runtime);

    handlers.open(ws as never);
    const upstream = await runtime.connected;
    upstream.close(1013, "desktop busy");
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 1013, reason: "desktop busy" });
  });

  test("propagates the viewer's close code upstream verbatim", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = createFakeDownstreamWs(runtime);

    handlers.open(ws as never);
    await runtime.connected;
    const upstreamClose = mock(ws.data.upstream!.close.bind(ws.data.upstream));
    ws.data.upstream!.close = upstreamClose;

    handlers.close(ws as never, 4001, "viewer left");

    expect(upstreamClose).toHaveBeenCalledWith(4001, "viewer left");
    expect(ws.data.pendingMessages).toBeUndefined();
  });
});
