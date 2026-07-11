/**
 * Guard tests for telephony TTS media-stream playability.
 *
 * Covers three layers:
 * 1. `resolveTelephonyTtsCapability` — catalog `mediaStreamPlayback` format
 *    plus credential availability produce the playable / not-playable verdict.
 * 2. `resolveCallTtsProvider({ requiresPcmAudio: true })` — a not-playable
 *    configured provider is swapped for a playable credentialed fallback
 *    instead of resolving into guaranteed media-stream silence.
 * 3. `speakSystemPrompt` on a PCM-requiring transport — synthesis failure
 *    retries once via the fallback provider before degrading to an
 *    end-of-turn-only signal; a mid-stream failure after the play URL went
 *    out skips all fallback (the truncated prompt stands); aborted
 *    synthesis short-circuits with no fallback and no end-of-turn token.
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
const realSecureKeysModule = {
  ...(await import("../security/secure-keys.js")),
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
  mediaStreamPlayback: { outputFormat: "pcm" | "none" };
  secretRequirements: Array<{
    credentialStoreKey: string;
    displayName: string;
    setCommand: string;
  }>;
}

function makeEntry(
  id: string,
  callMode: "native-twilio" | "synthesized-play",
  outputFormat: "pcm" | "none",
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
  makeEntry("fish-audio", "synthesized-play", "pcm", true),
  makeEntry("deepgram", "synthesized-play", "pcm", false),
  makeEntry("compressed-only", "synthesized-play", "none", false),
  makeEntry("vellum", "synthesized-play", "pcm", false),
];

// The catalog is also the adapter-resolution point (`getTtsProvider`), so the
// fake registry of stub adapters is served through the same module mock.
const registeredProviders = new Map<string, unknown>();

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
  getTtsProvider: (id: string) => {
    if (!guardMocksActive) {
      return realProviderCatalogModule.getTtsProvider(id);
    }
    const provider = registeredProviders.get(id);
    if (!provider) {
      throw new Error(`Unknown TTS provider "${id}".`);
    }
    return provider;
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
    guardMocksActive ? testConfig : realConfigLoaderModule.getConfigReadOnly(),
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

// -- Audio store + ingress URL (used by the tts/synthesis-stream sink) ----------

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

let mockManagedSpeechAvailable = true;

mock.module("../platform/managed-speech.js", () => ({
  managedSpeechAvailable: async () => mockManagedSpeechAvailable,
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

function registerStreamingStubProvider(
  id: string,
  synthesizeStream: NonNullable<TtsProvider["synthesizeStream"]>,
): TtsProvider {
  const provider: TtsProvider = {
    id,
    capabilities: { supportsStreaming: true, supportedFormats: ["mp3"] },
    synthesize: async () => {
      throw new Error("buffer path should not be used");
    },
    synthesizeStream,
  };
  registeredProviders.set(id, provider);
  return provider;
}

function createRelay(requiresPcmAudio: boolean) {
  const sentTokens: Array<{ token: string; last: boolean }> = [];
  const sentPlayUrls: string[] = [];
  const relay: CallTransport = {
    requiresPcmAudio,
    sendTextToken: (token, last) => {
      sentTokens.push({ token, last });
    },
    sendPlayUrl: (url) => {
      sentPlayUrls.push(url);
    },
    endSession: () => {},
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

  test("fish-audio with a resolvable key and referenceId is playable", async () => {
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

describe("resolveCallTtsProvider with requiresPcmAudio", () => {
  test("keeps the configured provider when it is playable and credentialed", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    registerStubProvider("deepgram", async () => {
      return { audio: Buffer.from("x"), contentType: "audio/pcm" };
    });

    const result = await resolveCallTtsProvider({ requiresPcmAudio: true });
    expect(result.provider?.id).toBe("deepgram");
    expect(result.useSynthesizedPath).toBe(true);
    expect(result.audioFormat).toBe("pcm");
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

    const result = await resolveCallTtsProvider({ requiresPcmAudio: true });
    expect(result.provider?.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("pcm");
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

    const result = await resolveCallTtsProvider({ requiresPcmAudio: true });
    expect(result.provider?.id).toBe("elevenlabs");
    expect(result.audioFormat).toBe("pcm");
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

    const result = await resolveCallTtsProvider({ requiresPcmAudio: true });
    expect(result.provider?.id).toBe("elevenlabs");
  });

  test("without requiresPcmAudio the configured provider is not swapped", async () => {
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

describe("speakSystemPrompt on a PCM-requiring transport", () => {
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

// ---------------------------------------------------------------------------
// speakSystemPrompt — mid-stream failure after audio started skips fallback
// ---------------------------------------------------------------------------

describe("speakSystemPrompt mid-stream failure after audio started", () => {
  /** Streaming stub that emits one chunk, lets it flush, then fails. */
  function failAfterFirstChunk(): NonNullable<TtsProvider["synthesizeStream"]> {
    return async (_request, emit) => {
      emit(Buffer.from("pcm-chunk"));
      // Let the queued emit flush so the play URL goes out before the failure.
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("stream died mid-flight");
    };
  }

  test("PCM transport: skips the fallback retry — the truncated prompt stands", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    const deepgramStream = jest.fn(failAfterFirstChunk());
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStreamingStubProvider("deepgram", deepgramStream);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(relay, "Your verification code is 123456.");

    expect(deepgramStream).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).not.toHaveBeenCalled();
    expect(sentPlayUrls.length).toBe(1);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });

  test("non-PCM transport: skips the native text fallback — no full-prompt re-speak", async () => {
    testConfig.services.tts.provider = "fish-audio";
    testConfig.services.tts.providers["fish-audio"].referenceId = "ref-123";

    const fishStream = jest.fn(failAfterFirstChunk());
    registerStreamingStubProvider("fish-audio", fishStream);

    const { relay, sentTokens, sentPlayUrls } = createRelay(false);
    await speakSystemPrompt(relay, "You have a new message.");

    expect(fishStream).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls.length).toBe(1);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });

  test("streaming failure before any chunk still retries the fallback provider", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    const deepgramStream = jest.fn(async () => {
      throw new Error("stream refused before first chunk");
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStreamingStubProvider("deepgram", deepgramStream);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(relay, "Your verification code is 123456.");

    expect(deepgramStream).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls.length).toBe(1);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });
});

// ---------------------------------------------------------------------------
// speakSystemPrompt — aborted synthesis short-circuits without fallback
// ---------------------------------------------------------------------------

describe("speakSystemPrompt aborted synthesis", () => {
  test("PCM transport: abort mid-flight skips the fallback retry and end-of-turn", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    const controller = new AbortController();
    const deepgramSynthesize = jest.fn(async () => {
      controller.abort();
      throw new DOMException("Synthesis aborted", "AbortError");
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStubProvider("deepgram", deepgramSynthesize);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(
      relay,
      "You have a new message.",
      controller.signal,
    );

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).not.toHaveBeenCalled();
    expect(sentPlayUrls).toEqual([]);
    expect(sentTokens).toEqual([]);
  });

  test("non-PCM transport with native-fallback provider: abort skips the text fallback and end-of-turn", async () => {
    testConfig.services.tts.provider = "fish-audio";
    testConfig.services.tts.providers["fish-audio"].referenceId = "ref-123";

    const controller = new AbortController();
    controller.abort();
    const fishSynthesize = jest.fn(async () => {
      throw new DOMException("Synthesis aborted", "AbortError");
    });
    registerStubProvider("fish-audio", fishSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(false);
    await speakSystemPrompt(
      relay,
      "You have a new message.",
      controller.signal,
    );

    expect(fishSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls).toEqual([]);
    expect(sentTokens).toEqual([]);
  });

  test("abort at provider resolution (silent, no throw) skips the end-of-turn token", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    // synthesizeAndEmit does NOT throw when the signal aborts after the
    // provider resolves but before queued emits run — it resolves normally
    // with zero emitted chunks. The success path must still honor the abort.
    const controller = new AbortController();
    const deepgramSynthesize = jest.fn(async () => {
      controller.abort();
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStubProvider("deepgram", deepgramSynthesize);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(
      relay,
      "You have a new message.",
      controller.signal,
    );

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).not.toHaveBeenCalled();
    expect(sentPlayUrls).toEqual([]);
    expect(sentTokens).toEqual([]);
  });

  test("provider AbortError without our signal aborted is a failure — PCM fallback retry still runs", async () => {
    testConfig.services.tts.provider = "deepgram";
    storedKeys["deepgram"] = "dg-key";
    storedKeys["elevenlabs"] = "el-key";

    // Provider-internal network abort: it throws AbortError, but the
    // caller's signal was never aborted — not a cancellation.
    const controller = new AbortController();
    const deepgramSynthesize = jest.fn(async () => {
      throw new DOMException("socket torn down", "AbortError");
    });
    const elevenlabsSynthesize = jest.fn(async () => {
      return { audio: Buffer.from("pcm-bytes"), contentType: "audio/pcm" };
    });
    registerStubProvider("deepgram", deepgramSynthesize);
    registerStubProvider("elevenlabs", elevenlabsSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(true);
    await speakSystemPrompt(
      relay,
      "You have a new message.",
      controller.signal,
    );

    expect(deepgramSynthesize).toHaveBeenCalledTimes(1);
    expect(elevenlabsSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls.length).toBe(1);
    expect(sentTokens).toEqual([{ token: "", last: true }]);
  });

  test("provider AbortError without any signal is a failure — non-PCM native fallback still runs", async () => {
    testConfig.services.tts.provider = "fish-audio";
    testConfig.services.tts.providers["fish-audio"].referenceId = "ref-123";

    const fishSynthesize = jest.fn(async () => {
      throw new DOMException("socket torn down", "AbortError");
    });
    registerStubProvider("fish-audio", fishSynthesize);

    const { relay, sentTokens, sentPlayUrls } = createRelay(false);
    await speakSystemPrompt(relay, "You have a new message.");

    expect(fishSynthesize).toHaveBeenCalledTimes(1);
    expect(sentPlayUrls).toEqual([]);
    expect(sentTokens).toEqual([
      { token: "You have a new message.", last: true },
    ]);
  });
});

describe("vellum managed playability", () => {
  test("playable only when the platform identity is fully provisioned", async () => {
    // The stored secret resolves, but availability decides.
    storedKeys["vellum"] = "stored";
    mockManagedSpeechAvailable = true;
    const playable = await evaluateTelephonyTtsPlayability("vellum");
    expect(playable.status).toBe("playable");
  });

  test("half-connected platform (secret without identity) is not playable", async () => {
    storedKeys["vellum"] = "stored";
    mockManagedSpeechAvailable = false;
    const playable = await evaluateTelephonyTtsPlayability("vellum");
    expect(playable).toMatchObject({
      status: "not-playable",
      reason: "missing-credentials",
    });
  });
});
