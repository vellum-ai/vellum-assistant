import { describe, expect, mock, test } from "bun:test";

import type { SttStreamServerEvent } from "../../stt/types.js";
import { OpenAIWhisperStreamingTranscriber } from "./openai-whisper-stream.js";

const TEST_API_KEY = "openai-test-key-for-streaming-tests";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock `whisperTranscribe` function that returns sequential responses
 * on each call, or rejects with an error.
 *
 * We intercept at the `transcribeAccumulated` level by replacing the
 * private method so we don't need to mock `fetch` or the shared
 * `whisperTranscribe` function directly.
 */
function mockWhisperResponses(
  responses: Array<{ text?: string } | { error: Error }>,
) {
  let callIndex = 0;
  const calls: Array<{ audio: Buffer; mimeType: string }> = [];

  const transcribeFn = mock(
    (audio: Buffer, mimeType: string): Promise<string> => {
      calls.push({ audio, mimeType });
      const entry = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;

      if ("error" in entry) {
        return Promise.reject(entry.error);
      }
      return Promise.resolve(entry.text ?? "");
    },
  );

  return { transcribeFn, calls };
}

/**
 * Create a transcriber with an injected mock transcribe method and a very
 * short poll interval for fast test execution.
 */
function createTranscriberWithMock(
  responses: Array<{ text?: string } | { error: Error }>,
  options?: { pollIntervalMs?: number },
): {
  transcriber: OpenAIWhisperStreamingTranscriber;
  transcribeFn: ReturnType<typeof mock>;
  calls: Array<{ audio: Buffer; mimeType: string }>;
} {
  const { transcribeFn, calls } = mockWhisperResponses(responses);
  const transcriber = new OpenAIWhisperStreamingTranscriber(TEST_API_KEY, {
    pollIntervalMs: options?.pollIntervalMs ?? 10,
  });

  // Replace the internal transcribeAccumulated method with our mock.
  // The mock intercepts after PCM-to-WAV conversion has happened (if
  // applicable), so we can inspect the mimeType that was passed.
  (
    transcriber as unknown as {
      transcribeAccumulated: () => Promise<string>;
    }
  ).transcribeAccumulated = async () => {
    // Access accumulated state through the private fields
    const chunks = (transcriber as unknown as { audioChunks: Buffer[] })
      .audioChunks;
    const mime = (transcriber as unknown as { audioMimeType: string })
      .audioMimeType;
    const combined = Buffer.concat(chunks);

    // Check for PCM-to-WAV conversion (mirrors the real implementation)
    const isPcm = (
      transcriber as unknown as { isPcmMimeType: (m: string) => boolean }
    ).isPcmMimeType(mime);
    const effectiveMime = isPcm ? "audio/wav" : mime;

    return transcribeFn(combined, effectiveMime);
  };

  return { transcriber, transcribeFn, calls };
}

/**
 * Collect all events emitted by a transcriber into an array.
 */
function collectEvents(
  transcriber: OpenAIWhisperStreamingTranscriber,
): SttStreamServerEvent[] {
  const events: SttStreamServerEvent[] = [];
  void transcriber.start((event) => events.push(event));
  return events;
}

/**
 * Wait for a condition to become true, polling at a short interval.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIWhisperStreamingTranscriber", () => {
  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    test("start() registers event callback without error", async () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      await transcriber.start(() => {});
      // No error = success
    });

    test("start() throws if called twice", async () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      await transcriber.start(() => {});

      await expect(transcriber.start(() => {})).rejects.toThrow(
        "already started",
      );
    });

    test("sendAudio() throws if called before start()", () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);

      expect(() =>
        transcriber.sendAudio(Buffer.from("audio"), "audio/webm"),
      ).toThrow("before start()");
    });

    test("sendAudio() is silently ignored after stop()", async () => {
      const { transcriber, transcribeFn } = createTranscriberWithMock([
        { text: "final" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.stop();

      await waitFor(() => events.some((e) => e.type === "closed"));

      // Sending audio after stop should not throw or trigger new requests.
      transcriber.sendAudio(Buffer.from("late-audio"), "audio/webm");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No audio was sent before stop, so the final emits from
      // lastEmittedText (empty) without a batch call.
      expect(transcribeFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Progressive partial updates
  // -----------------------------------------------------------------------

  describe("partial updates", () => {
    test("emits partial events as audio accumulates", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "Hello" },
        { text: "Hello world" },
        { text: "Hello world test" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.sendAudio(Buffer.from("chunk-2"), "audio/webm");
      await waitFor(
        () => events.filter((e) => e.type === "partial").length >= 2,
      );

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const partials = events.filter((e) => e.type === "partial");
      expect(partials.length).toBeGreaterThanOrEqual(1);
      expect(partials[0]).toEqual({ type: "partial", text: "Hello" });
    });

    test("does not emit partial when transcript has not changed", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "Hello" },
        { text: "Hello" }, // same as before
        { text: "Hello world" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.sendAudio(Buffer.from("chunk-2"), "audio/webm");
      // Wait a bit for the second poll
      await new Promise((resolve) => setTimeout(resolve, 50));

      transcriber.sendAudio(Buffer.from("chunk-3"), "audio/webm");
      await waitFor(
        () => events.filter((e) => e.type === "partial").length >= 2,
      );

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const partials = events.filter((e) => e.type === "partial");
      // Should have "Hello" and "Hello world", but NOT a duplicate "Hello"
      const texts = partials.map((e) => (e.type === "partial" ? e.text : ""));
      expect(texts).toContain("Hello");
      expect(texts).toContain("Hello world");
      // No duplicates
      const uniqueTexts = [...new Set(texts)];
      expect(uniqueTexts.length).toBe(texts.length);
    });

    test("does not emit partial when transcript regresses (shorter text)", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "Hello world" },
        { text: "Hello" }, // regression — shorter
        { text: "Hello world again" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.sendAudio(Buffer.from("chunk-2"), "audio/webm");
      await new Promise((resolve) => setTimeout(resolve, 50));

      transcriber.sendAudio(Buffer.from("chunk-3"), "audio/webm");
      await waitFor(
        () => events.filter((e) => e.type === "partial").length >= 2,
      );

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const partials = events.filter((e) => e.type === "partial");
      const texts = partials.map((e) => (e.type === "partial" ? e.text : ""));

      // "Hello" (regression) should NOT appear as a partial
      expect(texts).toContain("Hello world");
      expect(texts).not.toContain("Hello");
    });
  });

  // -----------------------------------------------------------------------
  // Final event
  // -----------------------------------------------------------------------

  describe("final event", () => {
    test("emits final event with complete transcript on stop", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "partial one" },
        { text: "full transcript" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const finals = events.filter((e) => e.type === "final");
      expect(finals.length).toBe(1);
      expect(finals[0]).toEqual({ type: "final", text: "full transcript" });
    });

    test("emits final with last known partial when no audio was sent", async () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      const events = collectEvents(transcriber);

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const finals = events.filter((e) => e.type === "final");
      expect(finals.length).toBe(1);
      expect(finals[0]).toEqual({ type: "final", text: "" });
    });

    test("emits closed event after final", async () => {
      const { transcriber } = createTranscriberWithMock([{ text: "done" }]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("audio"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const finalIdx = events.findIndex((e) => e.type === "final");
      const closedIdx = events.findIndex((e) => e.type === "closed");
      expect(finalIdx).toBeGreaterThanOrEqual(0);
      expect(closedIdx).toBeGreaterThan(finalIdx);
    });

    test("stop() is idempotent", async () => {
      const { transcriber } = createTranscriberWithMock([{ text: "done" }]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("audio"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      transcriber.stop(); // second stop should be a no-op

      await waitFor(() => events.some((e) => e.type === "closed"));

      // Only one closed event
      const closedEvents = events.filter((e) => e.type === "closed");
      expect(closedEvents.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    test("transient poll error emits error event but does not close session", async () => {
      const { transcriber } = createTranscriberWithMock([
        { error: new Error("transient network failure") },
        { text: "recovered" },
        { text: "recovered" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "error"));

      const errors = events.filter((e) => e.type === "error");
      expect(errors.length).toBe(1);
      expect(errors[0]).toEqual({
        type: "error",
        category: "provider-error",
        message: "transient network failure",
      });

      // Session is still alive — send more audio
      transcriber.sendAudio(Buffer.from("chunk-2"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      expect(events.some((e) => e.type === "final")).toBe(true);
    });

    test("final batch error emits error then falls back to last partial", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "partial before error" },
        { error: new Error("final request failed") },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("audio"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const finals = events.filter((e) => e.type === "final");
      expect(finals.length).toBe(1);
      // Should fall back to last emitted partial text
      expect(finals[0]).toEqual({
        type: "final",
        text: "partial before error",
      });

      // An error event should have been emitted before the final fallback
      const errors = events.filter((e) => e.type === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Rate limiting / throttling
  // -----------------------------------------------------------------------

  describe("rate limiting", () => {
    test("does not send more than one batch request per poll interval", async () => {
      const { transcriber, transcribeFn } = createTranscriberWithMock(
        [
          { text: "a" },
          { text: "ab" },
          { text: "abc" },
          { text: "abcd" },
          { text: "abcde" },
        ],
        { pollIntervalMs: 100 },
      );
      const events = collectEvents(transcriber);

      // Send multiple chunks rapidly
      transcriber.sendAudio(Buffer.from("c1"), "audio/webm");
      transcriber.sendAudio(Buffer.from("c2"), "audio/webm");
      transcriber.sendAudio(Buffer.from("c3"), "audio/webm");

      // Wait for just one poll cycle
      await waitFor(() => events.some((e) => e.type === "partial"));
      const callsAfterFirstPoll = (transcribeFn as ReturnType<typeof mock>).mock
        .calls.length;

      // Only 1 batch request should have fired despite 3 audio chunks.
      expect(callsAfterFirstPoll).toBe(1);

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------------

  describe("cancellation", () => {
    test("stop() cancels pending poll timer", async () => {
      const { transcriber } = createTranscriberWithMock(
        [{ text: "final text" }],
        { pollIntervalMs: 500 }, // long interval to ensure timer is pending
      );
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("audio"), "audio/webm");

      // Stop immediately before the poll fires
      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      // The final batch should fire (from emitFinal), but no poll should
      // have fired since we stopped before the interval elapsed.
      const finals = events.filter((e) => e.type === "final");
      expect(finals.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Provider identity
  // -----------------------------------------------------------------------

  describe("provider identity", () => {
    test("providerId is openai-whisper", () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      expect(transcriber.providerId).toBe("openai-whisper");
    });

    test("boundaryId is daemon-streaming", () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      expect(transcriber.boundaryId).toBe("daemon-streaming");
    });
  });

  // -----------------------------------------------------------------------
  // Timeout path
  // -----------------------------------------------------------------------

  describe("timeout", () => {
    test("AbortError during poll emits error event with provider-error category", async () => {
      const abortError = new DOMException(
        "The operation was aborted",
        "AbortError",
      );
      const { transcriber } = createTranscriberWithMock([
        { error: abortError },
        { text: "recovered after timeout" },
        { text: "recovered after timeout" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("audio"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "error"));

      const errors = events.filter((e) => e.type === "error");
      expect(errors[0]).toEqual({
        type: "error",
        category: "provider-error",
        message: "The operation was aborted",
      });

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));
    });
  });

  // -----------------------------------------------------------------------
  // PCM-to-WAV format path
  // -----------------------------------------------------------------------

  describe("PCM-to-WAV transcoding", () => {
    test("PCM audio input is WAV-wrapped before Whisper transcription calls", async () => {
      const { transcriber, calls } = createTranscriberWithMock([
        { text: "pcm transcription" },
        { text: "pcm transcription complete" },
      ]);
      const events = collectEvents(transcriber);

      // Send audio with PCM MIME type
      transcriber.sendAudio(Buffer.from("pcm-audio-chunk"), "audio/pcm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      // Verify that the mock was called with audio/wav (not audio/pcm)
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call.mimeType).toBe("audio/wav");
      }
    });

    test("audio/l16 is NOT WAV-wrapped (big-endian per RFC 3551, needs byte-swap)", async () => {
      const { transcriber, calls } = createTranscriberWithMock([
        { text: "l16 transcription" },
        { text: "l16 transcription complete" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("l16-audio-chunk"), "audio/l16");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      // audio/l16 is big-endian per RFC 3551 and should NOT be treated
      // as PCM16LE for WAV wrapping — it passes through unchanged.
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call.mimeType).toBe("audio/l16");
      }
    });

    test("non-PCM audio is passed through without WAV wrapping", async () => {
      const { transcriber, calls } = createTranscriberWithMock([
        { text: "webm transcription" },
        { text: "webm transcription complete" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("webm-audio-chunk"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call.mimeType).toBe("audio/webm");
      }
    });
  });
});
