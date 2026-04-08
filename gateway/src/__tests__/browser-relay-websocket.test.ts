import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  checkBrowserRelayAuth,
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
  isLoopbackPeer,
} from "../http/routes/browser-relay-websocket.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

const TEST_ACTOR_PRINCIPAL = "guardian-actor-123";

/** Mint a valid actor edge JWT for browser relay auth. */
function mintEdgeToken(actorPrincipalId: string = "test-user"): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: `actor:test-assistant:${actorPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

/**
 * Mint a service-style browser-relay edge token (svc:browser-relay:self).
 * This mirrors `mintBrowserRelayToken()` — the token is valid for the
 * gateway audience but carries no actor principal in its sub claim.
 */
function mintServiceEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:browser-relay:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const WS_CONNECTING = WebSocket.CONNECTING; // 0
const WS_OPEN = WebSocket.OPEN; // 1
const WS_CLOSED = WebSocket.CLOSED; // 3

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

function createFakeUpstreamWs() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sent: unknown[] = [];
  return {
    readyState: WS_CONNECTING as number,
    sent,
    listeners,
    addEventListener: mock(
      (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
      },
    ),
    send: mock((msg: unknown) => {
      sent.push(msg);
    }),
    close: mock(() => {}),
    emit(event: string, detail: unknown = {}) {
      for (const cb of listeners[event] ?? []) {
        cb(detail);
      }
    },
  };
}

describe("createBrowserRelayWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when token query parameter is valid", () => {
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when token is missing", () => {
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("allows unauthenticated upgrade when runtime proxy auth is disabled", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 403 when non-loopback host is requested from a public peer", () => {
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://gateway.example.com:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({
        address: "8.8.8.8",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("returns 403 for localhost host when peer is public (host spoof prevention)", () => {
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({
        address: "8.8.8.8",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("allows non-loopback host when peer is private network", () => {
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://gateway.example.com:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({
        address: "10.42.0.8",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });
});

describe("getBrowserRelayWebsocketHandlers", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let fakeUpstream: ReturnType<typeof createFakeUpstreamWs>;
  let handlers: ReturnType<typeof getBrowserRelayWebsocketHandlers>;

  beforeEach(() => {
    fakeUpstream = createFakeUpstreamWs();
    const MockWS = mock(() => fakeUpstream);
    Object.assign(MockWS, {
      CONNECTING: WS_CONNECTING,
      OPEN: WS_OPEN,
      CLOSING: 2,
      CLOSED: WS_CLOSED,
    });
    globalThis.WebSocket = MockWS as unknown as typeof WebSocket;
    handlers = getBrowserRelayWebsocketHandlers();
  });

  afterAll(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  test("open targets runtime browser-relay websocket and flushes buffered messages", () => {
    const ws = createFakeDownstreamWs({
      wsType: "browser-relay",
      config: makeConfig({
        assistantRuntimeBaseUrl: "http://runtime.internal:7821",
      }),
      auth: { authenticated: true, authBypassed: false },
    });

    handlers.open(ws as never);
    handlers.message(ws as never, "hello-before-open");

    const MockWS = globalThis.WebSocket as unknown as ReturnType<typeof mock>;
    const calledUrl = (MockWS.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toMatch(
      /^ws:\/\/runtime\.internal:7821\/v1\/browser-relay\?token=ey/,
    );

    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");
    expect(fakeUpstream.sent).toEqual(["hello-before-open"]);

    fakeUpstream.emit("message", { data: "runtime-message" });
    expect(ws.sent).toEqual(["runtime-message"]);
  });

  test("open appends guardianId query param when auth context carries one", () => {
    const ws = createFakeDownstreamWs({
      wsType: "browser-relay",
      config: makeConfig({
        assistantRuntimeBaseUrl: "http://runtime.internal:7821",
      }),
      auth: {
        authenticated: true,
        authBypassed: false,
        guardianId: TEST_ACTOR_PRINCIPAL,
      },
    });

    handlers.open(ws as never);

    const MockWS = globalThis.WebSocket as unknown as ReturnType<typeof mock>;
    const calledUrl = (MockWS.mock.calls[0] as unknown[])[0] as string;
    const parsed = new URL(calledUrl);
    expect(parsed.protocol).toBe("ws:");
    expect(parsed.host).toBe("runtime.internal:7821");
    expect(parsed.pathname).toBe("/v1/browser-relay");
    expect(parsed.searchParams.get("token")).toMatch(/^ey/);
    expect(parsed.searchParams.get("guardianId")).toBe(TEST_ACTOR_PRINCIPAL);
  });

  test("open omits guardianId query param when auth context has none (service-token path)", () => {
    const ws = createFakeDownstreamWs({
      wsType: "browser-relay",
      config: makeConfig({
        assistantRuntimeBaseUrl: "http://runtime.internal:7821",
      }),
      auth: { authenticated: true, authBypassed: false },
    });

    handlers.open(ws as never);

    const MockWS = globalThis.WebSocket as unknown as ReturnType<typeof mock>;
    const calledUrl = (MockWS.mock.calls[0] as unknown[])[0] as string;
    const parsed = new URL(calledUrl);
    // When the edge token has no actor principal, the gateway
    // propagates nothing for guardianId and the runtime accepts the
    // upgrade with `guardianId = undefined`.
    expect(parsed.searchParams.has("guardianId")).toBe(false);
  });
});

describe("checkBrowserRelayAuth", () => {
  test("returns structured auth context with guardianId for actor edge tokens", () => {
    const token = mintEdgeToken(TEST_ACTOR_PRINCIPAL);
    const config = makeConfig({});
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${token}`,
      { headers: { upgrade: "websocket" } },
    );
    const url = new URL(req.url);

    const result = checkBrowserRelayAuth(req, url, config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.context.authenticated).toBe(true);
    expect(result.context.authBypassed).toBe(false);
    expect(result.context.guardianId).toBe(TEST_ACTOR_PRINCIPAL);
  });

  test("returns ok with undefined guardianId for service-style edge tokens", () => {
    // Reflects the `mintBrowserRelayToken()` path where the edge token
    // sub is `svc:browser-relay:self`. The gateway accepts the token but
    // cannot resolve an actor principal to propagate upstream.
    const token = mintServiceEdgeToken();
    const config = makeConfig({});
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${token}`,
      { headers: { upgrade: "websocket" } },
    );
    const url = new URL(req.url);

    const result = checkBrowserRelayAuth(req, url, config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.context.authenticated).toBe(true);
    expect(result.context.guardianId).toBeUndefined();
  });

  test("returns error response when token is missing and auth is required", () => {
    const config = makeConfig({});
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const url = new URL(req.url);

    const result = checkBrowserRelayAuth(req, url, config);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.response.status).toBe(401);
  });

  test("returns bypassed context when runtimeProxyRequireAuth is disabled", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const url = new URL(req.url);

    const result = checkBrowserRelayAuth(req, url, config);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.context.authBypassed).toBe(true);
    expect(result.context.authenticated).toBe(false);
    expect(result.context.guardianId).toBeUndefined();
  });
});

describe("createBrowserRelayWebsocketHandler guardian propagation", () => {
  test("upgrades with guardianId populated in auth context for actor edge tokens", () => {
    const token = mintEdgeToken(TEST_ACTOR_PRINCIPAL);
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${token}`,
      { headers: { upgrade: "websocket" } },
    );

    let capturedData: unknown = null;
    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock((_req: Request, opts?: { data?: unknown }) => {
        capturedData = opts?.data;
        return true;
      }),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
    expect(capturedData).toMatchObject({
      wsType: "browser-relay",
      auth: {
        authenticated: true,
        authBypassed: false,
        guardianId: TEST_ACTOR_PRINCIPAL,
      },
    });
  });

  test("upgrades with undefined guardianId for service-style edge tokens", () => {
    const token = mintServiceEdgeToken();
    const config = makeConfig({});
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${token}`,
      { headers: { upgrade: "websocket" } },
    );

    let capturedData: unknown = null;
    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
      upgrade: mock((_req: Request, opts?: { data?: unknown }) => {
        capturedData = opts?.data;
        return true;
      }),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
    // The gateway still upgrades the connection, but propagates no
    // guardianId. The runtime allows the upgrade to proceed with an
    // unscoped connection when no fallback guardian context is
    // available.
    expect(capturedData).toMatchObject({
      wsType: "browser-relay",
      auth: { authenticated: true, authBypassed: false },
    });
    expect(
      (capturedData as { auth: { guardianId?: string } }).auth.guardianId,
    ).toBeUndefined();
  });
});

describe("isLoopbackPeer", () => {
  test("uses x-forwarded-for first hop when trustProxy is enabled", () => {
    const req = new Request("http://localhost:7830/v1/browser-relay/token", {
      headers: { "x-forwarded-for": "203.0.113.5, 127.0.0.1" },
    });

    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
    } as unknown as import("bun").Server<any>;

    expect(isLoopbackPeer(fakeServer, req, { trustProxy: true })).toBe(false);
  });

  test("falls back to peer IP when trustProxy is disabled", () => {
    const req = new Request("http://localhost:7830/v1/browser-relay/token", {
      headers: { "x-forwarded-for": "203.0.113.5, 127.0.0.1" },
    });

    const fakeServer = {
      requestIP: mock(() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 54000,
      })),
    } as unknown as import("bun").Server<any>;

    expect(isLoopbackPeer(fakeServer, req, { trustProxy: false })).toBe(true);
  });
});
