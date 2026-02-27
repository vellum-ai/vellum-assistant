import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import type { GatewayConfig } from "../config.js";
import {
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
} from "../http/routes/browser-relay-websocket.js";

const WS_CONNECTING = WebSocket.CONNECTING; // 0
const WS_OPEN = WebSocket.OPEN; // 1
const WS_CLOSED = WebSocket.CLOSED; // 3

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-ver",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: undefined,
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
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
    addEventListener: mock((event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
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
  const TEST_TOKEN = "relay-token-abc123";

  test("upgrades when token query parameter is valid", () => {
    const config = makeConfig({ runtimeProxyBearerToken: TEST_TOKEN });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({ address: "127.0.0.1", family: "IPv4", port: 54000 })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when token is missing", () => {
    const config = makeConfig({ runtimeProxyBearerToken: TEST_TOKEN });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const fakeServer = {
      requestIP: mock(() => ({ address: "127.0.0.1", family: "IPv4", port: 54000 })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("allows unauthenticated upgrade when runtime proxy auth is disabled", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false, runtimeProxyBearerToken: undefined });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request("http://localhost:7830/v1/browser-relay", {
      headers: { upgrade: "websocket" },
    });
    const fakeServer = {
      requestIP: mock(() => ({ address: "127.0.0.1", family: "IPv4", port: 54000 })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;
    const res = handler(req, fakeServer);

    expect(res).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 403 when non-loopback host is requested from a public peer", () => {
    const config = makeConfig({ runtimeProxyBearerToken: TEST_TOKEN });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://gateway.example.com:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({ address: "8.8.8.8", family: "IPv4", port: 54000 })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });

  test("returns 403 for localhost host when peer is public (host spoof prevention)", () => {
    const config = makeConfig({ runtimeProxyBearerToken: TEST_TOKEN });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({ address: "8.8.8.8", family: "IPv4", port: 54000 })),
      upgrade: mock(() => true),
    } as unknown as import("bun").Server<any>;

    const res = handler(req, fakeServer);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    expect(fakeServer.upgrade).not.toHaveBeenCalled();
  });


  test("allows non-loopback host when peer is private network", () => {
    const config = makeConfig({ runtimeProxyBearerToken: TEST_TOKEN });
    const handler = createBrowserRelayWebsocketHandler(config);
    const req = new Request(
      `http://gateway.example.com:7830/v1/browser-relay?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const fakeServer = {
      requestIP: mock(() => ({ address: "10.42.0.8", family: "IPv4", port: 54000 })),
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
        runtimeBearerToken: "runtime-token",
      }),
    });

    handlers.open(ws as never);
    handlers.message(ws as never, "hello-before-open");

    const MockWS = globalThis.WebSocket as unknown as ReturnType<typeof mock>;
    expect(MockWS).toHaveBeenCalledWith("ws://runtime.internal:7821/v1/browser-relay?token=runtime-token");

    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");
    expect(fakeUpstream.sent).toEqual(["hello-before-open"]);

    fakeUpstream.emit("message", { data: "runtime-message" });
    expect(ws.sent).toEqual(["runtime-message"]);
  });
});
