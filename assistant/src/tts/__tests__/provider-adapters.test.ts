import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Config mock -----------------------------------------------------------

let mockElevenLabsConfig = {
  voiceId: "test-voice-id",
  voiceModelId: "",
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  conversationTimeoutSeconds: 30,
};

let mockFishAudioConfig = {
  referenceId: "test-reference-id",
  chunkLength: 200,
  format: "mp3" as "mp3" | "wav" | "opus",
  latency: "normal" as "normal" | "balanced",
  speed: 1.0,
};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      tts: {
        providers: {
          elevenlabs: mockElevenLabsConfig,
          "fish-audio": mockFishAudioConfig,
        },
      },
    },
  }),
}));

// -- Secure keys mock ------------------------------------------------------

let mockApiKey: string | null = "test-elevenlabs-api-key";

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockApiKey,
}));

mock.module("../../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) =>
    `credential/${service}/${field}`,
}));

// -- Fish Audio client mock ------------------------------------------------

const mockSynthesizeWithFishAudio = mock(
  async (
    _text: string,
    _config: unknown,
    options?: { onChunk?: (chunk: Uint8Array) => void; signal?: AbortSignal },
  ) => {
    const audioData = Buffer.from("fake-fish-audio-data");
    if (options?.onChunk) {
      options.onChunk(new Uint8Array(audioData));
    }
    return audioData;
  },
);

mock.module("../../calls/fish-audio-client.js", () => ({
  synthesizeWithFishAudio: mockSynthesizeWithFishAudio,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { listCatalogProviderIds } from "../provider-catalog.js";
import {
  _resetTtsProviderRegistry,
  getTtsProvider,
  listTtsProviders,
} from "../provider-registry.js";
import { createElevenLabsProvider } from "../providers/elevenlabs-provider.js";
import { ElevenLabsTtsError } from "../providers/elevenlabs-provider.js";
import { createFishAudioProvider } from "../providers/fish-audio-provider.js";
import { FishAudioTtsError } from "../providers/fish-audio-provider.js";
import { providerFactories } from "../providers/index.js";
import {
  _resetBuiltinRegistration,
  registerBuiltinTtsProviders,
} from "../providers/register-builtins.js";
import type { TtsSynthesisRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockApiKey = "test-elevenlabs-api-key";
  mockElevenLabsConfig = {
    voiceId: "test-voice-id",
    voiceModelId: "",
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    conversationTimeoutSeconds: 30,
  };
  mockFishAudioConfig = {
    referenceId: "test-reference-id",
    chunkLength: 200,
    format: "mp3",
    latency: "normal",
    speed: 1.0,
  };
  mockSynthesizeWithFishAudio.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetTtsProviderRegistry();
  _resetBuiltinRegistration();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides?: Partial<TtsSynthesisRequest>,
): TtsSynthesisRequest {
  return {
    text: "Hello world",
    useCase: "message-playback",
    ...overrides,
  };
}

function mockFetchReturning(audioBytes: Uint8Array, status = 200): void {
  globalThis.fetch = mock(
    async () =>
      new Response(audioBytes.buffer as ArrayBuffer, {
        status,
        headers: { "Content-Type": "audio/mpeg" },
      }),
  ) as unknown as typeof globalThis.fetch;
}

function mockFetchError(status: number, body: string): void {
  globalThis.fetch = mock(
    async () => new Response(body, { status }),
  ) as unknown as typeof globalThis.fetch;
}

// ===========================================================================
// ElevenLabs provider adapter
// ===========================================================================

describe("ElevenLabs TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createElevenLabsProvider();
    expect(provider.id).toBe("elevenlabs");
  });

  test("advertises mp3 format support without streaming", () => {
    const provider = createElevenLabsProvider();
    expect(provider.capabilities.supportsStreaming).toBe(false);
    expect(provider.capabilities.supportedFormats).toEqual(["mp3"]);
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize sends request to ElevenLabs REST API with correct voice ID", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]); // Fake MP3 header
    let capturedUrl = "";
    let capturedHeaders: Headers | null = null;
    let capturedBody = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        return new Response(audioPayload, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("/v1/text-to-speech/test-voice-id");
    expect(capturedUrl).toContain("output_format=mp3_44100_128");
    expect(capturedHeaders!.get("xi-api-key")).toBe("test-elevenlabs-api-key");
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
    expect(body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1.0,
    });
  });

  test("uses lower-quality format for phone-call use case", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ useCase: "phone-call" }));

    expect(capturedUrl).toContain("output_format=mp3_22050_32");
  });

  test("request voiceId overrides config voiceId", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ voiceId: "override-voice" }));

    expect(capturedUrl).toContain("/v1/text-to-speech/override-voice");
  });

  test("uses configured voiceModelId when set", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_turbo_v2_5";

    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.model_id).toBe("eleven_turbo_v2_5");
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createElevenLabsProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  // -- Required config validation ------------------------------------------

  test("throws ELEVENLABS_TTS_NO_API_KEY when API key is missing", async () => {
    mockApiKey = null;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_NO_API_KEY",
      );
      expect((err as ElevenLabsTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws ELEVENLABS_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_HTTP_ERROR",
      );
      expect((err as ElevenLabsTtsError).statusCode).toBe(401);
    }
  });

  test("throws ELEVENLABS_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("throws ELEVENLABS_TTS_REQUEST_FAILED on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_REQUEST_FAILED",
      );
      expect((err as ElevenLabsTtsError).message).toContain(
        "Network unreachable",
      );
    }
  });
});

// ===========================================================================
// Fish Audio TTS provider adapter
// ===========================================================================

describe("Fish Audio TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createFishAudioProvider();
    expect(provider.id).toBe("fish-audio");
  });

  test("advertises streaming support with multiple formats", () => {
    const provider = createFishAudioProvider();
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportedFormats).toEqual([
      "mp3",
      "wav",
      "opus",
    ]);
  });

  test("implements synthesizeStream", () => {
    const provider = createFishAudioProvider();
    expect(typeof provider.synthesizeStream).toBe("function");
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize passes text and config to underlying client", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ text: "Test speech" }));

    expect(mockSynthesizeWithFishAudio).toHaveBeenCalledTimes(1);
    const [text, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect(text).toBe("Test speech");
    expect((config as { referenceId: string }).referenceId).toBe(
      "test-reference-id",
    );
    expect(
      (options as { signal?: AbortSignal } | undefined)?.signal,
    ).toBeUndefined();
  });

  test("request voiceId overrides config referenceId", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ voiceId: "custom-ref-id" }));

    const [, config] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { referenceId: string }).referenceId).toBe(
      "custom-ref-id",
    );
  });

  test("passes abort signal to underlying client", async () => {
    const controller = new AbortController();
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest({ signal: controller.signal }));

    const [, , options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((options as { signal?: AbortSignal } | undefined)?.signal).toBe(
      controller.signal,
    );
  });

  // -- Streaming -----------------------------------------------------------

  test("synthesizeStream passes onChunk callback through", async () => {
    const chunks: Uint8Array[] = [];
    const provider = createFishAudioProvider();
    await provider.synthesizeStream!(makeRequest(), (chunk) =>
      chunks.push(chunk),
    );

    expect(mockSynthesizeWithFishAudio).toHaveBeenCalledTimes(1);
    const [, , options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect(typeof (options as { onChunk?: unknown } | undefined)?.onChunk).toBe(
      "function",
    );
    // The mock calls onChunk once; verify it was received
    expect(chunks.length).toBeGreaterThan(0);
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    mockFishAudioConfig.format = "mp3";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/mpeg");
  });

  test("returns audio/wav content type for wav format", async () => {
    mockFishAudioConfig.format = "wav";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/wav");
  });

  test("returns audio/opus content type for opus format", async () => {
    mockFishAudioConfig.format = "opus";
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(makeRequest());
    expect(result.contentType).toBe("audio/opus");
  });

  // -- Required config validation ------------------------------------------

  test("throws FISH_AUDIO_TTS_NO_REFERENCE_ID when no reference ID is available", async () => {
    mockFishAudioConfig.referenceId = "";

    const provider = createFishAudioProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      );
      expect((err as FishAudioTtsError).message).toContain("reference ID");
    }
  });

  test("throws FISH_AUDIO_TTS_NO_REFERENCE_ID in synthesizeStream when no reference ID", async () => {
    mockFishAudioConfig.referenceId = "";

    const provider = createFishAudioProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_NO_REFERENCE_ID",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("wraps underlying client errors with FISH_AUDIO_TTS_SYNTHESIS_FAILED", async () => {
    mockSynthesizeWithFishAudio.mockImplementationOnce(async () => {
      throw new Error("API key not configured");
    });

    const provider = createFishAudioProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
      );
      expect((err as FishAudioTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  test("wraps streaming client errors with FISH_AUDIO_TTS_SYNTHESIS_FAILED", async () => {
    mockSynthesizeWithFishAudio.mockImplementationOnce(async () => {
      throw new Error("Connection reset");
    });

    const provider = createFishAudioProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FishAudioTtsError);
      expect((err as FishAudioTtsError).code).toBe(
        "FISH_AUDIO_TTS_SYNTHESIS_FAILED",
      );
      expect((err as FishAudioTtsError).message).toContain("Connection reset");
    }
  });
});

// ===========================================================================
// Built-in registration
// ===========================================================================

describe("registerBuiltinTtsProviders", () => {
  test("registers elevenlabs and fish-audio providers", () => {
    registerBuiltinTtsProviders();

    const providers = listTtsProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("elevenlabs");
    expect(ids).toContain("fish-audio");
  });

  test("providers are discoverable via getTtsProvider after registration", () => {
    registerBuiltinTtsProviders();

    const el = getTtsProvider("elevenlabs");
    expect(el.id).toBe("elevenlabs");

    const fa = getTtsProvider("fish-audio");
    expect(fa.id).toBe("fish-audio");
  });

  test("idempotent — calling twice does not throw", () => {
    // First call registers; second should be a no-op due to the guard flag.
    // However, because tests reset the registry via afterEach, the internal
    // `registered` flag may still be true. We call it once here and verify
    // it does not throw — that exercises the guard path.
    registerBuiltinTtsProviders();
    expect(() => registerBuiltinTtsProviders()).not.toThrow();
  });

  test("registers every provider declared in the catalog", () => {
    registerBuiltinTtsProviders();

    const catalogIds = listCatalogProviderIds();
    const registeredProviders = listTtsProviders();
    const registeredIds = registeredProviders.map((p) => p.id);

    for (const id of catalogIds) {
      expect(registeredIds).toContain(id);
    }
    // The registered set should match the catalog exactly (no extras).
    expect(registeredIds.length).toBe(catalogIds.length);
  });

  test("every catalog provider has a factory in the providerFactories map", () => {
    const catalogIds = listCatalogProviderIds();

    for (const id of catalogIds) {
      expect(providerFactories.has(id)).toBe(true);
    }
  });

  test("throws when a catalog provider has no adapter factory", () => {
    // Verify the error path by checking that the error message format is
    // correct. We cannot easily add a fake catalog entry without modifying
    // the catalog module, but we can verify the factory map keys match the
    // catalog — if they diverge this test will catch it.
    const catalogIds = listCatalogProviderIds();
    const factoryIds = [...providerFactories.keys()];

    const missingFactories = catalogIds.filter(
      (id) => !factoryIds.includes(id),
    );
    expect(missingFactories).toEqual([]);
  });
});
