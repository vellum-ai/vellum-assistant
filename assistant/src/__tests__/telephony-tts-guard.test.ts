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

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => storedKeys[account],
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
