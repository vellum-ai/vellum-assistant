import { describe, expect, mock, test } from "bun:test";

import type { SttStreamServerEvent } from "../../stt/types.js";
import { GoogleGeminiStreamingTranscriber } from "./google-gemini-stream.js";

const TEST_API_KEY = "google-test-key-for-streaming-tests";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock GoogleGenAI client whose `models.generateContent` returns
 * sequential responses on each call, or rejects with an error.
 */
function mockGenAIClient(
  responses: Array<{ text?: string } | { error: Error }>,
) {
  let callIndex = 0;

  const generateContent = mock(() => {
    const entry = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    if ("error" in entry) {
      return Promise.reject(entry.error);
    }
    return Promise.resolve(entry);
  });

  return { generateContent, client: { models: { generateContent } } };
}

/**
 * Create a transcriber with an injected mock client and a very short
 * poll interval for fast test execution.
 */
function createTranscriberWithMock(
  responses: Array<{ text?: string } | { error: Error }>,
  options?: { pollIntervalMs?: number },
): {
  transcriber: GoogleGeminiStreamingTranscriber;
  generateContent: ReturnType<typeof mock>;
} {
  const { client, generateContent } = mockGenAIClient(responses);
  const transcriber = new GoogleGeminiStreamingTranscriber(TEST_API_KEY, {
    pollIntervalMs: options?.pollIntervalMs ?? 10,
  });

  // Replace the internal client with our mock
  (transcriber as unknown as { client: unknown }).client = client;

  return { transcriber, generateContent };
}

/**
 * Collect all events emitted by a transcriber into an array.
 */
function collectEvents(
  transcriber: GoogleGeminiStreamingTranscriber,
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

describe("GoogleGeminiStreamingTranscriber", () => {
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
      const { transcriber, generateContent } = createTranscriberWithMock([
        { text: "final" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.stop();

      await waitFor(() => events.some((e) => e.type === "closed"));

      // Sending audio after stop should not throw or trigger new requests.
      transcriber.sendAudio(Buffer.from("late-audio"), "audio/webm");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only one generateContent call for the final (from stop's emitFinal).
      // The late audio should not have triggered an additional call.
      // Actually no audio was sent before stop, so the final emits from
      // lastEmittedText (empty) without a batch call.
      expect(generateContent).not.toHaveBeenCalled();
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

    test("suppresses meta-response text and only emits real transcript partials", async () => {
      const { transcriber } = createTranscriberWithMock([
        { text: "The user did not provide an audio file for transcription." },
        { text: "hello there" },
        { text: "hello there friend" },
      ]);
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");
      await new Promise((resolve) => setTimeout(resolve, 40));

      transcriber.sendAudio(Buffer.from("chunk-2"), "audio/webm");
      await waitFor(() => events.some((e) => e.type === "partial"));

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      const partials = events.filter((e) => e.type === "partial");
      const texts = partials.map((e) => (e.type === "partial" ? e.text : ""));

      expect(texts).not.toContain(
        "The user did not provide an audio file for transcription.",
      );
      expect(texts).toContain("hello there");
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
    test("waits one poll interval before first incremental request", async () => {
      const { transcriber, generateContent } = createTranscriberWithMock(
        [{ text: "hello" }, { text: "hello" }],
        { pollIntervalMs: 100 },
      );
      const events = collectEvents(transcriber);

      transcriber.sendAudio(Buffer.from("chunk-1"), "audio/webm");

      // Should not poll immediately on first chunk.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(generateContent).toHaveBeenCalledTimes(0);

      await waitFor(() => events.some((e) => e.type === "partial"));
      expect(generateContent).toHaveBeenCalledTimes(1);

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));
    });

    test("does not send more than one batch request per poll interval", async () => {
      const { transcriber, generateContent } = createTranscriberWithMock(
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
      const callsAfterFirstPoll = (generateContent as ReturnType<typeof mock>)
        .mock.calls.length;

      // Only 1 batch request should have fired despite 3 audio chunks.
      expect(callsAfterFirstPoll).toBe(1);

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));
    });
  });

  // -----------------------------------------------------------------------
  // PCM handling
  // -----------------------------------------------------------------------

  describe("pcm handling", () => {
    test("wraps audio/pcm input as audio/wav before Gemini requests", async () => {
      const { transcriber, generateContent } = createTranscriberWithMock(
        [{ text: "hello" }, { text: "hello" }],
        { pollIntervalMs: 10 },
      );
      const events = collectEvents(transcriber);
      const pcmChunk = Buffer.from("pcm-audio-chunk");

      transcriber.sendAudio(pcmChunk, "audio/pcm");
      await waitFor(
        () =>
          (generateContent as ReturnType<typeof mock>).mock.calls.length > 0,
      );

      transcriber.stop();
      await waitFor(() => events.some((e) => e.type === "closed"));

      expect(generateContent).toHaveBeenCalled();

      const firstCall = (generateContent as ReturnType<typeof mock>).mock
        .calls[0][0] as {
        contents: Array<{
          parts: Array<{ inlineData?: { mimeType: string; data: string } }>;
        }>;
      };

      const inlineData = firstCall.contents[0].parts[0].inlineData;
      expect(inlineData?.mimeType).toBe("audio/wav");
      expect(inlineData?.data).not.toBe(pcmChunk.toString("base64"));
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
    test("providerId is google-gemini", () => {
      const { transcriber } = createTranscriberWithMock([{ text: "" }]);
      expect(transcriber.providerId).toBe("google-gemini");
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
});
