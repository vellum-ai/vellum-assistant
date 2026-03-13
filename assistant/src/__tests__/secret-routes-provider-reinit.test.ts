import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Track calls to initializeProviders and invalidateConfigCache
// ---------------------------------------------------------------------------
let initializeProvidersCalls = 0;
let invalidateConfigCacheCalls = 0;

mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "openrouter",
    "brave",
    "perplexity",
  ],
  getConfig: () => ({
    apiKeys: {},
    provider: "anthropic",
    model: "test-model",
  }),
  invalidateConfigCache: () => {
    invalidateConfigCacheCalls++;
  },
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: () => {
    initializeProvidersCalls++;
  },
}));

// ---------------------------------------------------------------------------
// Mock secure-keys: track stored keys
// ---------------------------------------------------------------------------
const storedKeys = new Map<string, string>();

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: async (key: string, value: string) => {
    storedKeys.set(key, value);
    return true;
  },
  getSecureKeyAsync: async (key: string) => storedKeys.get(key),
  deleteSecureKeyAsync: async (key: string) => {
    storedKeys.delete(key);
    return "ok";
  },
}));

// ---------------------------------------------------------------------------
// Mock metadata store
// ---------------------------------------------------------------------------
mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
const { handleAddSecret, handleDeleteSecret } =
  await import("../runtime/routes/secret-routes.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  initializeProvidersCalls = 0;
  invalidateConfigCacheCalls = 0;
  storedKeys.clear();
});

describe("secret routes — provider reinitialization", () => {
  test("adding an api_key reinitializes providers", async () => {
    const req = buildRequest({
      type: "api_key",
      name: "anthropic",
      value: "sk-test-key",
    });
    const res = await handleAddSecret(req);
    expect(res.status).toBe(201);
    expect(initializeProvidersCalls).toBe(1);
    expect(invalidateConfigCacheCalls).toBe(1);
  });

  test("adding the assistant API key credential reinitializes providers", async () => {
    const req = buildRequest({
      type: "credential",
      name: "vellum:assistant_api_key",
      value: "ast-test-key-123",
    });
    const res = await handleAddSecret(req);
    expect(res.status).toBe(201);

    // The credential should be stored under the canonical key
    const expectedKey = credentialKey("vellum", "assistant_api_key");
    expect(storedKeys.get(expectedKey)).toBe("ast-test-key-123");

    // Providers must be reinitialized so the managed proxy picks up the key
    expect(invalidateConfigCacheCalls).toBe(1);
    expect(initializeProvidersCalls).toBe(1);
  });

  test("adding a non-managed-proxy credential does not reinitialize providers", async () => {
    const req = buildRequest({
      type: "credential",
      name: "github:api_token",
      value: "ghp-test-token",
    });
    const res = await handleAddSecret(req);
    expect(res.status).toBe(201);
    expect(invalidateConfigCacheCalls).toBe(0);
    expect(initializeProvidersCalls).toBe(0);
  });

  test("deleting a credential reinitializes providers", async () => {
    // Pre-populate the key so the delete finds it
    const key = credentialKey("vellum", "assistant_api_key");
    storedKeys.set(key, "ast-old-key");

    const req = buildRequest({
      type: "credential",
      name: "vellum:assistant_api_key",
    });
    const res = await handleDeleteSecret(req);
    expect(res.status).toBe(200);
    expect(invalidateConfigCacheCalls).toBe(1);
    expect(initializeProvidersCalls).toBe(1);
  });
});
