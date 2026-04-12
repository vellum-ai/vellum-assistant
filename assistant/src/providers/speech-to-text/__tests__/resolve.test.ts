import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject imports
// ---------------------------------------------------------------------------

// -- Logger mock ----------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Config mock ----------------------------------------------------------

let mockConfig: Record<string, unknown> = {};

mock.module("../../../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// -- Credential mock ------------------------------------------------------

let mockProviderKeys: Record<string, string | undefined> = {};

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) =>
    mockProviderKeys[provider] ?? undefined,
  getSecureKeyAsync: async () => null,
  getSecureKey: () => null,
}));

mock.module("../../../security/credential-key.js", () => ({
  credentialKey: (...args: string[]) => args.join("/"),
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import {
  resolveBatchTranscriber,
  resolveTelephonySttCapability,
} from "../resolve.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides: {
  provider?: string;
}): Record<string, unknown> {
  return {
    services: {
      stt: {
        mode: "your-own",
        provider: overrides.provider ?? "openai-whisper",
        providers: {
          "openai-whisper": {},
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — resolveBatchTranscriber
// ---------------------------------------------------------------------------

describe("resolveBatchTranscriber", () => {
  beforeEach(() => {
    mockConfig = buildConfig({});
    mockProviderKeys = {};
  });

  test("returns a BatchTranscriber when openai-whisper is configured and credentials are available", async () => {
    mockProviderKeys["openai"] = "sk-test-key";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("openai-whisper");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when credentials are missing for the configured provider", async () => {
    mockProviderKeys = {}; // no keys at all
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("returns null when configured provider is unsupported for daemon-batch", async () => {
    // Force an unknown provider past the type system to simulate a future
    // provider that hasn't been wired into the daemon-batch boundary yet.
    mockProviderKeys["deepgram"] = "dg-test-key";
    mockConfig = buildConfig({ provider: "deepgram" as string });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("uses config-driven provider selection, not hardcoded OpenAI", async () => {
    // Verify the resolver reads from config rather than always using "openai".
    // If the config says openai-whisper, we expect credential lookup for "openai".
    mockProviderKeys["openai"] = "sk-config-driven";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("openai-whisper");
  });

  test("resolved transcriber has stable provider identity", async () => {
    mockProviderKeys["openai"] = "sk-identity-test";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    // The providerId must remain "openai-whisper" for downstream identity checks.
    expect(transcriber!.providerId).toBe("openai-whisper");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveTelephonySttCapability
// ---------------------------------------------------------------------------

describe("resolveTelephonySttCapability", () => {
  beforeEach(() => {
    mockConfig = buildConfig({});
    mockProviderKeys = {};
  });

  test("returns 'supported' when provider is telephony-eligible and credentials exist", async () => {
    mockProviderKeys["openai"] = "sk-telephony-test";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
      // openai-whisper is batch-only, so telephonyMode should reflect that
      expect(result.telephonyMode).toBe("batch-only");
    }
  });

  test("returns 'unconfigured' when provider is not in the catalog", async () => {
    mockProviderKeys["unknown-provider"] = "key-doesnt-matter";
    mockConfig = buildConfig({ provider: "unknown-provider" as string });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("unconfigured");
    if (result.status === "unconfigured") {
      expect(result.reason).toContain("unknown-provider");
      expect(result.reason).toContain("not in the provider catalog");
    }
  });

  test("returns 'missing-credentials' when provider is eligible but has no API key", async () => {
    mockProviderKeys = {}; // no keys
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("openai-whisper");
      expect(result.credentialProvider).toBe("openai");
      expect(result.reason).toContain("openai");
    }
  });

  test("uses config-driven provider, not a hardcoded default", async () => {
    // Use a provider that IS in the catalog to verify config is read
    mockProviderKeys["openai"] = "sk-config-test";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
    }
  });

  test("returns 'unconfigured' for empty-string provider", async () => {
    mockConfig = buildConfig({ provider: "" as string });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("unconfigured");
  });
});
