import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isLikelyWhisperHallucination,
  OpenAIWhisperProvider,
  whisperTranscribe,
} from "./openai-whisper.js";

const TEST_API_KEY = "sk-test-key-for-unit-tests";

describe("OpenAIWhisperProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful transcription returns text", async () => {
    globalThis.fetch = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response(JSON.stringify({ text: "  Hello, world!  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("fake-audio"),
      "audio/ogg",
    );

    expect(result).toEqual({ text: "Hello, world!" });
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

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("Whisper API error (401)");
  });

  test("sends correct FormData structure (model=whisper-1, file blob with correct MIME)", async () => {
    let capturedBody: FormData | undefined;
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as FormData;
      capturedHeaders = init?.headers;
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");

      return new Response(JSON.stringify({ text: "transcribed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
    await provider.transcribe(Buffer.from("fake-audio"), "audio/mpeg");

    // Verify authorization header
    expect(capturedHeaders).toEqual({
      Authorization: `Bearer ${TEST_API_KEY}`,
    });

    // Verify FormData contents
    expect(capturedBody).toBeInstanceOf(FormData);
    const model = capturedBody!.get("model");
    expect(model).toBe("whisper-1");

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

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
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

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
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

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);

    try {
      await provider.transcribe(Buffer.from("audio"), "audio/wav");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Whisper API error (500)");
      // The body portion should be at most 300 chars
      const bodyPart = msg.replace("Whisper API error (500): ", "");
      expect(bodyPart.length).toBeLessThanOrEqual(300);
    }
  });

  test("sends hallucination-mitigation params (language, temperature, prompt) by default", async () => {
    let capturedBody: FormData | undefined;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: "real speech" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    expect(capturedBody?.get("language")).toBe("en");
    expect(capturedBody?.get("temperature")).toBe("0");
    expect(typeof capturedBody?.get("prompt")).toBe("string");
    expect((capturedBody?.get("prompt") as string).length).toBeGreaterThan(0);
  });

  test("filters known Whisper hallucinations on isolated short transcripts", async () => {
    for (const phrase of [
      "Thank you.",
      "thanks for watching",
      "Goodbye!",
      "Bye-bye",
      "Please subscribe",
    ]) {
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ text: phrase }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const provider = new OpenAIWhisperProvider(TEST_API_KEY);
      const result = await provider.transcribe(
        Buffer.from("silence"),
        "audio/wav",
      );

      expect(result.text).toBe("");
    }
  });

  test("preserves longer transcripts that happen to contain a flagged phrase", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          text: "Thank you, but I actually wanted to ask about the weather.",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIWhisperProvider(TEST_API_KEY);
    const result = await provider.transcribe(
      Buffer.from("real audio"),
      "audio/wav",
    );

    expect(result.text).toContain("weather");
  });

  test("hallucination filter can be disabled per call", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ text: "Thank you." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await whisperTranscribe(
      TEST_API_KEY,
      Buffer.from("audio"),
      "audio/wav",
      undefined,
      { filterHallucinations: false },
    );

    expect(result).toBe("Thank you.");
  });

  test("isLikelyWhisperHallucination heuristic", () => {
    expect(isLikelyWhisperHallucination("Thank you.")).toBe(true);
    expect(isLikelyWhisperHallucination("THANKS FOR WATCHING!")).toBe(true);
    expect(isLikelyWhisperHallucination("Goodbye.")).toBe(true);
    expect(isLikelyWhisperHallucination("bye")).toBe(true);
    expect(isLikelyWhisperHallucination("you")).toBe(true);
    expect(isLikelyWhisperHallucination("")).toBe(false);
    expect(isLikelyWhisperHallucination("Hello, how are you today?")).toBe(
      false,
    );
    expect(
      isLikelyWhisperHallucination(
        "Thanks for watching, but actually I have a question.",
      ),
    ).toBe(false);
  });
});
