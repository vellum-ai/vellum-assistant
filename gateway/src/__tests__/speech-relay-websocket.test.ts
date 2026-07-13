import { describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import type { CredentialCache } from "../credential-cache.js";
import {
  createSpeechRelayUpgradeHandler,
  getSpeechRelayWebsocketHandlers,
  type SpeechRelaySocketData,
} from "../http/routes/speech-relay-websocket.js";
import { VELAY_FORWARDED_HEADER } from "../velay/bridge-utils.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** The daemon's self-minted service token — the only accepted principal. */
function mintDaemonServiceToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:daemon:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

/** An actor edge token — valid signature, wrong principal for this path. */
function mintActorToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "actor:test-assistant:test-user",
    scope_profile: "actor_client_v1",
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
    velayBaseUrl: "https://velay.test",
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

function makeCredentials(apiKey: string | undefined): CredentialCache {
  return {
    get: mock(async () => apiKey),
  } as unknown as CredentialCache;
}

async function bodyOf(
  res: Response,
): Promise<{ code: string; detail: string }> {
  return (await res.json()) as { code: string; detail: string };
}

const TOKEN = mintDaemonServiceToken();

describe("createSpeechRelayUpgradeHandler — gate", () => {
  test("upgrades a daemon service connection and strips the key param", async () => {
    const server = makeFakeServer();
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${TOKEN}&encoding=linear16&sample_rate=16000&channels=1`,
      { headers: { upgrade: "websocket" } },
    );

    expect(await handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    const data = (server.upgrade as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1] as { data: SpeechRelaySocketData };
    const upstream = new URL(data.data.upstreamWsUrl);
    expect(upstream.origin).toBe("wss://velay.test");
    expect(upstream.pathname).toBe("/v1/speech/stt/stream");
    expect(upstream.searchParams.get("encoding")).toBe("linear16");
    expect(upstream.searchParams.get("sample_rate")).toBe("16000");
    // The daemon's gateway token must never be forwarded to velay.
    expect(upstream.searchParams.has("key")).toBe(false);
  });

  test("routes the tts operation to velay's tts path", async () => {
    const server = makeFakeServer();
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "tts", {
      credentials: makeCredentials("vk-1"),
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/tts/stream?key=${TOKEN}&encoding=linear16`,
      { headers: { upgrade: "websocket" } },
    );

    expect(await handler(req, server)).toBeUndefined();
    const data = (server.upgrade as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1] as { data: SpeechRelaySocketData };
    expect(new URL(data.data.upstreamWsUrl).pathname).toBe(
      "/v1/speech/tts/stream",
    );
  });

  test("rejects a missing token", async () => {
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
    });
    const req = new Request("http://127.0.0.1:7830/v1/speech/stt/stream", {
      headers: { upgrade: "websocket" },
    });

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("invalid_token");
  });

  test("rejects an actor token — daemon service principal only", async () => {
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${mintActorToken()}`,
      { headers: { upgrade: "websocket" } },
    );

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("invalid_token");
  });

  test("rejects velay-forwarded requests regardless of token", async () => {
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${TOKEN}`,
      { headers: { upgrade: "websocket", [VELAY_FORWARDED_HEADER]: "1" } },
    );

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("forbidden");
  });
});

describe("createSpeechRelayUpgradeHandler — probe (non-upgrade GET)", () => {
  test("returns missing_platform_connection without a stored API key", async () => {
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials(undefined),
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${TOKEN}`,
    );

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe("missing_platform_connection");
  });

  test("forwards velay's JSON rejection with its status", async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({ code: "insufficient_balance", detail: "empty" }),
          { status: 402 },
        ),
    ) as unknown as typeof fetch;
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
      fetchImpl,
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${TOKEN}&encoding=linear16`,
    );

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(402);
    expect(await bodyOf(res)).toEqual({
      code: "insufficient_balance",
      detail: "empty",
    });
    // The probe authenticates to velay with the assistant API key.
    const probeCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]!;
    expect(String(probeCall[0])).toContain(
      "https://velay.test/v1/speech/stt/stream",
    );
    expect(
      (probeCall[1] as { headers: Record<string, string> }).headers
        .Authorization,
    ).toBe("Api-Key vk-1");
  });

  test("returns upgrade_required when the gate passes", async () => {
    const fetchImpl = mock(
      async () => new Response("Upgrade Required", { status: 426 }),
    ) as unknown as typeof fetch;
    const handler = createSpeechRelayUpgradeHandler(makeConfig(), "stt", {
      credentials: makeCredentials("vk-1"),
      fetchImpl,
    });
    const req = new Request(
      `http://127.0.0.1:7830/v1/speech/stt/stream?key=${TOKEN}`,
    );

    const res = (await handler(req, makeFakeServer()))!;
    expect(res.status).toBe(426);
    expect((await bodyOf(res)).code).toBe("upgrade_required");
  });
});

// ---------------------------------------------------------------------------
// Websocket handlers — velay dial + frame pipe
// ---------------------------------------------------------------------------

type WsListener = (ev?: unknown) => void;

class FakeUpstreamWebSocket {
  static instances: FakeUpstreamWebSocket[] = [];
  readyState = 0; // CONNECTING
  binaryType = "";
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  closeCalled: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeUpstreamWebSocket.instances.push(this);
  }

  private listeners = new Map<string, WsListener[]>();

  addEventListener(type: string, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalled = { code, reason };
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l();
  }

  emitMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }

  emitClose(code: number, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) l({ code, reason });
  }

  emitError(): void {
    for (const l of this.listeners.get("error") ?? []) l({});
  }
}

class FakeDownstreamSocket {
  sent: (string | Uint8Array)[] = [];
  closeCalled: { code?: number; reason?: string } | null = null;
  data: SpeechRelaySocketData;

  constructor(data: SpeechRelaySocketData) {
    this.data = data;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalled = { code, reason };
  }
}

function makeSocketData(
  overrides: Partial<SpeechRelaySocketData> = {},
): SpeechRelaySocketData {
  return {
    wsType: "speech-relay",
    operation: "stt",
    upstreamWsUrl: "wss://velay.test/v1/speech/stt/stream?encoding=linear16",
    upstreamHttpUrl:
      "https://velay.test/v1/speech/stt/stream?encoding=linear16",
    deps: {
      credentials: makeCredentials("vk-1"),
      webSocketConstructor:
        FakeUpstreamWebSocket as unknown as SpeechRelaySocketData["deps"]["webSocketConstructor"],
    },
    ...overrides,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("getSpeechRelayWebsocketHandlers", () => {
  test("dials velay with the Api-Key header and pipes frames both ways", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const ws = new FakeDownstreamSocket(makeSocketData());

    await handlers.open(ws as never);
    const upstream = FakeUpstreamWebSocket.instances[0]!;
    expect(upstream.url).toBe(
      "wss://velay.test/v1/speech/stt/stream?encoding=linear16",
    );
    expect(upstream.options?.headers?.Authorization).toBe("Api-Key vk-1");

    // Frames sent before upstream opens are buffered, then flushed.
    handlers.message(ws as never, "early-audio");
    expect(upstream.sent).toHaveLength(0);
    upstream.emitOpen();
    expect(upstream.sent).toEqual(["early-audio"]);

    handlers.message(ws as never, "more-audio");
    expect(upstream.sent).toEqual(["early-audio", "more-audio"]);

    upstream.emitMessage('{"type":"Results"}');
    expect(ws.sent).toEqual(['{"type":"Results"}']);
  });

  test("forwards upstream close codes and reasons to the daemon", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const ws = new FakeDownstreamSocket(makeSocketData());

    await handlers.open(ws as never);
    const upstream = FakeUpstreamWebSocket.instances[0]!;
    upstream.emitOpen();
    upstream.emitMessage(
      '{"type":"velay_error","code":"session_duration_exceeded","detail":""}',
    );
    upstream.emitClose(1000, "session_duration_exceeded");

    // The velay_error frame passes through untouched, then the close.
    expect(ws.sent[0]).toContain("session_duration_exceeded");
    expect(ws.closeCalled).toEqual({
      code: 1000,
      reason: "session_duration_exceeded",
    });
  });

  test("sets arraybuffer binary mode on the upstream socket", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const ws = new FakeDownstreamSocket(makeSocketData());

    await handlers.open(ws as never);
    expect(FakeUpstreamWebSocket.instances[0]!.binaryType).toBe("arraybuffer");
  });

  test("a pre-open close waits for the probe's velay_error before closing", async () => {
    // A rejected handshake can emit close (or error+close) before the async
    // probe resolves; the raw close must not beat the synthesized frame.
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({ code: "insufficient_balance", detail: "empty" }),
          { status: 402 },
        ),
    ) as unknown as typeof fetch;
    const data = makeSocketData();
    data.deps.fetchImpl = fetchImpl;
    const ws = new FakeDownstreamSocket(data);

    await handlers.open(ws as never);
    const upstream = FakeUpstreamWebSocket.instances[0]!;
    upstream.emitError();
    upstream.emitClose(1006);
    await tick();

    // One synthesized frame, one close — the double-fire is coalesced.
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string).code).toBe("insufficient_balance");
    expect(ws.closeCalled?.code).toBe(1011);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1);
  });

  test("a failed velay dial synthesizes a velay_error from the HTTP probe", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const fetchImpl = mock(
      async () =>
        new Response(JSON.stringify({ code: "invalid_key", detail: "bad" }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;
    const data = makeSocketData();
    data.deps.fetchImpl = fetchImpl;
    const ws = new FakeDownstreamSocket(data);

    await handlers.open(ws as never);
    FakeUpstreamWebSocket.instances[0]!.emitError();
    await tick();

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      type: "velay_error",
      code: "invalid_key",
      detail: "bad",
    });
    expect(ws.closeCalled?.code).toBe(1011);
  });

  test("missing API key closes with a synthesized velay_error, no dial", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const data = makeSocketData();
    data.deps.credentials = makeCredentials(undefined);
    const ws = new FakeDownstreamSocket(data);

    await handlers.open(ws as never);

    expect(FakeUpstreamWebSocket.instances).toHaveLength(0);
    expect(JSON.parse(ws.sent[0] as string).code).toBe(
      "missing_platform_connection",
    );
    expect(ws.closeCalled?.code).toBe(1011);
  });

  test("daemon close is forwarded to velay", async () => {
    FakeUpstreamWebSocket.instances = [];
    const handlers = getSpeechRelayWebsocketHandlers();
    const ws = new FakeDownstreamSocket(makeSocketData());

    await handlers.open(ws as never);
    const upstream = FakeUpstreamWebSocket.instances[0]!;
    upstream.emitOpen();

    handlers.close(ws as never, 1000, "client done");
    expect(upstream.closeCalled).toEqual({ code: 1000, reason: "client done" });
  });
});
