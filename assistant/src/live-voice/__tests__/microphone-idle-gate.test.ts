import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";

import { MicrophoneIdleGate } from "../microphone-idle-gate.js";

function pcm(ms: number, amplitude: number, sampleRate = 24_000): Buffer {
  const audio = Buffer.alloc(Math.round((sampleRate * ms) / 1_000) * 2);
  for (let offset = 0; offset < audio.byteLength; offset += 2) {
    audio.writeInt16LE(amplitude, offset);
  }
  return audio;
}

describe("MicrophoneIdleGate", () => {
  test.each([16_000, 24_000, 48_000])(
    "gates after one second of audio at %i Hz, including across a frame boundary",
    (sampleRate) => {
      const gate = new MicrophoneIdleGate(sampleRate);
      const first = pcm(950, 100, sampleRate);
      expect(gate.process(first, false)).toEqual(first);
      expect(gate.closed).toBe(false);

      const output = gate.process(pcm(350, 100, sampleRate), false);
      expect(gate.closed).toBe(true);
      expect(output).toEqual(
        Buffer.concat([pcm(50, 100, sampleRate), pcm(100, 0, sampleRate)]),
      );
    },
  );

  test("restores the quiet onset once, without duplicating the audio timeline", () => {
    const gate = new MicrophoneIdleGate(24_000);
    const quiet = pcm(1_000, 100);
    const oldNoise = pcm(200, 90);
    const onset = pcm(200, 300);
    const speech = pcm(100, 8_000);
    const output = [
      gate.process(quiet, false),
      gate.process(oldNoise, false),
      gate.process(onset, false),
      gate.process(speech, true),
    ];
    expect(Buffer.concat(output)).toEqual(
      Buffer.concat([quiet, pcm(200, 0), onset, speech]),
    );
    expect(gate.closed).toBe(false);
    expect(gate.process(speech, true)).toEqual(speech);
  });

  test("each speech onset gets a fresh one-second tail", () => {
    const gate = new MicrophoneIdleGate(24_000);
    for (let index = 0; index < 3; index += 1) {
      const speech = pcm(100, 8_000);
      expect(gate.process(speech, true)).toEqual(speech);
      const quiet = pcm(990, 100);
      expect(gate.process(quiet, false)).toEqual(quiet);
      expect(gate.closed).toBe(false);
      const boundary = pcm(10, 100);
      expect(gate.process(boundary, false)).toEqual(boundary);
      expect(gate.closed).toBe(true);
    }
  });

  test("long idle input keeps only 200ms pending and sends silence at input cadence", () => {
    const gate = new MicrophoneIdleGate(24_000);
    gate.process(pcm(1_000, 100), false);
    for (let index = 0; index < 20; index += 1) {
      expect(gate.process(pcm(10, 100), false).byteLength).toBe(0);
    }
    for (let index = 0; index < 1_000; index += 1) {
      expect(gate.process(pcm(10, 100), false)).toEqual(pcm(10, 0));
    }
    const speech = pcm(10, 8_000);
    expect(gate.process(speech, true)).toEqual(
      Buffer.concat([pcm(200, 100), speech]),
    );
  });

  test("reset discards held audio at a stream or client-interrupt boundary", () => {
    const gate = new MicrophoneIdleGate(24_000);
    gate.process(pcm(1_200, 100), false);
    gate.reset();
    expect(gate.closed).toBe(false);
    const speech = pcm(10, 8_000);
    expect(gate.process(speech, true)).toEqual(speech);
  });
});
