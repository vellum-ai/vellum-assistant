import { beforeEach, describe, expect, mock, test } from "bun:test";

import { BadRequestError } from "../runtime/routes/errors.js";

// ---------------------------------------------------------------------------
// Mutable mock state (closed over by the mock factories below)
// ---------------------------------------------------------------------------

let secureStore: Map<string, string>;
let syncedServices: string[];

// ---------------------------------------------------------------------------
// Mocks for the collaborators handleAddSecret touches on the credential path
// ---------------------------------------------------------------------------

mock.module("../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: mock(async (key: string, value: string) => {
    secureStore.set(key, value);
    return true;
  }),
  getSecureKeyAsync: mock(async (key: string) => secureStore.get(key)),
  getSecureKeyResultAsync: mock(async (key: string) => ({
    value: secureStore.get(key),
    unreachable: false,
  })),
  deleteSecureKeyAsync: mock(async (key: string) =>
    secureStore.delete(key) ? "deleted" : "not-found",
  ),
  listSecureKeysAsync: mock(async () => ({ accounts: [], unreachable: false })),
  getActiveBackendName: () => "encrypted-store",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: mock(() => {}),
  deleteCredentialMetadata: mock(() => {}),
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async (service: string) => {
    syncedServices.push(service);
  }),
}));

import { ROUTES } from "../runtime/routes/secret-routes.js";

const addRoute = ROUTES.find(
  (r) => r.method === "POST" && r.endpoint === "secrets",
)!;

type AddResponse = { success: boolean; type: string; name: string };

function addCredential(name: string, value: string) {
  return addRoute.handler({ body: { type: "credential", name, value } });
}

describe("secrets add — ACP token-type format guard", () => {
  beforeEach(() => {
    secureStore = new Map();
    syncedServices = [];
  });

  /**
   * The original bug: an Anthropic API key (sk-ant-api…) stored under the ACP
   * OAuth field caused a 401. The write path now rejects a mismatched ACP
   * token type with a message routing the user to the correct field.
   */
  test("rejects an Anthropic API key under the ACP OAuth field", async () => {
    // WHEN an sk-ant-api… key is added under acp:claude_oauth_token
    let caught: unknown;
    try {
      await addCredential("acp:claude_oauth_token", "sk-ant-api03-abc123");
    } catch (err) {
      caught = err;
    }

    // THEN it is a BadRequestError routing to the API-key field, and nothing
    // is persisted
    expect(caught).toBeInstanceOf(BadRequestError);
    expect((caught as Error).message).toContain("anthropic_api_key");
    expect(secureStore.size).toBe(0);
  });

  test("rejects a Claude OAuth token under the ACP API-key field", async () => {
    // WHEN an sk-ant-oat… token is added under acp:anthropic_api_key
    let caught: unknown;
    try {
      await addCredential("acp:anthropic_api_key", "sk-ant-oat01-abc123");
    } catch (err) {
      caught = err;
    }

    // THEN it is a BadRequestError routing to the OAuth field
    expect(caught).toBeInstanceOf(BadRequestError);
    expect((caught as Error).message).toContain("claude_oauth_token");
    expect(secureStore.size).toBe(0);
  });

  test("stores correctly-paired ACP credentials", async () => {
    // WHEN each ACP token is added under its matching field
    const apiResult = (await addCredential(
      "acp:anthropic_api_key",
      "sk-ant-api03-abc123",
    )) as AddResponse;
    const oauthResult = (await addCredential(
      "acp:claude_oauth_token",
      "sk-ant-oat01-abc123",
    )) as AddResponse;

    // THEN both succeed and are persisted unchanged
    expect(apiResult.success).toBe(true);
    expect(oauthResult.success).toBe(true);
    expect(secureStore.get("acp:anthropic_api_key")).toBe(
      "sk-ant-api03-abc123",
    );
    expect(secureStore.get("acp:claude_oauth_token")).toBe(
      "sk-ant-oat01-abc123",
    );
  });

  test("leaves an unrelated service untouched by the ACP guard", async () => {
    // WHEN a token-shaped value is added under a non-ACP service
    const result = (await addCredential(
      "github:api_token",
      "sk-ant-oat01-abc123",
    )) as AddResponse;

    // THEN the guard does not fire and the value is persisted
    expect(result.success).toBe(true);
    expect(secureStore.get("github:api_token")).toBe("sk-ant-oat01-abc123");
  });
});
