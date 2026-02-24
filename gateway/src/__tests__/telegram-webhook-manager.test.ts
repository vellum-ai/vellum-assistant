import { describe, test, expect, mock } from "bun:test";
import { reconcileTelegramWebhook } from "../telegram/webhook-manager.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: "test-bot-token",
    telegramWebhookSecret: "test-webhook-secret",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: "https://example.ngrok.io",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("reconcileTelegramWebhook", () => {
  test("calls setWebhook when URL does not match", async () => {
    const calls: { method: string; body: unknown }[] = [];

    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/getWebhookInfo")) {
        calls.push({ method: "getWebhookInfo", body: null });
        return makeTelegramResponse({
          url: "https://old-url.example.com/webhooks/telegram",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      }
      if (url.includes("/setWebhook")) {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        calls.push({ method: "setWebhook", body });
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const config = makeConfig({ fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("getWebhookInfo");
    expect(calls[1].method).toBe("setWebhook");
    expect((calls[1].body as any).url).toBe("https://example.ngrok.io/webhooks/telegram");
    expect((calls[1].body as any).secret_token).toBe("test-webhook-secret");
    expect((calls[1].body as any).allowed_updates).toEqual(["message", "edited_message", "callback_query"]);
  });

  test("always calls setWebhook even when URL already matches (secret may have rotated)", async () => {
    const calls: string[] = [];

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/getWebhookInfo")) {
        calls.push("getWebhookInfo");
        return makeTelegramResponse({
          url: "https://example.ngrok.io/webhooks/telegram",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      }
      if (url.includes("/setWebhook")) {
        calls.push("setWebhook");
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const config = makeConfig({ fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });

  test("normalizes trailing slash on ingress base URL", async () => {
    const calls: { method: string; body: unknown }[] = [];

    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/getWebhookInfo")) {
        calls.push({ method: "getWebhookInfo", body: null });
        return makeTelegramResponse({
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      }
      if (url.includes("/setWebhook")) {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        calls.push({ method: "setWebhook", body });
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const config = makeConfig({ ingressPublicBaseUrl: "https://example.ngrok.io/", fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(calls).toHaveLength(2);
    expect((calls[1].body as any).url).toBe("https://example.ngrok.io/webhooks/telegram");
  });

  test("skips reconciliation when bot token is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));

    const config = makeConfig({ telegramBotToken: undefined, fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when webhook secret is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));

    const config = makeConfig({ telegramWebhookSecret: undefined, fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when ingress URL is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));

    const config = makeConfig({ ingressPublicBaseUrl: undefined, fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("calls setWebhook when current URL is empty", async () => {
    const calls: string[] = [];

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/getWebhookInfo")) {
        calls.push("getWebhookInfo");
        return makeTelegramResponse({
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      }
      if (url.includes("/setWebhook")) {
        calls.push("setWebhook");
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const config = makeConfig({ fetch: fetchMock as any });
    await reconcileTelegramWebhook(config);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });
});
