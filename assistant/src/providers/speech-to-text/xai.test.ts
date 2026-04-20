import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { XAIProvider } from "./xai.js";

const TEST_API_KEY = "xai-test-key-for-unit-tests";

describe("XAIProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful transcription returns trimmed text", async () => {
    globalThis.fetch = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response(JSON.stringify({ text: "  hello  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new XAIProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("fake-audio"),
      "audio/ogg",
    );

    expect(result).toEqual({ text: "hello" });
  });

  test("API error throws with status and partial body", async () => {
    const errorBody = JSON.stringify({
      error: {
        message: "Invalid API key provided",
        type: "invalid_request_error",
      },
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

    const provider = new XAIProvider(TEST_API_KEY);

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("xAI STT error (401)");
  });

  test("sends correct FormData structure (no model field, file blob with correct MIME)", async () => {
    let capturedBody: FormData | undefined;
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as FormData;
      capturedHeaders = init?.headers;
      expect(url).toBe("https://api.x.ai/v1/stt");
      expect(init?.method).toBe("POST");

      return new Response(JSON.stringify({ text: "transcribed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new XAIProvider(TEST_API_KEY);
    await provider.transcribe(Buffer.from("fake-audio"), "audio/mpeg");

    // Verify authorization header
    expect(capturedHeaders).toEqual({
      Authorization: `Bearer ${TEST_API_KEY}`,
    });

    // Verify FormData contents
    expect(capturedBody).toBeInstanceOf(FormData);

    // xAI does not use a `model` field.
    expect(capturedBody!.get("model")).toBeNull();

    const file = capturedBody!.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("audio/mpeg");
  });

  test("returns empty text when API returns empty text field", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new XAIProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("silence"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  test("returns empty text when API response has no text property", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new XAIProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("silence"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  test("error body is truncated to 300 characters", async () => {
    const longBody = "x".repeat(500);

    globalThis.fetch = (async () => {
      return new Response(longBody, { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new XAIProvider(TEST_API_KEY);

    try {
      await provider.transcribe(Buffer.from("audio"), "audio/wav");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("xAI STT error (500)");
      // The body portion should be at most 300 chars
      const bodyPart = msg.replace("xAI STT error (500): ", "");
      expect(bodyPart.length).toBeLessThanOrEqual(300);
    }
  });
});
