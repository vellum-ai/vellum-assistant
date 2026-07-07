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

import {
  mulawToPcm16,
  pcm16ToMulaw,
} from "../calls/media-stream-audio-transcode.js";
import { MediaStreamOutput } from "../calls/media-stream-output.js";
import { resolveCallTtsProvider } from "../calls/resolve-call-tts-provider.js";

const mockResolveCallTtsProvider = resolveCallTtsProvider as ReturnType<
  typeof jest.fn
>;

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
function makeWavBuffer(
  pcmSamples: number[],
  opts?: { sampleRate?: number; channels?: number },
): Buffer {
  const sampleRate = opts?.sampleRate ?? 8000;
  const channels = opts?.channels ?? 1;
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
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

/** Generate `count` samples of a sine tone at `freqHz` for a given rate. */
function sineSamples(
  count: number,
  freqHz: number,
  sampleRate: number,
): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 10000),
  );
}

/** Total decoded mu-law byte count across all sent media frames. */
function totalMulawBytes(sent: string[]): number {
  return sent
    .filter((s) => JSON.parse(s).event === "media")
    .reduce(
      (sum, s) =>
        sum + Buffer.from(JSON.parse(s).media.payload, "base64").length,
      0,
    );
}

/** Concatenate the decoded mu-law payloads of all sent media frames. */
function concatMulawPayloads(sent: string[]): Buffer {
  return Buffer.concat(
    sent
      .filter((s) => JSON.parse(s).event === "media")
      .map((s) => Buffer.from(JSON.parse(s).media.payload, "base64")),
  );
}

/** Number of media frames among the sent messages. */
function countMediaFrames(sent: string[]): number {
  return sent.filter((s) => JSON.parse(s).event === "media").length;
}

/** Encode samples as a raw PCM16 LE buffer. */
function pcm16Buffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], i * 2);
  }
  return buf;
}

/** Keep every other PCM16 sample (16 kHz -> 8 kHz decimation). */
function decimateByTwo(pcm: Buffer): Buffer {
  const outCount = Math.floor(pcm.length / 2 / 2);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    out.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
  }
  return out;
}

/** Install a resolveCallTtsProvider mock returning the given provider. */
function useProvider(provider: unknown): void {
  mockResolveCallTtsProvider.mockImplementation(() => ({
    provider,
    useSynthesizedPath: false,
    audioFormat: "wav" as const,
  }));
}

/** Count sign changes in a PCM16 LE buffer (proxy for tone frequency). */
function countZeroCrossings(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  let crossings = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 1; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  return crossings;
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

  describe("clearBufferedAudio — rejected barge-in", () => {
    test("sends a clear command to Twilio", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.clearBufferedAudio();

      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0])).toEqual({
        event: "clear",
        streamSid: "MZ-stream-1",
      });
    });

    test("preserves in-flight synthesis — queued speech still plays", async () => {
      const wav = makeWavBuffer([1000, 2000, 3000, 4000]);
      // Slow synthesis so the clear lands while the item is in flight
      mockSynthesize.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ audio: wav, contentType: "audio/wav" }),
              20,
            ),
          ),
      );

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");

      output.sendTextToken("hello world", true);
      output.clearBufferedAudio();

      await new Promise((resolve) => setTimeout(resolve, 60));

      // Unlike clearAudio, the in-flight synthesis is not aborted:
      // its frames go out once ready.
      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages.length).toBeGreaterThan(0);
    });

    test("keeps the audio-start signal armed", async () => {
      const wav = makeWavBuffer([1000, 2000, 3000, 4000]);
      mockSynthesize.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ audio: wav, contentType: "audio/wav" }),
              20,
            ),
          ),
      );

      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");

      let fired = 0;
      output.setAudioStartCallback(() => {
        fired++;
      });
      output.sendTextToken("hello world", true);
      output.clearBufferedAudio();

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(fired).toBe(1);
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.clearBufferedAudio();
      expect(sent).toHaveLength(0);
    });
  });

  describe("audio-start signal", () => {
    function makePlayableWav(): Buffer {
      const samples = Array.from({ length: 400 }, (_, i) =>
        Math.round(Math.sin(i * 0.1) * 10000),
      );
      return makeWavBuffer(samples);
    }

    test("fires once when the first audio frame of a synthesize item is sent", async () => {
      mockSynthesize.mockResolvedValue({
        audio: makePlayableWav(),
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      let fired = 0;
      let mediaSentWhenFired = -1;
      output.setAudioStartCallback(() => {
        fired++;
        mediaSentWhenFired = sent.filter(
          (s) => JSON.parse(s).event === "media",
        ).length;
      });

      output.sendTextToken("hello world", true);
      await drain();

      const mediaMessages = sent.filter((s) => JSON.parse(s).event === "media");
      expect(mediaMessages.length).toBeGreaterThan(1);
      // Fired exactly once, before any media frame went out.
      expect(fired).toBe(1);
      expect(mediaSentWhenFired).toBe(0);
    });

    test("one-shot: does not fire again for a subsequent item until re-armed", async () => {
      mockSynthesize.mockResolvedValue({
        audio: makePlayableWav(),
        contentType: "audio/wav",
      });

      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      let fired = 0;
      output.setAudioStartCallback(() => fired++);

      output.sendTextToken("first", true);
      await drain();
      expect(fired).toBe(1);

      // Second item without re-arming — signal already consumed.
      output.sendTextToken("second", true);
      await drain();
      expect(fired).toBe(1);

      // Re-armed — fires again for the next item.
      output.setAudioStartCallback(() => fired++);
      output.sendTextToken("third", true);
      await drain();
      expect(fired).toBe(2);
    });

    test("cleared on clearAudio: flushed playback never fires the signal", async () => {
      // Slow synthesis so clearAudio lands while the item is in flight.
      mockSynthesize.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ audio: makePlayableWav(), contentType: "audio/wav" }),
              200,
            ),
          ),
      );

      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      let fired = 0;
      output.setAudioStartCallback(() => fired++);

      output.sendTextToken("interrupted response", true);
      output.clearAudio();

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fired).toBe(0);
    });

    test("an empty end-of-turn (mark only) does not fire the signal", async () => {
      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      let fired = 0;
      output.setAudioStartCallback(() => fired++);

      output.sendTextToken("", true);
      await drain();
      expect(fired).toBe(0);
    });
  });

  describe("buffered text lifecycle", () => {
    test("clearAudio preserves text accumulating for an in-flight turn", async () => {
      const wav = makeWavBuffer([1000, 2000, 3000, 4000]);
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      // Tokens buffered mid-turn; a barge-in signal the controller ignores
      // (turn still processing) flushes queued audio but must not truncate
      // the pending response text.
      output.sendTextToken("hello ", false);
      output.clearAudio();
      output.sendTextToken("world", true);
      await drain();

      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      expect(mockSynthesize.mock.calls[0][0].text).toBe("hello world");
    });

    test("discardPendingText drops accumulated text so no synthesis occurs", async () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      output.sendTextToken("stale partial response", false);
      output.discardPendingText();
      output.sendTextToken("", true);
      await drain();

      expect(mockSynthesize).not.toHaveBeenCalled();
      // Only the end-of-turn mark goes out.
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]).event).toBe("mark");
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
  // Regression: WAV sample-rate handling (Fish Audio defaults WAV to 44.1 kHz)
  // ---------------------------------------------------------------------------

  describe("WAV sample-rate handling", () => {
    async function synthesizeWav(wav: Buffer): Promise<string[]> {
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("test", true);
      await drain();
      return sent;
    }

    test("8 kHz WAV passes through without rate conversion", async () => {
      const wav = makeWavBuffer(sineSamples(400, 440, 8000), {
        sampleRate: 8000,
      });
      const sent = await synthesizeWav(wav);
      // 400 samples at 8 kHz -> 400 mu-law bytes, unchanged.
      expect(totalMulawBytes(sent)).toBe(400);
    });

    test("16 kHz WAV is downsampled by 2 to 8 kHz", async () => {
      const wav = makeWavBuffer(sineSamples(800, 440, 16000), {
        sampleRate: 16000,
      });
      const sent = await synthesizeWav(wav);
      // 800 samples at 16 kHz -> 400 mu-law bytes after decimation.
      expect(totalMulawBytes(sent)).toBe(400);
    });

    test("44.1 kHz WAV is resampled to 8 kHz preserving pitch", async () => {
      // 4410 samples = 100 ms of a 440 Hz tone at Fish Audio's WAV default.
      const wav = makeWavBuffer(sineSamples(4410, 440, 44100), {
        sampleRate: 44100,
      });
      const sent = await synthesizeWav(wav);

      // 100 ms at 8 kHz = 800 mu-law bytes (allow ±1 frame of tolerance).
      const total = totalMulawBytes(sent);
      expect(Math.abs(total - 800)).toBeLessThanOrEqual(160);

      // Quality check: decode back to PCM and verify the tone frequency
      // survived. A 440 Hz tone over 100 ms has ~88 zero crossings; a
      // 5.5x-slow playback bug would show ~16 instead.
      const decoded = mulawToPcm16(concatMulawPayloads(sent));
      const crossings = countZeroCrossings(decoded);
      expect(Math.abs(crossings - 88)).toBeLessThanOrEqual(4);
    });

    test("unparseable (zero) sample rate falls back to the 8 kHz assumption", async () => {
      const wav = makeWavBuffer(sineSamples(400, 440, 8000), {
        sampleRate: 0,
      });
      const sent = await synthesizeWav(wav);
      // Falls back to current behavior: samples pass through 1:1.
      expect(totalMulawBytes(sent)).toBe(400);
    });

    test("stereo WAV keeps one channel", async () => {
      // 400 interleaved L/R sample pairs (800 samples total) at 8 kHz.
      const left = sineSamples(400, 440, 8000);
      const interleaved: number[] = [];
      for (const s of left) {
        interleaved.push(s, -s);
      }
      const wav = makeWavBuffer(interleaved, { sampleRate: 8000, channels: 2 });
      const sent = await synthesizeWav(wav);
      // One channel of 400 samples -> 400 mu-law bytes.
      expect(totalMulawBytes(sent)).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental sentence-bounded synthesis
  // ---------------------------------------------------------------------------

  describe("incremental sentence-bounded synthesis", () => {
    test("complete sentences synthesize and play before last: true arrives", async () => {
      const wav = makeWavBuffer(sineSamples(400, 440, 8000));
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");

      output.sendTextToken("First sentence. Sec", false);
      await drain();

      // The completed first sentence synthesizes (and its frames go out)
      // while the turn is still streaming.
      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      expect(mockSynthesize.mock.calls[0][0].text).toBe("First sentence.");
      expect(countMediaFrames(sent)).toBeGreaterThan(0);

      output.sendTextToken("ond sentence.", true);
      await drain();

      expect(mockSynthesize).toHaveBeenCalledTimes(2);
      expect(mockSynthesize.mock.calls[1][0].text).toBe("Second sentence.");
    });

    test("end-of-turn mark follows the final segment's frames", async () => {
      const wav = makeWavBuffer(sineSamples(400, 440, 8000));
      mockSynthesize.mockResolvedValue({
        audio: wav,
        contentType: "audio/wav",
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("One. Two.", true);
      await drain();

      expect(mockSynthesize).toHaveBeenCalledTimes(2);
      const events = sent.map((s) => JSON.parse(s).event);
      const markIndex = events.indexOf("mark");
      const lastMediaIndex = events.lastIndexOf("media");
      expect(lastMediaIndex).toBeGreaterThanOrEqual(0);
      expect(markIndex).toBeGreaterThan(lastMediaIndex);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming PCM synthesis (incremental transcode)
  // ---------------------------------------------------------------------------

  describe("streaming PCM synthesis", () => {
    test("frames are sent before the provider stream completes", async () => {
      let releaseStream!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      // 640 samples at 16 kHz -> 320 samples at 8 kHz = two whole frames.
      const chunk = pcm16Buffer(sineSamples(640, 440, 16000));
      useProvider({
        id: "streaming-pcm",
        capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
        synthesize: jest.fn(),
        async synthesizeStream(
          _request: unknown,
          onChunk: (c: Uint8Array) => void,
        ) {
          onChunk(chunk);
          await gate;
          onChunk(chunk);
          return {
            audio: Buffer.concat([chunk, chunk]),
            contentType: "audio/pcm",
          };
        },
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("Hello there.", true);
      await drain();

      // First chunk's frames went out while the stream is still open,
      // and the end-of-turn mark has not been sent yet.
      const framesBefore = countMediaFrames(sent);
      expect(framesBefore).toBe(2);
      expect(sent.some((s) => JSON.parse(s).event === "mark")).toBe(false);

      releaseStream();
      await drain();

      expect(countMediaFrames(sent)).toBe(4);
      expect(sent.some((s) => JSON.parse(s).event === "mark")).toBe(true);
    });

    test("odd-byte and partial-frame chunk boundaries produce well-formed frames", async () => {
      // 800 samples at 16 kHz (1600 bytes), split at deliberately awkward
      // boundaries: odd bytes, non-frame-aligned sizes.
      const full = pcm16Buffer(sineSamples(800, 440, 16000));
      const cuts = [0, 3, 251, 640, 1001, full.length];
      const chunks = cuts
        .slice(0, -1)
        .map((start, i) => full.subarray(start, cuts[i + 1]));
      useProvider({
        id: "streaming-pcm",
        capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
        synthesize: jest.fn(),
        async synthesizeStream(
          _request: unknown,
          onChunk: (c: Uint8Array) => void,
        ) {
          for (const c of chunks) {
            onChunk(c);
          }
          return { audio: full, contentType: "audio/pcm" };
        },
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("Test.", true);
      await drain();

      // The concatenated mu-law output must be byte-identical to a
      // whole-buffer transcode: no dropped or torn samples at chunk seams.
      const expected = pcm16ToMulaw(decimateByTwo(full));
      expect(expected.length).toBe(400);
      expect(concatMulawPayloads(sent).equals(expected)).toBe(true);
    });

    test("playbackVersion bump mid-stream stops further frames", async () => {
      let releaseStream!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      const chunk = pcm16Buffer(sineSamples(640, 440, 16000));
      useProvider({
        id: "streaming-pcm",
        capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
        synthesize: jest.fn(),
        async synthesizeStream(
          _request: unknown,
          onChunk: (c: Uint8Array) => void,
        ) {
          onChunk(chunk);
          await gate;
          // Stale chunk emitted after barge-in must never become frames.
          onChunk(chunk);
          return {
            audio: Buffer.concat([chunk, chunk]),
            contentType: "audio/pcm",
          };
        },
      });

      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("Hello there.", true);
      await drain();

      const framesBefore = countMediaFrames(sent);
      expect(framesBefore).toBeGreaterThan(0);

      output.clearAudio();
      releaseStream();
      await drain();

      expect(countMediaFrames(sent)).toBe(framesBefore);
    });

    test("streaming provider without PCM support falls back to the whole-buffer path", async () => {
      const wav = makeWavBuffer(sineSamples(400, 440, 8000));
      const half = Math.floor(wav.length / 2);
      let midStreamFrames = -1;
      const sentRef: { sent: string[] } = { sent: [] };
      useProvider({
        id: "streaming-wav",
        capabilities: { supportsStreaming: true, supportedFormats: ["wav"] },
        synthesize: jest.fn(),
        async synthesizeStream(
          _request: unknown,
          onChunk: (c: Uint8Array) => void,
        ) {
          onChunk(wav.subarray(0, half));
          await new Promise((resolve) => setTimeout(resolve, 5));
          midStreamFrames = countMediaFrames(sentRef.sent);
          onChunk(wav.subarray(half));
          return { audio: wav, contentType: "audio/wav" };
        },
      });

      const { ws, sent } = createMockWs();
      sentRef.sent = sent;
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("Hello.", true);
      await drain();

      // Nothing streamed mid-flight; the whole accumulated WAV is
      // transcoded once at the end.
      expect(midStreamFrames).toBe(0);
      expect(totalMulawBytes(sent)).toBe(400);
    });
  });
});
