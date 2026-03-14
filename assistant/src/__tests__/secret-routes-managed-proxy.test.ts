import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let lastGeminiConstructorOpts: Record<string, unknown> | null = null;
let secureKeyStore: Record<string, string | undefined> = {};
const metadataUpserts: Array<{ service: string; field: string }> = [];
const metadataDeletes: Array<{ service: string; field: string }> = [];

const PLATFORM_BASE_URL = "https://platform.example.com";
const ASSISTANT_API_KEY_PATH = credentialKey("vellum", "assistant_api_key");
const MANAGED_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "openrouter",
] as const;

const mockConfig = {
  provider: "anthropic",
  model: "test-model",
};

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(opts: Record<string, unknown>) {
      lastGeminiConstructorOpts = opts;
    }
    models = {
      generateContentStream: async () => ({
        [Symbol.asyncIterator]: async function* () {
          /* no chunks */
        },
      }),
    };
  },
  ApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => PLATFORM_BASE_URL,
}));

mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "fireworks",
    "openrouter",
  ],
  getConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../logfire.js", () => ({
  wrapWithLogfire: (provider: unknown) => provider,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => secureKeyStore[key],
  getSecureKeyAsync: async (key: string) => secureKeyStore[key],
  setSecureKeyAsync: async (key: string, value: string) => {
    secureKeyStore[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete secureKeyStore[key];
    return "deleted";
  },
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: (service: string, field: string) => {
    metadataUpserts.push({ service, field });
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    metadataDeletes.push({ service, field });
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";
import {
  handleAddSecret,
  handleDeleteSecret,
} from "../runtime/routes/secret-routes.js";

function makeAddCredentialRequest(name: string, value: string): Request {
  return new Request("http://localhost/v1/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "credential",
      name,
      value,
    }),
  });
}

function makeDeleteCredentialRequest(name: string): Request {
  return new Request("http://localhost/v1/secrets", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "credential",
      name,
    }),
  });
}

describe("secret routes managed proxy registry sync", () => {
  beforeEach(() => {
    secureKeyStore = {};
    metadataUpserts.length = 0;
    metadataDeletes.length = 0;
    lastGeminiConstructorOpts = null;
    initializeProviders(mockConfig);
  });

  test("adding vellum:assistant_api_key bootstraps managed providers immediately", async () => {
    expect(listProviders()).toEqual([]);

    const res = await handleAddSecret(
      makeAddCredentialRequest("vellum:assistant_api_key", "ast-managed-key"),
    );

    expect(res.status).toBe(201);
    expect(secureKeyStore[ASSISTANT_API_KEY_PATH]).toBe("ast-managed-key");
    expect(metadataUpserts).toEqual([
      { service: "vellum", field: "assistant_api_key" },
    ]);

    const providers = listProviders();
    expect(providers).toHaveLength(MANAGED_PROVIDERS.length);
    for (const provider of MANAGED_PROVIDERS) {
      expect(providers).toContain(provider);
      expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
    }
    expect(lastGeminiConstructorOpts).toBeDefined();
  });

  test("deleting vellum:assistant_api_key clears managed providers immediately", async () => {
    secureKeyStore[ASSISTANT_API_KEY_PATH] = "ast-managed-key";
    initializeProviders(mockConfig);

    for (const provider of MANAGED_PROVIDERS) {
      expect(listProviders()).toContain(provider);
      expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
    }

    const res = await handleDeleteSecret(
      makeDeleteCredentialRequest("vellum:assistant_api_key"),
    );

    expect(res.status).toBe(200);
    expect(secureKeyStore[ASSISTANT_API_KEY_PATH]).toBeUndefined();
    expect(metadataDeletes).toEqual([
      { service: "vellum", field: "assistant_api_key" },
    ]);
    expect(listProviders()).toEqual([]);
  });
});
