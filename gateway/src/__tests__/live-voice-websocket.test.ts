import { readFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import type { GatewayConfig } from "../config.js";
import {
  createLiveVoiceWebsocketHandler,
  getLiveVoiceWebsocketHandlers,
  type LiveVoiceSocketData,
} from "../http/routes/live-voice-websocket.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

const WS_CONNECTING = WebSocket.CONNECTING;
const WS_OPEN = WebSocket.OPEN;
const WS_CLOSED = WebSocket.CLOSED;

function mintEdgeToken(actorPrincipalId: string = "test-user"): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: `actor:test-assistant:${actorPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

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

function createFakeDownstreamWs(data: LiveVoiceSocketData) {
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
  const closes: { code?: number; reason?: string }[] = [];
  return {
    readyState: WS_CONNECTING as number,
    sent,
    closes,
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
    emit(event: string, detail: unknown = {}) {
      for (const cb of listeners[event] ?? []) {
        cb(detail);
      }
    },
  };
}

describe("createLiveVoiceWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when token query parameter is a valid actor edge token", () => {
    const config = makeConfig();
    const handler = createLiveVoiceWebsocketHandler(config);
    const req = new Request(
      `http://localhost:7830/v1/live-voice?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);

    const call = (server.upgrade as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    expect(call[0]).toBe(req);
    expect((call[1] as { data: LiveVoiceSocketData }).data).toEqual({
      wsType: "live-voice",
      config,
    });
  });

  test("upgrades when Authorization header is a valid actor edge token", () => {
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/live-voice", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when auth is required and no token is provided", () => {
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/live-voice", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when token is invalid", () => {
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/live-voice?token=bad-token",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when token lacks an actor principal", () => {
    const serviceToken = mintServiceEdgeToken();
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/live-voice?token=${serviceToken}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("allows unauthenticated upgrade when runtime proxy auth is disabled", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    const handler = createLiveVoiceWebsocketHandler(config);
    const req = new Request("http://localhost:7830/v1/live-voice", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 426 when upgrade header is not websocket", () => {
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/live-voice?token=${TEST_TOKEN}`,
    );
    const server = makeFakeServer();
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(426);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 500 when Bun.serve upgrade fails", () => {
    const handler = createLiveVoiceWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/live-voice?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false);
    const res = handler(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(500);
  });
});

describe("getLiveVoiceWebsocketHandlers", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let fakeUpstream: ReturnType<typeof createFakeUpstreamWs>;
  let handlers: ReturnType<typeof getLiveVoiceWebsocketHandlers>;

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
    handlers = getLiveVoiceWebsocketHandlers();
  });

  afterAll(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  test("open targets the runtime live voice websocket with a service token", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig({
        assistantRuntimeBaseUrl: "http://runtime.internal:7821",
      }),
    });

    handlers.open(ws as never);

    const MockWS = globalThis.WebSocket as unknown as ReturnType<typeof mock>;
    const calledUrl = (MockWS.mock.calls[0] as unknown[])[0] as string;
    const parsed = new URL(calledUrl);
    expect(parsed.protocol).toBe("ws:");
    expect(parsed.host).toBe("runtime.internal:7821");
    expect(parsed.pathname).toBe("/v1/live-voice");
    expect(parsed.searchParams.get("token")).toMatch(/^ey/);
  });

  test("buffers downstream text and binary messages before upstream opens", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });
    const binaryFrame = new Uint8Array([1, 2, 3]);

    handlers.open(ws as never);
    handlers.message(ws as never, '{"type":"start"}');
    handlers.message(ws as never, binaryFrame);

    expect(ws.data.pendingMessages).toEqual(['{"type":"start"}', binaryFrame]);
    expect(fakeUpstream.sent).toEqual([]);
  });

  test("flushes buffered messages on upstream open", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });
    const binaryFrame = new Uint8Array([4, 5, 6]);

    handlers.open(ws as never);
    handlers.message(ws as never, '{"type":"start"}');
    handlers.message(ws as never, binaryFrame);

    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");

    expect(fakeUpstream.sent).toEqual(['{"type":"start"}', binaryFrame]);
    expect(ws.data.pendingMessages).toBeUndefined();
  });

  test("forwards downstream binary audio frames without JSON conversion", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });
    const binaryFrame = new Uint8Array([9, 8, 7]);

    handlers.open(ws as never);
    fakeUpstream.readyState = WS_OPEN;
    fakeUpstream.emit("open");
    handlers.message(ws as never, binaryFrame);

    expect(fakeUpstream.sent).toEqual([binaryFrame]);
    expect(fakeUpstream.sent[0]).toBe(binaryFrame);
  });

  test("forwards upstream text and binary frames to the downstream socket", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });

    handlers.open(ws as never);
    fakeUpstream.emit("message", { data: '{"type":"ready"}' });
    fakeUpstream.emit("message", { data: new Uint8Array([5, 6]).buffer });

    expect(ws.sent[0]).toBe('{"type":"ready"}');
    expect(ws.sent[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sent[1] as Uint8Array)).toEqual([5, 6]);
  });

  test("closes downstream with 1008 on pending buffer overflow", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });

    handlers.open(ws as never);
    for (let i = 0; i < 100; i++) {
      handlers.message(ws as never, `msg-${i}`);
    }
    handlers.message(ws as never, "overflow");

    expect(ws.closes).toEqual([{ code: 1008, reason: "Buffer overflow" }]);
  });

  test("downstream close clears pending messages and closes connecting upstream", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });

    handlers.open(ws as never);
    handlers.message(ws as never, "pending");
    handlers.close(ws as never, 1000, "client closed");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(fakeUpstream.closes).toEqual([
      { code: 1000, reason: "client closed" },
    ]);
  });

  test("upstream close and error events close the downstream socket", () => {
    const ws = createFakeDownstreamWs({
      wsType: "live-voice",
      config: makeConfig(),
    });

    handlers.open(ws as never);
    fakeUpstream.emit("close", { code: 1001, reason: "going away" });
    fakeUpstream.emit("error", new Event("error"));

    expect(ws.closes).toEqual([
      { code: 1001, reason: "going away" },
      { code: 1011, reason: "Upstream error" },
    ]);
  });
});

describe("live voice gateway boundary", () => {
  test("handler does not import assistant package files", () => {
    const source = readFileSync(
      new URL("../http/routes/live-voice-websocket.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+assistant\//);
    expect(source).not.toContain('from "assistant/');
  });

  test("gateway index routes live voice websocket upgrades before the runtime proxy", () => {
    const source = readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createLiveVoiceWebsocketHandler");
    expect(source).toContain("getLiveVoiceWebsocketHandlers");
    expect(source).toContain("type LiveVoiceSocketData");
    expect(source).toContain("function isLiveVoiceSocketData");
    expect(source).toContain("const handleLiveVoiceWs");
    expect(source).toContain("const liveVoiceWebsocketHandlers");

    const liveVoiceRouteIndex = source.indexOf(
      'url.pathname === "/v1/live-voice"',
    );
    const runtimeProxyDispatchIndex = source.indexOf(
      "const response = router(req, url, resolveClientIp, svr);",
    );

    expect(liveVoiceRouteIndex).toBeGreaterThan(-1);
    expect(runtimeProxyDispatchIndex).toBeGreaterThan(-1);
    expect(liveVoiceRouteIndex).toBeLessThan(runtimeProxyDispatchIndex);

    expect(source).toContain("handleLiveVoiceWs(req, server)");
    expect(source).toContain('url.pathname === "/v1/stt/stream"');
    expect(source).toContain("handleSttStreamWs(req, server)");
  });

  test("gateway websocket lifecycle dispatches live voice socket data", () => {
    const source = readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /if \(isLiveVoiceSocketData\(ws\.data\)\) \{\s+liveVoiceWebsocketHandlers\.open\(ws as never\);\s+return;\s+\}/,
    );
    expect(source).toMatch(
      /if \(isLiveVoiceSocketData\(ws\.data\)\) \{\s+liveVoiceWebsocketHandlers\.message\(ws as never, message\);\s+return;\s+\}/,
    );
    expect(source).toMatch(
      /if \(isLiveVoiceSocketData\(ws\.data\)\) \{\s+liveVoiceWebsocketHandlers\.close\(ws as never, code, reason\);\s+return;\s+\}/,
    );
  });
});
