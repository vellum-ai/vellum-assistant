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
  const credentialMap: Record<string, string | undefined> = {
    [credentialKey("telegram", "bot_token")]: botToken,
    [credentialKey("telegram", "webhook_secret")]: webhookSecret,
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
