import { beforeEach, describe, expect, mock, test } from "bun:test";

import { SttError } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must precede dynamic imports
// ---------------------------------------------------------------------------

let mockTranscribeResult: { text: string } = { text: "" };
let mockTranscribeError: Error | null = null;

mock.module("../../providers/speech-to-text/openai-whisper.js", () => ({
  OpenAIWhisperProvider: class MockWhisperProvider {
    constructor(_apiKey: string) {}
    async transcribe(_audio: Buffer, _mimeType: string, _signal?: AbortSignal) {
      if (mockTranscribeError) throw mockTranscribeError;
      return mockTranscribeResult;
    }
  },
}));

// Dynamic import so mocks are active when the module loads.
const { createDaemonBatchTranscriber } =
  await import("../daemon-batch-transcriber.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDaemonBatchTranscriber", () => {
  beforeEach(() => {
    mockTranscribeResult = { text: "" };
    mockTranscribeError = null;
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
  // Provider identity
  // -------------------------------------------------------------------------

  test("reports providerId as openai-whisper", () => {
    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    expect(transcriber!.providerId).toBe("openai-whisper");
  });

  test("reports boundaryId as daemon-batch", () => {
    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Successful transcription
  // -------------------------------------------------------------------------

  test("delegates transcription to the underlying provider", async () => {
    mockTranscribeResult = { text: "Hello from Whisper" };

    const transcriber = createDaemonBatchTranscriber("sk-test-key");
    const result = await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello from Whisper" });
  });

  // -------------------------------------------------------------------------
  // Normalized error mapping
  // -------------------------------------------------------------------------

  test("normalizes AbortError to timeout category", async () => {
    mockTranscribeError = new DOMException(
      "The operation was aborted",
      "AbortError",
    );

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("timeout");
    }
  });

  test("normalizes 401 errors to auth category", async () => {
    mockTranscribeError = new Error("Whisper API error (401): Unauthorized");

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("auth");
    }
  });

  test("normalizes 403 errors to auth category", async () => {
    mockTranscribeError = new Error("Whisper API error (403): Forbidden");

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("auth");
    }
  });

  test("normalizes 429 errors to rate-limit category", async () => {
    mockTranscribeError = new Error(
      "Whisper API error (429): Too Many Requests",
    );

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("rate-limit");
    }
  });

  test("normalizes rate limit text to rate-limit category", async () => {
    mockTranscribeError = new Error("Request rate-limited by provider");

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("rate-limit");
    }
  });

  test("normalizes 400 audio errors to invalid-audio category", async () => {
    mockTranscribeError = new Error(
      "Whisper API error (400): Invalid audio format",
    );

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("invalid-audio");
    }
  });

  test("normalizes unknown errors to provider-error category", async () => {
    mockTranscribeError = new Error("Something went wrong");

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).category).toBe("provider-error");
    }
  });

  test("passes through SttError instances without re-wrapping", async () => {
    const original = new SttError("auth", "Custom auth failure");
    mockTranscribeError = original;

    const transcriber = createDaemonBatchTranscriber("sk-test-key");

    try {
      await transcriber!.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/wav",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
      expect((err as SttError).category).toBe("auth");
      expect((err as SttError).message).toBe("Custom auth failure");
    }
  });
});
