import { describe, test, expect, mock, afterEach } from "bun:test";
import { reconcileTelegramWebhook } from "../telegram/webhook-manager.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "test-bot-token",
    telegramWebhookSecret: "test-webhook-secret",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
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
    ingressPublicBaseUrl: "https://example.ngrok.io",
    publicUrl: undefined,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("reconcileTelegramWebhook", () => {
  test("calls setWebhook when URL does not match", async () => {
    const calls: { method: string; body: unknown }[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
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
        const req = typeof input === "object" && "json" in input ? input : null;
        const body = req ? await (req as Request).json() : null;
        calls.push({ method: "setWebhook", body });
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const config = makeConfig();
    await reconcileTelegramWebhook(config);

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("getWebhookInfo");
    expect(calls[1].method).toBe("setWebhook");
    expect((calls[1].body as any).url).toBe("https://example.ngrok.io/webhooks/telegram");
    expect((calls[1].body as any).secret_token).toBe("test-webhook-secret");
    expect((calls[1].body as any).allowed_updates).toEqual(["message", "edited_message"]);
  });

  test("always calls setWebhook even when URL already matches (secret may have rotated)", async () => {
    const calls: string[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
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
    }) as any;

    const config = makeConfig();
    await reconcileTelegramWebhook(config);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });

  test("normalizes trailing slash on ingress base URL", async () => {
    const calls: { method: string; body: unknown }[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
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
        const req = typeof input === "object" && "json" in input ? input : null;
        const body = req ? await (req as Request).json() : null;
        calls.push({ method: "setWebhook", body });
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const config = makeConfig({ ingressPublicBaseUrl: "https://example.ngrok.io/" });
    await reconcileTelegramWebhook(config);

    expect(calls).toHaveLength(2);
    expect((calls[1].body as any).url).toBe("https://example.ngrok.io/webhooks/telegram");
  });

  test("skips reconciliation when bot token is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const config = makeConfig({ telegramBotToken: undefined });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when webhook secret is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const config = makeConfig({ telegramWebhookSecret: undefined });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when ingress URL is not configured", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const config = makeConfig({ ingressPublicBaseUrl: undefined });
    await reconcileTelegramWebhook(config);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("calls setWebhook when current URL is empty", async () => {
    const calls: string[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
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
    }) as any;

    const config = makeConfig();
    await reconcileTelegramWebhook(config);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });
});
