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
  FakeWebSocket,
  makeFakeWebSocketConstructor,
} from "./test-fake-websocket.js";
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

const WS_OPEN = WebSocket.OPEN;
const WS_CLOSED = WebSocket.CLOSED;

function makeCredentials(values: Record<string, string | undefined>) {
  return {
    get: async (key: string) => values[key],
  } as unknown as CredentialCache;
}

function makeConfigFileCache(invalidations: { count: number }) {
  const invalidateCallbacks = new Set<() => void>();
  return {
    getBoolean: (section: string, key: string) => {
      let sectionValue: unknown;
      try {
        sectionValue = readConfig()[section];
      } catch {
        return undefined;
      }
      if (
        !sectionValue ||
        typeof sectionValue !== "object" ||
        Array.isArray(sectionValue)
      ) {
        return undefined;
      }
      const value = (sectionValue as Record<string, unknown>)[key];
      return typeof value === "boolean" ? value : undefined;
    },
    invalidate: () => {
      invalidations.count++;
      for (const callback of invalidateCallbacks) {
        callback();
      }
    },
    onInvalidate: (callback: () => void) => {
      invalidateCallbacks.add(callback);
      return () => {
        invalidateCallbacks.delete(callback);
      };
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

function makeManualTimerApi(delays: number[], callbacks: Array<() => void>) {
  return {
    setTimeout: (fn: () => void, delayMs: number) => {
      delays.push(delayMs);
      callbacks.push(fn);
      return fn;
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
    webSocketConstructor: makeFakeWebSocketConstructor(sockets),
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
    heartbeat: { intervalMs: 0, readTimeoutMs: 0 },
    timerApi: makeTimerApi(reconnectDelays),
  });
}

function sendFrame(ws: FakeWebSocket, frame: VelayFrame): void {
  ws.emit("message", { data: JSON.stringify(frame) });
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "velay-client-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("VelayTunnelClient", () => {
  test("stays disabled when VELAY_BASE_URL is unset", async () => {
    const client = createVelayTunnelClient(makeConfig(), {
      credentials: makeCredentials({}),
      configFile: makeConfigFileCache({ count: 0 }),
    });

    expect(client).toBeUndefined();
    await flushPromises();
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
    await client.stop();
  });

  test("opens a socket and registers when the platform assistant ID is missing", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    writeConfig({
      ingress: { publicBaseUrl: "https://ngrok.example.test" },
    });
    const client = makeClient({
      sockets,
      reconnectDelays,
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
      }),
    });

    client.start();
    await flushPromises();

    expect(sockets).toHaveLength(1);
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-from-velay",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    expect(sockets[0].closes).toEqual([]);
    expect(reconnectDelays).toEqual([]);
    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://velay-public.example.test/",
        publicBaseUrlManagedBy: "velay",
      },
    });
    await client.stop();
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
        publicBaseUrl: "https://velay-public.example.test/",
        publicBaseUrlManagedBy: "velay",
      },
      existing: { preserved: true },
    });
    expect(invalidations.count).toBe(1);
  });

  test("waits without connecting when public ingress is disabled", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        enabled: false,
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    const client = makeClient({
      sockets,
      reconnectDelays,
      configFile: makeConfigFileCache(invalidations),
    });

    client.start();
    await flushPromises();

    expect(sockets).toHaveLength(0);
    expect(reconnectDelays).toEqual([10]);
    expect(readConfig()).toEqual({
      ingress: {
        enabled: false,
      },
    });
    expect(invalidations.count).toBe(1);
    await client.stop();
  });

  test("closes without publishing when public ingress is disabled after connecting", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        enabled: true,
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
    expect(sockets).toHaveLength(1);

    writeConfig({
      ingress: {
        enabled: false,
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    sockets[0].readyState = WS_OPEN;
    sendFrame(sockets[0], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1000, reason: "public ingress disabled" },
    ]);
    expect(reconnectDelays).toEqual([10]);
    expect(readConfig()).toEqual({
      ingress: {
        enabled: false,
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    expect(invalidations.count).toBe(0);
  });

  test("closes and clears a published URL when public ingress is disabled while connected", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const invalidations = { count: 0 };
    const configFile = makeConfigFileCache(invalidations);
    writeConfig({
      ingress: {
        enabled: true,
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    const client = makeClient({
      sockets,
      reconnectDelays,
      configFile,
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

    writeConfig({
      ingress: {
        enabled: false,
        publicBaseUrl: "https://velay-public.example.test/",
        publicBaseUrlManagedBy: "velay",
      },
    });
    configFile.invalidate();
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1000, reason: "public ingress disabled" },
    ]);
    expect(reconnectDelays).toEqual([10]);
    expect(readConfig()).toEqual({
      ingress: {
        enabled: false,
      },
    });
    expect(invalidations.count).toBe(3);
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
      { code: 4008, reason: "assistant ID mismatch" },
    ]);
    expect(readConfig()).toEqual({
      ingress: { publicBaseUrl: "https://ngrok.example.test" },
    });
  });

  test("backs off repeated open-then-close failures until registration succeeds", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    writeConfig({
      ingress: { publicBaseUrl: "https://ngrok.example.test" },
    });
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
      reconnect: { baseDelayMs: 10, maxDelayMs: 80, jitterRatio: 0 },
      heartbeat: { intervalMs: 0, readTimeoutMs: 0 },
      timerApi: makeManualTimerApi(reconnectDelays, reconnectCallbacks),
    });

    client.start();
    await flushPromises();

    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    sockets[0].readyState = WS_CLOSED;
    sockets[0].emit("close", { code: 1006, reason: "" });
    await flushPromises();
    expect(reconnectDelays).toEqual([10]);

    reconnectCallbacks.shift()?.();
    await flushPromises();
    sockets[1].readyState = WS_OPEN;
    sockets[1].emit("open");
    sockets[1].readyState = WS_CLOSED;
    sockets[1].emit("close", { code: 1006, reason: "" });
    await flushPromises();
    expect(reconnectDelays).toEqual([10, 20]);

    reconnectCallbacks.shift()?.();
    await flushPromises();
    sockets[2].readyState = WS_OPEN;
    sockets[2].emit("open");
    sendFrame(sockets[2], {
      type: VELAY_FRAME_TYPES.registered,
      assistant_id: "asst-123",
      public_url: "https://velay-public.example.test",
    });
    await flushPromises();
    sockets[2].readyState = WS_CLOSED;
    sockets[2].emit("close", { code: 1006, reason: "" });
    await flushPromises();

    expect(reconnectDelays).toEqual([10, 20, 10]);
  });

  test("writes only ingress.publicBaseUrl when publishing a Velay URL", async () => {
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
        otherIngressSetting: "keep-me",
        publicBaseUrl: "https://velay-public.example.test/",
        publicBaseUrlManagedBy: "velay",
      },
      gateway: {
        runtimeProxyRequireAuth: false,
      },
    });
  });

  test("normalizes a valid registered public URL before publishing", async () => {
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
      assistant_id: "asst-123",
      public_url: "  HTTPS://VELAY-PUBLIC.EXAMPLE.TEST/twilio/../twilio  ",
    });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://velay-public.example.test/twilio",
        publicBaseUrlManagedBy: "velay",
      },
    });
  });

  test("rejects registration with an invalid public URL", async () => {
    for (const publicUrl of ["", "notaurl", "https://", "ftp://example.test"]) {
      const sockets: FakeWebSocket[] = [];
      const reconnectDelays: number[] = [];
      const invalidations = { count: 0 };
      writeConfig({
        ingress: { publicBaseUrl: "https://ngrok.example.test" },
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
        public_url: publicUrl,
      });
      await flushPromises();

      expect(sockets[0].closes).toEqual([
        { code: 4008, reason: "invalid public URL" },
      ]);
      expect(readConfig()).toEqual({
        ingress: { publicBaseUrl: "https://ngrok.example.test" },
      });
      expect(invalidations.count).toBe(0);
      expect(reconnectDelays).toEqual([10]);
      await client.stop();
    }
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
      ingress: {},
    });
    expect(invalidations.count).toBe(2);
    expect(reconnectDelays).toEqual([10]);
  });

  test("waits for disconnect cleanup before scheduling reconnect", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnectDelays: number[] = [];
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    const client = makeClient({
      sockets,
      reconnectDelays,
      configFile: makeConfigFileCache({ count: 0 }),
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

    expect(reconnectDelays).toEqual([]);

    await flushPromises();

    expect(reconnectDelays).toEqual([10]);
    expect(readConfig()).toEqual({
      ingress: {},
    });
  });

  test("preserves a newer Twilio public URL and clears stale Velay ownership on stale tunnel close", async () => {
    const sockets: FakeWebSocket[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://ngrok.example.test",
      },
    });
    const client = makeClient({
      sockets,
      configFile: makeConfigFileCache(invalidations),
    });

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
        publicBaseUrl: "https://velay-public-2.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });

    sockets[0].readyState = WS_CLOSED;
    sockets[0].emit("close", { code: 1006, reason: "" });
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://velay-public-2.example.test",
      },
    });
    expect(invalidations.count).toBe(2);

    expect(
      createVelayTunnelClient(makeConfig(), {
        credentials: makeCredentials({}),
        configFile: makeConfigFileCache(invalidations),
      }),
    ).toBeUndefined();
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://velay-public-2.example.test",
      },
    });
    expect(invalidations.count).toBe(2);
  });

  test("clears stale Velay-managed Twilio public URL on startup before connecting", async () => {
    const sockets: FakeWebSocket[] = [];
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    const client = makeClient({
      sockets,
      configFile: makeConfigFileCache(invalidations),
    });

    client.start();
    await flushPromises();

    expect(sockets).toHaveLength(1);
    expect(readConfig()).toEqual({
      ingress: {},
    });
    expect(invalidations.count).toBe(1);
    await client.stop();
  });

  test("disabled Velay cleanup clears stale managed URL and preserves manual Twilio URL", async () => {
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });

    expect(
      createVelayTunnelClient(makeConfig(), {
        credentials: makeCredentials({}),
        configFile: makeConfigFileCache(invalidations),
      }),
    ).toBeUndefined();
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {},
    });
    expect(invalidations.count).toBe(1);

    writeConfig({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
      },
    });

    expect(
      createVelayTunnelClient(makeConfig(), {
        credentials: makeCredentials({}),
        configFile: makeConfigFileCache(invalidations),
      }),
    ).toBeUndefined();
    await flushPromises();

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
      },
    });
    expect(invalidations.count).toBe(1);
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
    expect(sockets[0].sent.map((raw) => JSON.parse(raw as string))).toEqual([
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

  test("ignores websocket messages with invalid message types", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFrames: VelayWebSocketInboundFrame[] = [];
    const client = makeClient({ sockets, websocketFrames });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;

    sockets[0].emit("message", {
      data: JSON.stringify({
        type: VELAY_FRAME_TYPES.websocketMessage,
        connection_id: "conn-123",
        message_type: "json",
        body_base64: "",
      }),
    });
    await flushPromises();

    expect(websocketFrames).toEqual([]);
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
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
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
    await client.stop();
    sockets[0].emit("close", { code: 1000, reason: "gateway shutdown" });
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1000, reason: "gateway shutdown" },
    ]);
    expect(closeAllCount).toBe(1);
    expect(reconnectDelays).toEqual([]);
  });

  test("sends heartbeat frames periodically while connected", async () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    writeConfig({ ingress: { publicBaseUrl: "https://ngrok.example.test" } });
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      heartbeat: { intervalMs: 100, readTimeoutMs: 1000 },
      timerApi: makeManualTimerApi(delays, callbacks),
    });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    await flushPromises();

    expect(delays).toEqual([100]);

    callbacks[0]();
    await flushPromises();
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: VELAY_FRAME_TYPES.heartbeat }),
    ]);
    expect(delays).toEqual([100, 100]);

    await client.stop();
  });

  test("force-closes the tunnel when the read-timeout expires", async () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    writeConfig({ ingress: { publicBaseUrl: "https://ngrok.example.test" } });
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      heartbeat: { intervalMs: 100, readTimeoutMs: 1000 },
      timerApi: makeManualTimerApi(delays, callbacks),
    });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    await flushPromises();
    expect(delays).toEqual([100]);

    sendFrame(sockets[0], { type: VELAY_FRAME_TYPES.heartbeat });
    await flushPromises();
    expect(delays).toEqual([100, 1000]);

    callbacks[1]();
    await flushPromises();

    expect(sockets[0].closes).toEqual([
      { code: 1000, reason: "heartbeat read timeout" },
    ]);
    expect(delays).toEqual([100, 1000, 10]);
  });

  test("resets the read-timeout when an inbound frame arrives", async () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    writeConfig({ ingress: { publicBaseUrl: "https://ngrok.example.test" } });
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      heartbeat: { intervalMs: 100, readTimeoutMs: 1000 },
      timerApi: makeManualTimerApi(delays, callbacks),
    });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    await flushPromises();
    expect(delays).toEqual([100]);

    sendFrame(sockets[0], { type: VELAY_FRAME_TYPES.heartbeat });
    await flushPromises();
    expect(delays).toEqual([100, 1000]);

    sendFrame(sockets[0], { type: VELAY_FRAME_TYPES.heartbeat });
    await flushPromises();

    expect(delays).toEqual([100, 1000, 1000]);
    expect(sockets[0].closes).toEqual([]);

    await client.stop();
  });

  test("does not start the read-timeout until the peer echoes a heartbeat", async () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    writeConfig({ ingress: { publicBaseUrl: "https://ngrok.example.test" } });
    const client = new VelayTunnelClient({
      velayBaseUrl: "http://velay.example.test",
      gatewayLoopbackBaseUrl: "http://127.0.0.1:7830",
      credentials: makeCredentials({
        [credentialKey("vellum", "assistant_api_key")]: "api-key-123",
        [credentialKey("vellum", "platform_assistant_id")]: "asst-123",
      }),
      configFile: makeConfigFileCache({ count: 0 }),
      webSocketConstructor: makeFakeWebSocketConstructor(sockets),
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      heartbeat: { intervalMs: 100, readTimeoutMs: 1000 },
      timerApi: makeManualTimerApi(delays, callbacks),
    });

    client.start();
    await flushPromises();
    sockets[0].readyState = WS_OPEN;
    sockets[0].emit("open");
    await flushPromises();

    // Only the heartbeat send is scheduled; read-timeout stays gated.
    expect(delays).toEqual([100]);

    callbacks[0]();
    await flushPromises();
    callbacks[1]();
    await flushPromises();

    expect(delays).toEqual([100, 100, 100]);
    expect(sockets[0].closes).toEqual([]);

    await client.stop();
  });
});
