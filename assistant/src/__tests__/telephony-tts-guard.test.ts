/**
 * Telephony TTS playability guard.
 *
 * Verifies that media-stream TTS selection keys off declared
 * `mediaStreamPlayback.outputFormat` metadata PLUS credential availability,
 * and that an unplayable configured provider falls back to a PCM-capable
 * default instead of producing a silent call.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  MediaStreamPlaybackFormat,
  TtsCredentialLookup,
} from "../tts/provider-catalog.js";
import type { TtsProvider, TtsProviderId } from "../tts/types.js";

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

// Configured provider id (mutated per test).
let configuredProvider: TtsProviderId = "elevenlabs";
// Per-provider config blocks (mutated per test), keyed by provider id. Used by
// both resolveTtsConfig (active provider) and resolveProviderTtsConfig (any
// provider, e.g. the fallback default).
let providerConfigs: Record<string, Record<string, unknown>> = {};

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({ services: { tts: { provider: configuredProvider } } }),
}));

mock.module("../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({
    provider: configuredProvider,
    providerConfig: providerConfigs[configuredProvider] ?? {},
  }),
  resolveProviderTtsConfig: (_config: unknown, provider: string) =>
    providerConfigs[provider] ?? {},
}));

// Synthetic catalog: each entry declares a media-stream output format, a
// credential store key, and the lookup semantics its adapter uses. The probe
// MUST mirror that lookup, so the catalog declares it.
const fakeCatalog: Record<
  string,
  {
    mediaStreamPlayback: { outputFormat: MediaStreamPlaybackFormat };
    key: string;
    credentialLookup: TtsCredentialLookup;
  }
> = {
  // ElevenLabs reads ONLY the namespaced key (no legacy bare/env fallback).
  elevenlabs: {
    mediaStreamPlayback: { outputFormat: "pcm" },
    key: "credential/elevenlabs/api_key",
    credentialLookup: "namespaced-only",
  },
  "wav-provider": {
    mediaStreamPlayback: { outputFormat: "wav" },
    key: "credential/wav-provider/api_key",
    credentialLookup: "namespaced-only",
  },
  "compressed-only": {
    mediaStreamPlayback: { outputFormat: "none" },
    key: "credential/compressed-only/api_key",
    credentialLookup: "namespaced-only",
  },
  // Deepgram-style provider: reads via getProviderKeyAsync, so a key
  // configured only under the legacy bare or env form is still recognized.
  "deepgram-like": {
    mediaStreamPlayback: { outputFormat: "pcm" },
    key: "credential/deepgram-like/api_key",
    credentialLookup: "provider-key",
  },
  // Fish Audio: namespaced-only key; PCM-capable and credentialed, but
  // requires a non-empty referenceId before it can synthesize any audio.
  "fish-audio": {
    mediaStreamPlayback: { outputFormat: "pcm" },
    key: "credential/fish-audio/api_key",
    credentialLookup: "namespaced-only",
  },
};

mock.module("../tts/provider-catalog.js", () => ({
  getCatalogProvider: (id: string) => {
    const entry = fakeCatalog[id];
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
// Env-var fallback values keyed by provider id (mutated per test).
let envProviderKeys: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => storedKeys[account],
  // Mirror the real getProviderKeyAsync lookup order: namespaced
  // credential/{provider}/api_key, then the legacy bare {provider} key, then
  // an env-var fallback. This is the same lookup the TTS adapters use.
  getProviderKeyAsync: async (provider: string) =>
    storedKeys[`credential/${provider}/api_key`] ??
    storedKeys[provider] ??
    envProviderKeys[provider],
}));

// Provider registry — returns a trivial provider for any registered id.
const registeredProviders: Record<string, TtsProvider> = {};
mock.module("../tts/provider-registry.js", () => ({
  getTtsProvider: (id: string) => {
    const p = registeredProviders[id];
    if (!p) throw new Error(`Unknown TTS provider "${id}"`);
    return p;
  },
}));

mock.module("../calls/tts-call-strategy.js", () => ({
  resolveCallStrategy: () => ({
    providerId: configuredProvider,
    callMode: "synthesized-play",
  }),
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------

import { resolvePlayableCallTtsProvider } from "../calls/resolve-call-tts-provider.js";
import {
  isTtsProviderCredentialAvailable,
  resolveTelephonyTtsCapability,
} from "../calls/telephony-tts-capability.js";

function makeProvider(id: string): TtsProvider {
  return {
    id,
    capabilities: { supportsStreaming: false, supportedFormats: ["pcm"] },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/pcm" };
    },
  };
}

beforeEach(() => {
  configuredProvider = "elevenlabs";
  storedKeys = {};
  envProviderKeys = {};
  providerConfigs = {};
  for (const key of Object.keys(registeredProviders)) {
    delete registeredProviders[key];
  }
  registeredProviders.elevenlabs = makeProvider("elevenlabs");
});

// ---------------------------------------------------------------------------
// resolveTelephonyTtsCapability
// ---------------------------------------------------------------------------

describe("resolveTelephonyTtsCapability", () => {
  test("pcm provider with credentials is playable", async () => {
    configuredProvider = "elevenlabs";
    storedKeys["credential/elevenlabs/api_key"] = "sk_test";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("elevenlabs");
  });

  test("wav provider with credentials is playable", async () => {
    configuredProvider = "wav-provider";
    storedKeys["credential/wav-provider/api_key"] = "sk_test";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
  });

  test("none-format provider is not-playable (unsupported-format)", async () => {
    configuredProvider = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test"; // credential present, format still no good

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("unsupported-format");
      expect(result.providerId).toBe("compressed-only");
    }
  });

  test("pcm provider with no key is not-playable (missing-credentials)", async () => {
    configuredProvider = "elevenlabs";
    // No stored key.

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
      expect(result.providerId).toBe("elevenlabs");
    }
  });

  test("blank credential is treated as missing", async () => {
    configuredProvider = "elevenlabs";
    storedKeys["credential/elevenlabs/api_key"] = "   ";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
    }
  });

  test("provider-key provider is playable when key exists only under the legacy bare store key", async () => {
    configuredProvider = "deepgram-like";
    // Namespaced credential/deepgram-like/api_key is absent; only the legacy
    // bare key is present — the adapter (getProviderKeyAsync) would find it.
    storedKeys["deepgram-like"] = "sk_legacy";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("deepgram-like");
  });

  test("provider-key provider is playable when key exists only via the env-var fallback", async () => {
    configuredProvider = "deepgram-like";
    // Neither store key is set; only the provider env-var fallback resolves.
    envProviderKeys["deepgram-like"] = "sk_from_env";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("deepgram-like");
  });

  test("provider-key provider is missing-credentials when no key resolves under any lookup", async () => {
    configuredProvider = "deepgram-like";
    // No namespaced, bare, or env key present.

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
      expect(result.providerId).toBe("deepgram-like");
    }
  });

  test("namespaced-only provider is NOT playable when only the legacy bare key is set", async () => {
    // ElevenLabs reads only the namespaced key — a legacy bare key must NOT
    // satisfy the probe, or synthesis would throw ELEVENLABS_TTS_NO_API_KEY.
    configuredProvider = "elevenlabs";
    storedKeys["elevenlabs"] = "sk_legacy_bare";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
      expect(result.providerId).toBe("elevenlabs");
    }
  });

  test("namespaced-only provider is NOT playable when only the env-var fallback resolves", async () => {
    configuredProvider = "elevenlabs";
    envProviderKeys["elevenlabs"] = "sk_from_env";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
      expect(result.providerId).toBe("elevenlabs");
    }
  });

  test("namespaced-only provider is playable with the namespaced key", async () => {
    configuredProvider = "elevenlabs";
    storedKeys["credential/elevenlabs/api_key"] = "sk_namespaced";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("elevenlabs");
  });

  test("fish-audio with API key but empty referenceId is not-playable (missing-required-config)", async () => {
    configuredProvider = "fish-audio";
    storedKeys["credential/fish-audio/api_key"] = "sk_test"; // credentialed
    providerConfigs["fish-audio"] = { referenceId: "   " }; // blank reference id

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-required-config");
      expect(result.providerId).toBe("fish-audio");
    }
  });

  test("fish-audio with API key but missing referenceId is not-playable (missing-required-config)", async () => {
    configuredProvider = "fish-audio";
    storedKeys["credential/fish-audio/api_key"] = "sk_test"; // credentialed, no referenceId in config

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-required-config");
    }
  });

  test("fish-audio with API key and referenceId is playable", async () => {
    configuredProvider = "fish-audio";
    storedKeys["credential/fish-audio/api_key"] = "sk_test";
    providerConfigs["fish-audio"] = { referenceId: "voice_abc123" };

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("fish-audio");
  });

  test("fish-audio is NOT playable when only a legacy bare key is set", async () => {
    // Fish Audio reads only the namespaced key — a legacy bare key must not
    // satisfy the probe even when referenceId is present.
    configuredProvider = "fish-audio";
    storedKeys["fish-audio"] = "sk_legacy_bare";
    providerConfigs["fish-audio"] = { referenceId: "voice_abc123" };

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
    }
  });
});

// ---------------------------------------------------------------------------
// isTtsProviderCredentialAvailable (reusable helper)
// ---------------------------------------------------------------------------

describe("isTtsProviderCredentialAvailable", () => {
  test("true when the namespaced credential key has a value", async () => {
    storedKeys["credential/elevenlabs/api_key"] = "sk_test";
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(true);
  });

  test("false when no credential is stored", async () => {
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(false);
  });

  test("namespaced-only provider: false when only the legacy bare key is set", async () => {
    storedKeys["elevenlabs"] = "sk_legacy";
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(false);
  });

  test("namespaced-only provider: false when only the env-var fallback resolves", async () => {
    envProviderKeys["elevenlabs"] = "sk_from_env";
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(false);
  });

  test("provider-key provider: true when only the legacy bare key is set", async () => {
    storedKeys["deepgram-like"] = "sk_legacy";
    expect(await isTtsProviderCredentialAvailable("deepgram-like")).toBe(true);
  });

  test("provider-key provider: true when only the env-var fallback resolves", async () => {
    envProviderKeys["deepgram-like"] = "sk_from_env";
    expect(await isTtsProviderCredentialAvailable("deepgram-like")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePlayableCallTtsProvider fallback
// ---------------------------------------------------------------------------

describe("resolvePlayableCallTtsProvider", () => {
  test("returns the configured provider when it is playable", async () => {
    configuredProvider = "wav-provider";
    storedKeys["credential/wav-provider/api_key"] = "sk_test";
    registeredProviders["wav-provider"] = makeProvider("wav-provider");

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("wav-provider");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back to the PCM-capable default when format is unsupported", async () => {
    configuredProvider = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test";
    storedKeys["credential/elevenlabs/api_key"] = "sk_default"; // default provider is credentialed

    const result = await resolvePlayableCallTtsProvider();
    // No silent path: a usable provider is returned (the default), not null.
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back to the PCM-capable default when credentials are missing", async () => {
    configuredProvider = "wav-provider"; // playable format but no key
    storedKeys["credential/elevenlabs/api_key"] = "sk_default";
    registeredProviders["wav-provider"] = makeProvider("wav-provider");

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("elevenlabs");
  });

  test("falls back to the default for fish-audio without a referenceId", async () => {
    configuredProvider = "fish-audio";
    storedKeys["credential/fish-audio/api_key"] = "sk_fish"; // credentialed but no referenceId
    storedKeys["credential/elevenlabs/api_key"] = "sk_default"; // default is playable
    registeredProviders["fish-audio"] = makeProvider("fish-audio");

    const result = await resolvePlayableCallTtsProvider();
    // fish-audio would throw FISH_AUDIO_TTS_NO_REFERENCE_ID at synthesis, so
    // the guard must NOT return it; it falls back to the playable default.
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("elevenlabs");
  });

  test("returns no-playable-provider signal when configured AND default are both unplayable", async () => {
    // Configured provider can't emit a transcodable format...
    configuredProvider = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test";
    // ...and the default (elevenlabs) is NOT credentialed, so it is also not
    // playable. The guard must surface null rather than a silent provider.
    // (no namespaced elevenlabs key stored)

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).toBeNull();
    expect(result.audioFormat).toBe("wav");
  });

  test("does NOT accept the ElevenLabs fallback when it only has a legacy bare key", async () => {
    // Configured provider is unplayable, and the ElevenLabs default has ONLY a
    // legacy bare key — which the namespaced-only adapter would not read. The
    // fallback must be rejected and the no-playable-provider signal returned,
    // rather than dialing into silence.
    configuredProvider = "compressed-only";
    storedKeys["credential/compressed-only/api_key"] = "sk_test";
    storedKeys["elevenlabs"] = "sk_legacy_bare"; // legacy bare key only
    envProviderKeys["elevenlabs"] = "sk_from_env"; // env fallback also ignored

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).toBeNull();
    expect(result.audioFormat).toBe("wav");
  });
});
