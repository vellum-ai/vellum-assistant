/**
 * secrets_add (api_key) transcript-scrub seam.
 *
 * A provider API key stored via `assistant keys set` / the secrets API may
 * already sit in recent transcripts. Validates that the route:
 *   - scrubs the stored value exactly once, immediately after the
 *     secure-store write
 *   - never scrubs when validation rejects the request (nothing was stored)
 *   - still succeeds when the scrub itself rejects (best-effort hygiene)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state (closed over by the mock factories below)
// ---------------------------------------------------------------------------

let secureStore: Map<string, string>;
let scrubbedValues: string[];
let scrubRejects: boolean;
let anthropicKeyValid: boolean;
let providersRefreshed: number;

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

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
  listSecureKeysAsync: mock(async () => ({
    accounts: [...secureStore.keys()],
    unreachable: false,
  })),
  getActiveBackendName: () => "test",
}));

mock.module("../daemon/credential-transcript-scrub.js", () => ({
  scrubStoredCredentialFromTranscripts: mock(async (value: string) => {
    scrubbedValues.push(value);
    if (scrubRejects) {
      throw new Error("transcript sweep failed");
    }
    return { dbMessagesScrubbed: 0, residentMessagesScrubbed: 0 };
  }),
}));

mock.module("../providers/anthropic/client.js", () => ({
  validateAnthropicApiKey: mock(async () =>
    anthropicKeyValid
      ? { valid: true }
      : { valid: false, reason: "Invalid API key" },
  ),
}));

// Collaborators of refreshProvidersAfterSecretChange — stubbed so the api_key
// flow runs without a live config/provider/conversation graph.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));
mock.module("../providers/registry.js", () => ({
  initializeProviders: mock(async () => {
    providersRefreshed++;
  }),
}));
mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));
mock.module("../daemon/conversation-store.js", () => ({
  evictConversationsForReload: () => {},
}));

// Collaborators of the `credential` branch — stubbed so credential stores run
// without live metadata/oauth/platform-env state.
mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));
mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async () => {}),
}));
mock.module("../config/env.js", () => ({
  getPlatformAssistantId: () => undefined,
  setPlatformAssistantId: () => {},
  setPlatformBaseUrl: () => {},
  setPlatformOrganizationId: () => {},
  setPlatformUserId: () => {},
}));

import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/secret-routes.js";
import { credentialKey } from "../security/credential-key.js";

const addRoute = ROUTES.find((r) => r.operationId === "secrets_add")!;

const API_KEY_VALUE = "test-api-key-value-1234567890";

describe("secrets_add api_key transcript scrub", () => {
  beforeEach(() => {
    secureStore = new Map();
    scrubbedValues = [];
    scrubRejects = false;
    anthropicKeyValid = true;
    providersRefreshed = 0;
  });

  test("a successful api_key set scrubs the stored value exactly once", async () => {
    const result = await addRoute.handler({
      body: { type: "api_key", name: "fireworks", value: API_KEY_VALUE },
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, name: "fireworks" }),
    );
    expect(secureStore.get(credentialKey("fireworks", "api_key"))).toBe(
      API_KEY_VALUE,
    );
    expect(scrubbedValues).toEqual([API_KEY_VALUE]);
  });

  test("an unknown provider is rejected and never triggers a scrub", async () => {
    await expect(
      addRoute.handler({
        body: {
          type: "api_key",
          name: "not-a-real-provider",
          value: API_KEY_VALUE,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });

  test("a provider-validation failure stores nothing and never triggers a scrub", async () => {
    anthropicKeyValid = false;

    const result = await addRoute.handler({
      body: { type: "api_key", name: "anthropic", value: API_KEY_VALUE },
    });

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: "Invalid API key" }),
    );
    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });

  test("the route still succeeds (and refreshes providers) when the scrub rejects", async () => {
    scrubRejects = true;

    const result = await addRoute.handler({
      body: { type: "api_key", name: "fireworks", value: API_KEY_VALUE },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureStore.get(credentialKey("fireworks", "api_key"))).toBe(
      API_KEY_VALUE,
    );
    // The scrub ran (once) even though it failed, and the failure stayed
    // invisible to the caller — the provider refresh still happened.
    expect(scrubbedValues).toEqual([API_KEY_VALUE]);
    expect(providersRefreshed).toBe(1);
  });
});

const CREDENTIAL_VALUE = "synthetic-credential-value-0987654321";

describe("secrets_add credential transcript scrub", () => {
  beforeEach(() => {
    secureStore = new Map();
    scrubbedValues = [];
    scrubRejects = false;
    anthropicKeyValid = true;
    providersRefreshed = 0;
  });

  test("a successful credential set scrubs the stored value exactly once", async () => {
    const result = await addRoute.handler({
      body: {
        type: "credential",
        name: "github:api_token",
        value: CREDENTIAL_VALUE,
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureStore.get(credentialKey("github", "api_token"))).toBe(
      CREDENTIAL_VALUE,
    );
    expect(scrubbedValues).toEqual([CREDENTIAL_VALUE]);
  });

  test("the route still succeeds when the credential scrub rejects", async () => {
    scrubRejects = true;

    const result = await addRoute.handler({
      body: {
        type: "credential",
        name: "github:api_token",
        value: CREDENTIAL_VALUE,
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureStore.get(credentialKey("github", "api_token"))).toBe(
      CREDENTIAL_VALUE,
    );
    expect(scrubbedValues).toEqual([CREDENTIAL_VALUE]);
  });

  test("non-secret platform fields are stored but never scrubbed", async () => {
    for (const field of [
      "platform_assistant_id",
      "platform_organization_id",
      "platform_user_id",
      "platform_base_url",
    ]) {
      const result = await addRoute.handler({
        body: {
          type: "credential",
          name: `vellum:${field}`,
          value: "0198f4c2-1111-2222-3333-444455556666",
        },
      });
      expect(result).toEqual(expect.objectContaining({ success: true }));
    }

    // All four stored, none scrubbed — they are benign UUIDs/URLs that
    // legitimately appear in transcripts.
    expect(secureStore.size).toBe(4);
    expect(scrubbedValues).toEqual([]);
  });

  test("an identity-field delete stores nothing and never scrubs", async () => {
    const result = await addRoute.handler({
      body: {
        type: "credential",
        name: "vellum:platform_assistant_id",
        value: "   ",
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });

  test("a malformed credential name is rejected and never triggers a scrub", async () => {
    await expect(
      addRoute.handler({
        body: {
          type: "credential",
          name: "no-colon-here",
          value: CREDENTIAL_VALUE,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });
});
