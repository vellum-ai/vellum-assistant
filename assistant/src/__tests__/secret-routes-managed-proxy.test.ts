import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let lastGeminiConstructorOpts: Record<string, unknown> | null = null;
let secureKeyStore: Record<string, string | undefined> = {};
const metadataUpserts: Array<{ service: string; field: string }> = [];
const metadataDeletes: Array<{ service: string; field: string }> = [];

const PLATFORM_BASE_URL = "https://platform.example.com";
const ASSISTANT_API_KEY_PATH = credentialKey("vellum", "assistant_api_key");
const PLATFORM_BASE_URL_PATH = credentialKey("vellum", "platform_base_url");
const MANAGED_PROVIDERS = ["anthropic", "gemini"] as const;

let platformBaseUrlOverride: string | undefined;

const mockConfig = {
  services: {
    inference: {
      mode: "your-own" as const,
      provider: "anthropic",
      model: "test-model",
    },
    "image-generation": {
      mode: "your-own" as const,
      provider: "gemini",
      model: "gemini-3.1-flash-image-preview",
    },
    "web-search": {
      mode: "your-own" as const,
      provider: "inference-provider-native",
    },
  },
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
  setPlatformBaseUrl: (value: string | undefined) => {
    platformBaseUrlOverride = value;
  },
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
  getSecureKeyAsync: async (key: string) => ({
    value: secureKeyStore[key],
    unreachable: false,
  }),
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
  beforeEach(async () => {
    secureKeyStore = {};
    metadataUpserts.length = 0;
    metadataDeletes.length = 0;
    lastGeminiConstructorOpts = null;
    platformBaseUrlOverride = undefined;
    await initializeProviders(mockConfig);
  });

  test("adding vellum:assistant_api_key bootstraps managed fallback providers immediately", async () => {
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

  test("deleting vellum:assistant_api_key clears managed fallback providers immediately", async () => {
    secureKeyStore[ASSISTANT_API_KEY_PATH] = "ast-managed-key";
    await initializeProviders(mockConfig);

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

  test("storing vellum:platform_base_url sets override and triggers initializeProviders", async () => {
    const res = await handleAddSecret(
      makeAddCredentialRequest(
        "vellum:platform_base_url",
        "https://managed.example.com",
      ),
    );

    expect(res.status).toBe(201);
    expect(secureKeyStore[PLATFORM_BASE_URL_PATH]).toBe(
      "https://managed.example.com",
    );
    expect(platformBaseUrlOverride).toBe("https://managed.example.com");
    expect(metadataUpserts).toEqual([
      { service: "vellum", field: "platform_base_url" },
    ]);
  });

  test("storing both vellum:platform_base_url and vellum:assistant_api_key enables managed proxy", async () => {
    expect(listProviders()).toEqual([]);

    await handleAddSecret(
      makeAddCredentialRequest(
        "vellum:platform_base_url",
        "https://managed.example.com",
      ),
    );
    expect(platformBaseUrlOverride).toBe("https://managed.example.com");

    const res = await handleAddSecret(
      makeAddCredentialRequest("vellum:assistant_api_key", "ast-managed-key"),
    );

    expect(res.status).toBe(201);
    const providers = listProviders();
    expect(providers).toHaveLength(MANAGED_PROVIDERS.length);
    for (const provider of MANAGED_PROVIDERS) {
      expect(providers).toContain(provider);
      expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
    }
  });

  test("deleting vellum:platform_base_url clears override and re-initializes providers", async () => {
    // Set up: store the platform URL credential first
    secureKeyStore[PLATFORM_BASE_URL_PATH] = "https://managed.example.com";
    platformBaseUrlOverride = "https://managed.example.com";

    const res = await handleDeleteSecret(
      makeDeleteCredentialRequest("vellum:platform_base_url"),
    );

    expect(res.status).toBe(200);
    expect(secureKeyStore[PLATFORM_BASE_URL_PATH]).toBeUndefined();
    expect(platformBaseUrlOverride).toBeUndefined();
    expect(metadataDeletes).toEqual([
      { service: "vellum", field: "platform_base_url" },
    ]);
  });
});
