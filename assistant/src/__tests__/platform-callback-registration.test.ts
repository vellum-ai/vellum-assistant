import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setIngressPublicBaseUrl } from "../config/env.js";
import { credentialKey } from "../security/credential-key.js";

let mockIsPlatform = true;
let mockPlatformBaseUrl = "";
let mockPlatformAssistantId = "";
let mockSecureKeys: Record<string, string> = {};
let mockConfig: { ingress?: { publicBaseUrl?: string; enabled?: boolean } } =
  {};

// Bun shares mocked modules across test files in a combined run, so each mock
// spreads the real module and overrides only what this file drives. Replacing
// a module wholesale drops the exports peer tests import from it and breaks
// their ESM named-import validation whenever this mock wins evaluation.
const actualEnvRegistry = await import("../config/env-registry.js");
mock.module("../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsPlatform: () => mockIsPlatform,
}));

const actualEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...actualEnv,
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
}));

const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? undefined,
}));

const actualLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => mockConfig,
}));

const originalFetch = globalThis.fetch;
const originalEnvCredential = process.env.ASSISTANT_API_KEY;

const {
  registerCallbackRoute,
  resolveCallbackUrl,
  resolvePlatformCallbackRegistrationContext,
} = await import("../inbound/platform-callback-registration.js");

const { PublicIngressDisabledError } =
  await import("../inbound/public-ingress-urls.js");

describe("platform callback registration", () => {
  beforeEach(() => {
    mockIsPlatform = true;
    mockPlatformBaseUrl = "";
    mockPlatformAssistantId = "";
    mockSecureKeys = {};
    mockConfig = {};
    setIngressPublicBaseUrl(undefined);
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

  test("self-hosted registerCallbackRoute sends configured callback_base_url", async () => {
    mockIsPlatform = false;
    mockConfig = {
      ingress: { publicBaseUrl: "https://my-assistant.example.com" },
    };
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "22222222-3333-4444-8555-666666666666";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-self-hosted-key";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          assistant_id: "22222222-3333-4444-8555-666666666666",
          callback_path: "webhooks/telegram",
          type: "telegram",
          callback_base_url: "https://my-assistant.example.com",
        });

        return new Response(
          JSON.stringify({
            callback_url:
              "https://my-assistant.example.com/v1/gateway/callbacks/x/",
            callback_path:
              "22222222-3333-4444-8555-666666666666/webhooks/telegram",
            type: "telegram",
            assistant_id: "22222222-3333-4444-8555-666666666666",
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
    ).resolves.toBe(
      "https://my-assistant.example.com/v1/gateway/callbacks/x/",
    );
  });

  test("self-hosted registerCallbackRoute sends detected module-level callback_base_url", async () => {
    mockIsPlatform = false;
    mockConfig = {};
    setIngressPublicBaseUrl("https://detected.example.com/");
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "22222222-3333-4444-8555-666666666666";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-self-hosted-key";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          assistant_id: "22222222-3333-4444-8555-666666666666",
          callback_path: "webhooks/telegram",
          type: "telegram",
          callback_base_url: "https://detected.example.com",
        });

        return new Response(
          JSON.stringify({
            callback_url:
              "https://detected.example.com/v1/gateway/callbacks/x/",
            callback_path:
              "22222222-3333-4444-8555-666666666666/webhooks/telegram",
            type: "telegram",
            assistant_id: "22222222-3333-4444-8555-666666666666",
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
    ).resolves.toBe("https://detected.example.com/v1/gateway/callbacks/x/");
  });

  test("self-hosted registerCallbackRoute omits callback_base_url when no ingress is available", async () => {
    mockIsPlatform = false;
    mockConfig = {};
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "22222222-3333-4444-8555-666666666666";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-self-hosted-key";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body).toEqual({
          assistant_id: "22222222-3333-4444-8555-666666666666",
          callback_path: "webhooks/telegram",
          type: "telegram",
        });
        expect(body).not.toHaveProperty("callback_base_url");

        return new Response(
          JSON.stringify({
            callback_url:
              "https://platform.example.com/v1/gateway/callbacks/x/",
            callback_path:
              "22222222-3333-4444-8555-666666666666/webhooks/telegram",
            type: "telegram",
            assistant_id: "22222222-3333-4444-8555-666666666666",
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

  test("platform-managed registerCallbackRoute omits callback_base_url even when ingress exists", async () => {
    mockIsPlatform = true;
    mockConfig = { ingress: { publicBaseUrl: "https://velay.example.com" } };
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "11111111-2222-4333-8444-555555555555";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-managed-key";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body).not.toHaveProperty("callback_base_url");
        expect(body).toEqual({
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

/**
 * `resolveCallbackUrl` drives Twilio voice/status callbacks and OAuth redirect
 * URIs. Its tier order has to match `handleWebhooksRegister` in
 * `runtime/routes/webhook-routes.ts` and `hasWebhookRoutingConfigured` in
 * `config/webhook-routing.ts` (LUM-2882).
 */
describe("resolveCallbackUrl resolution order", () => {
  const PLATFORM_URL = "https://platform.example.com/v1/gateway/callbacks/x/";

  /** Stand in for a URL builder that cannot resolve a public ingress URL. */
  function noIngress(): string {
    throw new Error(
      "No public base URL configured. Set ingress.publicBaseUrl in config.",
    );
  }

  /** Stand in for a URL builder reached while ingress is switched off. */
  function ingressDisabled(): string {
    throw new PublicIngressDisabledError();
  }

  function seedPlatformCredentials(): void {
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      "https://platform.example.com";
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      "11111111-2222-4333-8444-555555555555";
    mockSecureKeys[credentialKey("vellum", "assistant_api_key")] =
      "ast-managed-key";
  }

  let registerCalls: number;

  beforeEach(() => {
    mockIsPlatform = false;
    mockPlatformBaseUrl = "";
    mockPlatformAssistantId = "";
    mockSecureKeys = {};
    mockConfig = {};
    setIngressPublicBaseUrl(undefined);
    delete process.env.ASSISTANT_API_KEY;
    registerCalls = 0;
    globalThis.fetch = mock(async () => {
      registerCalls++;
      return new Response(
        JSON.stringify({
          callback_url: PLATFORM_URL,
          callback_path: "webhooks/twilio/voice",
          type: "twilio_voice",
          assistant_id: "11111111-2222-4333-8444-555555555555",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("platform pods register with the platform gateway", async () => {
    mockIsPlatform = true;
    seedPlatformCredentials();

    // The direct supplier is never evaluated on a pod: there is no ingress of
    // its own to advertise, and evaluating it would throw.
    await expect(
      resolveCallbackUrl(noIngress, "webhooks/twilio/voice", "twilio_voice"),
    ).resolves.toBe(PLATFORM_URL);
    expect(registerCalls).toBe(1);
  });

  test("a configured ingress wins over platform connectivity", async () => {
    seedPlatformCredentials();

    await expect(
      resolveCallbackUrl(
        () => "https://tunnel.example.com/webhooks/twilio/voice",
        "webhooks/twilio/voice",
        "twilio_voice",
      ),
    ).resolves.toBe("https://tunnel.example.com/webhooks/twilio/voice");
    expect(registerCalls).toBe(0);
  });

  test("a platform-connected assistant with no ingress registers with the platform", async () => {
    // LUM-2882: this used to return the direct builder's throw because the
    // platform branch was gated on IS_PLATFORM, which is only true on a pod.
    seedPlatformCredentials();

    await expect(
      resolveCallbackUrl(noIngress, "webhooks/twilio/voice", "twilio_voice"),
    ).resolves.toBe(PLATFORM_URL);
    expect(registerCalls).toBe(1);
  });

  test("query parameters are appended to the platform URL", async () => {
    seedPlatformCredentials();

    await expect(
      resolveCallbackUrl(noIngress, "webhooks/twilio/voice", "twilio_voice", {
        callSessionId: "conv-xyz",
      }),
    ).resolves.toBe(`${PLATFORM_URL}?callSessionId=conv-xyz`);
  });

  test("an explicit ingress opt-out is not routed around", async () => {
    seedPlatformCredentials();

    await expect(
      resolveCallbackUrl(
        ingressDisabled,
        "webhooks/twilio/voice",
        "twilio_voice",
      ),
    ).rejects.toThrow("Public ingress is disabled");
    expect(registerCalls).toBe(0);
  });

  test("without platform credentials the ingress error surfaces unchanged", async () => {
    await expect(
      resolveCallbackUrl(noIngress, "webhooks/twilio/voice", "twilio_voice"),
    ).rejects.toThrow("No public base URL configured");
    expect(registerCalls).toBe(0);
  });
});
