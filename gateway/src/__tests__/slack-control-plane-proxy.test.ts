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

const { createSlackControlPlaneProxyHandler } =
  await import("../http/routes/slack-control-plane-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: undefined,
    telegramWebhookSecret: undefined,
    telegramApiBaseUrl: "https://api.telegram.org",
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
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("slack control-plane proxy", () => {
  test("forwards slack share endpoints to the runtime", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackControlPlaneProxyHandler(makeConfig());

    await handler.handleListSlackChannels(
      new Request("http://localhost:7830/v1/slack/channels"),
    );
    await handler.handleShareToSlack(
      new Request("http://localhost:7830/v1/slack/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C123", text: "hello" }),
      }),
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/slack/channels",
      "http://localhost:7821/v1/slack/share",
    ]);
  });

  test("forwards query string for channel listing", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ channels: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackControlPlaneProxyHandler(makeConfig());

    await handler.handleListSlackChannels(
      new Request("http://localhost:7830/v1/slack/channels?types=public"),
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/slack/channels?types=public",
    ]);
  });

  test("replaces caller auth with service token", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createSlackControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleShareToSlack(
      new Request("http://localhost:7830/v1/slack/share", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": "application/json",
          host: "localhost:7830",
        },
        body: JSON.stringify({ channel: "C123", text: "hello" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
    expect(capturedHeaders?.has("host")).toBe(false);
  });

  test("passes through upstream client errors", async () => {
    fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: "slack_not_configured" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createSlackControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleShareToSlack(
      new Request("http://localhost:7830/v1/slack/share", {
        method: "POST",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slack_not_configured" });
  });

  test("returns 502 when runtime is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createSlackControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListSlackChannels(
      new Request("http://localhost:7830/v1/slack/channels"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway" });
  });
});
