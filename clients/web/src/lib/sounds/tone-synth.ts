/**
 * A small additive synth for UI tones, built on the Web Audio API.
 *
 * A tone is a {@link ToneRecipe}: a few oscillator layers, each with its own
 * pitch (optionally gliding), start offset, and attack/decay envelope, summed
 * through a low-pass filter and an optional feedback echo. Recipes are plain
 * JSON so the Debug tone lab can mix one, copy it out, and paste it back here
 * as a preset.
 *
 * `scheduleTone` builds the graph on any `BaseAudioContext`, so the same code
 * plays a tone live and renders it offline for the lab's waveform preview.
 */

export const TONE_WAVEFORMS = [
  "sine",
  "triangle",
  "square",
  "sawtooth",
] as const;

export type ToneWaveform = (typeof TONE_WAVEFORMS)[number];

export interface ToneLayer {
  waveform: ToneWaveform;
  /** Pitch at the start of the layer, in Hz. */
  frequency: number;
  /** Pitch the layer glides to over its envelope. Equal to `frequency` for none. */
  glideTo: number;
  /** Fine detune in cents, for chorus between stacked layers. */
  detuneCents: number;
  /** Offset from the start of the tone, in ms. */
  startMs: number;
  /** Rise from silence to peak, in ms. */
  attackMs: number;
  /** Exponential fall from peak to silence, in ms. */
  decayMs: number;
  /** Peak level, 0 to 1, before the recipe gain. */
  gain: number;
}

export interface ToneRecipe {
  layers: ToneLayer[];
  /** Low-pass cutoff on the summed layers, in Hz. */
  filterHz: number;
  /** Echo repeat interval, in ms. */
  echoMs: number;
  /** Share of each echo fed back into the next, 0 to 0.9. */
  echoFeedback: number;
  /** Level of the echo return, 0 to 1. Zero disables the echo. */
  echoMix: number;
  /** Output level, 0 to 1. */
  gain: number;
}

export const TONE_LIMITS = {
  frequency: { min: 40, max: 8000 },
  detuneCents: { min: -100, max: 100 },
  startMs: { min: 0, max: 2000 },
  attackMs: { min: 1, max: 1000 },
  decayMs: { min: 10, max: 3000 },
  gain: { min: 0, max: 1 },
  filterHz: { min: 200, max: 18000 },
  echoMs: { min: 20, max: 800 },
  echoFeedback: { min: 0, max: 0.9 },
  echoMix: { min: 0, max: 1 },
  layers: { max: 8 },
} as const;

/** Echo repeats are cut once they fall below this level. */
const ECHO_FLOOR = 0.001;
/** Longest echo tail a tone may ring for, in seconds. */
const MAX_ECHO_TAIL_SEC = 3;
/** Master-bus headroom: stacked layers at full gain must not clip. */
const MIX_HEADROOM = 0.35;

export function defaultToneLayer(): ToneLayer {
  return {
    waveform: "sine",
    frequency: 660,
    glideTo: 660,
    detuneCents: 0,
    startMs: 0,
    attackMs: 8,
    decayMs: 300,
    gain: 0.6,
  };
}

function clampNumber(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(range.max, Math.max(range.min, value));
}

function sanitizeLayer(raw: unknown): ToneLayer | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const fallback = defaultToneLayer();
  const waveform = (TONE_WAVEFORMS as readonly unknown[]).includes(r.waveform)
    ? (r.waveform as ToneWaveform)
    : fallback.waveform;
  const frequency = clampNumber(
    r.frequency,
    TONE_LIMITS.frequency,
    fallback.frequency,
  );
  return {
    waveform,
    frequency,
    glideTo: clampNumber(r.glideTo, TONE_LIMITS.frequency, frequency),
    detuneCents: clampNumber(r.detuneCents, TONE_LIMITS.detuneCents, 0),
    startMs: clampNumber(r.startMs, TONE_LIMITS.startMs, 0),
    attackMs: clampNumber(r.attackMs, TONE_LIMITS.attackMs, fallback.attackMs),
    decayMs: clampNumber(r.decayMs, TONE_LIMITS.decayMs, fallback.decayMs),
    gain: clampNumber(r.gain, TONE_LIMITS.gain, fallback.gain),
  };
}

/**
 * Coerce untrusted JSON (a pasted recipe, a stored override) into a playable
 * recipe, clamping every field into range. Returns `null` when nothing
 * playable is left.
 */
export function sanitizeToneRecipe(raw: unknown): ToneRecipe | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.layers)) {
    return null;
  }
  const layers = r.layers
    .map(sanitizeLayer)
    .filter((layer): layer is ToneLayer => layer !== null)
    .slice(0, TONE_LIMITS.layers.max);
  if (layers.length === 0) {
    return null;
  }
  return {
    layers,
    filterHz: clampNumber(r.filterHz, TONE_LIMITS.filterHz, 12000),
    echoMs: clampNumber(r.echoMs, TONE_LIMITS.echoMs, 160),
    echoFeedback: clampNumber(r.echoFeedback, TONE_LIMITS.echoFeedback, 0),
    echoMix: clampNumber(r.echoMix, TONE_LIMITS.echoMix, 0),
    gain: clampNumber(r.gain, TONE_LIMITS.gain, 0.8),
  };
}

function hasEcho(recipe: ToneRecipe): boolean {
  return recipe.echoMix > 0 && recipe.echoFeedback > 0;
}

/** How long the echo keeps ringing after the last layer ends, in seconds. */
function echoTailSec(recipe: ToneRecipe): number {
  if (!hasEcho(recipe)) {
    return 0;
  }
  const repeats = Math.log(ECHO_FLOOR) / Math.log(recipe.echoFeedback);
  return Math.min(MAX_ECHO_TAIL_SEC, (repeats * recipe.echoMs) / 1000);
}

/** Total length of a tone, including its echo tail, in seconds. */
export function toneDurationSec(recipe: ToneRecipe): number {
  const dry = recipe.layers.reduce(
    (end, layer) =>
      Math.max(end, (layer.startMs + layer.attackMs + layer.decayMs) / 1000),
    0,
  );
  return dry + echoTailSec(recipe);
}

/**
 * The tone played backwards in pitch: the notes keep their timing and
 * envelopes, but the pitch sequence runs in reverse and every glide flips
 * direction. A rising arpeggio becomes a falling one that lands on its root.
 *
 * Layers that start together form one note (a chord or a doubled octave). The
 * notes swap pitches as units, layer for layer in recipe order, so a doubling
 * keeps its voicing. A layer whose mirror note has fewer layers keeps its pitch.
 */
export function invertTone(recipe: ToneRecipe): ToneRecipe {
  const starts = [...new Set(recipe.layers.map((l) => l.startMs))].sort(
    (a, b) => a - b,
  );
  const notes = starts.map((start) =>
    recipe.layers.filter((layer) => layer.startMs === start),
  );
  const layers = recipe.layers.map((layer) => {
    const noteIndex = starts.indexOf(layer.startMs);
    const member = notes[noteIndex]?.indexOf(layer) ?? -1;
    const source = notes[notes.length - 1 - noteIndex]?.[member] ?? layer;
    return { ...layer, frequency: source.glideTo, glideTo: source.frequency };
  });
  return { ...recipe, layers };
}

/**
 * Build `recipe`'s graph on `ctx`, feeding `destination`, starting at context
 * time `when`. `volume` scales the whole tone. Returns the context time at
 * which the tone has fully decayed.
 */
export function scheduleTone(
  ctx: BaseAudioContext,
  destination: AudioNode,
  recipe: ToneRecipe,
  when: number,
  volume = 1,
): number {
  const master = ctx.createGain();
  master.gain.value = recipe.gain * volume * MIX_HEADROOM;
  master.connect(destination);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = recipe.filterHz;
  filter.Q.value = 0.7;
  filter.connect(master);

  const end = when + toneDurationSec(recipe);

  if (hasEcho(recipe)) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = recipe.echoMs / 1000;
    const feedback = ctx.createGain();
    feedback.gain.value = recipe.echoFeedback;
    const wet = ctx.createGain();
    wet.gain.value = recipe.echoMix;
    filter.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(master);
  }

  for (const layer of recipe.layers) {
    const t0 = when + layer.startMs / 1000;
    const peakAt = t0 + layer.attackMs / 1000;
    const silentAt = peakAt + layer.decayMs / 1000;

    const osc = ctx.createOscillator();
    osc.type = layer.waveform;
    osc.detune.value = layer.detuneCents;
    osc.frequency.setValueAtTime(layer.frequency, t0);
    if (layer.glideTo !== layer.frequency) {
      osc.frequency.exponentialRampToValueAtTime(layer.glideTo, silentAt);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(Math.max(layer.gain, 0.0001), peakAt);
    env.gain.exponentialRampToValueAtTime(0.0001, silentAt);

    osc.connect(env);
    env.connect(filter);
    osc.start(t0);
    osc.stop(silentAt + 0.02);
  }

  return end;
}

/**
 * Render `recipe` offline to mono samples, for drawing its waveform.
 * Resolves `null` where the browser has no `OfflineAudioContext`.
 */
export async function renderTone(
  recipe: ToneRecipe,
  sampleRate = 22050,
): Promise<Float32Array | null> {
  if (typeof OfflineAudioContext === "undefined") {
    return null;
  }
  const frames = Math.max(1, Math.ceil(toneDurationSec(recipe) * sampleRate));
  const ctx = new OfflineAudioContext(1, frames, sampleRate);
  scheduleTone(ctx, ctx.destination, recipe, 0);
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

let liveContext: AudioContext | null = null;

function getLiveContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (liveContext) {
    return liveContext;
  }
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  liveContext = new Ctor();
  return liveContext;
}

/**
 * Create and resume the shared tone context from inside a user gesture, so a
 * cue played later, outside any gesture (a call's end tone), is not refused by
 * the autoplay policy. Safe to call repeatedly.
 */
export function prewarmToneContext(): void {
  try {
    const ctx = getLiveContext();
    if (ctx && ctx.state !== "running") {
      void ctx.resume();
    }
  } catch {
    // No Web Audio, or the context was refused; the cue is simply skipped.
  }
}

/**
 * Play `recipe` through the default output. Never throws: autoplay policy can
 * refuse audio before the page has had a user gesture, and a missed UI tone is
 * not worth surfacing.
 */
export async function playTone(recipe: ToneRecipe, volume = 1): Promise<void> {
  try {
    const ctx = getLiveContext();
    if (!ctx) {
      return;
    }
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    scheduleTone(ctx, ctx.destination, recipe, ctx.currentTime + 0.01, volume);
  } catch {
    // Autoplay can be blocked until the user interacts with the page.
  }
}

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

/** Nearest equal-tempered note name for a frequency, e.g. `440` is `A4`. */
export function noteNameForFrequency(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${Math.floor(midi / 12) - 1}`;
}
