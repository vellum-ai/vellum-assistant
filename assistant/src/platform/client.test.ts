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

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../providers/managed-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => mockManagedProxyCtx,
}));

mock.module("../config/env.js", () => ({
  getPlatformAssistantId: () => mockAssistantId,
}));

// Stub the credential-store fallback so tests stay hermetic and do not
// read real values from the host credential backend.
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (namespace: string, key: string) => `${namespace}:${key}`,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { VellumPlatformClient } from "./client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureFetch(): { calls: { url: string; init: RequestInit }[] } {
  const state = { calls: [] as { url: string; init: RequestInit }[] };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    state.calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return state;
}

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

  describe("requireAssistantId()", () => {
    test("returns assistant ID when configured", async () => {
      const client = await VellumPlatformClient.create();
      expect(client!.requireAssistantId()).toBe("asst-123");
    });

    test("throws when assistant ID is empty", async () => {
      mockAssistantId = "";
      const client = await VellumPlatformClient.create();
      expect(() => client!.requireAssistantId()).toThrow(
        "Assistant ID not configured",
      );
    });
  });

  describe("assistant", () => {
    test("getter throws when assistant ID is empty", async () => {
      mockAssistantId = "";
      const client = await VellumPlatformClient.create();
      expect(() => client!.assistant).toThrow("Assistant ID not configured");
    });

    test("getter returns cached sub-client", async () => {
      const client = await VellumPlatformClient.create();
      const a = client!.assistant;
      const b = client!.assistant;
      expect(a).toBe(b);
    });

    test("fetch() scopes paths to /v1/assistants/{id}/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.fetch("/email-addresses/");
      expect(state.calls[0].url).toBe(
        "https://platform.example.com/v1/assistants/asst-123/email-addresses/",
      );
    });

    test("patch() sends PATCH with JSON body", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.patch({ name: "TestBot" });
      expect(state.calls[0].url).toBe(
        "https://platform.example.com/v1/assistants/asst-123/",
      );
      expect(state.calls[0].init.method).toBe("PATCH");
      expect(state.calls[0].init.body).toBe('{"name":"TestBot"}');
    });

    test("patch() merges extra init options", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.patch(
        { name: "TestBot" },
        { signal: AbortSignal.timeout(5_000) },
      );
      expect(state.calls[0].init.signal).toBeDefined();
    });
  });

  describe("assistant.emailAddresses", () => {
    test("list() calls GET /email-addresses/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emailAddresses.list();
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/email-addresses/",
      );
      expect(state.calls[0].init.method).toBeUndefined();
    });

    test("create() calls POST /email-addresses/ with username", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emailAddresses.create("mybot");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/email-addresses/",
      );
      expect(state.calls[0].init.method).toBe("POST");
      expect(JSON.parse(state.calls[0].init.body as string)).toEqual({
        username: "mybot",
      });
    });

    test("delete() calls DELETE /email-addresses/{id}/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emailAddresses.delete("addr-456");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/email-addresses/addr-456/",
      );
      expect(state.calls[0].init.method).toBe("DELETE");
    });

    test("getStatus() calls GET /email-addresses/{id}/status/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emailAddresses.getStatus("addr-456");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/email-addresses/addr-456/status/",
      );
    });
  });

  describe("assistant.emails", () => {
    test("list() calls GET /emails/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emails.list();
      expect(state.calls[0].url).toEndWith("/v1/assistants/asst-123/emails/");
    });

    test("list() appends query params", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      const params = new URLSearchParams({ direction: "inbound", limit: "5" });
      await client!.assistant.emails.list(params);
      expect(state.calls[0].url).toContain("direction=inbound");
      expect(state.calls[0].url).toContain("limit=5");
    });

    test("get() calls GET /emails/{id}/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emails.get("msg-789");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/emails/msg-789/",
      );
    });

    test("listAttachments() calls correct path", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emails.listAttachments("msg-789");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/emails/msg-789/attachments/",
      );
    });

    test("downloadAttachment() calls correct path", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.emails.downloadAttachment("msg-789", "att-111");
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/emails/msg-789/attachments/att-111/download/",
      );
    });
  });

  describe("assistant.oauth", () => {
    test("connections() calls GET /oauth/connections/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.oauth.connections();
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/oauth/connections/",
      );
    });

    test("connections() appends query params", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      const params = new URLSearchParams({ provider: "google" });
      await client!.assistant.oauth.connections(params);
      expect(state.calls[0].url).toContain("provider=google");
    });

    test("managedCatalog() calls GET /oauth/managed/catalog/", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.oauth.managedCatalog();
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/oauth/managed/catalog/",
      );
    });

    test("externalProviderProxy() calls correct path", async () => {
      const state = captureFetch();
      const client = await VellumPlatformClient.create();
      await client!.assistant.oauth.externalProviderProxy("conn-42", {
        method: "POST",
      });
      expect(state.calls[0].url).toEndWith(
        "/v1/assistants/asst-123/external-provider-proxy/conn-42/",
      );
      expect(state.calls[0].init.method).toBe("POST");
    });
  });
});
