import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createTelegramControlPlaneProxyHandler } =
  await import("../http/routes/telegram-control-plane-proxy.js");

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

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("telegram control-plane proxy", () => {
  test("forwards telegram control-plane endpoints to the runtime", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createTelegramControlPlaneProxyHandler(makeConfig());

    await handler.handleGetTelegramConfig(
      new Request("http://localhost:7830/v1/integrations/telegram/config"),
    );
    await handler.handleSetTelegramConfig(
      new Request("http://localhost:7830/v1/integrations/telegram/config", {
        method: "POST",
      }),
    );
    await handler.handleClearTelegramConfig(
      new Request("http://localhost:7830/v1/integrations/telegram/config", {
        method: "DELETE",
      }),
    );
    await handler.handleSetTelegramCommands(
      new Request("http://localhost:7830/v1/integrations/telegram/commands", {
        method: "POST",
      }),
    );
    await handler.handleSetupTelegram(
      new Request("http://localhost:7830/v1/integrations/telegram/setup", {
        method: "POST",
      }),
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/integrations/telegram/config",
      "http://localhost:7821/v1/integrations/telegram/config",
      "http://localhost:7821/v1/integrations/telegram/config",
      "http://localhost:7821/v1/integrations/telegram/commands",
      "http://localhost:7821/v1/integrations/telegram/setup",
    ]);
  });

  test("replaces caller auth with runtime auth", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createTelegramControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleSetupTelegram(
      new Request("http://localhost:7830/v1/integrations/telegram/setup", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": "application/json",
          host: "localhost:7830",
        },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
    expect(capturedHeaders?.has("host")).toBe(false);
  });

  test("passes through upstream client errors", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ success: false, error: "invalid_bot_token" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const handler = createTelegramControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleSetupTelegram(
      new Request("http://localhost:7830/v1/integrations/telegram/setup", {
        method: "POST",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: "invalid_bot_token",
    });
  });

  test("returns 502 when runtime is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createTelegramControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetTelegramConfig(
      new Request("http://localhost:7830/v1/integrations/telegram/config"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway" });
  });
});
