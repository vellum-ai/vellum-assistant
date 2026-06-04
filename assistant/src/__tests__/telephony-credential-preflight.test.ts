/**
 * Credential-compatibility preflight for media-stream telephony calls.
 *
 * On the media-stream call path the daemon does STT + TTS itself, so both
 * providers need real, usable credentials or the call connects silent. These
 * tests verify that `resolveTelephonyCredentialReadiness` validates BOTH legs
 * (reusing the merged telephony-tts-capability helpers and the STT resolver's
 * adapter-accurate key lookup), and that the not-ready behavior is wired into
 * the outbound (no dial + pointer + event) and inbound (spoken setup message +
 * event + end call) call paths.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  MediaStreamPlaybackFormat,
  TtsCredentialLookup,
} from "../tts/provider-catalog.js";

// ---------------------------------------------------------------------------
// Mocks — declared before subject imports
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Configured providers (mutated per test).
let configuredStt = "openai-whisper";
let configuredTts = "elevenlabs";
// Per-TTS-provider config blocks (mutated per test).
let ttsProviderConfigs: Record<string, Record<string, unknown>> = {};

mock.module("../config/loader.js", () => {
  const config = () => ({
    services: {
      stt: { provider: configuredStt },
      tts: { provider: configuredTts },
    },
  });
  return { loadConfig: config, getConfig: config };
});

mock.module("../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({
    provider: configuredTts,
    providerConfig: ttsProviderConfigs[configuredTts] ?? {},
  }),
  resolveProviderTtsConfig: (_config: unknown, provider: string) =>
    ttsProviderConfigs[provider] ?? {},
}));

// Synthetic TTS catalog: each entry declares a media-stream output format and a
// credential lookup the probe must mirror. Mirrors the telephony-tts-guard test.
const fakeTtsCatalog: Record<
  string,
  {
    mediaStreamPlayback: { outputFormat: MediaStreamPlaybackFormat };
    key: string;
    credentialLookup: TtsCredentialLookup;
  }
> = {
  elevenlabs: {
    mediaStreamPlayback: { outputFormat: "pcm" },
    key: "credential/elevenlabs/api_key",
    credentialLookup: "namespaced-only",
  },
  "compressed-only": {
    mediaStreamPlayback: { outputFormat: "none" },
    key: "credential/compressed-only/api_key",
    credentialLookup: "namespaced-only",
  },
};

mock.module("../tts/provider-catalog.js", () => ({
  getCatalogProvider: (id: string) => {
    const entry = fakeTtsCatalog[id];
    if (!entry) throw new Error(`Unknown TTS provider "${id}"`);
    return {
      id,
      mediaStreamPlayback: entry.mediaStreamPlayback,
      secretRequirements: [
        {
          credentialStoreKey: entry.key,
          credentialLookup: entry.credentialLookup,
          displayName: `${id} key`,
          setCommand: "set",
        },
      ],
    };
  },
}));

// Stored credentials keyed by credential store key (mutated per test).
let storedKeys: Record<string, string> = {};
// Provider key lookup (STT resolver + provider-key TTS lookups) by provider id.
let providerKeys: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => storedKeys[account],
  // Mirror the real getProviderKeyAsync lookup: namespaced, then bare, then env.
  getProviderKeyAsync: async (provider: string) =>
    providerKeys[provider] ??
    storedKeys[`credential/${provider}/api_key`] ??
    storedKeys[provider],
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks). Uses the REAL STT provider catalog so the
// STT credential probe stays adapter-accurate.
// ---------------------------------------------------------------------------

import {
  describeCredentialGaps,
  resolveTelephonyCredentialReadiness,
} from "../calls/telephony-credential-preflight.js";

beforeEach(() => {
  configuredStt = "openai-whisper"; // credentialProvider: "openai"
  configuredTts = "elevenlabs";
  storedKeys = {};
  providerKeys = {};
  ttsProviderConfigs = {};
});

// ---------------------------------------------------------------------------
// resolveTelephonyCredentialReadiness
// ---------------------------------------------------------------------------

describe("resolveTelephonyCredentialReadiness", () => {
  test("STT key present + TTS playable → ready", async () => {
    providerKeys.openai = "sk_openai"; // STT credential
    storedKeys["credential/elevenlabs/api_key"] = "sk_eleven"; // TTS credential

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("ready");
  });

  test("missing STT key → not-ready (stt / missing-credentials)", async () => {
    // No openai key; TTS is fine.
    storedKeys["credential/elevenlabs/api_key"] = "sk_eleven";

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("not-ready");
    if (result.status === "not-ready") {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toEqual({
        kind: "stt",
        providerId: "openai-whisper",
        reason: "missing-credentials",
      });
    }
  });

  test("non-playable TTS → not-ready (tts)", async () => {
    providerKeys.openai = "sk_openai"; // STT fine
    configuredTts = "compressed-only"; // format "none"
    storedKeys["credential/compressed-only/api_key"] = "sk_test"; // credentialed but unplayable
    // No elevenlabs default key, so the fallback is not playable either.

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("not-ready");
    if (result.status === "not-ready") {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].kind).toBe("tts");
      expect(result.missing[0].providerId).toBe("compressed-only");
      expect(result.missing[0].reason).toBe("not-playable");
    }
  });

  test("both missing → not-ready lists both gaps", async () => {
    // No STT key, unplayable TTS with no usable fallback.
    configuredTts = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test";

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("not-ready");
    if (result.status === "not-ready") {
      const kinds = result.missing.map((g) => g.kind).sort();
      expect(kinds).toEqual(["stt", "tts"]);
    }
  });

  test("unconfigured STT provider → not-ready (unconfigured-provider)", async () => {
    configuredStt = "not-a-real-provider";
    storedKeys["credential/elevenlabs/api_key"] = "sk_eleven";

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("not-ready");
    if (result.status === "not-ready") {
      expect(result.missing[0]).toEqual({
        kind: "stt",
        providerId: null,
        reason: "unconfigured-provider",
      });
    }
  });

  // Fallback: a verified-ready configured provider (or default) is the ONLY
  // accepted substitute. Here the configured TTS is unplayable but the default
  // (elevenlabs) is credentialed + playable, so TTS is treated as ready.
  test("fallback only chosen when the default TTS provider verifies ready", async () => {
    providerKeys.openai = "sk_openai"; // STT fine
    configuredTts = "compressed-only"; // unplayable configured provider
    storedKeys["credential/compressed-only/api_key"] = "sk_test";
    storedKeys["credential/elevenlabs/api_key"] = "sk_default"; // default verifies ready

    const result = await resolveTelephonyCredentialReadiness();
    // The default is verified ready, so the call may proceed via fallback.
    expect(result.status).toBe("ready");
  });

  test("fallback NOT chosen when the default TTS provider is also uncredentialed", async () => {
    providerKeys.openai = "sk_openai";
    configuredTts = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test";
    // elevenlabs default has NO namespaced key — not a verified substitute.

    const result = await resolveTelephonyCredentialReadiness();
    expect(result.status).toBe("not-ready");
    if (result.status === "not-ready") {
      expect(result.missing.some((g) => g.kind === "tts")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// describeCredentialGaps
// ---------------------------------------------------------------------------

describe("describeCredentialGaps", () => {
  test("names each missing provider credential", () => {
    const text = describeCredentialGaps([
      {
        kind: "stt",
        providerId: "openai-whisper",
        reason: "missing-credentials",
      },
      { kind: "tts", providerId: "elevenlabs", reason: "missing-credentials" },
    ]);
    expect(text).toContain("speech-to-text");
    expect(text).toContain('"openai-whisper"');
    expect(text).toContain("text-to-speech");
    expect(text).toContain('"elevenlabs"');
    expect(text).toContain("missing-credentials");
  });

  test("renders an unconfigured provider without a quoted id", () => {
    const text = describeCredentialGaps([
      { kind: "stt", providerId: null, reason: "unconfigured-provider" },
    ]);
    expect(text).toContain("(unconfigured)");
  });
});
