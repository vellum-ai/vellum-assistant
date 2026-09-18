/**
 * Prebuilt tones for the Debug tone lab. Each is a starting point to audition
 * or remix; `bloom` is what a voice conversation plays when it connects (see
 * `voice-start-tone.ts`).
 *
 * To promote a tone mixed in the lab, use its Copy button and paste the JSON
 * here as a new preset.
 */

import type { ToneLayer, ToneRecipe } from "@/lib/sounds/tone-synth";

export const TONE_PRESET_IDS = [
  "rise",
  "glass",
  "bloom",
  "wood",
  "tuneIn",
  "doubleBlip",
  "warm",
] as const;

export type TonePresetId = (typeof TONE_PRESET_IDS)[number];

function layer(
  overrides: Partial<ToneLayer> & { frequency: number },
): ToneLayer {
  return {
    waveform: "sine",
    glideTo: overrides.frequency,
    detuneCents: 0,
    startMs: 0,
    attackMs: 8,
    decayMs: 300,
    gain: 0.6,
    ...overrides,
  };
}

const NO_ECHO = { echoMs: 160, echoFeedback: 0, echoMix: 0 } as const;

export const TONE_PRESETS: Record<TonePresetId, ToneRecipe> = {
  // A rising fifth, C5 to G5, with a quiet triangle octave under each note.
  rise: {
    layers: [
      layer({ frequency: 523.25, decayMs: 260, gain: 0.55 }),
      layer({
        waveform: "triangle",
        frequency: 261.63,
        decayMs: 200,
        gain: 0.2,
      }),
      layer({ frequency: 783.99, startMs: 95, decayMs: 380, gain: 0.6 }),
      layer({
        waveform: "triangle",
        frequency: 392,
        startMs: 95,
        decayMs: 260,
        gain: 0.2,
      }),
    ],
    filterHz: 6000,
    ...NO_ECHO,
    gain: 0.8,
  },
  // Two high bell partials with a short room echo.
  glass: {
    layers: [
      layer({
        waveform: "triangle",
        frequency: 1318.51,
        attackMs: 3,
        decayMs: 600,
        gain: 0.5,
      }),
      layer({
        frequency: 1975.53,
        startMs: 60,
        attackMs: 3,
        decayMs: 700,
        gain: 0.35,
      }),
      layer({
        frequency: 3951.07,
        startMs: 60,
        attackMs: 2,
        decayMs: 120,
        gain: 0.08,
      }),
    ],
    filterHz: 9000,
    echoMs: 140,
    echoFeedback: 0.3,
    echoMix: 0.25,
    gain: 0.75,
  },
  // A C major arpeggio opening upward.
  bloom: {
    layers: [
      layer({ frequency: 523.25, attackMs: 10, decayMs: 450, gain: 0.45 }),
      layer({
        frequency: 659.25,
        startMs: 70,
        attackMs: 10,
        decayMs: 450,
        gain: 0.45,
      }),
      layer({
        frequency: 783.99,
        startMs: 140,
        attackMs: 10,
        decayMs: 450,
        gain: 0.45,
      }),
      layer({
        frequency: 1046.5,
        startMs: 210,
        attackMs: 10,
        decayMs: 600,
        gain: 0.5,
      }),
    ],
    filterHz: 7000,
    echoMs: 180,
    echoFeedback: 0.25,
    echoMix: 0.2,
    gain: 0.8,
  },
  // Two marimba-like knocks: a fast-decaying fundamental with a bright fourth harmonic.
  wood: {
    layers: [
      layer({ frequency: 440, attackMs: 2, decayMs: 190, gain: 0.7 }),
      layer({ frequency: 1760, attackMs: 1, decayMs: 50, gain: 0.18 }),
      layer({
        frequency: 587.33,
        startMs: 110,
        attackMs: 2,
        decayMs: 240,
        gain: 0.7,
      }),
      layer({
        frequency: 2349.32,
        startMs: 110,
        attackMs: 1,
        decayMs: 50,
        gain: 0.18,
      }),
    ],
    filterHz: 5000,
    ...NO_ECHO,
    gain: 0.85,
  },
  // A filtered saw sweeping up into a clean landing note.
  tuneIn: {
    layers: [
      layer({
        waveform: "sawtooth",
        frequency: 220,
        glideTo: 880,
        attackMs: 40,
        decayMs: 220,
        gain: 0.3,
      }),
      layer({
        frequency: 880,
        startMs: 230,
        attackMs: 6,
        decayMs: 320,
        gain: 0.55,
      }),
    ],
    filterHz: 1800,
    ...NO_ECHO,
    gain: 0.8,
  },
  // Two short blips, A5 then D6.
  doubleBlip: {
    layers: [
      layer({ frequency: 880, attackMs: 4, decayMs: 90, gain: 0.6 }),
      layer({
        frequency: 1174.66,
        startMs: 120,
        attackMs: 4,
        decayMs: 110,
        gain: 0.6,
      }),
    ],
    filterHz: 8000,
    ...NO_ECHO,
    gain: 0.75,
  },
  // A soft, slightly chorused open fifth in a low register.
  warm: {
    layers: [
      layer({
        frequency: 196,
        detuneCents: -6,
        attackMs: 60,
        decayMs: 700,
        gain: 0.5,
      }),
      layer({
        frequency: 293.66,
        detuneCents: 6,
        attackMs: 60,
        decayMs: 700,
        gain: 0.45,
      }),
      layer({
        waveform: "triangle",
        frequency: 392,
        startMs: 40,
        attackMs: 80,
        decayMs: 650,
        gain: 0.3,
      }),
    ],
    filterHz: 2500,
    ...NO_ECHO,
    gain: 0.9,
  },
};
