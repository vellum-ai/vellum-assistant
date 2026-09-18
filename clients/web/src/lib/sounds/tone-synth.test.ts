import { describe, expect, test } from "bun:test";

import { TONE_PRESET_IDS, TONE_PRESETS } from "@/lib/sounds/tone-presets";
import {
  noteNameForFrequency,
  sanitizeToneRecipe,
  scheduleTone,
  TONE_LIMITS,
  toneDurationSec,
  type ToneRecipe,
} from "@/lib/sounds/tone-synth";

function recipe(overrides: Partial<ToneRecipe> = {}): ToneRecipe {
  return {
    layers: [
      {
        waveform: "sine",
        frequency: 440,
        glideTo: 440,
        detuneCents: 0,
        startMs: 100,
        attackMs: 10,
        decayMs: 290,
        gain: 0.5,
      },
    ],
    filterHz: 8000,
    echoMs: 100,
    echoFeedback: 0,
    echoMix: 0,
    gain: 0.8,
    ...overrides,
  };
}

describe("sanitizeToneRecipe", () => {
  test("keeps a valid recipe unchanged", () => {
    expect(sanitizeToneRecipe(recipe())).toEqual(recipe());
  });

  test("rejects non-recipes and recipes with no playable layer", () => {
    expect(sanitizeToneRecipe(null)).toBeNull();
    expect(sanitizeToneRecipe("tone")).toBeNull();
    expect(sanitizeToneRecipe({ layers: [] })).toBeNull();
    expect(sanitizeToneRecipe({ layers: [null, 3] })).toBeNull();
  });

  test("clamps out-of-range fields and fills missing ones", () => {
    const out = sanitizeToneRecipe({
      layers: [{ waveform: "noise", frequency: 99999, gain: 7 }],
      echoFeedback: 5,
    });
    expect(out?.layers[0]?.waveform).toBe("sine");
    expect(out?.layers[0]?.frequency).toBe(TONE_LIMITS.frequency.max);
    expect(out?.layers[0]?.glideTo).toBe(TONE_LIMITS.frequency.max);
    expect(out?.layers[0]?.gain).toBe(1);
    expect(out?.echoFeedback).toBe(TONE_LIMITS.echoFeedback.max);
  });

  test("caps the layer count", () => {
    const layers = Array.from({ length: 20 }, () => recipe().layers[0]);
    expect(sanitizeToneRecipe({ layers })?.layers).toHaveLength(
      TONE_LIMITS.layers.max,
    );
  });
});

describe("toneDurationSec", () => {
  test("ends when the last layer has decayed", () => {
    expect(toneDurationSec(recipe())).toBeCloseTo(0.4);
  });

  test("adds a bounded echo tail when the echo is on", () => {
    const dry = toneDurationSec(recipe());
    const wet = toneDurationSec(
      recipe({ echoMix: 0.5, echoFeedback: 0.5, echoMs: 100 }),
    );
    expect(wet).toBeGreaterThan(dry);
    const longest = toneDurationSec(
      recipe({ echoMix: 1, echoFeedback: 0.9, echoMs: 800 }),
    );
    expect(longest - dry).toBeLessThanOrEqual(3);
  });
});

describe("presets", () => {
  test.each(TONE_PRESET_IDS.map((id) => [id]))(
    "%s survives sanitizing unchanged",
    (id) => {
      expect(sanitizeToneRecipe(TONE_PRESETS[id])).toEqual(TONE_PRESETS[id]);
    },
  );
});

describe("scheduleTone", () => {
  test("starts and stops one oscillator per layer inside the tone", () => {
    const starts: number[] = [];
    const stops: number[] = [];
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
    });
    const node = () => ({ connect() {}, gain: param() });
    const ctx = {
      createGain: node,
      createDelay: () => ({ connect() {}, delayTime: param() }),
      createBiquadFilter: () => ({
        connect() {},
        type: "lowpass",
        frequency: param(),
        Q: param(),
      }),
      createOscillator: () => ({
        connect() {},
        type: "sine",
        detune: param(),
        frequency: param(),
        start: (t: number) => starts.push(t),
        stop: (t: number) => stops.push(t),
      }),
    } as unknown as BaseAudioContext;

    const tone = TONE_PRESETS.rise;
    const end = scheduleTone(ctx, {} as AudioNode, tone, 1);
    expect(starts).toHaveLength(tone.layers.length);
    expect(Math.min(...starts)).toBe(1);
    expect(end).toBeCloseTo(1 + toneDurationSec(tone));
    for (const stop of stops) {
      expect(stop).toBeLessThanOrEqual(end + 0.02);
    }
  });
});

describe("noteNameForFrequency", () => {
  test("names equal-tempered pitches", () => {
    expect(noteNameForFrequency(440)).toBe("A4");
    expect(noteNameForFrequency(261.63)).toBe("C4");
    expect(noteNameForFrequency(783.99)).toBe("G5");
  });
});
