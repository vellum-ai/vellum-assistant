/**
 * Telephony TTS playability guard.
 *
 * Verifies that media-stream TTS selection keys off declared
 * `mediaStreamPlayback.outputFormat` metadata PLUS credential availability,
 * and that an unplayable configured provider falls back to a PCM-capable
 * default instead of producing a silent call.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MediaStreamPlaybackFormat } from "../tts/provider-catalog.js";
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

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({ services: { tts: { provider: configuredProvider } } }),
}));

mock.module("../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({
    provider: configuredProvider,
    providerConfig: {},
  }),
}));

// Synthetic catalog: each entry declares a media-stream output format and a
// credential store key. Real adapter behavior is irrelevant to the guard.
const fakeCatalog: Record<
  string,
  {
    mediaStreamPlayback: { outputFormat: MediaStreamPlaybackFormat };
    key: string;
  }
> = {
  elevenlabs: { mediaStreamPlayback: { outputFormat: "pcm" }, key: "k/eleven" },
  "wav-provider": {
    mediaStreamPlayback: { outputFormat: "wav" },
    key: "k/wav",
  },
  "compressed-only": {
    mediaStreamPlayback: { outputFormat: "none" },
    key: "k/compressed",
  },
  // Provider whose catalog requirement uses the standard namespaced api_key
  // store key (credential/{id}/api_key), exercising the getProviderKeyAsync
  // path: a key configured only under the legacy bare or env form must still
  // be recognized as available.
  "legacy-keyed": {
    mediaStreamPlayback: { outputFormat: "pcm" },
    key: "credential/legacy-keyed/api_key",
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
    storedKeys["k/eleven"] = "sk_test";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("elevenlabs");
  });

  test("wav provider with credentials is playable", async () => {
    configuredProvider = "wav-provider";
    storedKeys["k/wav"] = "sk_test";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
  });

  test("none-format provider is not-playable (unsupported-format)", async () => {
    configuredProvider = "compressed-only";
    storedKeys["k/compressed"] = "sk_test"; // credential present, format still no good

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
    storedKeys["k/eleven"] = "   ";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
    }
  });

  test("playable when key exists only under the legacy bare store key", async () => {
    configuredProvider = "legacy-keyed";
    // Namespaced credential/legacy-keyed/api_key is absent; only the legacy
    // bare key is present — the adapter (getProviderKeyAsync) would find it.
    storedKeys["legacy-keyed"] = "sk_legacy";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("legacy-keyed");
  });

  test("playable when key exists only via the env-var fallback", async () => {
    configuredProvider = "legacy-keyed";
    // Neither store key is set; only the provider env-var fallback resolves.
    envProviderKeys["legacy-keyed"] = "sk_from_env";

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("playable");
    expect(result.providerId).toBe("legacy-keyed");
  });

  test("missing-credentials when no key resolves under any lookup", async () => {
    configuredProvider = "legacy-keyed";
    // No namespaced, bare, or env key present.

    const result = await resolveTelephonyTtsCapability();
    expect(result.status).toBe("not-playable");
    if (result.status === "not-playable") {
      expect(result.reason).toBe("missing-credentials");
      expect(result.providerId).toBe("legacy-keyed");
    }
  });
});

// ---------------------------------------------------------------------------
// isTtsProviderCredentialAvailable (reusable helper)
// ---------------------------------------------------------------------------

describe("isTtsProviderCredentialAvailable", () => {
  test("true when the catalog credential key has a value", async () => {
    storedKeys["k/eleven"] = "sk_test";
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(true);
  });

  test("false when no credential is stored", async () => {
    expect(await isTtsProviderCredentialAvailable("elevenlabs")).toBe(false);
  });

  test("true when only the legacy bare key is set", async () => {
    storedKeys["legacy-keyed"] = "sk_legacy";
    expect(await isTtsProviderCredentialAvailable("legacy-keyed")).toBe(true);
  });

  test("true when only the env-var fallback resolves", async () => {
    envProviderKeys["legacy-keyed"] = "sk_from_env";
    expect(await isTtsProviderCredentialAvailable("legacy-keyed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePlayableCallTtsProvider fallback
// ---------------------------------------------------------------------------

describe("resolvePlayableCallTtsProvider", () => {
  test("returns the configured provider when it is playable", async () => {
    configuredProvider = "wav-provider";
    storedKeys["k/wav"] = "sk_test";
    registeredProviders["wav-provider"] = makeProvider("wav-provider");

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("wav-provider");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back to the PCM-capable default when format is unsupported", async () => {
    configuredProvider = "compressed-only";
    storedKeys["k/compressed"] = "sk_test";
    storedKeys["k/eleven"] = "sk_default"; // default provider is credentialed

    const result = await resolvePlayableCallTtsProvider();
    // No silent path: a usable provider is returned (the default), not null.
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back to the PCM-capable default when credentials are missing", async () => {
    configuredProvider = "wav-provider"; // playable format but no key
    storedKeys["k/eleven"] = "sk_default";
    registeredProviders["wav-provider"] = makeProvider("wav-provider");

    const result = await resolvePlayableCallTtsProvider();
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("elevenlabs");
  });
});
