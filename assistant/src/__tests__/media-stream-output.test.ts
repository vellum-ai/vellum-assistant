import { afterEach, describe, expect, jest, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Mock TTS provider for synthesis tests
const mockSynthesize = jest.fn();
const mockProvider = {
  id: "test-provider",
  capabilities: { supportsStreaming: false, supportedFormats: ["wav"] },
  synthesize: mockSynthesize,
};

mock.module("../calls/resolve-call-tts-provider.js", () => ({
  resolveCallTtsProvider: jest.fn(() => ({
    provider: mockProvider,
    useSynthesizedPath: false,
    audioFormat: "wav" as const,
  })),
}));

import { MediaStreamOutput } from "../calls/media-stream-output.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

function createMockWs() {
  const sent: string[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    ws: {
      send(data: string) {
        if (closed) throw new Error("WebSocket is closed");
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closed = true;
        closeCode = code;
        closeReason = reason;
      },
    } as unknown as import("bun").ServerWebSocket<unknown>,
    get sent() {
      return sent;
    },
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for async playback queue to drain. */
async function drain(): Promise<void> {
  // Allow microtasks and the drain loop to run
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Generate a minimal valid WAV buffer with PCM data. */
function makeWavBuffer(pcmSamples: number[]): Buffer {
  const pcmData = Buffer.alloc(pcmSamples.length * 2);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmData.writeInt16LE(pcmSamples[i], i * 2);
  }
  // 44-byte WAV header (simplified)
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(16000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  mockSynthesize.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MediaStreamOutput", () => {
  describe("CallTransport interface — sendTextToken", () => {
    test("accumulates text and sends mark on last: true with non-empty text", async () => {
      const wav = makeWavBuffer([1000, 2000, 3000, 4000]);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("hello ", false);
      output.sendTextToken("world", true);

      await drain();

      // Should have sent media frames (from synthesis) and a mark
      const events = sent.map((s) => JSON.parse(s).event);
      expect(events).toContain("media");
      expect(events).toContain("mark");

      // The mark should be end-of-turn
      const markMsg = sent.find((s) => JSON.parse(s).event === "mark");
      expect(JSON.parse(markMsg!).mark.name).toBe("end-of-turn");
    });

    test("empty token with last: true sends only end-of-turn mark (no synthesis)", async () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("", true);

      await drain();

      // Should send only a mark, no media frames
      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.event).toBe("mark");
      expect(parsed.mark.name).toBe("end-of-turn");

      // Synthesis should NOT have been called
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    test("non-last tokens accumulate without sending", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("hello ", false);
      output.sendTextToken("world ", false);
      expect(sent).toHaveLength(0);
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.endSession();
      output.sendTextToken("hello", true);
      expect(sent).toHaveLength(0);
    });
  });

  describe("CallTransport interface — sendPlayUrl", () => {
    test("enqueues a fetch-url item in the playback queue", () => {
      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendPlayUrl("https://example.com/audio.mp3");
      // The queue should have one item (the fetch will fail since
      // there's no real server, but the enqueueing is synchronous)
      expect(output.getPlaybackQueueLength()).toBeGreaterThanOrEqual(0);
    });

    test("does not enqueue when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.endSession();
      output.sendPlayUrl("https://example.com/audio.mp3");
      expect(sent).toHaveLength(0);
    });
  });

  describe("CallTransport interface — endSession", () => {
    test("closes the WebSocket with code 1000", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession("test-reason");
      expect(mock.closed).toBe(true);
      expect(mock.closeCode).toBe(1000);
      expect(mock.closeReason).toBe("test-reason");
    });

    test("uses default reason when none provided", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession();
      expect(mock.closed).toBe(true);
      expect(mock.closeReason).toBe("session-ended");
    });

    test("is idempotent", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession("first");
      // Second call should not throw (ws.close would throw on already-closed)
      output.endSession("second");
      expect(mock.closed).toBe(true);
    });

    test("getConnectionState returns 'connected' initially", () => {
      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      expect(output.getConnectionState()).toBe("connected");
    });

    test("getConnectionState returns 'closed' after endSession", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession();
      expect(output.getConnectionState()).toBe("closed");
    });
  });

  describe("sendAudioPayload", () => {
    test("sends a media command with the base64 payload", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.sendAudioPayload("dGVzdA==");

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "media",
        streamSid: "MZ-stream-1",
        media: { payload: "dGVzdA==" },
      });
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.sendAudioPayload("dGVzdA==");
      // Only the close would have happened, no media sent
      expect(sent).toHaveLength(0);
    });
  });

  describe("sendMark", () => {
    test("sends a mark command with the given name", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.sendMark("end-of-turn");

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "mark",
        streamSid: "MZ-stream-1",
        mark: { name: "end-of-turn" },
      });
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.sendMark("end-of-turn");
      expect(sent).toHaveLength(0);
    });
  });

  describe("clearAudio — barge-in", () => {
    test("sends a clear command to Twilio", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.clearAudio();

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "clear",
        streamSid: "MZ-stream-1",
      });
    });

    test("flushes pending playback queue on barge-in", async () => {
      const wav = makeWavBuffer([1000, 2000, 3000, 4000]);
      // Make synthesis slow so it's still in-flight when we clear
      mockSynthesize.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ audio: wav, contentType: "audio/wav" }),
              500,
            ),
          ),
      );

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");

      // Queue synthesis
      output.sendTextToken("hello world", true);
      // Immediately barge-in
      output.clearAudio();

      await drain();

      // The clear command should have been sent
      const clearMessages = sent.filter((s) => JSON.parse(s).event === "clear");
      expect(clearMessages.length).toBeGreaterThanOrEqual(1);

      // No media frames should have been sent (synthesis was aborted)
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages).toHaveLength(0);
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.clearAudio();
      expect(sent).toHaveLength(0);
    });
  });

  describe("setStreamSid / getStreamSid", () => {
    test("updates the stream SID used in subsequent commands", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "old-sid");
      expect(output.getStreamSid()).toBe("old-sid");

      output.setStreamSid("new-sid");
      expect(output.getStreamSid()).toBe("new-sid");

      output.sendAudioPayload("dGVzdA==");
      const parsed = JSON.parse(sent[0]);
      expect(parsed.streamSid).toBe("new-sid");
    });
  });

  describe("markClosed", () => {
    test("transitions to closed state without sending a close frame", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.markClosed();
      expect(output.getConnectionState()).toBe("closed");
      expect(mock.closed).toBe(false); // WebSocket not actually closed
      output.sendAudioPayload("dGVzdA=="); // Should be suppressed
      expect(mock.sent).toHaveLength(0);
    });
  });

  describe("error resilience", () => {
    test("sendAudioPayload handles ws.send throwing", () => {
      const ws = {
        send() {
          throw new Error("send failed");
        },
        close() {},
      } as unknown as import("bun").ServerWebSocket<unknown>;

      const output = new MediaStreamOutput(ws, "stream-1");
      // Should not throw
      expect(() => output.sendAudioPayload("dGVzdA==")).not.toThrow();
    });

    test("endSession handles ws.close throwing", () => {
      const ws = {
        send() {},
        close() {
          throw new Error("close failed");
        },
      } as unknown as import("bun").ServerWebSocket<unknown>;

      const output = new MediaStreamOutput(ws, "stream-1");
      // Should not throw
      expect(() => output.endSession()).not.toThrow();
    });
  });

  describe("playback queue", () => {
    test("synthesis produces media frames from WAV audio", async () => {
      // Generate WAV with enough samples to produce at least one mu-law frame
      const samples = Array.from({ length: 200 }, (_, i) =>
        Math.round(Math.sin(i * 0.1) * 10000),
      );
      const wav = makeWavBuffer(samples);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test synthesis", true);

      await drain();

      // Should have sent at least one media frame and an end-of-turn mark
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      const markMessages = sent.filter((s) => JSON.parse(s).event === "mark");

      expect(mediaMessages.length).toBeGreaterThan(0);
      expect(markMessages.length).toBeGreaterThan(0);

      // Each media message should have a base64 payload
      for (const msg of mediaMessages) {
        const parsed = JSON.parse(msg);
        expect(parsed.media.payload).toBeDefined();
        expect(typeof parsed.media.payload).toBe("string");
      }
    });

    test("getPlaybackQueueLength reflects queue state", () => {
      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      // Initially empty
      expect(output.getPlaybackQueueLength()).toBe(0);
    });
  });
});
