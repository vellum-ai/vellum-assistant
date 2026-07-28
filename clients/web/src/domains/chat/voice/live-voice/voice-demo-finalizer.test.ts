import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  finalizeVoiceDemoCapture,
  type VoiceDemoFinalizerInput,
} from "@/domains/chat/voice/live-voice/voice-demo-finalizer";

describe("finalizeVoiceDemoCapture", () => {
  test("preserves the shared origin and writes aligned mono/stereo float WAVs", async () => {
    const input: VoiceDemoFinalizerInput = {
      folderName: "voice-demo-test",
      session: {
        sessionId: "session-123",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationSeconds: 2,
        audioRoute: {
          inputs: [],
          outputs: [],
          sampleRate: 48_000,
          ioBufferDuration: 0.01,
        },
        files: {
          alex: "alex.wav",
          pax: "pax.wav",
          mix: "mix.wav",
        },
        events: [],
      },
      alexSegments: [
        {
          id: "alex-1",
          startT: 0.5,
          endT: 1.5,
          sampleRate: 4,
          format: "int16",
          channels: [new Int16Array([16_384, 16_384, 16_384, 16_384]).buffer],
        },
      ],
      paxSegments: [
        {
          id: "pax-1",
          startT: 1,
          endT: 1.5,
          sampleRate: 4,
          format: "float32",
          channels: [new Float32Array([-0.25, -0.25]).buffer],
        },
      ],
      transcriptEntries: [
        { t: 1, speaker: "PAX", text: "Hello." },
        { t: 0.5, speaker: "ALEX", text: "Hey." },
      ],
    };

    const { filename, zip } = await finalizeVoiceDemoCapture(input);

    expect(filename).toBe("voice-demo-test.zip");
    const archive = await JSZip.loadAsync(zip);
    const alex = await archive
      .file("voice-demo-test/alex.wav")!
      .async("uint8array");
    const pax = await archive
      .file("voice-demo-test/pax.wav")!
      .async("uint8array");
    const mix = await archive
      .file("voice-demo-test/mix.wav")!
      .async("uint8array");
    const transcript = await archive
      .file("voice-demo-test/transcript.txt")!
      .async("string");

    expect(readWavHeader(alex)).toEqual({
      format: 3,
      channels: 1,
      sampleRate: 48_000,
      bitsPerSample: 32,
    });
    expect(readWavHeader(mix).channels).toBe(2);

    expect(readSample(alex, 0.25, 0, 1)).toBe(0);
    expect(readSample(alex, 0.75, 0, 1)).toBeCloseTo(0.5, 5);
    expect(readSample(pax, 0.75, 0, 1)).toBe(0);
    expect(readSample(pax, 1.25, 0, 1)).toBeCloseTo(-0.25, 5);
    expect(readSample(mix, 1.25, 0, 2)).toBeCloseTo(0.5, 5);
    expect(readSample(mix, 1.25, 1, 2)).toBeCloseTo(-0.25, 5);
    expect(transcript).toBe(
      "[00:00.500] ALEX: Hey.\n[00:01.000] PAX: Hello.\n",
    );
  });
});

function readWavHeader(bytes: Uint8Array): {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
} {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  return {
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
  };
}

function readSample(
  bytes: Uint8Array,
  t: number,
  channel: number,
  channelCount: number,
): number {
  const frame = Math.round(t * 48_000);
  const offset = 44 + (frame * channelCount + channel) * 4;
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat32(offset, true);
}
