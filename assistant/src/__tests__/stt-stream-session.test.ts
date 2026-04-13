/**
 * Integration tests for the STT stream session orchestrator.
 *
 * Validates:
 * - End-to-end session lifecycle with mock deepgram and google-gemini
 *   streaming adapters.
 * - Normalized event flow: ready -> partial -> final -> closed.
 * - Per-session ordering guarantees (monotonic `seq` field).
 * - Graceful handling of unsupported providers (e.g. openai-whisper).
 * - Session teardown on client disconnect.
 * - Idle timeout behavior.
 * - Binary audio frame handling.
 */

import { describe, expect, test } from "bun:test";

import {
  SttStreamSession,
  type SttStreamSocket,
} from "../stt/stt-stream-session.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockSocket implements SttStreamSocket {
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  /** Parse all sent frames as JSON. */
  get frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Mock streaming transcribers
// ---------------------------------------------------------------------------

/**
 * Mock Deepgram-like transcriber that emits partial + final events
 * when audio is sent and stop is called.
 */
class MockDeepgramTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  audioChunks: Buffer[] = [];
  stopped = false;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    this.audioChunks.push(audio);
    // Simulate partial transcript on each audio chunk.
    this.onEvent?.({
      type: "partial",
      text: `partial-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.stopped = true;
    // Simulate final transcript and close.
    this.onEvent?.({ type: "final", text: "final transcript" });
    this.onEvent?.({ type: "closed" });
  }
}

/**
 * Mock Google Gemini-like transcriber that polls on audio arrival
 * and emits a final on stop.
 */
class MockGoogleTranscriber implements StreamingTranscriber {
  readonly providerId = "google-gemini" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  audioChunks: Buffer[] = [];
  stopped = false;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, _mimeType: string): void {
    this.audioChunks.push(audio);
    // Simulate incremental-batch partial.
    this.onEvent?.({
      type: "partial",
      text: `transcribing-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.stopped = true;
    this.onEvent?.({ type: "final", text: "complete transcription" });
    this.onEvent?.({ type: "closed" });
  }
}

/**
 * Mock transcriber that throws on start() to test error handling.
 */
class FailingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;

  async start(_onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    throw new Error("Mock provider connection refused");
  }

  sendAudio(_audio: Buffer, _mimeType: string): void {
    throw new Error("Should not be called");
  }

  stop(): void {
    throw new Error("Should not be called");
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSession(
  provider: string,
  options?: { idleTimeoutMs?: number },
): { ws: MockSocket; session: SttStreamSession } {
  const ws = new MockSocket();
  const session = new SttStreamSession(ws, provider, "audio/webm", options);
  return { ws, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SttStreamSession", () => {
  // ── Deepgram end-to-end flow ──────────────────────────────────────

  describe("deepgram provider flow", () => {
    test("emits ready, partial, final, closed events with ordering", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      // Should have sent a ready event.
      expect(ws.frames.length).toBeGreaterThanOrEqual(1);
      const readyFrame = ws.frames[0];
      expect(readyFrame.type).toBe("ready");
      expect(readyFrame.provider).toBe("deepgram");

      // Send audio via JSON text frame.
      const audioB64 = Buffer.from("test-audio-1").toString("base64");
      session.handleMessage(JSON.stringify({ type: "audio", audio: audioB64 }));

      // Should have emitted a partial.
      const afterAudio1 = ws.frames;
      expect(afterAudio1.some((f) => f.type === "partial")).toBe(true);

      // Send more audio.
      session.handleMessage(
        JSON.stringify({
          type: "audio",
          audio: Buffer.from("test-audio-2").toString("base64"),
        }),
      );

      // Send stop.
      session.handleMessage(JSON.stringify({ type: "stop" }));

      // Should have emitted final and closed.
      const allFrames = ws.frames;
      expect(allFrames.some((f) => f.type === "final")).toBe(true);
      expect(allFrames.some((f) => f.type === "closed")).toBe(true);

      // Verify monotonic sequence numbers.
      const seqs = allFrames
        .filter((f) => typeof f.seq === "number")
        .map((f) => f.seq as number);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }

      // Verify transcriber received audio.
      expect(transcriber.audioChunks.length).toBe(2);
      expect(transcriber.stopped).toBe(true);

      // Session should be closed.
      expect(session.isClosed).toBe(true);
    });

    test("handles binary audio frames", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      // Send binary audio.
      const audioData = Buffer.from("raw-pcm-audio");
      session.handleBinaryAudio(audioData);

      expect(transcriber.audioChunks.length).toBe(1);
      expect(transcriber.audioChunks[0]).toEqual(audioData);

      // Partial should have been emitted.
      const partialFrames = ws.frames.filter((f) => f.type === "partial");
      expect(partialFrames.length).toBe(1);
    });
  });

  // ── Google Gemini end-to-end flow ─────────────────────────────────

  describe("google-gemini provider flow", () => {
    test("emits ready, partial, final, closed events", async () => {
      const { ws, session } = createSession("google-gemini");
      const transcriber = new MockGoogleTranscriber();

      await session.start(async () => transcriber);

      // Should have sent a ready event.
      const readyFrame = ws.frames[0];
      expect(readyFrame.type).toBe("ready");
      expect(readyFrame.provider).toBe("google-gemini");

      // Send audio.
      session.handleMessage(
        JSON.stringify({
          type: "audio",
          audio: Buffer.from("audio-chunk-1").toString("base64"),
        }),
      );

      // Stop.
      session.handleMessage(JSON.stringify({ type: "stop" }));

      // Verify event flow.
      const allFrames = ws.frames;
      const types = allFrames.map((f) => f.type);
      expect(types).toContain("ready");
      expect(types).toContain("partial");
      expect(types).toContain("final");
      expect(types).toContain("closed");

      // Final text should match mock.
      const finalFrame = allFrames.find((f) => f.type === "final");
      expect(finalFrame?.text).toBe("complete transcription");

      expect(session.isClosed).toBe(true);
    });
  });

  // ── Unsupported provider (openai-whisper) ─────────────────────────

  describe("unsupported provider fallback", () => {
    test("openai-whisper emits error + closed without crashing", async () => {
      const { ws, session } = createSession("openai-whisper");

      // Resolve returns null for openai-whisper (no streaming support).
      await session.start(async () => null);

      const frames = ws.frames;
      expect(frames.length).toBe(2);
      expect(frames[0].type).toBe("error");
      expect(frames[0].category).toBe("provider-error");
      expect((frames[0].message as string).includes("not supported")).toBe(
        true,
      );
      expect(frames[1].type).toBe("closed");

      // Session should be fully closed.
      expect(session.isClosed).toBe(true);

      // Socket should be closed cleanly.
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(1000);
    });

    test("unknown provider emits error + closed without crashing", async () => {
      const { ws, session } = createSession("nonexistent-provider");

      await session.start(async () => null);

      const frames = ws.frames;
      expect(frames[0].type).toBe("error");
      expect(frames[0].category).toBe("provider-error");
      expect(frames[1].type).toBe("closed");
      expect(session.isClosed).toBe(true);
    });
  });

  // ── Provider start failure ────────────────────────────────────────

  describe("provider start failure", () => {
    test("emits error + closed when transcriber.start() throws", async () => {
      const { ws, session } = createSession("deepgram");

      await session.start(async () => new FailingTranscriber());

      const frames = ws.frames;
      expect(frames[0].type).toBe("error");
      expect(frames[0].category).toBe("provider-error");
      expect(
        (frames[0].message as string).includes(
          "Mock provider connection refused",
        ),
      ).toBe(true);
      expect(frames[1].type).toBe("closed");
      expect(session.isClosed).toBe(true);
      expect(ws.closed).toBe(true);
    });
  });

  // ── Client disconnect ─────────────────────────────────────────────

  describe("client disconnect", () => {
    test("tears down session on WebSocket close", async () => {
      const { session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);
      expect(session.isClosed).toBe(false);

      // Simulate WebSocket close.
      session.handleClose(1001, "going away");

      expect(session.isClosed).toBe(true);
      // Transcriber should have been stopped.
      expect(transcriber.stopped).toBe(true);
    });

    test("destroy() is idempotent", async () => {
      const { session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      session.destroy();
      expect(session.isClosed).toBe(true);

      // Calling again should not throw.
      session.destroy();
      expect(session.isClosed).toBe(true);
    });
  });

  // ── Idle timeout ──────────────────────────────────────────────────

  describe("idle timeout", () => {
    test("fires timeout error after inactivity", async () => {
      const { ws, session } = createSession("deepgram", {
        idleTimeoutMs: 50,
      });
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      // Wait for idle timeout to fire.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const frames = ws.frames;
      const errorFrame = frames.find(
        (f) => f.type === "error" && f.category === "timeout",
      );
      expect(errorFrame).toBeDefined();
      expect(session.isClosed).toBe(true);
    });

    test("activity resets idle timer", async () => {
      const { session } = createSession("deepgram", {
        idleTimeoutMs: 100,
      });
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      // Send audio at 50ms, resetting the idle timer.
      await new Promise((resolve) => setTimeout(resolve, 50));
      session.handleMessage(
        JSON.stringify({
          type: "audio",
          audio: Buffer.from("keep-alive").toString("base64"),
        }),
      );

      // At 100ms from start, original timer would have fired but was reset.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(session.isClosed).toBe(false);

      // Now wait for the reset timer to fire.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(session.isClosed).toBe(true);
    });
  });

  // ── Event ordering guarantees ─────────────────────────────────────

  describe("event ordering", () => {
    test("all emitted events have monotonically increasing seq numbers", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      // Send several audio frames.
      for (let i = 0; i < 5; i++) {
        session.handleMessage(
          JSON.stringify({
            type: "audio",
            audio: Buffer.from(`chunk-${i}`).toString("base64"),
          }),
        );
      }

      // Stop.
      session.handleMessage(JSON.stringify({ type: "stop" }));

      const allFrames = ws.frames;
      const seqs = allFrames
        .filter((f) => typeof f.seq === "number")
        .map((f) => f.seq as number);

      // Verify strict monotonic ordering.
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      // First seq should be 0.
      expect(seqs[0]).toBe(0);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("audio events in non-active state are dropped", async () => {
      const { ws, session } = createSession("deepgram");

      // Session is in "initializing" state — audio should be dropped.
      session.handleMessage(
        JSON.stringify({
          type: "audio",
          audio: Buffer.from("too-early").toString("base64"),
        }),
      );

      // No events should be sent (session hasn't started).
      expect(ws.frames.length).toBe(0);
    });

    test("stop in non-active state is dropped", async () => {
      const { ws, session } = createSession("deepgram");

      // Session is in "initializing" state — stop should be dropped.
      session.handleMessage(JSON.stringify({ type: "stop" }));
      expect(ws.frames.length).toBe(0);
    });

    test("non-JSON text frames are silently dropped", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      const frameCountBefore = ws.frames.length;
      session.handleMessage("this is not json");
      // No new events should be emitted.
      expect(ws.frames.length).toBe(frameCountBefore);
    });

    test("unknown event types are silently dropped", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);

      const frameCountBefore = ws.frames.length;
      session.handleMessage(JSON.stringify({ type: "unknown-event" }));
      expect(ws.frames.length).toBe(frameCountBefore);
    });

    test("messages after close are dropped", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);
      session.handleClose(1000, "normal");
      expect(session.isClosed).toBe(true);

      const frameCountAfterClose = ws.frames.length;
      session.handleMessage(
        JSON.stringify({
          type: "audio",
          audio: Buffer.from("after-close").toString("base64"),
        }),
      );
      expect(ws.frames.length).toBe(frameCountAfterClose);
    });

    test("handleClose is idempotent", async () => {
      const { ws, session } = createSession("deepgram");
      const transcriber = new MockDeepgramTranscriber();

      await session.start(async () => transcriber);
      session.handleClose(1001, "first close");
      expect(session.isClosed).toBe(true);

      // Calling again should not throw or emit additional events.
      const frameCountAfter = ws.frames.length;
      session.handleClose(1001, "second close");
      expect(ws.frames.length).toBe(frameCountAfter);
    });
  });
});
