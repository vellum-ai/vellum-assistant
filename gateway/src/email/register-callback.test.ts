import { describe, test, expect, afterEach } from "bun:test";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import {
  mockFetch,
  getMockFetchCalls,
  resetMockFetch,
} from "../__tests__/mock-fetch.js";
import {
  registerEmailCallbackRoute,
  EMAIL_CALLBACK_PATH,
} from "./register-callback.js";

afterEach(() => {
  resetMockFetch();
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.PLATFORM_INTERNAL_API_KEY;
});

function makeConfigFile(
  values: Record<string, Record<string, string>> = {},
): ConfigFileCache {
  return {
    getString: (section: string, key: string) =>
      values[section]?.[key] ?? undefined,
    invalidate: () => {},
  } as unknown as ConfigFileCache;
}

function makeCaches(opts: {
  platformBaseUrl?: string;
  assistantApiKey?: string;
  platformAssistantId?: string;
  ingressUrl?: string;
}): { credentials: CredentialCache; configFile?: ConfigFileCache } {
  const store = new Map<string, string>();
  if (opts.platformBaseUrl)
    store.set(
      credentialKey("vellum", "platform_base_url"),
      opts.platformBaseUrl,
    );
  if (opts.assistantApiKey)
    store.set(
      credentialKey("vellum", "assistant_api_key"),
      opts.assistantApiKey,
    );
  if (opts.platformAssistantId)
    store.set(
      credentialKey("vellum", "platform_assistant_id"),
      opts.platformAssistantId,
    );

  const result: {
    credentials: CredentialCache;
    configFile?: ConfigFileCache;
  } = {
    credentials: {
      get: async (key: string) => store.get(key),
      invalidate: () => {},
    } as CredentialCache,
  };

  if (opts.ingressUrl) {
    result.configFile = makeConfigFile({
      ingress: { publicBaseUrl: opts.ingressUrl },
    });
  }

  return result;
}

describe("registerEmailCallbackRoute", () => {
  test("returns undefined when credentials are missing", async () => {
    const result = await registerEmailCallbackRoute();
    expect(result).toBeUndefined();
  });

  test("returns undefined when credential cache has no platform values", async () => {
    const caches = makeCaches({});
    const result = await registerEmailCallbackRoute(caches);
    expect(result).toBeUndefined();
  });

  test("registers callback route with platform via credential cache", async () => {
    const caches = makeCaches({
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "test-api-key",
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    const callbackUrl =
      "https://platform.example.com/v1/gateway/callbacks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/webhooks/email/";

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      {
        body: { callback_url: callbackUrl },
        status: 201,
      },
    );

    const result = await registerEmailCallbackRoute(caches);

    expect(result).toBe(callbackUrl);

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(
      "/v1/internal/gateway/callback-routes/register/",
    );
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      assistant_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      callback_path: EMAIL_CALLBACK_PATH,
      type: "email",
    });
  });

  test("uses credential cache for assistant ID", async () => {
    process.env.VELLUM_PLATFORM_URL = "https://env-platform.example.com";
    process.env.PLATFORM_INTERNAL_API_KEY = "internal-key";

    const callbackUrl =
      "https://env-platform.example.com/v1/gateway/callbacks/11111111-2222-3333-4444-555555555555/webhooks/email/";

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      {
        body: { callback_url: callbackUrl },
        status: 201,
      },
    );

    const caches = makeCaches({
      platformAssistantId: "11111111-2222-3333-4444-555555555555",
    });

    const result = await registerEmailCallbackRoute(caches);

    expect(result).toBe(callbackUrl);

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer internal-key");
  });

  test("throws on non-ok response", async () => {
    const caches = makeCaches({
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "test-api-key",
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      new Response("Forbidden", { status: 403 }),
    );

    await expect(registerEmailCallbackRoute(caches)).rejects.toThrow(
      /Email callback route registration failed \(HTTP 403\)/,
    );
  });

  test("throws when response has no callback_url", async () => {
    const caches = makeCaches({
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "test-api-key",
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      {
        body: { id: "route-id" },
        status: 201,
      },
    );

    await expect(registerEmailCallbackRoute(caches)).rejects.toThrow(
      /did not include callback_url/,
    );
  });

  test("sends callback_base_url when ingress URL is configured (self-hosted)", async () => {
    const caches = makeCaches({
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "vak_selfhosted",
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ingressUrl: "https://my-assistant.example.com",
    });

    const callbackUrl =
      "https://my-assistant.example.com/v1/gateway/callbacks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/webhooks/email/";

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      {
        body: { callback_url: callbackUrl },
        status: 201,
      },
    );

    const result = await registerEmailCallbackRoute(caches);

    expect(result).toBe(callbackUrl);

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      assistant_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      callback_path: EMAIL_CALLBACK_PATH,
      type: "email",
      callback_base_url: "https://my-assistant.example.com",
    });
  });

  test("omits callback_base_url when no ingress URL is configured (platform-managed)", async () => {
    const caches = makeCaches({
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "vak_managed",
      platformAssistantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    const callbackUrl =
      "https://platform.example.com/v1/gateway/callbacks/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/webhooks/email/";

    mockFetch(
      "callback-routes/register",
      { method: "POST" },
      {
        body: { callback_url: callbackUrl },
        status: 201,
      },
    );

    await registerEmailCallbackRoute(caches);

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).not.toHaveProperty("callback_base_url");
  });

  test("EMAIL_CALLBACK_PATH matches gateway route", () => {
    expect(EMAIL_CALLBACK_PATH).toBe("webhooks/email");
  });
});
