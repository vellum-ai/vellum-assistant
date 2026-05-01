/**
 * Tests for credential account key normalization in the HTTP routes.
 *
 * Verifies that colon-separated account names (e.g. `vellum:platform_organization_id`)
 * are transparently normalized to the internal slash-separated format
 * (e.g. `credential/vellum/platform_organization_id`) so that credentials
 * stored via direct HTTP are findable by the gateway and assistant.
 */

import { describe, it, expect } from "bun:test";

import { handleCredentialRoute } from "../credential-routes.js";
import type { CredentialRouteDeps } from "../credential-routes.js";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_TOKEN = "test-token-normalization";

function makeDeps(): { deps: CredentialRouteDeps; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: SecureKeyBackend = {
    get: async (account: string) => store.get(account),
    set: async (account: string, value: string) => {
      store.set(account, value);
      return true;
    },
    delete: async (account: string) => {
      if (!store.has(account)) return "not-found";
      store.delete(account);
      return "deleted";
    },
    list: async () => [...store.keys()],
  };
  return { deps: { backend, serviceToken: SERVICE_TOKEN }, store };
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const url = `http://localhost:8090${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SERVICE_TOKEN}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("credential route key normalization", () => {
  it("normalizes colon-separated key on POST (set)", async () => {
    const { deps, store } = makeDeps();

    const req = makeRequest(
      "POST",
      "/v1/credentials/vellum%3Aplatform_organization_id",
      { value: "org-uuid-123" },
    );
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.account).toBe("credential/vellum/platform_organization_id");

    // Verify it was stored under the normalized key
    expect(store.get("credential/vellum/platform_organization_id")).toBe("org-uuid-123");
    expect(store.has("vellum:platform_organization_id")).toBe(false);
  });

  it("normalizes colon-separated key on GET", async () => {
    const { deps, store } = makeDeps();
    store.set("credential/vellum/platform_user_id", "user-uuid-456");

    const req = makeRequest(
      "GET",
      "/v1/credentials/vellum%3Aplatform_user_id",
    );
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.value).toBe("user-uuid-456");
  });

  it("normalizes colon-separated key on DELETE", async () => {
    const { deps, store } = makeDeps();
    store.set("credential/vellum/temp_cred", "temp-value");

    const req = makeRequest(
      "DELETE",
      "/v1/credentials/vellum%3Atemp_cred",
    );
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(store.has("credential/vellum/temp_cred")).toBe(false);
  });

  it("passes through keys already in credential/ format", async () => {
    const { deps, store } = makeDeps();

    const req = makeRequest(
      "POST",
      "/v1/credentials/credential%2Fvellum%2Fassistant_api_key",
      { value: "api-key-789" },
    );
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(store.get("credential/vellum/assistant_api_key")).toBe("api-key-789");
  });

  it("passes through oauth/ prefixed keys", async () => {
    const { deps, store } = makeDeps();

    const req = makeRequest(
      "POST",
      "/v1/credentials/oauth%2Fconnection%2Faccess_token",
      { value: "token-abc" },
    );
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(store.get("oauth/connection/access_token")).toBe("token-abc");
  });

  it("normalizes colon-separated keys in bulk set", async () => {
    const { deps, store } = makeDeps();

    const req = makeRequest("POST", "/v1/credentials/bulk", {
      credentials: [
        { account: "vellum:platform_organization_id", value: "org-1" },
        { account: "vellum:platform_user_id", value: "user-1" },
        { account: "credential/vellum/assistant_api_key", value: "key-1" },
      ],
    });
    const res = await handleCredentialRoute(req, deps);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();

    expect(body.results).toHaveLength(3);
    expect(body.results[0].account).toBe("credential/vellum/platform_organization_id");
    expect(body.results[1].account).toBe("credential/vellum/platform_user_id");
    expect(body.results[2].account).toBe("credential/vellum/assistant_api_key");

    expect(store.get("credential/vellum/platform_organization_id")).toBe("org-1");
    expect(store.get("credential/vellum/platform_user_id")).toBe("user-1");
    expect(store.get("credential/vellum/assistant_api_key")).toBe("key-1");
  });

  it("returns normalized key in response body", async () => {
    const { deps } = makeDeps();

    const req = makeRequest(
      "POST",
      "/v1/credentials/slack_channel%3Abot_token",
      { value: "xoxb-test" },
    );
    const res = await handleCredentialRoute(req, deps);

    const body = await res!.json();
    expect(body.account).toBe("credential/slack_channel/bot_token");
  });
});
