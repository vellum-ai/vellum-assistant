/**
 * Tests for the POST /v1/credentials/bulk endpoint.
 *
 * Verifies:
 * - Successful bulk set with multiple credentials
 * - Validation failure (missing fields, non-array body)
 * - Auth requirement (401 without token)
 */

import { describe, it, expect } from "bun:test";

import { handleCredentialRoute } from "../credential-routes.js";
import type { CredentialRouteDeps } from "../credential-routes.js";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_TOKEN = "test-ces-service-token-12345";

function makeDeps(
  overrides: Partial<SecureKeyBackend> = {},
): CredentialRouteDeps {
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
    ...overrides,
  };
  return { backend, serviceToken: SERVICE_TOKEN };
}

function makeRequest(
  opts: {
    body?: unknown;
    token?: string | null;
    method?: string;
  } = {},
): Request {
  const url = "http://localhost:8090/v1/credentials/bulk";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token !== null) {
    headers["Authorization"] = `Bearer ${opts.token ?? SERVICE_TOKEN}`;
  }

  return new Request(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/credentials/bulk", () => {
  it("sets multiple credentials and returns per-credential results", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({
        body: {
          credentials: [
            { account: "openai", value: "sk-abc" },
            { account: "anthropic", value: "sk-xyz" },
          ],
        },
      }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json();
    expect(body.results).toEqual([
      { account: "openai", ok: true },
      { account: "anthropic", ok: true },
    ]);

    // Verify credentials were actually stored
    expect(await deps.backend.get("openai")).toBe("sk-abc");
    expect(await deps.backend.get("anthropic")).toBe("sk-xyz");
  });

  it("reports per-credential failure when backend.set returns false", async () => {
    let callCount = 0;
    const deps = makeDeps({
      set: async () => {
        callCount++;
        // Fail on the second call
        return callCount !== 2;
      },
    });

    const res = await handleCredentialRoute(
      makeRequest({
        body: {
          credentials: [
            { account: "a", value: "1" },
            { account: "b", value: "2" },
            { account: "c", value: "3" },
          ],
        },
      }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json();
    expect(body.results).toEqual([
      { account: "a", ok: true },
      { account: "b", ok: false },
      { account: "c", ok: true },
    ]);
  });

  it("returns 400 when credentials field is not an array", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ body: { credentials: "not-an-array" } }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const body = await res!.json();
    expect(body.error).toMatch(/credentials.*array/i);
  });

  it("returns 400 when credentials field is missing", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ body: {} }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const body = await res!.json();
    expect(body.error).toMatch(/credentials.*array/i);
  });

  it("returns 400 when an entry is missing account field", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({
        body: {
          credentials: [{ value: "sk-abc" }],
        },
      }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const body = await res!.json();
    expect(body.error).toMatch(/account.*value/i);
  });

  it("returns 400 when an entry is missing value field", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({
        body: {
          credentials: [{ account: "openai" }],
        },
      }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const body = await res!.json();
    expect(body.error).toMatch(/account.*value/i);
  });

  it("returns 401 without Authorization header", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ token: null, body: { credentials: [] } }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);

    const body = await res!.json();
    expect(body.error).toMatch(/Missing Authorization/i);
  });

  it("returns 403 with wrong service token", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ token: "wrong-token", body: { credentials: [] } }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);

    const body = await res!.json();
    expect(body.error).toMatch(/Invalid service token/i);
  });

  it("non-POST methods fall through to single-account handler (bulk treated as account name)", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ method: "GET", body: undefined }),
      deps,
    );

    expect(res).not.toBeNull();
    // "bulk" is interpreted as an account name by the :account handler;
    // no such credential exists, so we get 404.
    expect(res!.status).toBe(404);
  });

  it("handles empty credentials array", async () => {
    const deps = makeDeps();
    const res = await handleCredentialRoute(
      makeRequest({ body: { credentials: [] } }),
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json();
    expect(body.results).toEqual([]);
  });
});
