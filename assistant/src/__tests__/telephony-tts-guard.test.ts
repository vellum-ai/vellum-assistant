/**
 * Guard tests for telephony TTS media-stream playability.
 *
 * Covers three layers:
 * 1. `resolveTelephonyTtsCapability` — catalog `mediaStreamPlayback` format
 *    plus credential availability produce the playable / not-playable verdict.
 * 2. `resolveCallTtsProvider({ preferWav: true })` — a not-playable configured
 *    provider is swapped for a playable credentialed fallback instead of
 *    resolving into guaranteed media-stream silence.
 * 3. `speakSystemPrompt` on a WAV-requiring transport — synthesis failure
 *    retries once via the fallback provider before degrading to an
 *    end-of-turn-only signal.
 *
 * The provider catalog, config loader, credential store, provider registry,
 * audio store, and ingress URL modules are all mocked so the tests exercise
 * the capability/fallback logic in isolation.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// `mock.module` is process-global in Bun and leaks into sibling files that
// run later in the same `bun test` invocation (e.g. the real catalog tests
// in `src/tts/__tests__/`). Each stub therefore delegates to the real
// implementation unless this file's tests are active (`guardMocksActive`,
// toggled in beforeAll/afterAll). The real exports are snapshotted into
// plain objects NOW, before the stubs register — a module namespace is a
// live view, so reading the real export after the stub installs would
// resolve back to the stub (infinite recursion).

let guardMocksActive = false;

const realProviderCatalogModule = {
  ...(await import("../tts/provider-catalog.js")),
};
const realConfigLoaderModule = { ...(await import("../config/loader.js")) };
const realSecureKeysModule = { ...(await import("../security/secure-keys.js")) };
const realProviderRegistryModule = {
  ...(await import("../tts/provider-registry.js")),
};
const realAudioStoreModule = { ...(await import("../calls/audio-store.js")) };
const realPublicIngressUrlsModule = {
  ...(await import("../inbound/public-ingress-urls.js")),
};

// -- Fake provider catalog ---------------------------------------------------

interface FakeCatalogEntry {
  id: string;
  displayName: string;
  callMode: "native-twilio" | "synthesized-play";
  allowNativeFallback: boolean;
  capabilities: { supportsStreaming: boolean; supportedFormats: string[] };
  mediaStreamPlayback: { outputFormat: "pcm" | "wav" | "none" };
  secretRequirements: Array<{
    credentialStoreKey: string;
    displayName: string;
    setCommand: string;
  }>;
}

function makeEntry(
  id: string,
  callMode: "native-twilio" | "synthesized-play",
  outputFormat: "pcm" | "wav" | "none",
  allowNativeFallback: boolean,
): FakeCatalogEntry {
  return {
    id,
    displayName: id,
    callMode,
    allowNativeFallback,
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    mediaStreamPlayback: { outputFormat },
    secretRequirements: [
      {
        credentialStoreKey: `credential/${id}/api_key`,
        displayName: `${id} API Key`,
        setCommand: `assistant credentials set --service ${id} --field api_key <key>`,
      },
    ],
  };
}

const fakeCatalog: FakeCatalogEntry[] = [
  makeEntry("elevenlabs", "native-twilio", "pcm", true),
  makeEntry("fish-audio", "synthesized-play", "wav", true),
  makeEntry("deepgram", "synthesized-play", "pcm", false),
  makeEntry("compressed-only", "synthesized-play", "none", false),
];

mock.module("../tts/provider-catalog.js", () => ({
  ...realProviderCatalogModule,
  listCatalogProviders: () =>
    guardMocksActive
      ? fakeCatalog
      : realProviderCatalogModule.listCatalogProviders(),
  listCatalogProviderIds: () =>
    guardMocksActive
      ? fakeCatalog.map((e) => e.id)
      : realProviderCatalogModule.listCatalogProviderIds(),
  getCatalogProvider: (id: string) => {
    if (!guardMocksActive) {
      return realProviderCatalogModule.getCatalogProvider(id);
    }
    const entry = fakeCatalog.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Unknown TTS provider "${id}" is not in the catalog.`);
    }
    return entry;
  },
}));

// -- Mutable config ------------------------------------------------------------

const testConfig = {
  services: {
    tts: {
      provider: "elevenlabs",
      providers: {
        elevenlabs: {},
        "fish-audio": { referenceId: "", format: "mp3" },
        deepgram: { format: "mp3" },
        "compressed-only": { format: "mp3" },
      } as Record<string, { referenceId?: string; format?: string }>,
    },
  },
};

mock.module("../config/loader.js", () => ({
  ...realConfigLoaderModule,
  loadConfig: () =>
    guardMocksActive ? testConfig : realConfigLoaderModule.loadConfig(),
  getConfig: () =>
    guardMocksActive ? testConfig : realConfigLoaderModule.getConfig(),
  getConfigReadOnly: () =>
    guardMocksActive
      ? testConfig
      : realConfigLoaderModule.getConfigReadOnly(),
}));

// -- Mutable credential store --------------------------------------------------

let storedKeys: Record<string, string | undefined> = {};

mock.module("../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getProviderKeyAsync: async (provider: string) =>
    guardMocksActive
      ? storedKeys[provider]
      : realSecureKeysModule.getProviderKeyAsync(provider),
  getSecureKeyAsync: async (key: string) =>
    guardMocksActive
      ? storedKeys[key]
      : realSecureKeysModule.getSecureKeyAsync(key),
}));

// -- Mutable provider registry ---------------------------------------------------

const registeredProviders = new Map<string, unknown>();

mock.module("../tts/provider-registry.js", () => ({
  ...realProviderRegistryModule,
  getTtsProvider: (id: string) => {
    if (!guardMocksActive) {
      return realProviderRegistryModule.getTtsProvider(id);
    }
    const provider = registeredProviders.get(id);
    if (!provider) {
      throw new Error(`Unknown TTS provider "${id}".`);
    }
    return provider;
  },
}));

// -- Audio store + ingress URL (used by call-speech-output) ---------------------

const finalizeCalls: string[] = [];
let audioEntryCounter = 0;

mock.module("../calls/audio-store.js", () => ({
  ...realAudioStoreModule,
  createStreamingEntry: (
    format: Parameters<typeof realAudioStoreModule.createStreamingEntry>[0],
  ) => {
    if (!guardMocksActive) {
      return realAudioStoreModule.createStreamingEntry(format);
    }
    const audioId = `audio-${++audioEntryCounter}-${format}`;
    return {
      audioId,
      push: () => {},
      finalize: () => finalizeCalls.push(audioId),
    };
  },
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  ...realPublicIngressUrlsModule,
  getPublicBaseUrl: (
    config: Parameters<typeof realPublicIngressUrlsModule.getPublicBaseUrl>[0],
  ) =>
    guardMocksActive
      ? "https://example.test"
      : realPublicIngressUrlsModule.getPublicBaseUrl(config),
}));

import { speakSystemPrompt } from "../calls/call-speech-output.js";
import type { CallTransport } from "../calls/call-transport.js";
import {
  findPlayableTelephonyTtsFallback,
  resolveCallTtsProvider,
} from "../calls/resolve-call-tts-provider.js";
import {
  evaluateTelephonyTtsPlayability,
  resolveTelephonyTtsCapability,
} from "../calls/telephony-tts-capability.js";
import type { TtsProvider } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerStubProvider(
  id: string,
  synthesize: TtsProvider["synthesize"],
): TtsProvider {
  const provider: TtsProvider = {
    id,
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    synthesize,
  };
  registeredProviders.set(id, provider);
  return provider;
}

function createRelay(requiresWavAudio: boolean) {
  const sentTokens: Array<{ token: string; last: boolean }> = [];
  const sentPlayUrls: string[] = [];
  const relay: CallTransport = {
    requiresWavAudio,
    sendTextToken: (token, last) => {
      sentTokens.push({ token, last });
    },
    sendPlayUrl: (url) => {
      sentPlayUrls.push(url);
    },
    endSession: () => {},
    getConnectionState: () => "connected",
  } as CallTransport;
  return { relay, sentTokens, sentPlayUrls };
}

beforeAll(() => {
  guardMocksActive = true;
});

afterAll(() => {
  guardMocksActive = false;
});

beforeEach(() => {
  storedKeys = {};
  registeredProviders.clear();
  finalizeCalls.length = 0;
  testConfig.services.tts.provider = "elevenlabs";
  testConfig.services.tts.providers["fish-audio"].referenceId = "";
});

// ---------------------------------------------------------------------------
// Capability resolver
// ---------------------------------------------------------------------------

describe("resolveTelephonyTtsCapability", () => {
  test("pcm provider with a resolvable key is playable", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";

    const capability = await resolveTelephonyTtsCapability();
    expect(capability).toEqual({ status: "playable", providerId: "deepgram" });
  });

  test("wav provider with a resolvable key and referenceId is playable", async () => {
    testConfig.services.tts.provider = "fish-audio";
    testConfig.services.tts.providers["fish-audio"].referenceId = "ref-123";
    storedKeys["fish-audio"] = "fa-key";

    const capability = await resolveTelephonyTtsCapability();
    expect(capability).toEqual({
      status: "playable",
      providerId: "fish-audio",
    });
  });

  test("fish-audio with a key but no referenceId is not playable (missing-fish-audio-reference-id)", async () => {
    testConfig.services.tts.provider = "fish-audio";
    storedKeys["fish-audio"] = "fa-key";

    const capability = await resolveTelephonyTtsCapability();
    expect(capability).toEqual({
      status: "not-playable",
      providerId: "fish-audio",
      reason: "missing-fish-audio-reference-id",
    });
  });

  test("provider with mediaStreamPlayback 'none' is not playable (unsupported-format)", async () => {
    testConfig.services.tts.provider = "compressed-only";
    storedKeys["compressed-only"] = "co-key";

    const capability = await resolveTelephonyTtsCapability();
    expect(capability).toEqual({
      status: "not-playable",
      providerId: "compressed-only",
      reason: "unsupported-format",
    });
  });

  test("pcm provider without a key is not playable (missing-credentials)", async () => {
    testConfig.services.tts.provider = "deepgram";

    const capability = await resolveTelephonyTtsCapability();
    expect(capability).toEqual({
      status: "not-playable",
      providerId: "deepgram",
      reason: "missing-credentials",
    });
  });

  test("unknown provider is not playable (unsupported-format)", async () => {
    const capability = await evaluateTelephonyTtsPlayability("nonexistent");
    expect(capability).toEqual({
      status: "not-playable",
      providerId: "nonexistent",
      reason: "unsupported-format",
    });
  });
});

// ---------------------------------------------------------------------------
// Fallback provider scan
// ---------------------------------------------------------------------------

describe("findPlayableTelephonyTtsFallback", () => {
  test("prefers the ElevenLabs default when its key resolves", async () => {
    storedKeys["elevenlabs"] = "el-key";
    storedKeys["deepgram"] = "dg-key";

    expect(await findPlayableTelephonyTtsFallback("compressed-only")).toBe(
      "elevenlabs",
    );
  });

  test("skips fish-audio without a referenceId and picks the next playable provider", async () => {
    storedKeys["fish-audio"] = "fa-key";
    storedKeys["deepgram"] = "dg-key";

    expect(await findPlayableTelephonyTtsFallback("elevenlabs")).toBe(
      "deepgram",
    );

    testConfig.services.tts.providers["fish-audio"].referenceId = "ref-123";
    expect(await findPlayableTelephonyTtsFallback("elevenlabs")).toBe(
      "fish-audio",
    );
  });

  test("returns null when no provider is playable and credentialed", async () => {
    storedKeys["compressed-only"] = "co-key";

    expect(await findPlayableTelephonyTtsFallback()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Call TTS resolver — media-stream playability guard
// ---------------------------------------------------------------------------

describe("resolveCallTtsProvider with preferWav", () => {
  test("keeps the configured provider when it is playable and credentialed", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    registerStubProvider("deepgram", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/pcm" };
    });

    const result = await resolveCallTtsProvider({ preferWav: true });
    expect(result.provider?.id).toBe("deepgram");
    expect(result.useSynthesizedPath).toBe(true);
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back to a playable credentialed provider when the configured provider has an unsupported format", async () => {
    testConfig.services.tts.provider = "compressed-only";
    storedKeys["compressed-only"] = "co-key";
    storedKeys["elevenlabs"] = "el-key";
    registerStubProvider("compressed-only", async () => {
      throw new Error("should not be used");
    });
    registerStubProvider("elevenlabs", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/pcm" };
    });

    const result = await resolveCallTtsProvider({ preferWav: true });
    expect(result.provider?.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back when configured fish-audio has a key but no referenceId", async () => {
    testConfig.services.tts.provider = "fish-audio";
    storedKeys["fish-audio"] = "fa-key";
    storedKeys["elevenlabs"] = "el-key";
    registerStubProvider("fish-audio", async () => {
      throw new Error("should not be used");
    });
    registerStubProvider("elevenlabs", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/pcm" };
    });

    const result = await resolveCallTtsProvider({ preferWav: true });
    expect(result.provider?.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("wav");
  });

  test("falls back when the configured provider is missing credentials", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["elevenlabs"] = "el-key";
    registerStubProvider("deepgram", async () => {
      throw new Error("should not be used");
    });
    registerStubProvider("elevenlabs", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/pcm" };
    });

    const result = await resolveCallTtsProvider({ preferWav: true });
    expect(result.provider?.id).toBe("elevenlabs");
  });

  test("without preferWav the configured provider is not swapped", async () => {
    testConfig.services.tts.provider = "deepgram";
    // No credentials at all — the CR transport path does not consult the
    // media-stream playability capability.
    registerStubProvider("deepgram", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/mpeg" };
    });

    const result = await resolveCallTtsProvider();
    expect(result.provider?.id).toBe("deepgram");
    expect(result.useSynthesizedPath).toBe(true);
    expect(result.audioFormat).toBe("mp3");
  });
});

// ---------------------------------------------------------------------------
// speakSystemPrompt — media-stream synthesis failure retries the fallback
// ---------------------------------------------------------------------------

describe("speakSystemPrompt on a WAV-requiring transport", () => {
  test("retries with the fallback provider instead of emitting only end-of-turn", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    const deepgramSynthesize = jest.fn(async () => {
      throw new Error("deepgram synthesis down");
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStubProvider("deepgram", deepgramSynthesize);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(relay, "You have a new message.");

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).toHaveBeenCalledTimes(1);

    // The fallback synthesis produced playable audio.
    expect(sentPlayUrls.length).toBe(1);

    // End-of-turn is signalled, and the raw prompt text is never sent as a
    // text token (which the media-stream transport would re-synthesize via
    // the same failing provider).
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });

  test("degrades to end-of-turn only when no fallback provider is available", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";

    const deepgramSynthesize = jest.fn(async () => {
      throw new Error("deepgram synthesis down");
    });
    registerStubProvider("deepgram", deepgramSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(relay, "You have a new message.");

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls.length).toBe(0);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });

  test("does not retry more than once when the fallback provider also fails", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    const deepgramSynthesize = jest.fn(async () => {
      throw new Error("deepgram synthesis down");
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      throw new Error("elevenlabs synthesis down");
    });
    registerStubProvider("deepgram", deepgramSynthesize);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(relay, "You have a new message.");

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls.length).toBe(0);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });
});
