import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let mockIsPlatform = true;
let mockPlatformBaseUrl = "";
let mockPlatformAssistantId = "";
let mockSecureKeys: Record<string, string> = {};

mock.module("../config/env-registry.js", () => ({
  getIsPlatform: () => mockIsPlatform,
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? undefined,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const originalFetch = globalThis.fetch;
const originalEnvCredential = process.env.ASSISTANT_API_KEY;

const { registerCallbackRoute, resolvePlatformCallbackRegistrationContext } =
  await import("../inbound/platform-callback-registration.js");

describe("platform callback registration", () => {
  beforeEach(() => {
    mockIsPlatform = true;
    mockPlatformBaseUrl = "";
    mockPlatformAssistantId = "";
    mockSecureKeys = {};
    delete process.env.ASSISTANT_API_KEY;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnvCredential === undefined) {
      delete process.env.ASSISTANT_API_KEY;
    } else {
      process.env.ASSISTANT_API_KEY = originalEnvCredential;
    }
  });

  test("resolves managed callback context from stored credentials", async () => {
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "11111111-2222-4333-8444-555555555555";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-managed-key";

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.enabled).toBe(true);
    expect(context.isPlatform).toBe(true);
    expect(context.platformBaseUrl).toBe("https://platform.example.com");
    expect(context.assistantId).toBe("11111111-2222-4333-8444-555555555555");
    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key ast-managed-key");
  });

  test("self-hosted assistant with stored credentials is enabled without IS_PLATFORM", async () => {
    mockIsPlatform = false;
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "22222222-3333-4444-8555-666666666666";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-self-hosted-key";

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.enabled).toBe(true);
    expect(context.isPlatform).toBe(false);
    expect(context.platformBaseUrl).toBe("https://platform.example.com");
    expect(context.assistantId).toBe("22222222-3333-4444-8555-666666666666");
    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key ast-self-hosted-key");
  });

  test("uses ASSISTANT_API_KEY env fallback when stored credential is missing", async () => {
    process.env.ASSISTANT_API_KEY = "env-key";
    mockPlatformBaseUrl = "https://platform.example.com";
    mockPlatformAssistantId = "33333333-4444-4555-8666-777777777777";

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.enabled).toBe(true);
    expect(context.platformBaseUrl).toBe("https://platform.example.com");
    expect(context.assistantId).toBe("33333333-4444-4555-8666-777777777777");
    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key env-key");
  });

  test("registerCallbackRoute falls back to assistant API key auth", async () => {
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "11111111-2222-4333-8444-555555555555";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-managed-key";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://platform.example.com/v1/internal/gateway/callback-routes/register/",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Api-Key ast-managed-key");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({
          assistant_id: "11111111-2222-4333-8444-555555555555",
          callback_path: "webhooks/telegram",
          type: "telegram",
        });

        return new Response(
          JSON.stringify({
            callback_url:
              "https://platform.example.com/v1/gateway/callbacks/x/",
            callback_path:
              "11111111-2222-4333-8444-555555555555/webhooks/telegram",
            type: "telegram",
            assistant_id: "11111111-2222-4333-8444-555555555555",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      },
    ) as unknown as typeof fetch;

    await expect(
      registerCallbackRoute("webhooks/telegram", "telegram"),
    ).resolves.toBe("https://platform.example.com/v1/gateway/callbacks/x/");
  });
});
