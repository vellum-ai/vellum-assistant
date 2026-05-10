import { describe, test, expect, mock, afterEach } from "bun:test";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";

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

const { reconcileTelegramWebhook } =
  await import("../telegram/webhook-manager.js");

afterEach(() => {
  fetchMock = mock(async () => new Response());
  delete process.env.IS_CONTAINERIZED;
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.ASSISTANT_API_KEY;
});

function makeTelegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Create mock caches for webhook manager tests.
 * Pass `null` for a credential to simulate "not configured". */
function makeCaches(
  opts: {
    botToken?: string | null;
    webhookSecret?: string | null;
    ingressUrl?: string | null;
    platformBaseUrl?: string | null;
    assistantApiKey?: string | null;
    platformAssistantId?: string | null;
  } = {},
) {
  const botToken =
    "botToken" in opts ? (opts.botToken ?? undefined) : "test-bot-token";
  const webhookSecret =
    "webhookSecret" in opts
      ? (opts.webhookSecret ?? undefined)
      : "test-webhook-secret";
  const ingressUrl =
    "ingressUrl" in opts
      ? (opts.ingressUrl ?? undefined)
      : "https://example.ngrok.io";
  const platformBaseUrl =
    "platformBaseUrl" in opts ? (opts.platformBaseUrl ?? undefined) : undefined;
  const assistantApiKey =
    "assistantApiKey" in opts ? (opts.assistantApiKey ?? undefined) : undefined;
  const platformAssistantId =
    "platformAssistantId" in opts
      ? (opts.platformAssistantId ?? undefined)
      : undefined;
  const credentialMap: Record<string, string | undefined> = {
    [credentialKey("telegram", "bot_token")]: botToken,
    [credentialKey("telegram", "webhook_secret")]: webhookSecret,
    [credentialKey("vellum", "platform_base_url")]: platformBaseUrl,
    [credentialKey("vellum", "assistant_api_key")]: assistantApiKey,
    [credentialKey("vellum", "platform_assistant_id")]: platformAssistantId,
  };
  const credentials = {
    get: async (key: string) => credentialMap[key],
    invalidate: () => {},
  } as unknown as CredentialCache;
  const configFile = {
    getString: (section: string, key: string) => {
      if (section === "ingress" && key === "publicBaseUrl") return ingressUrl;
      return undefined;
    },
    getNumber: () => undefined,
    getBoolean: () => undefined,
    getRecord: () => undefined,
    refreshNow: () => {},
  } as unknown as ConfigFileCache;
  return { credentials, configFile };
}

describe("reconcileTelegramWebhook", () => {
  const caches = makeCaches();

  test("calls setWebhook when URL does not match", async () => {
    const calls: { method: string; body: unknown }[] = [];

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
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
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("getWebhookInfo");
    expect(calls[1].method).toBe("setWebhook");
    expect((calls[1].body as any).url).toBe(
      "https://example.ngrok.io/webhooks/telegram",
    );
    expect((calls[1].body as any).secret_token).toBe("test-webhook-secret");
    expect((calls[1].body as any).allowed_updates).toEqual([
      "message",
      "edited_message",
      "callback_query",
    ]);
  });

  test("always calls setWebhook even when URL already matches (secret may have rotated)", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await reconcileTelegramWebhook(caches);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });

  test("normalizes trailing slash on ingress base URL", async () => {
    const calls: { method: string; body: unknown }[] = [];

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
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
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toHaveLength(2);
    expect((calls[1].body as any).url).toBe(
      "https://example.ngrok.io/webhooks/telegram",
    );
  });

  test("skips reconciliation when bot token is not configured", async () => {
    fetchMock = mock(async () => new Response("", { status: 200 }));

    const noBotCaches = makeCaches({ botToken: undefined });
    await reconcileTelegramWebhook(noBotCaches);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when webhook secret is not configured", async () => {
    fetchMock = mock(async () => new Response("", { status: 200 }));

    const noSecretCaches = makeCaches({ webhookSecret: undefined });
    await reconcileTelegramWebhook(noSecretCaches);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips reconciliation when ingress URL is not configured", async () => {
    fetchMock = mock(async () => new Response("", { status: 200 }));

    const noIngressCaches = makeCaches({ ingressUrl: undefined });
    await reconcileTelegramWebhook(noIngressCaches);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("registers a managed callback route when ingress URL is not configured", async () => {
    const calls: { method: string; body: unknown }[] = [];
    process.env.IS_CONTAINERIZED = "true";
    const caches = makeCaches({
      ingressUrl: undefined,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "ast-managed-key",
      platformAssistantId: "11111111-2222-4333-8444-555555555555",
    });

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (
          url ===
          "https://platform.example.com/v1/internal/gateway/callback-routes/register/"
        ) {
          const body = init?.body ? JSON.parse(init.body as string) : null;
          calls.push({ method: "registerCallbackRoute", body });
          return new Response(
            JSON.stringify({
              callback_url:
                "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
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
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("registerCallbackRoute");
    expect(calls[0].body).toEqual({
      assistant_id: "11111111-2222-4333-8444-555555555555",
      callback_path: "webhooks/telegram",
      type: "telegram",
    });
    expect(calls[1].method).toBe("getWebhookInfo");
    expect(calls[2].method).toBe("setWebhook");
    expect((calls[2].body as any).url).toBe(
      "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
    );
    expect((calls[2].body as any).secret_token).toBe("test-webhook-secret");
  });

  test("registers via env assistant key and credential cache for assistant ID", async () => {
    const calls: {
      method: string;
      body: unknown;
      headers?: Record<string, string>;
    }[] = [];
    process.env.IS_CONTAINERIZED = "true";
    process.env.VELLUM_PLATFORM_URL = "https://env-platform.example.com";
    process.env.ASSISTANT_API_KEY = "env-key";

    const caches = makeCaches({
      ingressUrl: undefined,
      platformBaseUrl: undefined,
      assistantApiKey: undefined,
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/callback-routes/register/")) {
          const body = init?.body ? JSON.parse(init.body as string) : null;
          const headers = init?.headers as Record<string, string>;
          calls.push({ method: "registerCallbackRoute", body, headers });
          return new Response(
            JSON.stringify({
              callback_url:
                "https://env-platform.example.com/v1/gateway/callbacks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/webhooks/telegram/",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
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
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("registerCallbackRoute");
    expect(calls[0].body).toEqual({
      assistant_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      callback_path: "webhooks/telegram",
      type: "telegram",
    });
    expect(calls[0].headers?.Authorization).toBe("Api-Key env-key");
    expect(calls[2].method).toBe("setWebhook");
    expect((calls[2].body as any).url).toBe(
      "https://env-platform.example.com/v1/gateway/callbacks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/webhooks/telegram/",
    );
  });

  test("credential cache for assistant ID, base URL, and auth key", async () => {
    const calls: {
      method: string;
      body: unknown;
      headers?: Record<string, string>;
    }[] = [];
    process.env.IS_CONTAINERIZED = "true";
    process.env.VELLUM_PLATFORM_URL = "https://env-platform.example.com";

    const caches = makeCaches({
      ingressUrl: undefined,
      platformBaseUrl: "https://cache-platform.example.com",
      assistantApiKey: "cache-api-key",
      platformAssistantId: "cache-assistant-id",
    });

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/callback-routes/register/")) {
          const body = init?.body ? JSON.parse(init.body as string) : null;
          const headers = init?.headers as Record<string, string>;
          calls.push({ method: "registerCallbackRoute", body, headers });
          return new Response(
            JSON.stringify({
              callback_url:
                "https://cache-platform.example.com/v1/gateway/callbacks/cache-assistant-id/webhooks/telegram/",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
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
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("registerCallbackRoute");
    // platform_base_url: credential cache takes precedence over env var
    expect(calls[0].body).toEqual({
      assistant_id: "cache-assistant-id",
      callback_path: "webhooks/telegram",
      type: "telegram",
    });
    expect(calls[0].headers?.Authorization).toBe("Api-Key cache-api-key");
    // Registration URL should use cache platform URL
    expect((calls[2].body as any).url).toBe(
      "https://cache-platform.example.com/v1/gateway/callbacks/cache-assistant-id/webhooks/telegram/",
    );
  });

  test("skips registration when no platform URL is available from cache or env", async () => {
    process.env.IS_CONTAINERIZED = "true";

    const caches = makeCaches({
      ingressUrl: undefined,
      platformBaseUrl: undefined,
      assistantApiKey: undefined,
      platformAssistantId: undefined,
    });

    fetchMock = mock(async () => new Response("", { status: 200 }));

    await reconcileTelegramWebhook(caches);

    // No fetch calls should be made — registration is skipped
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("calls setWebhook when current URL is empty", async () => {
    const calls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

    await reconcileTelegramWebhook(caches);

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
  });
});
