import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let mockIsContainerized = true;
let mockPlatformBaseUrl = "";
let mockPlatformAssistantId = "";
let mockPlatformInternalApiKey = "";
let mockSecureKeys: Record<string, string> = {};

mock.module("../config/env-registry.js", () => ({
  getIsContainerized: () => mockIsContainerized,
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
  getPlatformInternalApiKey: () => mockPlatformInternalApiKey,
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

const { registerCallbackRoute, resolvePlatformCallbackRegistrationContext } =
  await import("../inbound/platform-callback-registration.js");

describe("platform callback registration", () => {
  beforeEach(() => {
    mockIsContainerized = true;
    mockPlatformBaseUrl = "";
    mockPlatformAssistantId = "";
    mockPlatformInternalApiKey = "";
    mockSecureKeys = {};
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    expect(context.containerized).toBe(true);
    expect(context.platformBaseUrl).toBe("https://platform.example.com");
    expect(context.assistantId).toBe("11111111-2222-4333-8444-555555555555");
    expect(context.hasInternalApiKey).toBe(false);
    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key ast-managed-key");
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
