import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockManagedProxyCtx = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};
let mockAssistantId = "";
let mockSecureKeys: Record<string, string | null | undefined> = {};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => mockManagedProxyCtx,
}));

mock.module("../config/env.js", () => ({
  getPlatformAssistantId: () => mockAssistantId,
}));

// Stub the credential-store fallback so tests stay hermetic and do not
// read real values from the host credential backend.
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? null,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (namespace: string, key: string) => `${namespace}:${key}`,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { VellumPlatformClient } from "./client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VellumPlatformClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockManagedProxyCtx = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "sk-test-key",
    };
    mockAssistantId = "asst-123";
    mockSecureKeys = {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("create()", () => {
    test("returns a client when all prerequisites are met", async () => {
      const client = await VellumPlatformClient.create();
      expect(client).not.toBeNull();
      expect(client!.baseUrl).toBe("https://platform.example.com");
      expect(client!.assistantApiKey).toBe("sk-test-key");
      expect(client!.platformAssistantId).toBe("asst-123");
    });

    test("returns null when managed proxy is not enabled", async () => {
      mockManagedProxyCtx = {
        enabled: false,
        platformBaseUrl: "",
        assistantApiKey: "",
      };

      const client = await VellumPlatformClient.create();
      expect(client).toBeNull();
    });

    test("returns client with empty assistantId when assistant ID is missing", async () => {
      mockAssistantId = "";

      const client = await VellumPlatformClient.create();
      expect(client).not.toBeNull();
      expect(client!.platformAssistantId).toBe("");
    });

    test("strips trailing slash from platform base URL", async () => {
      mockManagedProxyCtx.platformBaseUrl = "https://platform.example.com///";

      const client = await VellumPlatformClient.create();
      expect(client!.baseUrl).toBe("https://platform.example.com");
    });

    test("falls back to credential store values when managed context is not rehydrated", async () => {
      mockManagedProxyCtx = {
        enabled: false,
        platformBaseUrl: "",
        assistantApiKey: "",
      };
      mockAssistantId = "";
      mockSecureKeys = {
        "vellum:platform_base_url": "https://stored-platform.example.com/",
        "vellum:assistant_api_key": "stored-api-key",
        "vellum:platform_assistant_id": " stored-assistant-id ",
      };

      const client = await VellumPlatformClient.create();

      expect(client).not.toBeNull();
      expect(client!.baseUrl).toBe("https://stored-platform.example.com");
      expect(client!.assistantApiKey).toBe("stored-api-key");
      expect(client!.platformAssistantId).toBe("stored-assistant-id");
    });
  });

  describe("fetch()", () => {
    test("prepends base URL to path", async () => {
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        expect(String(url)).toBe(
          "https://platform.example.com/v1/some/endpoint/",
        );
        return new Response("ok", { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      await client!.fetch("/v1/some/endpoint/");
    });

    test("injects Api-Key auth header", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      await client!.fetch("/v1/test/");
    });

    test("preserves caller-provided headers", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Content-Type")).toBe("application/json");
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      await client!.fetch("/v1/test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    });

    test("passes through request init options", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.method).toBe("POST");
          expect(init?.body).toBe('{"key":"value"}');
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      await client!.fetch("/v1/test/", {
        method: "POST",
        body: '{"key":"value"}',
      });
    });
  });

  describe("getOwnerConsent()", () => {
    test("maps snake_case body to camelCase on 200", async () => {
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        expect(String(url)).toBe(
          "https://platform.example.com/v1/assistants/asst-123/owner-consent/",
        );
        return new Response(
          JSON.stringify({
            share_analytics: true,
            share_diagnostics: false,
            share_diagnostics_accepted_version: "2026-06-18",
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: false,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      });
    });

    test("defaults shareDiagnosticsAcceptedVersion to '' when the platform omits it (back-compat)", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "",
      });
    });

    test("uses the authenticated Api-Key header", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          );
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      await client!.getOwnerConsent();
    });

    test("returns null on 404", async () => {
      globalThis.fetch = mock(
        async () => new Response("not found", { status: 404 }),
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null on 500", async () => {
      globalThis.fetch = mock(
        async () => new Response("error", { status: 500 }),
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null on network error", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("null share_analytics (owner never chose) maps to false, keeping diagnostics intact", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              share_analytics: null,
              share_diagnostics: true,
              share_diagnostics_accepted_version: "2026-06-18",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: false,
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      });
    });

    test("returns null on malformed body (non-boolean fields)", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: "yes", share_diagnostics: 1 }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null without fetching when assistantId is empty", async () => {
      mockAssistantId = "";
      mockSecureKeys = {};

      const fetchSpy = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          ),
      );
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      const client = await VellumPlatformClient.create();
      expect(client!.platformAssistantId).toBe("");
      expect(await client!.getOwnerConsent()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
