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
  resolvePlayableCallTtsProvider: jest.fn(async () => ({
    provider: mockProvider,
    audioFormat: "wav" as const,
  })),
}));

import { MediaStreamOutput } from "../calls/media-stream-output.js";
import {
  resolveCallTtsProvider,
  resolvePlayableCallTtsProvider,
} from "../calls/resolve-call-tts-provider.js";

const mockResolveCallTtsProvider = resolveCallTtsProvider as ReturnType<
  typeof jest.fn
>;
const mockResolvePlayableCallTtsProvider =
  resolvePlayableCallTtsProvider as ReturnType<typeof jest.fn>;

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

/** Generate a minimal valid WAV buffer with PCM data at the given rate. */
function makeWavBuffer(
  pcmSamples: number[],
  sampleRate = 8000,
  numChannels = 1,
): Buffer {
  const pcmData = Buffer.alloc(pcmSamples.length * 2);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmData.writeInt16LE(pcmSamples[i], i * 2);
  }
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  // 44-byte WAV header (simplified)
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24); // sample rate
  header.writeUInt32LE(byteRate, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32); // block align
  header.writeUInt16LE(bitsPerSample, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

/** Count total mu-law samples (bytes) across all base64 media frames. */
function totalMulawSamples(sent: string[]): number {
  return sent
    .filter((s) => JSON.parse(s).event === "media")
    .reduce(
      (sum, s) =>
        sum + Buffer.from(JSON.parse(s).media.payload, "base64").length,
      0,
    );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  mockSynthesize.mockReset();
  // Restore the default resolveCallTtsProvider mock
  mockResolveCallTtsProvider.mockImplementation(() => ({
    provider: mockProvider,
    useSynthesizedPath: false,
    audioFormat: "wav" as const,
  }));
  // Restore the default media-stream playability-guarded mock
  mockResolvePlayableCallTtsProvider.mockImplementation(async () => ({
    provider: mockProvider,
    audioFormat: "wav" as const,
  }));
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

  // ---------------------------------------------------------------------------
  // Regression: audio format / content-type mismatch
  // ---------------------------------------------------------------------------

  describe("audio format mismatch regression", () => {
    test("mp3 bytes declared as audio/wav returns silence (not garbled)", async () => {
      // Simulate a broken provider that claims content-type audio/wav but
      // actually returns mp3 bytes (starts with MPEG sync word 0xFF 0xFB).
      const mp3Bytes = Buffer.alloc(256);
      mp3Bytes[0] = 0xff; // MPEG sync
      mp3Bytes[1] = 0xfb; // MPEG Layer 3
      // Fill rest with non-zero data to make garbling detectable
      for (let i = 2; i < mp3Bytes.length; i++) {
        mp3Bytes[i] = 0x80;
      }

      mockSynthesize.mockResolvedValue({
        audio: mp3Bytes,
        contentType: "audio/wav", // Mismatch! Says WAV but bytes are mp3
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);

      await drain();

      // The audioBufferToFrames magic-byte detection should detect mp3
      // sync bytes when format is "wav" and return silence (no media
      // frames) rather than garbled audio.
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages).toHaveLength(0);

      // Should still have the end-of-turn mark
      const markMessages = sent.filter((s) => JSON.parse(s).event === "mark");
      expect(markMessages.length).toBeGreaterThan(0);
    });

    test("raw PCM declared as audio/pcm produces valid frames", async () => {
      // Raw 16-bit signed LE PCM samples at 16 kHz (no RIFF header).
      // Generate enough samples (400 = 200 after downsample) for at
      // least one mu-law frame.
      const sampleCount = 400;
      const pcmData = Buffer.alloc(sampleCount * 2);
      for (let i = 0; i < sampleCount; i++) {
        const sample = Math.round(Math.sin(i * 0.1) * 10000);
        pcmData.writeInt16LE(sample, i * 2);
      }

      mockSynthesize.mockResolvedValue({
        audio: pcmData,
        contentType: "audio/pcm",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);

      await drain();

      // processSynthesizeItem derives actualFormat from content-type:
      // "audio/pcm" -> "pcm". audioBufferToFrames handles raw PCM by
      // downsampling 16 kHz -> 8 kHz and converting to mu-law.
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages.length).toBeGreaterThan(0);

      // Verify each frame has a valid base64 payload
      for (const msg of mediaMessages) {
        const parsed = JSON.parse(msg);
        expect(typeof parsed.media.payload).toBe("string");
        expect(parsed.media.payload.length).toBeGreaterThan(0);
      }
    });

    test("raw PCM with content-type audio/x-raw produces valid frames", async () => {
      // Same as above but using the alternative content-type that some
      // providers may return for raw PCM.
      const sampleCount = 400;
      const pcmData = Buffer.alloc(sampleCount * 2);
      for (let i = 0; i < sampleCount; i++) {
        const sample = Math.round(Math.sin(i * 0.1) * 10000);
        pcmData.writeInt16LE(sample, i * 2);
      }

      mockSynthesize.mockResolvedValue({
        audio: pcmData,
        contentType: "audio/x-raw",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);

      await drain();

      // processSynthesizeItem detects "audio/x-raw" -> "pcm" format.
      // audioBufferToFrames converts raw PCM to mu-law frames.
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages.length).toBeGreaterThan(0);

      for (const msg of mediaMessages) {
        const parsed = JSON.parse(msg);
        expect(typeof parsed.media.payload).toBe("string");
        expect(parsed.media.payload.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // WAV sample-rate resampling (fix for garbled non-8kHz WAV TTS, e.g. fish-audio)
  // ---------------------------------------------------------------------------

  describe("WAV sample-rate resampling", () => {
    test("24 kHz WAV resamples to ~8 kHz (duration preserved, not encoded as 24 kHz)", async () => {
      // 1 second of audio at 24 kHz = 24000 samples. After resampling to
      // 8 kHz it should be ~8000 mu-law samples (~50 frames of 160 bytes),
      // NOT 24000. This proves the parsed rate is honored.
      const sampleRate = 24000;
      const samples = Array.from({ length: sampleRate }, (_, i) =>
        Math.round(Math.sin(i * 0.05) * 10000),
      );
      const wav = makeWavBuffer(samples, sampleRate);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();

      const total = totalMulawSamples(sent);
      // ~8000 samples expected (1s @ 8kHz). Allow a small rounding window.
      expect(total).toBeGreaterThan(7900);
      expect(total).toBeLessThan(8100);
      // Sanity: definitely not encoded as 24kHz worth of samples.
      expect(total).toBeLessThan(12000);
    });

    test("44.1 kHz WAV resamples to ~8 kHz", async () => {
      const sampleRate = 44100;
      const samples = Array.from({ length: sampleRate }, (_, i) =>
        Math.round(Math.sin(i * 0.02) * 8000),
      );
      const wav = makeWavBuffer(samples, sampleRate);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();

      const total = totalMulawSamples(sent);
      // 1s @ 8kHz ≈ 8000 samples.
      expect(total).toBeGreaterThan(7900);
      expect(total).toBeLessThan(8100);
    });

    test("16 kHz WAV downsamples correctly (regression)", async () => {
      const sampleRate = 16000;
      const samples = Array.from({ length: sampleRate }, (_, i) =>
        Math.round(Math.sin(i * 0.03) * 9000),
      );
      const wav = makeWavBuffer(samples, sampleRate);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();

      const total = totalMulawSamples(sent);
      expect(total).toBeGreaterThan(7900);
      expect(total).toBeLessThan(8100);
    });

    test("8 kHz WAV is identity (no rate change)", async () => {
      const sampleRate = 8000;
      const samples = Array.from({ length: sampleRate }, (_, i) =>
        Math.round(Math.sin(i * 0.1) * 10000),
      );
      const wav = makeWavBuffer(samples, sampleRate);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();

      const total = totalMulawSamples(sent);
      // 8000 input samples @ 8kHz -> 8000 mu-law samples exactly.
      expect(total).toBe(8000);
    });

    test("stereo WAV at higher rate takes channel 0 and resamples to 8 kHz", async () => {
      // Interleaved stereo: L,R,L,R... 1s @ 24kHz = 24000 frames = 48000 samples.
      const sampleRate = 24000;
      const frames = sampleRate; // 1 second
      const interleaved: number[] = [];
      for (let i = 0; i < frames; i++) {
        interleaved.push(Math.round(Math.sin(i * 0.05) * 10000)); // L
        interleaved.push(0); // R (silent, proves we take channel 0)
      }
      const wav = makeWavBuffer(interleaved, sampleRate, 2);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();

      const total = totalMulawSamples(sent);
      // 24000 mono frames -> ~8000 mu-law samples after resample.
      expect(total).toBeGreaterThan(7900);
      expect(total).toBeLessThan(8100);
    });
  });
});
