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

let velayWebhooksEnabled = false;
let claimedRoutes: { path: string; type: string }[] = [];
let claimError: Error | undefined;

// Stubbing the store keeps this suite on the resolver, and the claim log is
// where the ordering against setWebhook is asserted. Module mocks are visible
// to every file in the run, so the untouched exports are spread through rather
// than dropped.
const actualRouteStore = await import("../db/webhook-ingress-route-store.js");
mock.module("../db/webhook-ingress-route-store.js", () => ({
  ...actualRouteStore,
  registerWebhookIngressRoute: (input: { path: string; type: string }) => {
    if (claimError) {
      throw claimError;
    }
    claimedRoutes.push(input);
    return input;
  },
}));

const actualFlagResolver = await import("../feature-flag-resolver.js");
mock.module("../feature-flag-resolver.js", () => ({
  ...actualFlagResolver,
  isFeatureFlagEnabled: (flag: string) =>
    flag === "velay-webhooks" ? velayWebhooksEnabled : false,
}));

const { reconcileTelegramWebhook } =
  await import("../telegram/webhook-manager.js");

afterEach(() => {
  fetchMock = mock(async () => new Response());
  velayWebhooksEnabled = false;
  claimedRoutes = [];
  claimError = undefined;
  delete process.env.IS_CONTAINERIZED;
  delete process.env.IS_PLATFORM;
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
    ingressEnabled?: boolean;
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
    getBoolean: (section: string, key: string) => {
      if (section === "ingress" && key === "enabled") {
        return opts.ingressEnabled;
      }
      return undefined;
    },
    getRecord: () => undefined,
    refreshNow: () => {},
  } as unknown as ConfigFileCache;
  return { credentials, configFile };
}

const PLATFORM_ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const MANAGED_CALLBACK_URL = `https://platform.example.com/v1/gateway/callbacks/${PLATFORM_ASSISTANT_ID}/webhooks/telegram/`;

/** Caches for a pod holding platform credentials, with the published URL varied. */
function makePlatformCaches(ingressUrl: string | undefined) {
  return makeCaches({
    ingressUrl,
    platformBaseUrl: "https://platform.example.com",
    assistantApiKey: "ast-managed-key",
    platformAssistantId: PLATFORM_ASSISTANT_ID,
  });
}

/**
 * Answer every endpoint a reconcile can reach, in call order. Managed callback
 * registration 404s unless `callbackUrl` is given, so a test expecting the
 * Velay tier fails loudly if the resolver falls back instead.
 */
function mockReconcileFetch(opts: { callbackUrl?: string } = {}): {
  calls: string[];
  result: { registeredUrl?: string; claimsAtSetWebhook?: number };
} {
  const calls: string[] = [];
  const result: { registeredUrl?: string; claimsAtSetWebhook?: number } = {};

  fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/getMe")) {
        // Managed registration looks the bot up for a display name. Answered
        // but not recorded, so `calls` stays a record of the resolution order.
        return makeTelegramResponse({ username: "test_bot" });
      }
      if (url.includes("/callback-routes/register/")) {
        calls.push("registerCallbackRoute");
        if (!opts.callbackUrl) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({ callback_url: opts.callbackUrl }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
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
        result.claimsAtSetWebhook = claimedRoutes.length;
        result.registeredUrl = init?.body
          ? (JSON.parse(init.body as string) as { url?: string }).url
          : undefined;
        return makeTelegramResponse(true);
      }
      calls.push(`unexpected:${url}`);
      return new Response("Not found", { status: 404 });
    },
  );

  return { calls, result };
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

  test("registers a managed callback route without IS_CONTAINERIZED when platform credentials are present (LUM-2899)", async () => {
    const calls: { method: string; body: unknown }[] = [];
    // IS_CONTAINERIZED deliberately unset: a platform-connected local
    // assistant must complete the setWebhook handshake for the managed
    // callback mode that `hasWebhookRoutingConfigured` reports as configured.
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
    expect(calls[1].method).toBe("getWebhookInfo");
    expect(calls[2].method).toBe("setWebhook");
    expect((calls[2].body as any).url).toBe(
      "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
    );
    expect((calls[2].body as any).secret_token).toBe("test-webhook-secret");
  });

  test("includes callback_base_url when a platform pod has an ingress URL in config", async () => {
    const calls: { method: string; body: unknown }[] = [];
    process.env.IS_PLATFORM = "true";
    process.env.IS_CONTAINERIZED = "true";
    const caches = makeCaches({
      ingressUrl: "https://velay.example.com",
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

    expect(calls[0].method).toBe("registerCallbackRoute");
    expect(calls[0].body).toEqual({
      assistant_id: "11111111-2222-4333-8444-555555555555",
      callback_path: "webhooks/telegram",
      type: "telegram",
      callback_base_url: "https://velay.example.com",
    });
    expect((calls[2].body as { url: string }).url).toBe(
      "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
    );
  });

  test("deregisters the webhook instead of using the managed callback fallback when ingress is explicitly disabled", async () => {
    const calls: string[] = [];
    const caches = makeCaches({
      ingressUrl: undefined,
      ingressEnabled: false,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "ast-managed-key",
      platformAssistantId: "11111111-2222-4333-8444-555555555555",
    });

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/deleteWebhook")) {
        calls.push("deleteWebhook");
        return makeTelegramResponse(true);
      }
      calls.push(`unexpected:${url}`);
      return new Response("Not found", { status: 404 });
    });

    await reconcileTelegramWebhook(caches);

    expect(calls).toEqual(["deleteWebhook"]);
  });

  test("deregisters the webhook when ingress is explicitly disabled even with an ingress URL", async () => {
    const calls: string[] = [];
    const caches = makeCaches({
      ingressEnabled: false,
      ingressUrl: "https://example.ngrok.io",
    });

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/deleteWebhook")) {
        calls.push("deleteWebhook");
        return makeTelegramResponse(true);
      }
      calls.push(`unexpected:${url}`);
      return new Response("Not found", { status: 404 });
    });

    await reconcileTelegramWebhook(caches);

    expect(calls).toEqual(["deleteWebhook"]);
  });

  test("ignores ingress.enabled false on platform pods and registers the managed callback route", async () => {
    const calls: string[] = [];
    process.env.IS_PLATFORM = "true";
    const caches = makeCaches({
      ingressUrl: undefined,
      ingressEnabled: false,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "ast-managed-key",
      platformAssistantId: "11111111-2222-4333-8444-555555555555",
    });

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/callback-routes/register/")) {
        calls.push("registerCallbackRoute");
        return new Response(
          JSON.stringify({
            callback_url:
              "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/deleteWebhook")) {
        calls.push("deleteWebhook");
        return makeTelegramResponse(true);
      }
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

    expect(calls).toEqual([
      "registerCallbackRoute",
      "getWebhookInfo",
      "setWebhook",
    ]);
  });

  test("prefers the managed callback route over the Velay ingress URL on platform pods", async () => {
    const calls: string[] = [];
    let registeredUrl: string | undefined;
    process.env.IS_PLATFORM = "true";
    // A platform pod always has an `ingress.publicBaseUrl`: the Velay tunnel
    // client publishes one at boot. It must not win over the managed callback
    // route — the Velay address dies with the tunnel, and the daemon's
    // `hasWebhookRoutingConfigured` reports this pod as managed-callback mode.
    const caches = makeCaches({
      ingressUrl:
        "https://velay.vellum.ai/11111111-2222-4333-8444-555555555555",
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
        if (url.includes("/callback-routes/register/")) {
          calls.push("registerCallbackRoute");
          return new Response(
            JSON.stringify({
              callback_url:
                "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
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
          const body = init?.body
            ? (JSON.parse(init.body as string) as { url?: string })
            : undefined;
          registeredUrl = body?.url;
          return makeTelegramResponse(true);
        }
        return new Response("Not found", { status: 404 });
      },
    );

    await reconcileTelegramWebhook(caches);

    expect(calls).toEqual([
      "registerCallbackRoute",
      "getWebhookInfo",
      "setWebhook",
    ]);
    expect(registeredUrl).toBe(
      "https://platform.example.com/v1/gateway/callbacks/11111111-2222-4333-8444-555555555555/webhooks/telegram/",
    );
    expect(claimedRoutes).toEqual([]);
  });

  test("points a pod at its published Velay URL and claims the path first when the flag is on", async () => {
    process.env.IS_PLATFORM = "true";
    velayWebhooksEnabled = true;
    const { calls, result } = mockReconcileFetch();

    await reconcileTelegramWebhook(
      makePlatformCaches(
        "https://velay.vellum.ai/11111111-2222-4333-8444-555555555555/",
      ),
    );

    expect(calls).toEqual(["getWebhookInfo", "setWebhook"]);
    expect(claimedRoutes).toEqual([
      { path: "/webhooks/telegram", type: "telegram" },
    ]);
    // The claim is what makes the URL reachable, so it has to land first.
    expect(result.claimsAtSetWebhook).toBe(1);
    expect(result.registeredUrl).toBe(
      "https://velay.vellum.ai/11111111-2222-4333-8444-555555555555/webhooks/telegram",
    );
  });

  test("falls back to the managed callback route when the path claim fails", async () => {
    process.env.IS_PLATFORM = "true";
    velayWebhooksEnabled = true;
    claimError = new Error("database disk image is malformed");
    const { calls, result } = mockReconcileFetch({
      callbackUrl: MANAGED_CALLBACK_URL,
    });

    await reconcileTelegramWebhook(
      makePlatformCaches(
        "https://velay.vellum.ai/11111111-2222-4333-8444-555555555555",
      ),
    );

    expect(calls).toEqual([
      "registerCallbackRoute",
      "getWebhookInfo",
      "setWebhook",
    ]);
    expect(result.registeredUrl).toBe(MANAGED_CALLBACK_URL);
  });

  test("falls back to the managed callback route when the flag is on but no URL is published", async () => {
    process.env.IS_PLATFORM = "true";
    velayWebhooksEnabled = true;
    const { calls, result } = mockReconcileFetch({
      callbackUrl: MANAGED_CALLBACK_URL,
    });

    await reconcileTelegramWebhook(makePlatformCaches(undefined));

    expect(calls).toEqual([
      "registerCallbackRoute",
      "getWebhookInfo",
      "setWebhook",
    ]);
    expect(claimedRoutes).toEqual([]);
    expect(result.registeredUrl).toBe(MANAGED_CALLBACK_URL);
  });

  test("does not claim a path for a self-hosted ingress URL", async () => {
    velayWebhooksEnabled = true;
    const { result } = mockReconcileFetch();

    await reconcileTelegramWebhook(makeCaches());

    expect(claimedRoutes).toEqual([]);
    expect(result.registeredUrl).toBe(
      "https://example.ngrok.io/webhooks/telegram",
    );
  });

  test("does not call Telegram when ingress is disabled but credentials are absent", async () => {
    fetchMock = mock(async () => new Response("", { status: 200 }));

    const caches = makeCaches({ ingressEnabled: false, botToken: undefined });
    await reconcileTelegramWebhook(caches);

    expect(fetchMock).not.toHaveBeenCalled();
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

const VELAY_BASE_URL = `https://velay.vellum.ai/${PLATFORM_ASSISTANT_ID}`;
const VELAY_WEBHOOK_URL = `${VELAY_BASE_URL}/webhooks/telegram`;

/**
 * Platform caches that read the published ingress URL live, so a reconcile
 * latched behind another one resolves against whatever the tunnel settled on
 * rather than the value that was current when it was queued.
 */
function makeLivePlatformCaches(readIngressUrl: () => string | undefined) {
  const credentialMap: Record<string, string | undefined> = {
    [credentialKey("telegram", "bot_token")]: "test-bot-token",
    [credentialKey("telegram", "webhook_secret")]: "test-webhook-secret",
    [credentialKey("vellum", "platform_base_url")]:
      "https://platform.example.com",
    [credentialKey("vellum", "assistant_api_key")]: "ast-managed-key",
    [credentialKey("vellum", "platform_assistant_id")]: PLATFORM_ASSISTANT_ID,
  };
  const credentials = {
    get: async (key: string) => credentialMap[key],
    invalidate: () => {},
  } as unknown as CredentialCache;
  let refreshCount = 0;
  const configFile = {
    getString: (section: string, key: string) =>
      section === "ingress" && key === "publicBaseUrl"
        ? readIngressUrl()
        : undefined,
    getNumber: () => undefined,
    getBoolean: () => undefined,
    getRecord: () => undefined,
    refreshNow: () => {
      refreshCount += 1;
    },
  } as unknown as ConfigFileCache;
  return {
    caches: { credentials, configFile },
    refreshes: () => refreshCount,
  };
}

/** Yield until a condition holds, so a test can act mid-reconcile. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}

describe("reconcileTelegramWebhook serialization", () => {
  test("a reconcile latched behind a slow one settles on the newer address", async () => {
    process.env.IS_PLATFORM = "true";
    velayWebhooksEnabled = true;

    // The tunnel clears its published URL and republishes it moments later.
    // The first reconcile sees the cleared state and resolves the managed
    // callback route; the second must win with the Velay URL.
    const published: { ingressUrl?: string } = {};
    const { caches, refreshes } = makeLivePlatformCaches(
      () => published.ingressUrl,
    );

    const registeredUrls: string[] = [];
    let releaseFirstSetWebhook = () => {};
    const firstSetWebhookHeld = new Promise<void>((resolve) => {
      releaseFirstSetWebhook = resolve;
    });

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/getMe")) {
          return makeTelegramResponse({ username: "test_bot" });
        }
        if (url.includes("/callback-routes/register/")) {
          return new Response(
            JSON.stringify({ callback_url: MANAGED_CALLBACK_URL }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/getWebhookInfo")) {
          return makeTelegramResponse({
            url: registeredUrls[registeredUrls.length - 1] ?? "",
            has_custom_certificate: false,
            pending_update_count: 0,
          });
        }
        if (url.includes("/setWebhook")) {
          const body = init?.body
            ? (JSON.parse(init.body as string) as { url?: string })
            : undefined;
          registeredUrls.push(body?.url ?? "");
          if (registeredUrls.length === 1) {
            await firstSetWebhookHeld;
          }
          return makeTelegramResponse(true);
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const first = reconcileTelegramWebhook(caches);
    await waitFor(() => registeredUrls.length === 1);

    published.ingressUrl = VELAY_BASE_URL;
    const second = reconcileTelegramWebhook(caches);
    releaseFirstSetWebhook();
    await Promise.all([first, second]);

    // The managed registration is the stale one, so it must not be what
    // Telegram is left pointed at.
    expect(registeredUrls).toEqual([MANAGED_CALLBACK_URL, VELAY_WEBHOOK_URL]);
    expect(claimedRoutes).toEqual([
      { path: "/webhooks/telegram", type: "telegram" },
    ]);
    // The rerun re-reads config rather than trusting the snapshot the first
    // run was resolved against.
    expect(refreshes()).toBe(1);
  });

  test("a burst of triggers costs at most two reconciles", async () => {
    const caches = makeCaches();
    let setWebhookCount = 0;
    let releaseFirstSetWebhook = () => {};
    const firstSetWebhookHeld = new Promise<void>((resolve) => {
      releaseFirstSetWebhook = resolve;
    });

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/getWebhookInfo")) {
        return makeTelegramResponse({
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      }
      if (url.includes("/setWebhook")) {
        setWebhookCount += 1;
        if (setWebhookCount === 1) {
          await firstSetWebhookHeld;
        }
        return makeTelegramResponse(true);
      }
      return new Response("Not found", { status: 404 });
    });

    const pending = [reconcileTelegramWebhook(caches)];
    await waitFor(() => setWebhookCount === 1);
    for (let i = 0; i < 5; i++) {
      pending.push(reconcileTelegramWebhook(caches));
    }
    releaseFirstSetWebhook();
    await Promise.all(pending);

    // One in flight plus one latched, no matter how many triggers land.
    expect(setWebhookCount).toBe(2);
  });
});
