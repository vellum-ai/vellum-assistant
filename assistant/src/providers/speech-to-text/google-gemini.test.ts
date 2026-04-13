import { describe, expect, mock, test } from "bun:test";

import { GoogleGeminiProvider } from "./google-gemini.js";

const TEST_API_KEY = "google-test-key-for-unit-tests";

// ---------------------------------------------------------------------------
// Mock setup — replace @google/genai's GoogleGenAI before each test
// ---------------------------------------------------------------------------

/**
 * Build a mock GoogleGenAI constructor whose `models.generateContent`
 * resolves to the given value or rejects with the given error.
 */
function mockGenAI(
  behaviour: { response: { text?: string } } | { error: Error },
) {
  const generateContent = mock(() => {
    if ("error" in behaviour) {
      return Promise.reject(behaviour.error);
    }
    return Promise.resolve(behaviour.response);
  });

  const Constructor = mock((_opts: unknown) => ({
    models: { generateContent },
  }));

  return { Constructor, generateContent };
}

// We need to intercept the GoogleGenAI constructor at the module level.
// Since the provider uses `new GoogleGenAI(...)`, we mock the module.
let mockGenerateContent: ReturnType<typeof mock>;

/**
 * Helper: create a provider that uses a stubbed GoogleGenAI client.
 * We replace the private `client` field after construction.
 */
function createProviderWithMock(
  behaviour: { response: { text?: string } } | { error: Error },
  options?: { model?: string; baseUrl?: string },
): GoogleGeminiProvider {
  const provider = new GoogleGeminiProvider(TEST_API_KEY, options);

  const mocked = mockGenAI(behaviour);
  mockGenerateContent = mocked.generateContent;

  // Replace the internal client with our mock
  (provider as unknown as { client: unknown }).client = {
    models: { generateContent: mocked.generateContent },
  };

  return provider;
}

describe("GoogleGeminiProvider", () => {
  // -----------------------------------------------------------------------
  // Success path
  // -----------------------------------------------------------------------

  test("successful transcription returns trimmed text", async () => {
    const provider = createProviderWithMock({
      response: { text: "  Hello from Gemini!  " },
    });

    const result = await provider.transcribe(
      Buffer.from("fake-audio"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "Hello from Gemini!" });
  });

  test("passes audio as base64 inlineData with correct mimeType", async () => {
    const provider = createProviderWithMock({
      response: { text: "transcribed" },
    });

    const audioData = Buffer.from("test-audio-bytes");
    await provider.transcribe(audioData, "audio/ogg");

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const call = (mockGenerateContent as ReturnType<typeof mock>).mock
      .calls[0][0] as {
      contents: Array<{
        parts: Array<{ inlineData?: { mimeType: string; data: string } }>;
      }>;
    };

    const inlineData = call.contents[0].parts[0].inlineData;
    expect(inlineData?.mimeType).toBe("audio/ogg");
    expect(inlineData?.data).toBe(audioData.toString("base64"));
  });

  test("uses default model gemini-2.0-flash", async () => {
    const provider = createProviderWithMock({
      response: { text: "text" },
    });

    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    const call = (mockGenerateContent as ReturnType<typeof mock>).mock
      .calls[0][0] as { model: string };
    expect(call.model).toBe("gemini-2.0-flash");
  });

  test("uses custom model when specified", async () => {
    const provider = createProviderWithMock(
      { response: { text: "text" } },
      { model: "gemini-2.0-pro" },
    );

    await provider.transcribe(Buffer.from("audio"), "audio/wav");

    const call = (mockGenerateContent as ReturnType<typeof mock>).mock
      .calls[0][0] as { model: string };
    expect(call.model).toBe("gemini-2.0-pro");
  });

  // -----------------------------------------------------------------------
  // Empty transcript fallback
  // -----------------------------------------------------------------------

  test("returns empty text when response text is empty string", async () => {
    const provider = createProviderWithMock({
      response: { text: "" },
    });

    const result = await provider.transcribe(
      Buffer.from("silence"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  test("returns empty text when response text is undefined", async () => {
    const provider = createProviderWithMock({
      response: { text: undefined },
    });

    const result = await provider.transcribe(
      Buffer.from("silence"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  test("API error with status code includes status in message", async () => {
    const apiError = Object.assign(new Error("Invalid API key"), {
      status: 401,
    });

    const provider = createProviderWithMock({ error: apiError });

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("Google Gemini API error (401)");
  });

  test("API error with 429 status propagates for rate-limit detection", async () => {
    const apiError = Object.assign(new Error("Resource exhausted"), {
      status: 429,
    });

    const provider = createProviderWithMock({ error: apiError });

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("Google Gemini API error (429)");
  });

  test("API error without status code still throws descriptive error", async () => {
    const networkError = new Error("Network connection failed");

    const provider = createProviderWithMock({ error: networkError });

    await expect(
      provider.transcribe(Buffer.from("fake-audio"), "audio/wav"),
    ).rejects.toThrow("Google Gemini API error: Network connection failed");
  });

  test("AbortError is re-thrown as-is (not wrapped)", async () => {
    const abortError = new DOMException(
      "The operation was aborted",
      "AbortError",
    );

    const provider = createProviderWithMock({ error: abortError });

    try {
      await provider.transcribe(Buffer.from("audio"), "audio/wav");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
      expect(err).toBe(abortError);
    }
  });

  test("error message body is truncated to 300 characters", async () => {
    const longMessage = "x".repeat(500);
    const apiError = Object.assign(new Error(longMessage), {
      status: 500,
    });

    const provider = createProviderWithMock({ error: apiError });

    try {
      await provider.transcribe(Buffer.from("audio"), "audio/wav");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Google Gemini API error (500)");
      // The body portion should be at most 300 chars
      const bodyPart = msg.replace("Google Gemini API error (500): ", "");
      expect(bodyPart.length).toBeLessThanOrEqual(300);
    }
  });
});
