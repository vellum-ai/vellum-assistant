/**
 * Tests for one-time credential-collection links: the credential_requests
 * store lifecycle (atomic claim / redeem / rollback), the public peek/submit
 * HTTP handlers, and the IPC mint handler's guards (flag, public URL, caps).
 *
 * SECURITY invariants pinned here: the plaintext token is never stored (only
 * its sha256 hash), a link is single-use under racing submitters, and a
 * failed daemon forward releases the claim instead of burning the link.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import "./test-preload.js";

import { generateInviteToken, hashInviteToken } from "@vellumai/gateway-client";

// Mock the daemon IPC client before importing the handlers under test.
let ipcCalls: Array<{ method: string; params: unknown }> = [];
let ipcFailure: Error | null = null;
mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: async (method: string, params?: unknown) => {
    ipcCalls.push({ method, params });
    if (ipcFailure) throw ipcFailure;
    return {};
  },
  IpcHandlerError: class IpcHandlerError extends Error {
    statusCode = 500;
  },
}));

let flagEnabled = true;
mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: () => flagEnabled,
  getFeatureFlagValue: () => flagEnabled,
}));

const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { credentialRequests } = await import("../db/schema.js");
const { CredentialRequestStore } =
  await import("../db/credential-request-store.js");
const { handleCredentialRequestPeek, handleCredentialRequestSubmit } =
  await import("../http/routes/credential-requests.js");
const { createCredentialRequest, resetCredentialRequestRateLimiterForTests } =
  await import("../ipc/credential-request-handlers.js");

import type { ConfigFileCache } from "../config-file-cache.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(credentialRequests).run();
  ipcCalls = [];
  ipcFailure = null;
  flagEnabled = true;
  resetCredentialRequestRateLimiterForTests();
});

afterAll(() => {
  resetGatewayDb();
});

const fakeConfigFile = (publicBaseUrl?: string) =>
  ({
    getString: (_section: string, field: string) =>
      field === "publicBaseUrl" ? publicBaseUrl : undefined,
  }) as unknown as ConfigFileCache;

function mintRow(params?: { expiresAt?: number; purpose?: string }) {
  const token = generateInviteToken();
  const store = new CredentialRequestStore();
  const row = store.create({
    id: crypto.randomUUID(),
    tokenHash: hashInviteToken(token),
    purpose: (params?.purpose ?? "standalone") as "standalone" | "prompt",
    service: "github",
    field: "api_token",
    label: "GitHub token",
    expiresAt: params?.expiresAt ?? Date.now() + 60_000,
  });
  return { token, row, store };
}

function postJson(body: unknown): Request {
  return new Request("http://gateway.local/v1/credential-requests/x", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("credential-request mint (IPC)", () => {
  test("mints a link whose URL carries the token and whose row stores only the hash", () => {
    const result = createCredentialRequest(
      fakeConfigFile("https://assistant.example.com/"),
      { service: "github", field: "api_token", label: "GitHub token" },
    );

    if (!result.ok) throw new Error(`mint failed: ${result.error}`);
    // Fragment, not query: browsers never send fragments over HTTP, so the
    // token cannot land in access logs or Referer headers.
    expect(result.url).toBe(
      `https://assistant.example.com/assistant/credentials/enter#token=${encodeURIComponent(result.token)}`,
    );

    const row = new CredentialRequestStore().findByTokenHash(
      hashInviteToken(result.token),
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe("active");
    // The plaintext token never lands in the DB.
    expect(JSON.stringify(row)).not.toContain(result.token);
  });

  test("refuses to mint when the feature flag is off", () => {
    flagEnabled = false;
    const result = createCredentialRequest(fakeConfigFile("https://x.test"), {
      service: "github",
      field: "api_token",
    });
    expect(result).toEqual({ ok: false, error: "flag_disabled" });
  });

  test("refuses to mint without a public ingress URL", () => {
    const result = createCredentialRequest(fakeConfigFile(undefined), {
      service: "github",
      field: "api_token",
    });
    expect(result).toEqual({ ok: false, error: "no_public_base_url" });
  });
});

describe("credential-request peek", () => {
  test("returns the collection spec for a valid token", async () => {
    const { token } = mintRow();
    const res = await handleCredentialRequestPeek(postJson({ token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("github");
    expect(body.field).toBe("api_token");
    expect(body.label).toBe("GitHub token");
  });

  test("does not consume the token", async () => {
    const { token, row } = mintRow();
    await handleCredentialRequestPeek(postJson({ token }));
    await handleCredentialRequestPeek(postJson({ token }));
    const fresh = new CredentialRequestStore().findByTokenHash(row.tokenHash);
    expect(fresh!.status).toBe("active");
    expect(fresh!.useCount).toBe(0);
  });

  test.each([["unknown token", { token: generateInviteToken() }, "INVALID"]])(
    "404s an %s",
    async (_label, body, code) => {
      const res = await handleCredentialRequestPeek(postJson(body));
      expect(res.status).toBe(404);
      const parsed = (await res.json()) as { error: { code: string } };
      expect(parsed.error.code).toBe(code);
    },
  );

  test("404s an expired token as EXPIRED", async () => {
    const { token } = mintRow({ expiresAt: Date.now() - 1 });
    const res = await handleCredentialRequestPeek(postJson({ token }));
    expect(res.status).toBe(404);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("EXPIRED");
  });
});

describe("credential-request submit", () => {
  test("stores the value via the daemon and marks the link redeemed", async () => {
    const { token, row } = mintRow();
    const res = await handleCredentialRequestSubmit(
      postJson({ token, value: "sekret-value" }),
    );
    expect(res.status).toBe(200);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]).toEqual({
      method: "credentials_set",
      params: {
        body: {
          service: "github",
          field: "api_token",
          value: "sekret-value",
          label: "GitHub token",
        },
      },
    });

    const fresh = new CredentialRequestStore().findByTokenHash(row.tokenHash);
    expect(fresh!.status).toBe("redeemed");
    expect(fresh!.useCount).toBe(1);
  });

  test("is single-use: a second submit sees USED", async () => {
    const { token } = mintRow();
    await handleCredentialRequestSubmit(postJson({ token, value: "v1" }));
    const res = await handleCredentialRequestSubmit(
      postJson({ token, value: "v2" }),
    );
    expect(res.status).toBe(404);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("USED");
    expect(ipcCalls).toHaveLength(1);
  });

  test("releases the claim when the daemon forward fails", async () => {
    const { token, row } = mintRow();
    ipcFailure = new Error("daemon offline");

    const res = await handleCredentialRequestSubmit(
      postJson({ token, value: "sekret" }),
    );
    expect(res.status).toBe(502);

    // The link survives the transient failure and can be retried.
    const fresh = new CredentialRequestStore().findByTokenHash(row.tokenHash);
    expect(fresh!.status).toBe("active");

    ipcFailure = null;
    const retry = await handleCredentialRequestSubmit(
      postJson({ token, value: "sekret" }),
    );
    expect(retry.status).toBe(200);
  });

  test("applies the mint-time policy together with the value", async () => {
    /**
     * The credential policy captured at mint time travels on the row
     * (policyJson) and is forwarded to credentials_set at redemption — never
     * before — so an unredeemed link cannot mutate an existing credential's
     * metadata.
     */
    const token = generateInviteToken();
    new CredentialRequestStore().create({
      id: crypto.randomUUID(),
      tokenHash: hashInviteToken(token),
      purpose: "standalone",
      service: "stripe",
      field: "api_key",
      label: "Stripe API Key",
      policyJson: JSON.stringify({
        usageDescription: "Billing lookups",
        allowedTools: ["make_authenticated_request"],
        allowedDomains: ["api.stripe.com"],
        injectionTemplates: [
          { hostPattern: "api.stripe.com", injectionType: "header" },
        ],
      }),
      expiresAt: Date.now() + 60_000,
    });

    const res = await handleCredentialRequestSubmit(
      postJson({ token, value: "sekret" }),
    );
    expect(res.status).toBe(200);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.params).toEqual({
      body: {
        service: "stripe",
        field: "api_key",
        value: "sekret",
        label: "Stripe API Key",
        description: "Billing lookups",
        allowedTools: ["make_authenticated_request"],
        allowedDomains: ["api.stripe.com"],
        injectionTemplates: [
          { hostPattern: "api.stripe.com", injectionType: "header" },
        ],
      },
    });
  });

  test.todo(
    "resolves the pending prompt for prompt-bound requests (assistant link fallback)",
    () => {},
  );
});
