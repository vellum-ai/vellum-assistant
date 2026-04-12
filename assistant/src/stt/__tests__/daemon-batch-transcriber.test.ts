import { beforeEach, describe, expect, mock, test } from "bun:test";

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
      if (mockWhisperTranscribeError) throw mockWhisperTranscribeError;
      return mockWhisperTranscribeResult;
    }
  },
}));

let mockDeepgramTranscribeResult: { text: string } = { text: "" };
let mockDeepgramTranscribeError: Error | null = null;

mock.module("../../providers/speech-to-text/deepgram.js", () => ({
  DeepgramProvider: class MockDeepgramProvider {
    constructor(_apiKey: string) {}
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockDeepgramTranscribeError) throw mockDeepgramTranscribeError;
      return mockDeepgramTranscribeResult;
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
  });

  // -------------------------------------------------------------------------
  // Credential resolution
  // -------------------------------------------------------------------------

  test("returns null when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null)).toBeNull();
    expect(createDaemonBatchTranscriber(undefined)).toBeNull();
  });

  test("returns a BatchTranscriber when API key is present", () => {
    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    expect(transcriber).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Provider identity — Whisper (default)
  // -------------------------------------------------------------------------

  test("reports providerId as openai-whisper by default", () => {
    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    expect(transcriber!.providerId).toBe("openai-whisper");
  });

  test("reports boundaryId as daemon-batch", () => {
    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription — Whisper
  // -------------------------------------------------------------------------

  test("delegates transcription to the Whisper provider", async () => {
    mockWhisperTranscribeResult = { text: "Hello from Whisper" };

    const transcriber = createDaemonBatchTranscriber("sk-test-key");
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

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

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

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

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
  // Null on missing key — Deepgram
  // -------------------------------------------------------------------------

  test("returns null for deepgram when no API key is provided", () => {
    expect(createDaemonBatchTranscriber(null, "deepgram")).toBeNull();
    expect(createDaemonBatchTranscriber(undefined, "deepgram")).toBeNull();
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
