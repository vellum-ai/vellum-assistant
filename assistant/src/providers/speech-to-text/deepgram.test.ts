import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DeepgramProvider } from "./deepgram.js";

const TEST_API_KEY = "dg-test-key-for-unit-tests";

/** Helper: build a Deepgram-shaped JSON response body. */
function deepgramResponse(transcript: string): string {
  return JSON.stringify({
    results: {
      channels: [{ alternatives: [{ transcript }] }],
    },
  });
}

describe("DeepgramProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Success path
  // -----------------------------------------------------------------------

  test("successful transcription returns trimmed text", async () => {
    globalThis.fetch = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response(deepgramResponse("  Hello from Deepgram!  "), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("fake-audio"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "Hello from Deepgram!" });
  });

  // -----------------------------------------------------------------------
  // Empty transcript
  // -----------------------------------------------------------------------

  test("returns empty text when transcript is empty string", async () => {
    globalThis.fetch = (async () => {
      return new Response(deepgramResponse(""), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("silence"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  // -----------------------------------------------------------------------
  // Malformed response fallback
  // -----------------------------------------------------------------------

  test("returns empty text when response has no results property", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(result).toEqual({ text: "" });
  });

  test("returns empty text when channels array is empty", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ results: { channels: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(result).toEqual({ text: "" });
  });

  test("returns empty text when alternatives array is empty", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [] }] } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(result).toEqual({ text: "" });
  });

  test("returns empty text when transcript field is missing", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ confidence: 0.95 }] }] },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    const result = await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(result).toEqual({ text: "" });
  });

  // -----------------------------------------------------------------------
  // Non-2xx error propagation
  // -----------------------------------------------------------------------

  test("API error throws with status and partial body", async () => {
    const errorBody = JSON.stringify({
      err_code: "INVALID_AUTH",
      err_msg: "Invalid credentials",
    });

    globalThis.fetch = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response(errorBody, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("Deepgram API error (401)");
  });

  test("error body is truncated to 300 characters", async () => {
    const longBody = "x".repeat(500);

    globalThis.fetch = (async () => {
      return new Response(longBody, { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);

    try {
      await provider.transcribe(Buffer.from("audio"), "audio/wav");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Deepgram API error (500)");
      // The body portion should be at most 300 chars
      const bodyPart = msg.replace("Deepgram API error (500): ", "");
      expect(bodyPart.length).toBeLessThanOrEqual(300);
    }
  });

  // -----------------------------------------------------------------------
  // Request URL / query construction
  // -----------------------------------------------------------------------

  test("sends correct URL with default query params (model, smart_format)", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedContentType: string | undefined;

    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      capturedHeaders = headers;
      capturedContentType = headers?.["Content-Type"];

      return new Response(deepgramResponse("ok"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY);
    await provider.transcribe(Buffer.from("fake-audio"), "audio/ogg");

    // URL shape
    expect(capturedUrl).toContain("https://api.deepgram.com/v1/listen");
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.has("language")).toBe(false);

    // Auth header uses Token scheme
    expect(capturedHeaders?.Authorization).toBe(`Token ${TEST_API_KEY}`);

    // Content-Type matches the input MIME
    expect(capturedContentType).toBe("audio/ogg");
  });

  test("includes language param when specified", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(deepgramResponse("hola"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY, { language: "es" });
    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("language")).toBe("es");
  });

  test("uses custom model when specified", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(deepgramResponse("text"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY, {
      model: "nova-2-medical",
    });
    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("model")).toBe("nova-2-medical");
  });

  test("omits smart_format when smartFormatting is false", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(deepgramResponse("text"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY, {
      smartFormatting: false,
    });
    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    const url = new URL(capturedUrl!);
    expect(url.searchParams.has("smart_format")).toBe(false);
  });

  test("uses custom base URL when specified", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(deepgramResponse("text"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DeepgramProvider(TEST_API_KEY, {
      baseUrl: "https://custom-deepgram.example.com/",
    });
    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(capturedUrl).toContain(
      "https://custom-deepgram.example.com/v1/listen",
    );
  });

  test("sends raw audio bytes as request body (not FormData)", async () => {
    let capturedBody: BodyInit | undefined;

    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as BodyInit;
      return new Response(deepgramResponse("text"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const audioData = Buffer.from("raw-audio-bytes");
    const provider = new DeepgramProvider(TEST_API_KEY);
    await provider.transcribe(audioData, "audio/wav");

    // Deepgram accepts raw bytes — verify we're not wrapping in FormData
    expect(capturedBody).toBeInstanceOf(Buffer);
    expect(Buffer.compare(capturedBody as Buffer, audioData)).toBe(0);
  });
});
