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
  resolveConversationStreamingSttCapability,
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
          deepgram: {},
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
    mockProviderKeys["some-provider"] = "key";
    mockConfig = buildConfig({ provider: "unknown-provider" as string });

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

  // -------------------------------------------------------------------------
  // Deepgram provider resolution
  // -------------------------------------------------------------------------

  test("returns a BatchTranscriber when deepgram is configured and credentials are available", async () => {
    mockProviderKeys["deepgram"] = "dg-test-key";
    mockConfig = buildConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("deepgram");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when deepgram is configured but no credentials exist", async () => {
    mockProviderKeys = {}; // no keys
    mockConfig = buildConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("deepgram uses 'deepgram' credential key, not 'openai'", async () => {
    // Only openai key is set — deepgram should NOT resolve
    mockProviderKeys["openai"] = "sk-test-key";
    mockConfig = buildConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("resolved deepgram transcriber has stable provider identity", async () => {
    mockProviderKeys["deepgram"] = "dg-identity-test";
    mockConfig = buildConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber!.providerId).toBe("deepgram");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Google Gemini provider resolution
  // -------------------------------------------------------------------------

  test("returns a BatchTranscriber when google-gemini is configured and credentials are available", async () => {
    mockProviderKeys["gemini"] = "gemini-test-key";
    mockConfig = buildConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("google-gemini");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when google-gemini is configured but no credentials exist", async () => {
    mockProviderKeys = {}; // no keys
    mockConfig = buildConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("google-gemini uses 'gemini' credential key, not 'openai' or 'deepgram'", async () => {
    // Only openai key is set — google-gemini should NOT resolve
    mockProviderKeys["openai"] = "sk-test-key";
    mockConfig = buildConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("resolved google-gemini transcriber has stable provider identity", async () => {
    mockProviderKeys["gemini"] = "gemini-identity-test";
    mockConfig = buildConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber!.providerId).toBe("google-gemini");
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

  // -------------------------------------------------------------------------
  // Google Gemini telephony capability
  // -------------------------------------------------------------------------

  test("returns 'supported' for google-gemini with batch-only telephonyMode", async () => {
    mockProviderKeys["gemini"] = "gemini-telephony-test";
    mockConfig = buildConfig({ provider: "google-gemini" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.telephonyMode).toBe("batch-only");
    }
  });

  test("returns 'missing-credentials' for google-gemini without a gemini key", async () => {
    mockProviderKeys = {};
    mockConfig = buildConfig({ provider: "google-gemini" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.credentialProvider).toBe("gemini");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — telephony routing alignment with provider catalog
// ---------------------------------------------------------------------------

import { getProviderEntry, listProviderIds } from "../provider-catalog.js";

describe("telephony routing catalog alignment", () => {
  /**
   * These tests verify that the assumptions made by the telephony STT
   * routing resolver (telephony-stt-routing.ts) remain consistent with
   * the provider catalog entries. If a catalog entry changes its
   * telephonyMode, routing metadata, or a new provider is added, these
   * tests will catch misalignment early.
   */

  test("deepgram catalog entry has realtime-ws telephonyMode (Twilio-native eligible)", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("realtime-ws");
  });

  test("google-gemini catalog entry has batch-only telephonyMode (Twilio-native eligible)", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("batch-only");
  });

  test("openai-whisper catalog entry has batch-only telephonyMode (media-stream path)", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("batch-only");
  });

  test("deepgram uses 'deepgram' credential provider", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry!.credentialProvider).toBe("deepgram");
  });

  test("google-gemini uses 'gemini' credential provider", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry!.credentialProvider).toBe("gemini");
  });

  test("openai-whisper uses 'openai' credential provider", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry!.credentialProvider).toBe("openai");
  });

  test("every catalog provider has a non-none telephonyMode", () => {
    // The telephony routing resolver assumes all known providers
    // participate in some telephony path (native or media-stream).
    // If a provider with telephonyMode: "none" is added, the routing
    // resolver would need to handle it explicitly.
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry).toBeDefined();
      expect(entry!.telephonyMode).not.toBe("none");
    }
  });

  // -----------------------------------------------------------------------
  // Telephony routing metadata invariants
  // -----------------------------------------------------------------------

  test("every catalog provider has telephonyRouting metadata", () => {
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry).toBeDefined();
      expect(entry!.telephonyRouting).toBeDefined();
      expect(["conversation-relay-native", "media-stream-custom"]).toContain(
        entry!.telephonyRouting.strategyKind,
      );
    }
  });

  test("conversation-relay-native providers have twilioNativeMapping with non-empty provider name", () => {
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id)!;
      if (entry.telephonyRouting.strategyKind === "conversation-relay-native") {
        expect(entry.telephonyRouting.twilioNativeMapping).toBeDefined();
        expect(
          entry.telephonyRouting.twilioNativeMapping!.provider.length,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("media-stream-custom providers do not have twilioNativeMapping", () => {
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id)!;
      if (entry.telephonyRouting.strategyKind === "media-stream-custom") {
        expect(entry.telephonyRouting.twilioNativeMapping).toBeUndefined();
      }
    }
  });

  test("deepgram routing metadata maps to Twilio-native Deepgram with nova-3 speech model", () => {
    const entry = getProviderEntry("deepgram")!;
    expect(entry.telephonyRouting.strategyKind).toBe(
      "conversation-relay-native",
    );
    expect(entry.telephonyRouting.twilioNativeMapping?.provider).toBe(
      "Deepgram",
    );
    expect(entry.telephonyRouting.twilioNativeMapping?.defaultSpeechModel).toBe(
      "nova-3",
    );
  });

  test("google-gemini routing metadata maps to Twilio-native Google with no default speech model", () => {
    const entry = getProviderEntry("google-gemini")!;
    expect(entry.telephonyRouting.strategyKind).toBe(
      "conversation-relay-native",
    );
    expect(entry.telephonyRouting.twilioNativeMapping?.provider).toBe("Google");
    expect(
      entry.telephonyRouting.twilioNativeMapping?.defaultSpeechModel,
    ).toBeUndefined();
  });

  test("openai-whisper routing metadata uses media-stream-custom without Twilio mapping", () => {
    const entry = getProviderEntry("openai-whisper")!;
    expect(entry.telephonyRouting.strategyKind).toBe("media-stream-custom");
    expect(entry.telephonyRouting.twilioNativeMapping).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Stable provider identity
  // -----------------------------------------------------------------------

  test("provider IDs remain stable across catalog lookups", () => {
    // Guard against accidental ID mutation or aliasing bugs.
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(id);
    }
  });

  test("capability resolver returns supported for all catalog providers with credentials", async () => {
    // Verify that every provider in the catalog can resolve to "supported"
    // when the correct credentials are present. This catches regressions
    // where a catalog entry is added but the credential mapping is wrong.
    const credentialMap: Record<string, string> = {
      "openai-whisper": "openai",
      deepgram: "deepgram",
      "google-gemini": "gemini",
    };

    for (const id of listProviderIds()) {
      const credKey = credentialMap[id];
      expect(credKey).toBeDefined();

      mockProviderKeys = { [credKey]: `test-key-${id}` };
      mockConfig = buildConfig({ provider: id });

      const result = await resolveTelephonySttCapability();
      expect(result.status).toBe("supported");
      if (result.status === "supported") {
        expect(result.providerId).toBe(id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveConversationStreamingSttCapability
// ---------------------------------------------------------------------------

describe("resolveConversationStreamingSttCapability", () => {
  beforeEach(() => {
    mockConfig = buildConfig({});
    mockProviderKeys = {};
  });

  // -------------------------------------------------------------------------
  // Deepgram — realtime-ws streaming
  // -------------------------------------------------------------------------

  test("returns 'supported' with realtime-ws mode for deepgram", async () => {
    mockProviderKeys["deepgram"] = "dg-stream-key";
    mockConfig = buildConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("deepgram");
      expect(result.streamingMode).toBe("realtime-ws");
    }
  });

  test("returns 'missing-credentials' for deepgram without an API key", async () => {
    mockProviderKeys = {};
    mockConfig = buildConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("deepgram");
      expect(result.credentialProvider).toBe("deepgram");
      expect(result.reason).toContain("deepgram");
    }
  });

  // -------------------------------------------------------------------------
  // Google Gemini — incremental-batch streaming
  // -------------------------------------------------------------------------

  test("returns 'supported' with incremental-batch mode for google-gemini", async () => {
    mockProviderKeys["gemini"] = "gemini-stream-key";
    mockConfig = buildConfig({ provider: "google-gemini" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.streamingMode).toBe("incremental-batch");
    }
  });

  test("returns 'missing-credentials' for google-gemini without a gemini key", async () => {
    mockProviderKeys = {};
    mockConfig = buildConfig({ provider: "google-gemini" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.credentialProvider).toBe("gemini");
    }
  });

  // -------------------------------------------------------------------------
  // OpenAI Whisper — no streaming support
  // -------------------------------------------------------------------------

  test("returns 'unsupported' for openai-whisper (no conversation streaming)", async () => {
    mockProviderKeys["openai"] = "sk-stream-test";
    mockConfig = buildConfig({ provider: "openai-whisper" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") {
      expect(result.providerId).toBe("openai-whisper");
      expect(result.reason).toContain("openai-whisper");
      expect(result.reason).toContain(
        "does not support conversation streaming",
      );
    }
  });

  // -------------------------------------------------------------------------
  // Unknown / unconfigured provider
  // -------------------------------------------------------------------------

  test("returns 'unconfigured' when provider is not in the catalog", async () => {
    mockProviderKeys["unknown-provider"] = "key-doesnt-matter";
    mockConfig = buildConfig({ provider: "unknown-provider" as string });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("unconfigured");
    if (result.status === "unconfigured") {
      expect(result.reason).toContain("unknown-provider");
      expect(result.reason).toContain("not in the provider catalog");
    }
  });

  test("returns 'unconfigured' for empty-string provider", async () => {
    mockConfig = buildConfig({ provider: "" as string });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("unconfigured");
  });

  // -------------------------------------------------------------------------
  // Config-driven behaviour
  // -------------------------------------------------------------------------

  test("uses config-driven provider, not a hardcoded default", async () => {
    mockProviderKeys["deepgram"] = "dg-config-test";
    mockConfig = buildConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("deepgram");
    }
  });
});
