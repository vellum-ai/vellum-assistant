import { beforeEach, describe, expect, mock, test } from "bun:test";

import { batchBoundaryGapReason } from "../../providers/speech-to-text/provider-catalog.js";
import { SttError } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must precede dynamic imports
// ---------------------------------------------------------------------------

let mockWhisperTranscribeResult: { text: string } = { text: "" };
let mockWhisperTranscribeError: Error | null = null;

mock.module("../../providers/speech-to-text/openai-whisper.js", () => ({
  OpenAIWhisperProvider: class MockWhisperProvider {
    constructor(_apiKey: string) {}
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockWhisperTranscribeError) {
        throw mockWhisperTranscribeError;
      }
      return mockWhisperTranscribeResult;
    }
  },
}));

let mockDeepgramTranscribeResult: { text: string } = { text: "" };
let mockDeepgramTranscribeError: Error | null = null;

/**
 * Captured DeepgramProvider constructor calls so tests can assert which
 * options (language, model) the batch adapter forwards.
 */
const deepgramProviderCtorCalls: Array<{ apiKey: string; options: unknown }> =
  [];

// Real module captured before the mock replaces it, so pure exports
// (deepgramLanguageOptions) stay real while the provider class
// alone is stubbed.
const actualDeepgram =
  await import("../../providers/speech-to-text/deepgram.js");

mock.module("../../providers/speech-to-text/deepgram.js", () => ({
  ...actualDeepgram,
  DeepgramProvider: class MockDeepgramProvider {
    constructor(apiKey: string, options?: unknown) {
      deepgramProviderCtorCalls.push({ apiKey, options });
    }
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockDeepgramTranscribeError) {
        throw mockDeepgramTranscribeError;
      }
      return mockDeepgramTranscribeResult;
    }
  },
}));

let mockGeminiTranscribeResult: { text: string } = { text: "" };
let mockGeminiTranscribeError: Error | null = null;

mock.module("../../providers/speech-to-text/google-gemini.js", () => ({
  GoogleGeminiProvider: class MockGoogleGeminiProvider {
    constructor(_apiKey: string) {}
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockGeminiTranscribeError) {
        throw mockGeminiTranscribeError;
      }
      return mockGeminiTranscribeResult;
    }
  },
}));

let mockXAITranscribeResult: { text: string } = { text: "" };
let mockXAITranscribeError: Error | null = null;

/**
 * Captured XAIProvider constructor calls so tests can assert which options
 * (language) the batch adapter forwards.
 */
const xaiProviderCtorCalls: Array<{ apiKey: string; options: unknown }> = [];

// Real module captured before the mock replaces it, so pure exports
// (xaiLanguageOptions) stay real while the provider class alone is stubbed.
const actualXai = await import("../../providers/speech-to-text/xai.js");

mock.module("../../providers/speech-to-text/xai.js", () => ({
  ...actualXai,
  XAIProvider: class MockXAIProvider {
    constructor(apiKey: string, options?: unknown) {
      xaiProviderCtorCalls.push({ apiKey, options });
    }
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockXAITranscribeError) {
        throw mockXAITranscribeError;
      }
      return mockXAITranscribeResult;
    }
  },
}));

// Dynamic import so mocks are active when the module loads.
const { createDaemonBatchTranscriber, normalizeSttError } =
  await import("../daemon-batch-transcriber.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDaemonBatchTranscriber", () => {
  beforeEach(() => {
    mockWhisperTranscribeResult = { text: "" };
    mockWhisperTranscribeError = null;
    mockDeepgramTranscribeResult = { text: "" };
    mockDeepgramTranscribeError = null;
    deepgramProviderCtorCalls.length = 0;
    mockGeminiTranscribeResult = { text: "" };
    mockGeminiTranscribeError = null;
    mockXAITranscribeResult = { text: "" };
    mockXAITranscribeError = null;
    xaiProviderCtorCalls.length = 0;
  });

  // -------------------------------------------------------------------------
  // Credential resolution
  // -------------------------------------------------------------------------

  test("returns null when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null, "openai-whisper")).toBeNull();
    expect(
      createDaemonBatchTranscriber(undefined, "openai-whisper"),
    ).toBeNull();
  });

  test("returns a BatchTranscriber when API key is present", () => {
    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );
    expect(transcriber).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Provider identity — Whisper
  // -------------------------------------------------------------------------

  test("reports providerId as openai-whisper when created with openai-whisper", () => {
    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );
    expect(transcriber!.providerId).toBe("openai-whisper");
  });

  test("reports boundaryId as daemon-batch", () => {
    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription — Whisper
  // -------------------------------------------------------------------------

  test("delegates transcription to the Whisper provider", async () => {
    mockWhisperTranscribeResult = { text: "Hello from Whisper" };

    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );
    const result = await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello from Whisper" });
  });

  // -------------------------------------------------------------------------
  // Error propagation — raw provider errors pass through unchanged so that
  // legacy callers (e.g. transcribe-audio.ts) can still detect AbortError.
  // -------------------------------------------------------------------------

  test("propagates AbortError unchanged", async () => {
    const original = new DOMException(
      "The operation was aborted",
      "AbortError",
    );
    mockWhisperTranscribeError = original;

    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
      expect((err as Error).name).toBe("AbortError");
    }
  });

  test("propagates generic errors unchanged", async () => {
    const original = new Error("Something went wrong");
    mockWhisperTranscribeError = original;

    const transcriber = createDaemonBatchTranscriber(
      "sk-test-key",
      "openai-whisper",
    );

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });

  // -------------------------------------------------------------------------
  // Provider identity — Deepgram
  // -------------------------------------------------------------------------

  test("reports providerId as deepgram when created with deepgram", () => {
    const transcriber = createDaemonBatchTranscriber("dg-test-key", "deepgram");
    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("deepgram");
  });

  test("reports boundaryId as daemon-batch for deepgram", () => {
    const transcriber = createDaemonBatchTranscriber("dg-test-key", "deepgram");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription — Deepgram
  // -------------------------------------------------------------------------

  test("delegates transcription to the Deepgram provider", async () => {
    mockDeepgramTranscribeResult = { text: "Hello from Deepgram" };

    const transcriber = createDaemonBatchTranscriber("dg-test-key", "deepgram");
    const result = await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello from Deepgram" });
  });

  // -------------------------------------------------------------------------
  // Error propagation — Deepgram
  // -------------------------------------------------------------------------

  test("propagates Deepgram errors unchanged", async () => {
    const original = new Error("Deepgram API error (401): Invalid credentials");
    mockDeepgramTranscribeError = original;

    const transcriber = createDaemonBatchTranscriber("dg-test-key", "deepgram");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });

  // -------------------------------------------------------------------------
  // Language forwarding - Deepgram
  // -------------------------------------------------------------------------

  test("forwards the configured language to the Deepgram provider", async () => {
    const transcriber = createDaemonBatchTranscriber(
      "dg-test-key",
      "deepgram",
      "hi",
    );
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramProviderCtorCalls).toHaveLength(1);
    expect(deepgramProviderCtorCalls[0]?.options).toMatchObject({
      language: "hi",
      // Any configured language pins nova-3, the model the roster is
      // verified for; the provider default (nova-2) covers only a subset.
      model: "nova-3",
    });
  });

  test("pins nova-3 on the Deepgram provider when language is 'multi'", async () => {
    // multi is a nova-3-only code-switching feature; the provider's default
    // model (nova-2) rejects it.
    const transcriber = createDaemonBatchTranscriber(
      "dg-test-key",
      "deepgram",
      "multi",
    );
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramProviderCtorCalls).toHaveLength(1);
    expect(deepgramProviderCtorCalls[0]?.options).toMatchObject({
      language: "multi",
      model: "nova-3",
    });
  });

  test("passes neither language nor model to Deepgram when no language is configured", async () => {
    const transcriber = createDaemonBatchTranscriber("dg-test-key", "deepgram");
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramProviderCtorCalls).toHaveLength(1);
    expect(deepgramProviderCtorCalls[0]?.options).not.toHaveProperty(
      "language",
    );
    expect(deepgramProviderCtorCalls[0]?.options).not.toHaveProperty("model");
  });

  // -------------------------------------------------------------------------
  // Null on missing key — Deepgram
  // -------------------------------------------------------------------------

  test("returns null for deepgram when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null, "deepgram")).toBeNull();
    expect(createDaemonBatchTranscriber(undefined, "deepgram")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Provider identity — Google Gemini
  // -------------------------------------------------------------------------

  test("reports providerId as google-gemini when created with google-gemini", () => {
    const transcriber = createDaemonBatchTranscriber(
      "gemini-test-key",
      "google-gemini",
    );
    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("google-gemini");
  });

  test("reports boundaryId as daemon-batch for google-gemini", () => {
    const transcriber = createDaemonBatchTranscriber(
      "gemini-test-key",
      "google-gemini",
    );
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription — Google Gemini
  // -------------------------------------------------------------------------

  test("delegates transcription to the Google Gemini provider", async () => {
    mockGeminiTranscribeResult = { text: "Hello from Gemini" };

    const transcriber = createDaemonBatchTranscriber(
      "gemini-test-key",
      "google-gemini",
    );
    const result = await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello from Gemini" });
  });

  // -------------------------------------------------------------------------
  // Error propagation — Google Gemini
  // -------------------------------------------------------------------------

  test("propagates Google Gemini errors unchanged", async () => {
    const original = new Error(
      "Google Gemini API error (401): Invalid credentials",
    );
    mockGeminiTranscribeError = original;

    const transcriber = createDaemonBatchTranscriber(
      "gemini-test-key",
      "google-gemini",
    );

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });

  // -------------------------------------------------------------------------
  // Null on missing key — Google Gemini
  // -------------------------------------------------------------------------

  test("returns null for google-gemini when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null, "google-gemini")).toBeNull();
    expect(createDaemonBatchTranscriber(undefined, "google-gemini")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Provider identity — xAI
  // -------------------------------------------------------------------------

  test("reports providerId as xai when created with xai", () => {
    const transcriber = createDaemonBatchTranscriber("xai-test-key", "xai");
    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("xai");
  });

  test("reports boundaryId as daemon-batch for xai", () => {
    const transcriber = createDaemonBatchTranscriber("xai-test-key", "xai");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription — xAI
  // -------------------------------------------------------------------------

  test("delegates transcription to the xAI provider", async () => {
    mockXAITranscribeResult = { text: "Hello from xAI" };

    const transcriber = createDaemonBatchTranscriber("xai-test-key", "xai");
    const result = await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello from xAI" });
  });

  // -------------------------------------------------------------------------
  // Error propagation — xAI
  // -------------------------------------------------------------------------

  test("propagates xAI errors unchanged", async () => {
    const original = new Error("xAI API error (401): Invalid credentials");
    mockXAITranscribeError = original;

    const transcriber = createDaemonBatchTranscriber("xai-test-key", "xai");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });

  // -------------------------------------------------------------------------
  // Language forwarding - xAI
  // -------------------------------------------------------------------------

  test("forwards the configured language to the xAI provider", async () => {
    const transcriber = createDaemonBatchTranscriber(
      "xai-test-key",
      "xai",
      "hi",
    );
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(xaiProviderCtorCalls).toHaveLength(1);
    expect(xaiProviderCtorCalls[0]?.options).toMatchObject({ language: "hi" });
  });

  test("never passes 'multi' to the xAI provider (a Deepgram-specific value, not a language code)", async () => {
    const transcriber = createDaemonBatchTranscriber(
      "xai-test-key",
      "xai",
      "multi",
    );
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(xaiProviderCtorCalls).toHaveLength(1);
    expect(xaiProviderCtorCalls[0]?.options).not.toHaveProperty("language");
  });

  test("passes no language to the xAI provider when none is configured", async () => {
    const transcriber = createDaemonBatchTranscriber("xai-test-key", "xai");
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(xaiProviderCtorCalls).toHaveLength(1);
    expect(xaiProviderCtorCalls[0]?.options).not.toHaveProperty("language");
  });

  // -------------------------------------------------------------------------
  // Null on missing key — xAI
  // -------------------------------------------------------------------------

  test("returns null for xai when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null, "xai")).toBeNull();
    expect(createDaemonBatchTranscriber(undefined, "xai")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeSttError — callers use this explicitly when they need categories
// ---------------------------------------------------------------------------

describe("normalizeSttError", () => {
  test("normalizes AbortError to timeout category", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const result = normalizeSttError(err);
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("timeout");
  });

  test("normalizes 401 errors to auth category", () => {
    const result = normalizeSttError(
      new Error("Whisper API error (401): Unauthorized"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("auth");
  });

  test("normalizes 403 errors to auth category", () => {
    const result = normalizeSttError(
      new Error("Whisper API error (403): Forbidden"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("auth");
  });

  test("normalizes 429 errors to rate-limit category", () => {
    const result = normalizeSttError(
      new Error("Whisper API error (429): Too Many Requests"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("rate-limit");
  });

  test("normalizes rate limit text to rate-limit category", () => {
    const result = normalizeSttError(
      new Error("Request rate-limited by provider"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("rate-limit");
  });

  test("normalizes 400 audio errors to invalid-audio category", () => {
    const result = normalizeSttError(
      new Error("Whisper API error (400): Invalid audio format"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("invalid-audio");
  });

  test("normalizes unknown errors to provider-error category", () => {
    const result = normalizeSttError(new Error("Something went wrong"));
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("provider-error");
  });

  test("passes through SttError instances without re-wrapping", () => {
    const original = new SttError("auth", "Custom auth failure");
    const result = normalizeSttError(original);
    expect(result).toBe(original);
    expect(result.category).toBe("auth");
  });

  // Deepgram error normalization (same categories apply)

  test("normalizes Deepgram 401 errors to auth category", () => {
    const result = normalizeSttError(
      new Error("Deepgram API error (401): Invalid credentials"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("auth");
  });

  test("normalizes Deepgram 429 errors to rate-limit category", () => {
    const result = normalizeSttError(
      new Error("Deepgram API error (429): Rate limited"),
    );
    expect(result).toBeInstanceOf(SttError);
    expect(result.category).toBe("rate-limit");
  });
});

describe("vellum factory case", () => {
  test("constructs the managed transcriber with no API key", () => {
    const transcriber = createDaemonBatchTranscriber(null, "vellum");
    expect(transcriber?.providerId).toBe("vellum");
    expect(transcriber?.boundaryId).toBe("daemon-batch");
  });

  test("still returns null for key-based providers without a key", () => {
    expect(createDaemonBatchTranscriber(null, "deepgram")).toBeNull();
  });
});

describe("deepgram-flux factory case", () => {
  // The copy itself is pinned in provider-catalog.test.ts; what matters here
  // is that the factory speaks with the catalog's voice rather than its own.
  test("throws the catalog's streaming-only reason", () => {
    expect(() =>
      createDaemonBatchTranscriber("dg-test-key", "deepgram-flux"),
    ).toThrow(batchBoundaryGapReason("deepgram-flux"));
  });

  test("marks the error user-facing so friendly copy does not overwrite it", () => {
    try {
      createDaemonBatchTranscriber("dg-test-key", "deepgram-flux");
      throw new Error("expected the factory to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("provider-error");
      expect((err as SttError).userFacing).toBe(true);
    }
  });
});
