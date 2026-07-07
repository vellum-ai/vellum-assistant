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

let mockDeepgramConfig = {
  model: "aura-asteria-en",
  format: "mp3" as "mp3" | "wav" | "opus",
};

let mockXaiConfig = {
  voiceId: "eve",
  language: "auto",
  format: "mp3" as "mp3" | "wav",
  sampleRate: 24000,
  bitRate: 128000,
};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      tts: {
        providers: {
          elevenlabs: mockElevenLabsConfig,
          "fish-audio": mockFishAudioConfig,
          deepgram: mockDeepgramConfig,
          xai: mockXaiConfig,
        },
      },
    },
  }),
}));

// -- Secure keys mock ------------------------------------------------------

let mockApiKey: string | null = "test-elevenlabs-api-key";
let mockDeepgramApiKey: string | null = "test-deepgram-api-key";
let mockXaiApiKey: string | null = "test-xai-api-key";

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key?: string) => {
    if (key === "credential/xai/api_key") return mockXaiApiKey;
    return mockApiKey;
  },
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "deepgram") return mockDeepgramApiKey;
    return mockApiKey;
  },
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

import {
  getProviderDefinition,
  getTtsProvider,
  listCatalogProviderIds,
} from "../provider-catalog.js";
import {
  createDeepgramProvider,
  DeepgramTtsError,
} from "../providers/deepgram-provider.js";
import {
  createElevenLabsProvider,
  ElevenLabsTtsError,
  extractElevenLabsErrorMessage,
} from "../providers/elevenlabs-provider.js";
import { createFishAudioProvider } from "../providers/fish-audio-provider.js";
import { FishAudioTtsError } from "../providers/fish-audio-provider.js";
import { createXaiProvider, XaiTtsError } from "../providers/xai-provider.js";
import type { TtsSynthesisRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockApiKey = "test-elevenlabs-api-key";
  mockDeepgramApiKey = "test-deepgram-api-key";
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
  mockDeepgramConfig = {
    model: "aura-asteria-en",
    format: "mp3",
  };
  mockXaiApiKey = "test-xai-api-key";
  mockXaiConfig = {
    voiceId: "eve",
    language: "auto",
    format: "mp3",
    sampleRate: 24000,
    bitRate: 128000,
  };
  mockSynthesizeWithFishAudio.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
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

  test("advertises mp3 and pcm format support with streaming", () => {
    const provider = createElevenLabsProvider();
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportedFormats).toEqual(["mp3", "pcm"]);
  });

  test("implements synthesizeStream", () => {
    const provider = createElevenLabsProvider();
    expect(typeof provider.synthesizeStream).toBe("function");
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

  test("synthesize defaults to eleven_multilingual_v2 model", async () => {
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
    expect(body.model_id).toBe("eleven_multilingual_v2");
  });

  // -- PCM sample-rate mapping ----------------------------------------------

  test("pcm output with sampleRateHz 24000 requests pcm_24000", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 24000 }),
    );

    expect(capturedUrl).toContain("output_format=pcm_24000");
    expect(result.contentType).toBe("audio/pcm");
  });

  test("pcm output without sampleRateHz defaults to pcm_16000", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(makeRequest({ outputFormat: "pcm" }));

    expect(capturedUrl).toContain("output_format=pcm_16000");
  });

  test("pcm output with unmatched sampleRateHz falls back to pcm_16000", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 8000 }),
    );

    expect(capturedUrl).toContain("output_format=pcm_16000");
  });

  test("resolveOutputSampleRateHz reports the actual PCM rate without synthesis", () => {
    const provider = createElevenLabsProvider();

    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 24000 }),
      ),
    ).toBe(24000);
    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 48000 }),
      ),
    ).toBe(16000);
    expect(provider.resolveOutputSampleRateHz!(makeRequest())).toBeUndefined();
  });

  // -- Streaming -------------------------------------------------------------

  test("synthesizeStream reads chunks from the /stream endpoint and concatenates them", async () => {
    const part1 = new Uint8Array([0x01, 0x02]);
    const part2 = new Uint8Array([0x03]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(streamOf(part1, part2), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const received: Uint8Array[] = [];
    const provider = createElevenLabsProvider();
    const result = await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm" }),
      (chunk) => received.push(chunk),
    );

    expect(capturedUrl).toContain(
      "/v1/text-to-speech/test-voice-id/stream?output_format=pcm_16000",
    );
    expect(received).toEqual([part1, part2]);
    expect(result.audio).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    expect(result.contentType).toBe("audio/pcm");
  });

  test("synthesizeStream rejects after the first-chunk timeout when the stream never produces audio", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
        }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider({
      firstChunkTimeoutMs: 20,
      idleTimeoutMs: 20,
    });

    await expect(
      provider.synthesizeStream!(
        makeRequest({ outputFormat: "pcm" }),
        () => {},
      ),
    ).rejects.toMatchObject({
      name: "ElevenLabsTtsError",
      code: "ELEVENLABS_TTS_STREAM_TIMEOUT",
      message: expect.stringContaining("timed out after 20ms"),
    });
  });

  test("synthesizeStream rejects after the idle timeout when the stream stalls mid-stream", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x01, 0x02]));
              // Never enqueue again and never close — a mid-stream stall.
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;

    const received: Uint8Array[] = [];
    const provider = createElevenLabsProvider({
      firstChunkTimeoutMs: 1_000,
      idleTimeoutMs: 20,
    });

    await expect(
      provider.synthesizeStream!(
        makeRequest({ outputFormat: "pcm" }),
        (chunk) => received.push(chunk),
      ),
    ).rejects.toMatchObject({
      name: "ElevenLabsTtsError",
      code: "ELEVENLABS_TTS_STREAM_TIMEOUT",
    });
    expect(received).toHaveLength(1);
  });

  test("synthesizeStream defaults to eleven_flash_v2_5 model", async () => {
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(streamOf(new Uint8Array([0x01])), { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesizeStream!(makeRequest(), () => {});

    const body = JSON.parse(capturedBody);
    expect(body.model_id).toBe("eleven_flash_v2_5");
  });

  test("synthesizeStream respects configured voiceModelId over flash default", async () => {
    mockElevenLabsConfig.voiceModelId = "eleven_turbo_v2_5";
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(streamOf(new Uint8Array([0x01])), { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();
    await provider.synthesizeStream!(makeRequest(), () => {});

    const body = JSON.parse(capturedBody);
    expect(body.model_id).toBe("eleven_turbo_v2_5");
  });

  test("synthesizeStream throws ELEVENLABS_TTS_EMPTY_RESPONSE on null body", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("synthesizeStream throws ELEVENLABS_TTS_EMPTY_RESPONSE on zero-byte stream", async () => {
    globalThis.fetch = mock(
      async () => new Response(streamOf(), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("synthesizeStream surfaces upstream error message on HTTP error", async () => {
    mockFetchError(
      402,
      JSON.stringify({ detail: { message: "Quota exceeded" } }),
    );

    const provider = createElevenLabsProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElevenLabsTtsError);
      expect((err as ElevenLabsTtsError).code).toBe(
        "ELEVENLABS_TTS_HTTP_ERROR",
      );
      expect((err as ElevenLabsTtsError).statusCode).toBe(402);
      expect((err as ElevenLabsTtsError).message).toBe("Quota exceeded");
    }
  });

  test("synthesizeStream propagates AbortError unmodified", async () => {
    globalThis.fetch = mock(async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    const provider = createElevenLabsProvider();

    try {
      await provider.synthesizeStream!(
        makeRequest({ signal: controller.signal }),
        () => {},
      );
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(ElevenLabsTtsError);
      expect((err as Error).name).toBe("AbortError");
    }
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

  // -- Upstream error-body extraction --------------------------------------

  describe("extractElevenLabsErrorMessage", () => {
    test("extracts message from standard { detail: { message } } shape", () => {
      const body = JSON.stringify({
        detail: {
          type: "payment_required",
          code: "paid_plan_required",
          message:
            "Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.",
          status: "payment_required",
        },
      });
      expect(extractElevenLabsErrorMessage(body)).toBe(
        "Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.",
      );
    });

    test("falls back to { detail: '...' } when detail is a string", () => {
      const body = JSON.stringify({ detail: "Voice not found" });
      expect(extractElevenLabsErrorMessage(body)).toBe("Voice not found");
    });

    test("falls back to { message: '...' } when present", () => {
      const body = JSON.stringify({ message: "Quota exceeded" });
      expect(extractElevenLabsErrorMessage(body)).toBe("Quota exceeded");
    });

    test("returns trimmed raw body when not JSON", () => {
      expect(extractElevenLabsErrorMessage("  upstream timeout  ")).toBe(
        "upstream timeout",
      );
    });

    test("truncates oversized raw bodies", () => {
      const long = "x".repeat(1000);
      const result = extractElevenLabsErrorMessage(long);
      expect(result).not.toBeUndefined();
      // 200-char limit plus an ellipsis character.
      expect(result!.length).toBeLessThanOrEqual(201);
      expect(result!.endsWith("…")).toBe(true);
    });

    test("returns undefined for empty input", () => {
      expect(extractElevenLabsErrorMessage("")).toBeUndefined();
      expect(extractElevenLabsErrorMessage("   \n  ")).toBeUndefined();
    });

    test("returns truncated raw body when JSON is malformed", () => {
      // Not valid JSON despite the leading `{` — falls through to raw fallback.
      const body = "{not really json}";
      expect(extractElevenLabsErrorMessage(body)).toBe("{not really json}");
    });

    test("ignores empty-string message fields", () => {
      const body = JSON.stringify({ detail: { message: "   " } });
      // Falls through to top-level message — also absent — then to raw body.
      const result = extractElevenLabsErrorMessage(body);
      expect(result).not.toBeUndefined();
      // Raw body fallback contains the JSON text itself.
      expect(result).toContain("detail");
    });

    test("trims whitespace from extracted messages", () => {
      const body = JSON.stringify({
        detail: { message: "  hello world  " },
      });
      expect(extractElevenLabsErrorMessage(body)).toBe("hello world");
    });
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
      "pcm",
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

  test("pcm output request maps to raw pcm format at the 16 kHz default", async () => {
    const provider = createFishAudioProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { sampleRate?: number } | undefined)?.sampleRate).toBe(
      16000,
    );
    expect(result.contentType).toBe("audio/pcm");
  });

  test("pcm output request honors a supported sampleRateHz hint", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 24000 }),
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { sampleRate?: number } | undefined)?.sampleRate).toBe(
      24000,
    );
  });

  test("pcm output request clamps an unsupported sampleRateHz hint to the nearest supported rate", async () => {
    const provider = createFishAudioProvider();
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 48000 }),
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { sampleRate?: number } | undefined)?.sampleRate).toBe(
      44100,
    );
  });

  test("synthesizeStream pcm output request maps to raw pcm honoring the hint", async () => {
    const provider = createFishAudioProvider();
    const result = await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 24000 }),
      () => {},
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { sampleRate?: number } | undefined)?.sampleRate).toBe(
      24000,
    );
    expect(result.contentType).toBe("audio/pcm");
  });

  test("resolveOutputSampleRateHz clamps unsupported pcm hints and is undefined otherwise", () => {
    const provider = createFishAudioProvider();

    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 48000 }),
      ),
    ).toBe(44100);
    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 24000 }),
      ),
    ).toBe(24000);
    expect(
      provider.resolveOutputSampleRateHz!(makeRequest({ outputFormat: "pcm" })),
    ).toBe(16000);
    expect(provider.resolveOutputSampleRateHz!(makeRequest())).toBeUndefined();
  });

  test("synthesizeStream pcm chunks pass through raw with no RIFF header", async () => {
    const rawPcm = new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x03, 0x00]);
    mockSynthesizeWithFishAudio.mockImplementationOnce(
      async (_text, _config, options) => {
        options?.onChunk?.(rawPcm);
        return Buffer.from(rawPcm);
      },
    );

    const chunks: Uint8Array[] = [];
    const provider = createFishAudioProvider();
    await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm" }),
      (chunk) => chunks.push(chunk),
    );

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("pcm");
    expect((options as { sampleRate?: number } | undefined)?.sampleRate).toBe(
      16000,
    );
    // Chunks are forwarded verbatim — raw PCM, no WAV container.
    expect(chunks).toEqual([rawPcm]);
    expect(Buffer.from(chunks[0]!).subarray(0, 4).toString("ascii")).not.toBe(
      "RIFF",
    );
  });

  test("explicit format request does not set a sample rate", async () => {
    mockFishAudioConfig.format = "wav";
    const provider = createFishAudioProvider();
    await provider.synthesize(makeRequest());

    const [, config, options] = mockSynthesizeWithFishAudio.mock.calls[0]!;
    expect((config as { format: string }).format).toBe("wav");
    expect(
      (options as { sampleRate?: number } | undefined)?.sampleRate,
    ).toBeUndefined();
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
// Deepgram TTS provider adapter
// ===========================================================================

describe("Deepgram TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createDeepgramProvider();
    expect(provider.id).toBe("deepgram");
  });

  test("advertises mp3, wav, opus, pcm format support with streaming", () => {
    const provider = createDeepgramProvider();
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.supportedFormats).toEqual([
      "mp3",
      "wav",
      "opus",
      "pcm",
    ]);
  });

  test("implements synthesizeStream", () => {
    const provider = createDeepgramProvider();
    expect(typeof provider.synthesizeStream).toBe("function");
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize sends request to Deepgram REST TTS API with correct model", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
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

    const provider = createDeepgramProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("/v1/speak");
    expect(capturedUrl).toContain("model=aura-asteria-en");
    expect(capturedUrl).toContain("encoding=mp3");
    expect(capturedHeaders!.get("Authorization")).toBe(
      "Token test-deepgram-api-key",
    );
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
  });

  test("uses linear16 encoding with container=none and sample_rate=16000 when outputFormat is pcm", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=none");
    expect(capturedUrl).toContain("sample_rate=16000");
    expect(result.contentType).toBe("audio/pcm");
  });

  test("pcm request honors a supported sampleRateHz hint", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 24_000 }),
    );

    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=none");
    expect(capturedUrl).toContain("sample_rate=24000");
  });

  test("pcm request clamps an unsupported sampleRateHz hint to the nearest supported rate", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();

    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 44_100 }),
    );
    expect(capturedUrl).toContain("sample_rate=48000");

    // Tie between 8000 and 16000 prefers the higher rate.
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 12_000 }),
    );
    expect(capturedUrl).toContain("sample_rate=16000");
  });

  // -- Output sample rate probe ---------------------------------------------

  test("resolveOutputSampleRateHz returns the clamped rate for pcm requests", () => {
    const provider = createDeepgramProvider();
    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 44_100 }),
      ),
    ).toBe(48_000);
  });

  test("resolveOutputSampleRateHz defaults to 16 kHz for hint-less pcm requests", () => {
    const provider = createDeepgramProvider();
    expect(
      provider.resolveOutputSampleRateHz!(makeRequest({ outputFormat: "pcm" })),
    ).toBe(16_000);
  });

  test("resolveOutputSampleRateHz returns undefined for non-pcm requests", () => {
    const provider = createDeepgramProvider();
    expect(provider.resolveOutputSampleRateHz!(makeRequest())).toBeUndefined();
    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ sampleRateHz: 24_000 }),
      ),
    ).toBeUndefined();
  });

  test("translates wav config format to linear16 encoding with container=wav", async () => {
    mockDeepgramConfig.format = "wav";
    const audioPayload = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=wav");
    expect(capturedUrl).not.toContain("sample_rate=");
    expect(result.contentType).toBe("audio/wav");
  });

  test("uses configured model", async () => {
    mockDeepgramConfig.model = "aura-luna-en";
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(audioPayload, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toContain("model=aura-luna-en");
  });

  // -- Streaming -------------------------------------------------------------

  test("synthesizeStream reads chunks from /v1/speak and concatenates them", async () => {
    const part1 = new Uint8Array([0x01, 0x02]);
    const part2 = new Uint8Array([0x03]);
    const part3 = new Uint8Array([0x04, 0x05]);
    let capturedUrl = "";

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(streamOf(part1, part2, part3), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const received: Uint8Array[] = [];
    const provider = createDeepgramProvider();
    const result = await provider.synthesizeStream!(
      makeRequest({ outputFormat: "pcm" }),
      (chunk) => received.push(chunk),
    );

    expect(capturedUrl).toContain("/v1/speak");
    expect(capturedUrl).toContain("encoding=linear16");
    expect(capturedUrl).toContain("container=none");
    expect(capturedUrl).toContain("sample_rate=");
    expect(received).toEqual([part1, part2, part3]);
    expect(result.audio).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    expect(result.contentType).toBe("audio/pcm");
  });

  test("synthesizeStream rejects after the first-chunk timeout when the stream never produces audio", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
        }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider({
      firstChunkTimeoutMs: 20,
      idleTimeoutMs: 20,
    });

    await expect(
      provider.synthesizeStream!(
        makeRequest({ outputFormat: "pcm" }),
        () => {},
      ),
    ).rejects.toMatchObject({
      name: "DeepgramTtsError",
      code: "DEEPGRAM_TTS_STREAM_TIMEOUT",
      message: expect.stringContaining("timed out after 20ms"),
    });
  });

  test("synthesizeStream rejects after the idle timeout when the stream stalls mid-stream", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x01, 0x02]));
              // Never enqueue again and never close — a mid-stream stall.
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;

    const received: Uint8Array[] = [];
    const provider = createDeepgramProvider({
      firstChunkTimeoutMs: 1_000,
      idleTimeoutMs: 20,
    });

    await expect(
      provider.synthesizeStream!(
        makeRequest({ outputFormat: "pcm" }),
        (chunk) => received.push(chunk),
      ),
    ).rejects.toMatchObject({
      name: "DeepgramTtsError",
      code: "DEEPGRAM_TTS_STREAM_TIMEOUT",
    });
    expect(received).toHaveLength(1);
  });

  test("synthesizeStream throws DEEPGRAM_TTS_EMPTY_RESPONSE on null body", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("synthesizeStream throws DEEPGRAM_TTS_EMPTY_RESPONSE on zero-byte stream", async () => {
    globalThis.fetch = mock(
      async () => new Response(streamOf(), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("synthesizeStream throws DEEPGRAM_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(429, "Rate limit exceeded");

    const provider = createDeepgramProvider();

    try {
      await provider.synthesizeStream!(makeRequest(), () => {});
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe("DEEPGRAM_TTS_HTTP_ERROR");
      expect((err as DeepgramTtsError).statusCode).toBe(429);
    }
  });

  test("synthesizeStream propagates AbortError unmodified", async () => {
    globalThis.fetch = mock(async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    const provider = createDeepgramProvider();

    try {
      await provider.synthesizeStream!(
        makeRequest({ signal: controller.signal }),
        () => {},
      );
      throw new Error("Expected synthesizeStream to throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(DeepgramTtsError);
      expect((err as Error).name).toBe("AbortError");
    }
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createDeepgramProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  test("synthesizeStream resolves audio/mpeg content type for mp3 format", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(streamOf(new Uint8Array([0x49])), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();
    const result = await provider.synthesizeStream!(makeRequest(), () => {});

    expect(result.contentType).toBe("audio/mpeg");
  });

  // -- Required config validation ------------------------------------------

  test("throws DEEPGRAM_TTS_NO_API_KEY when API key is missing", async () => {
    mockDeepgramApiKey = null;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe("DEEPGRAM_TTS_NO_API_KEY");
      expect((err as DeepgramTtsError).message).toContain(
        "API key not configured",
      );
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws DEEPGRAM_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe("DEEPGRAM_TTS_HTTP_ERROR");
      expect((err as DeepgramTtsError).statusCode).toBe(401);
    }
  });

  test("throws DEEPGRAM_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_EMPTY_RESPONSE",
      );
    }
  });

  test("throws DEEPGRAM_TTS_REQUEST_FAILED on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof globalThis.fetch;

    const provider = createDeepgramProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepgramTtsError);
      expect((err as DeepgramTtsError).code).toBe(
        "DEEPGRAM_TTS_REQUEST_FAILED",
      );
      expect((err as DeepgramTtsError).message).toContain(
        "Network unreachable",
      );
    }
  });
});

// ===========================================================================
// xAI TTS provider adapter
// ===========================================================================

describe("xAI TTS provider adapter", () => {
  // -- Interface conformance -----------------------------------------------

  test("has correct provider ID", () => {
    const provider = createXaiProvider();
    expect(provider.id).toBe("xai");
  });

  test("advertises mp3 and wav format support without streaming", () => {
    const provider = createXaiProvider();
    expect(provider.capabilities).toEqual({
      supportsStreaming: false,
      supportedFormats: ["mp3", "wav"],
    });
  });

  // -- Request mapping -----------------------------------------------------

  test("synthesize posts to /v1/tts with correct auth and default body", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
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

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest());

    expect(capturedUrl).toBe("https://api.x.ai/v1/tts");
    expect(capturedHeaders!.get("Authorization")).toBe(
      "Bearer test-xai-api-key",
    );
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Hello world");
    expect(body.voice_id).toBe("eve");
    expect(body.language).toBe("auto");
    expect(body.output_format).toEqual({
      codec: "mp3",
      sample_rate: 24000,
      bit_rate: 128000,
    });
  });

  test("request voiceId overrides config voiceId", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest({ voiceId: "rex" }));

    const body = JSON.parse(capturedBody);
    expect(body.voice_id).toBe("rex");
  });

  test("uses configured voiceId when request has none", async () => {
    mockXaiConfig.voiceId = "ara";
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.voice_id).toBe("ara");
  });

  test("wav config format produces codec=wav without bit_rate", async () => {
    mockXaiConfig.format = "wav";
    const audioPayload = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    const result = await provider.synthesize(makeRequest());

    const body = JSON.parse(capturedBody);
    expect(body.output_format).toEqual({
      codec: "wav",
      sample_rate: 24000,
    });
    expect(body.output_format.bit_rate).toBeUndefined();
    expect(result.contentType).toBe("audio/wav");
  });

  test("outputFormat=pcm uses codec=pcm and 16 kHz sample rate", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    const result = await provider.synthesize(
      makeRequest({ outputFormat: "pcm" }),
    );

    const body = JSON.parse(capturedBody);
    expect(body.output_format).toEqual({
      codec: "pcm",
      sample_rate: 16000,
    });
    expect(body.output_format.bit_rate).toBeUndefined();
    expect(result.contentType).toBe("audio/pcm");
  });

  test("pcm sampleRateHz hint is sent when xAI supports the rate", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();
    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 22_050 }),
    );

    const body = JSON.parse(capturedBody);
    expect(body.output_format).toEqual({
      codec: "pcm",
      sample_rate: 22050,
    });
  });

  test("unsupported pcm sampleRateHz hints clamp to the nearest xAI rate", async () => {
    const audioPayload = new Uint8Array([0x00, 0x01, 0x02]);
    let capturedBody = "";

    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(audioPayload, { status: 200 });
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createXaiProvider();

    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 11_025 }),
    );
    expect(JSON.parse(capturedBody).output_format.sample_rate).toBe(8000);

    await provider.synthesize(
      makeRequest({ outputFormat: "pcm", sampleRateHz: 96_000 }),
    );
    expect(JSON.parse(capturedBody).output_format.sample_rate).toBe(48000);
  });

  test("resolveOutputSampleRateHz reports the clamped pcm rate and is undefined otherwise", () => {
    const provider = createXaiProvider();

    expect(
      provider.resolveOutputSampleRateHz!(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 96_000 }),
      ),
    ).toBe(48000);
    expect(
      provider.resolveOutputSampleRateHz!(makeRequest({ outputFormat: "pcm" })),
    ).toBe(16000);
    expect(provider.resolveOutputSampleRateHz!(makeRequest())).toBeUndefined();
  });

  // -- Content type / format -----------------------------------------------

  test("returns audio/mpeg content type for mp3 format", async () => {
    const audioPayload = new Uint8Array([0x49, 0x44, 0x33]);
    mockFetchReturning(audioPayload);

    const provider = createXaiProvider();
    const result = await provider.synthesize(makeRequest());

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  // -- Required config validation ------------------------------------------

  test("throws XAI_TTS_NO_API_KEY when API key is missing", async () => {
    mockXaiApiKey = null;

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_NO_API_KEY");
      expect((err as XaiTtsError).message).toContain("API key not configured");
    }
  });

  // -- Error handling ------------------------------------------------------

  test("throws XAI_TTS_HTTP_ERROR on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_HTTP_ERROR");
      expect((err as XaiTtsError).statusCode).toBe(401);
      expect((err as XaiTtsError).message).toContain("Unauthorized");
    }
  });

  test("throws XAI_TTS_EMPTY_RESPONSE on empty audio body", async () => {
    mockFetchReturning(new Uint8Array(0));

    const provider = createXaiProvider();

    try {
      await provider.synthesize(makeRequest());
      throw new Error("Expected synthesize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiTtsError);
      expect((err as XaiTtsError).code).toBe("XAI_TTS_EMPTY_RESPONSE");
    }
  });
});

// ===========================================================================
// Static catalog wiring
// ===========================================================================
// Catalog completeness (one definition per canonical ID) is enforced at
// compile time by the `satisfies` check in provider-catalog.ts; these are
// runtime smoke checks over the assembled definitions.

describe("static provider catalog wiring", () => {
  test("every catalog provider resolves to an adapter with a matching ID", () => {
    for (const id of listCatalogProviderIds()) {
      const provider = getTtsProvider(id);
      expect(provider.id).toBe(id);
      expect(typeof provider.synthesize).toBe("function");
    }
  });

  test("streaming capability in the catalog matches the adapter", () => {
    for (const id of listCatalogProviderIds()) {
      const definition = getProviderDefinition(id);
      if (definition.capabilities.supportsStreaming) {
        expect(typeof definition.adapter.synthesizeStream).toBe("function");
      }
    }
  });
});
