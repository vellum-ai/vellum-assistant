import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

interface MockPlatformClient {
  platformAssistantId: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

let mockClient: MockPlatformClient | null = null;

mock.module("./client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  createManagedSpeechClient,
  MAX_STT_AUDIO_BYTES,
  MAX_TTS_TEXT_CHARS,
} from "./managed-speech.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("managed-speech", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockClient = {
      platformAssistantId: "asst-123",
      fetch: (path, init) => globalThis.fetch(path, init),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockClient = null;
  });

  describe("createManagedSpeechClient()", () => {
    test("returns null when the platform client is unavailable", async () => {
      mockClient = null;
      expect(await createManagedSpeechClient()).toBeNull();
    });

    test("returns null when the assistant ID is missing", async () => {
      mockClient = {
        platformAssistantId: "",
        fetch: (path, init) => globalThis.fetch(path, init),
      };
      expect(await createManagedSpeechClient()).toBeNull();
    });

    test("returns a client when prerequisites are met", async () => {
      expect(await createManagedSpeechClient()).not.toBeNull();
    });
  });

  describe("transcribe()", () => {
    test("posts the correct URL, method, and JSON body with base64 round-trip", async () => {
      const audio = new Uint8Array([1, 2, 3, 250, 251, 252]);
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock(
        async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedInit = init;
          return new Response(
            JSON.stringify({
              text: "hello world",
              providerId: "deepgram",
              model: "nova-2",
              durationSeconds: 1.23,
            }),
            { status: 200 },
          );
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio,
        mimeType: "audio/webm",
        source: "voice-note",
      });

      expect(capturedUrl).toBe(
        "/v1/assistants/asst-123/managed-speech/stt/transcribe/",
      );
      expect(capturedInit?.method).toBe("POST");

      const body = JSON.parse(capturedInit!.body as string);
      expect(body.mimeType).toBe("audio/webm");
      expect(body.source).toBe("voice-note");
      expect(new Uint8Array(Buffer.from(body.audioBase64, "base64"))).toEqual(
        audio,
      );

      expect(result).toEqual({
        ok: true,
        value: {
          text: "hello world",
          providerId: "deepgram",
          model: "nova-2",
          durationSeconds: 1.23,
        },
      });
    });

    test("omits source when not provided", async () => {
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          capturedInit = init;
          return new Response(
            JSON.stringify({
              text: "",
              providerId: "deepgram",
              model: "nova-2",
              durationSeconds: 0,
            }),
            { status: 200 },
          );
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect("source" in JSON.parse(capturedInit!.body as string)).toBe(false);
    });

    test("rejects oversized audio locally without calling fetch", async () => {
      const fetchSpy = mock(async () => new Response("unreachable"));
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array(MAX_STT_AUDIO_BYTES + 1),
        mimeType: "audio/webm",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_request");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("maps a 400 error envelope to invalid_request", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ code: "invalid_request", detail: "bad mime" }),
            { status: 400 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "invalid_request", detail: "bad mime", status: 400 },
      });
    });

    test("maps a 402 insufficient_balance error envelope", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              code: "insufficient_balance",
              detail: "top up required",
            }),
            { status: 402 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "insufficient_balance",
          detail: "top up required",
          status: 402,
        },
      });
    });

    test("maps a 402 missing_price error envelope", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ code: "missing_price", detail: "no price set" }),
            { status: 402 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "missing_price", detail: "no price set", status: 402 },
      });
    });

    test("maps a 429 rate_limited error envelope", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ code: "rate_limited", detail: "slow down" }),
            { status: 429 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "rate_limited", detail: "slow down", status: 429 },
      });
    });

    test("maps a 502 upstream_error error envelope", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              code: "upstream_error",
              detail: "provider down",
            }),
            { status: 502 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "upstream_error", detail: "provider down", status: 502 },
      });
    });

    test("maps a non-JSON error body to a synthetic upstream_error", async () => {
      globalThis.fetch = mock(
        async () => new Response("<html>Bad Gateway</html>", { status: 504 }),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("upstream_error");
        expect(result.error.status).toBe(504);
      }
    });

    test("passes through an unknown error code without breaking", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              code: "some_future_code",
              detail: "not yet documented",
            }),
            { status: 400 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "some_future_code",
          detail: "not yet documented",
          status: 400,
        },
      });
    });

    test("forwards the caller's abort signal to fetch", async () => {
      let seenSignal: AbortSignal | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(
          JSON.stringify({
            text: "hi",
            providerId: "deepgram",
            model: "m",
            durationSeconds: 1,
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch;

      const controller = new AbortController();
      const client = await createManagedSpeechClient();
      await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
        signal: controller.signal,
      });

      expect(seenSignal).toBe(controller.signal);
    });

    test("maps an aborted request to a typed error instead of throwing", async () => {
      globalThis.fetch = mock(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }) as unknown as typeof globalThis.fetch;

      const controller = new AbortController();
      controller.abort();
      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
        signal: controller.signal,
      });

      expect(result.ok).toBe(false);
    });

    test("maps a 200 whose body read fails to a typed error instead of throwing", async () => {
      const res = new Response("{}", { status: 200 });
      res.json = async () => {
        throw new Error("terminated mid-stream");
      };
      globalThis.fetch = mock(
        async () => res,
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("upstream_error");
        expect(result.error.status).toBe(200);
      }
    });

    test("maps a network error (fetch rejects) to a typed error instead of throwing", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("upstream_error");
        expect(result.error.detail).toContain("network down");
      }
    });
  });

  describe("synthesize()", () => {
    test("posts the correct URL and JSON body with format sent explicitly", async () => {
      const audioBytes = new Uint8Array([10, 20, 30]);
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock(
        async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedInit = init;
          return new Response(audioBytes, {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.synthesize({
        text: "hello",
        format: "mp3",
      });

      expect(capturedUrl).toBe(
        "/v1/assistants/asst-123/managed-speech/tts/synthesize/",
      );
      expect(JSON.parse(capturedInit!.body as string)).toEqual({
        text: "hello",
        format: "mp3",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.contentType).toBe("audio/mpeg");
        expect(new Uint8Array(result.value.audio)).toEqual(audioBytes);
      }
    });

    test("supports wav_8000 and pcm_16000 formats", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          expect(JSON.parse(init!.body as string).format).toBe("pcm_16000");
          return new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      await client!.synthesize({ text: "hello", format: "pcm_16000" });
    });

    test("counts the text cap in code points so non-BMP text is not over-rejected", async () => {
      const fetchMock = mock(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      // 2000 code points but 4000 UTF-16 code units — valid server-side.
      const result = await client!.synthesize({
        text: "😀".repeat(MAX_TTS_TEXT_CHARS),
        format: "mp3",
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("rejects text over the character cap locally without calling fetch", async () => {
      const fetchSpy = mock(async () => new Response("unreachable"));
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.synthesize({
        text: "x".repeat(MAX_TTS_TEXT_CHARS + 1),
        format: "mp3",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_request");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("maps error envelopes the same way as transcribe", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              code: "provider_configuration_error",
              detail: "no provider configured",
            }),
            { status: 500 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.synthesize({ text: "hello", format: "mp3" });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "provider_configuration_error",
          detail: "no provider configured",
          status: 500,
        },
      });
    });

    test("forwards the caller's abort signal to fetch", async () => {
      let seenSignal: AbortSignal | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }) as unknown as typeof globalThis.fetch;

      const controller = new AbortController();
      const client = await createManagedSpeechClient();
      await client!.synthesize({
        text: "hello",
        format: "mp3",
        signal: controller.signal,
      });

      expect(seenSignal).toBe(controller.signal);
    });

    test("maps a 200 whose body read fails to a typed error instead of throwing", async () => {
      const res = new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
      res.arrayBuffer = async () => {
        throw new Error("proxy reset after headers");
      };
      globalThis.fetch = mock(
        async () => res,
      ) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.synthesize({ text: "hello", format: "mp3" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("upstream_error");
        expect(result.error.status).toBe(200);
      }
    });

    test("maps a network error (fetch rejects) to a typed error instead of throwing", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("connection reset");
      }) as unknown as typeof globalThis.fetch;

      const client = await createManagedSpeechClient();
      const result = await client!.synthesize({ text: "hello", format: "mp3" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("upstream_error");
      }
    });
  });
});
