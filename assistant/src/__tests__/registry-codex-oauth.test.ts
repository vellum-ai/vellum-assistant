import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

const STORAGE_KEY = credentialKey("openai_codex_oauth", "blob");

const secureKeyStore: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeyStore[key],
  setSecureKeyAsync: async (key: string, value: string) => {
    secureKeyStore[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete secureKeyStore[key];
    return "ok" as const;
  },
  getProviderKeyAsync: async (provider: string) =>
    secureKeyStore[`provider:${provider}`],
}));

const { initializeProviders, listProviders, getProviderRoutingSource } =
  await import("../providers/registry.js");

const BASE_CONFIG = {
  services: {
    inference: { mode: "your-own" as const },
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
  llm: { default: { provider: "openai", model: "gpt-5.5" } },
};

function blobOf(creds: {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId: string;
}): string {
  return Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
}

const FRESH_CREDS = {
  access: "access-test",
  refresh: "refresh-test",
  expiresAt: Date.now() + 60 * 60 * 1000,
  accountId: "account-test",
};

const ORIGINAL_FLAG = process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH;

beforeEach(() => {
  for (const key of Object.keys(secureKeyStore)) delete secureKeyStore[key];
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH;
  } else {
    process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH = ORIGINAL_FLAG;
  }
});

describe("provider registry — OpenAI Codex OAuth", () => {
  test("flag on + Codex creds present → openai registered with oauth-codex source", async () => {
    process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH = "1";
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH_CREDS);

    await initializeProviders(BASE_CONFIG);

    expect(listProviders()).toContain("openai");
    expect(getProviderRoutingSource("openai")).toBe("oauth-codex");
  });

  test("flag on + no Codex creds → falls through to API-key path", async () => {
    process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH = "1";
    secureKeyStore["provider:openai"] = "sk-test-key";

    await initializeProviders(BASE_CONFIG);

    expect(listProviders()).toContain("openai");
    expect(getProviderRoutingSource("openai")).toBe("user-key");
  });

  test("flag off → ignores stored Codex creds, uses API-key path", async () => {
    delete process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH;
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH_CREDS);
    secureKeyStore["provider:openai"] = "sk-test-key";

    await initializeProviders(BASE_CONFIG);

    expect(listProviders()).toContain("openai");
    expect(getProviderRoutingSource("openai")).toBe("user-key");
  });

  test("flag off + no API key → openai not registered", async () => {
    delete process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH;
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH_CREDS);

    await initializeProviders(BASE_CONFIG);

    expect(listProviders()).not.toContain("openai");
    expect(getProviderRoutingSource("openai")).toBeUndefined();
  });

  test("flag set to value other than '1' is treated as off", async () => {
    process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH = "true";
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH_CREDS);
    secureKeyStore["provider:openai"] = "sk-test-key";

    await initializeProviders(BASE_CONFIG);

    expect(getProviderRoutingSource("openai")).toBe("user-key");
  });
});
