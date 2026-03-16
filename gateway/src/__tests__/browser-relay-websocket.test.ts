import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
  isLoopbackPeer,
} from "../http/routes/browser-relay-websocket.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid edge JWT for browser relay auth. */
function mintEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "actor:test-assistant:test-user",
    scope_profile: "actor_client_v1",
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
