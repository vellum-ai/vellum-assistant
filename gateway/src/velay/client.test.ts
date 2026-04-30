import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import {
  VELAY_FRAME_TYPES,
  VELAY_TUNNEL_SUBPROTOCOL,
  VELAY_WEBSOCKET_MESSAGE_TYPES,
  type VelayFrame,
  type VelayHttpRequestFrame,
  type VelayHttpResponseFrame,
  type VelayWebSocketInboundFrame,
} from "./protocol.js";

let workspaceDir = "";

mock.module("../credential-reader.js", () => ({
  getWorkspaceDir: () => workspaceDir,
  readCredential: async () => undefined,
}));

const { VelayTunnelClient, createVelayTunnelClient } =
  await import("./client.js");

const WS_CONNECTING = WebSocket.CONNECTING;
const WS_OPEN = WebSocket.OPEN;
const WS_CLOSED = WebSocket.CLOSED;

type Listener = (event?: unknown) => void;

class FakeWebSocket {
  binaryType: BinaryType = "blob";
  readyState: number = WS_CONNECTING;
  sent: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.readyState = WS_CLOSED;
    this.closes.push({ code, reason });
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeWebSocketConstructor(created: FakeWebSocket[]) {
  return function FakeWebSocketConstructor(
    this: unknown,
    url: string,
    options: unknown,
  ) {
    const ws = new FakeWebSocket(url, options);
    created.push(ws);
    return ws;
  } as unknown as {
    new (url: string | URL, options?: unknown): WebSocket;
  };
}

function makeCredentials(values: Record<string, string | undefined>) {
  return {
    get: async (key: string) => values[key],
  } as unknown as CredentialCache;
}

function makeConfigFileCache(invalidations: { count: number }) {
  return {
    invalidate: () => {
      invalidations.count++;
    },
  } as unknown as ConfigFileCache;
}

function makeTimerApi(delays: number[]) {
  return {
    setTimeout: (_fn: () => void, delayMs: number) => {
      delays.push(delayMs);
      return { delayMs };
    },
    clearTimeout: () => {},
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: join(workspaceDir, "logs"), retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 1,
      slack: 1,
      whatsapp: 1,
      default: 1,
    },
    maxAttachmentConcurrency: 1,
    maxWebhookPayloadBytes: 1,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 1,
    runtimeMaxRetries: 0,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 1,
    shutdownDrainMs: 1,
    unmappedPolicy: "reject",
    trustProxy: false,
    ...overrides,
  };
}

function writeConfig(data: Record<string, unknown>): void {
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data),
    "utf-8",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function makeClient(
  overrides: {
    credentials?: CredentialCache;
    configFile?: ConfigFileCache;
    sockets?: FakeWebSocket[];
    httpBridge?: (
      frame: VelayHttpRequestFrame,
      gatewayLoopbackBaseUrl: string,
    ) => Promise<VelayHttpResponseFrame>;
    websocketFrames?: VelayWebSocketInboundFrame[];
    reconnectDelays?: number[];
  } = {},
) {
  const sockets = overrides.sockets ?? [];
  const reconnectDelays = overrides.reconnectDelays ?? [];
  return new VelayTunnelClient({
    velayBaseUrl: "http://velay.example.test",
    gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
    credentials:
      overrides.credentials ??
      makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
    configFile: overrides.configFile ?? makeConfigFileCache({ count: 0 }),
    webSocketConstructor: makeWebSocketConstructor(sockets),
    httpBridge: overrides.httpBridge,
    webSocketBridgeFactory:
      overrides.websocketFrames === undefined
        ? undefined
        : () =>
            ({
              handleFrame: (frame: VelayWebSocketInboundFrame) => {
                overrides.websocketFrames?.push(frame);
              },
              closeAll: () => {},
            }) as never,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    timerApi: makeTimerApi(reconnectDelays),
  });
}

function sendFrame(ws: FakeWebSocket, frame: VelayFrame): void {
  ws.emit("message", { data: JSON.stringify(frame) });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "velay-client-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("VelayTunnelClient", () => {
  test("stays disabled when VELAY_BASE_URL is unset", () => {
    const client = createVelayTunnelClient(makeConfig(), {
      credentials: makeCredentials({}),
      configFile: makeConfigFileCache({ count: 0 }),
    });

    expect(client).toBeUndefined();
  });

  test("retries without opening a socket when the assistant API key is missing", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const client = makeClient({
      sockets,
      reconnectDelays,
      credentials: makeCredentials({
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
    });

    client.start();
    await flushPromises();

    expect(sockets).toHaveLength(0);
    expect(reconnectDelays).toEqual([10]);
    client.stop();
  });

  test("registers with Velay and publishes the Twilio public URL", async () => {
    const sockets: FakeWebSocket[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
      existing: { preserved: true },
    });
    const client = makeClient({
      sockets,
      configFile: makeConfigFileCache(invalidations),
    });

    client.start();
    await flushPromises();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://velay.example.test/v1/register");
    expect(sockets[0].options).toEqual({
      protocols: [VELAY_TUNNEL_SUBPROTOCOL],
      headers: { Authorization: "Api-Key api-key-123" },
    });

    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
        twilioPublicBaseUrl: "https://velay-public.example.test",
      },
      existing: { preserved: true },
    });
    expect(invalidations.count).toBe(1);
  });

  test("rejects registration when Velay returns a different assistant ID", async () => {
    const sockets: FakeWebSocket[] = [];
    writeConfig({
      ingress: { publicBaseUrl: "https://ngrok.example.test" },
    });
    const client = makeClient({ sockets });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-other",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1008, reason: "assistant ID mismatch" },
    ]);
    expect(readConfig()).toEqual({
      ingress: { publicBaseUrl: "https://ngrok.example.test" },
    });
  });

  test("writes only ingress.twilioPublicBaseUrl when publishing a Velay URL", async () => {
    const sockets: FakeWebSocket[] = [];
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
        otherIngressSetting: "keep-me",
      },
      gateway: {
        runtimeProxyRequireAuth: false,
      },
    });
    const client = makeClient({ sockets });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
        otherIngressSetting: "keep-me",
        twilioPublicBaseUrl: "https://velay-public.example.test",
      },
      gateway: {
        runtimeProxyRequireAuth: false,
      },
    });
  });

  test("clears the published Twilio public URL when the tunnel disconnects", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    const client = makeClient({
      sockets,
      reconnectDelays,
      configFile: makeConfigFileCache(invalidations),
    });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    sockets[0].readyState = WS_CLOSED;
    sockets[0].emit("close", { code: 1006, reason: "" });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    expect(invalidations.count).toBe(2);
    expect(reconnectDelays).toEqual([10]);
  });

  test("does not clear a newer Twilio public URL on stale tunnel close", async () => {
    const sockets: FakeWebSocket[] = [];
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    const client = makeClient({ sockets });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public-1.example.test",
    });
    await flushPromises();
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
        twilioPublicBaseUrl: "https://velay-public-2.example.test",
      },
    });

    sockets[0].readyState = WS_CLOSED;
    sockets[0].emit("close", { code: 1006, reason: "" });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
        twilioPublicBaseUrl: "https://velay-public-2.example.test",
      },
    });
  });

  test("dispatches HTTP and WebSocket frames to the loopback bridges", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFrames: VelayWebSocketInboundFrame[] = [];
    const httpBridge = mock(
      async (
        frame: VelayHttpRequestFrame,
        gatewayLoopbackBaseUrl: string,
      ): Promise<VelayHttpResponseFrame> => ({
        type: VELAY_FRAME_TYPES.httpResponse,
        request_id: frame.request_id,
        status_code:
          gatewayLoopbackBaseUrl === "http://127.0.0.1:7830" ? 204 : 500,
      }),
    );
    const client = makeClient({ sockets, httpBridge, websocketFrames });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;

    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.httpRequest,
      request_id: "req-123",
      method: "POST",
      path: "/webhooks/twilio/voice",
      headers: {},
    });
    await flushPromises();

    expect(httpBridge).toHaveBeenCalledTimes(1);
    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: VELAY_FRAME_TYPES.httpResponse,
        request_id: "req-123",
        status_code: 204,
      },
    ]);

    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.websocketOpen,
      connection_id: "conn-123",
      path: "/webhooks/twilio/relay",
      headers: {},
    });
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: "",
    });
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.websocketClose,
      connection_id: "conn-123",
      code: 1000,
      reason: "done",
    });

    expect(websocketFrames.map((frame) => frame.type)).toEqual([
      VELAY_FRAME_TYPES.websocketOpen,
      VELAY_FRAME_TYPES.websocketMessage,
      VELAY_FRAME_TYPES.websocketClose,
    ]);
  });

  test("stops reconnecting and closes bridged sockets on shutdown", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let closeAllCount = 0;
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeWebSocketConstructor(sockets),
      webSocketBridgeFactory: () =>
        ({
          handleFrame: () => {},
          closeAll: () => {
            closeAllCount++;
          },
        }) as never,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      timerApi: makeTimerApi(reconnectDelays),
    });

    client.start();
    await flushPromises();
    client.stop();
    sockets[0].emit("close", { code: 1000, reason: "gateway shutdown" });
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1000, reason: "gateway shutdown" },
    ]);
    expect(closeAllCount).toBe(1);
    expect(reconnectDelays).toEqual([]);
  });
});
