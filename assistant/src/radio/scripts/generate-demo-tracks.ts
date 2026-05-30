import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sampleRate = 22_050;
const durationSeconds = 18;
const sampleCount = sampleRate * durationSeconds;
const channelCount = 1;
const bytesPerSample = 2;
const bitsPerSample = 16;

interface OscillatorLayer {
  semitone: number;
  gain: number;
  waveform: "sine" | "triangle" | "square";
}

interface DemoTrackSpec {
  filename: string;
  bpm: number;
  rootMidi: number;
  progression: readonly (readonly number[])[];
  bassPattern: readonly (number | null)[];
  melodyPattern: readonly (number | null)[];
  chordLayers: readonly OscillatorLayer[];
  groove: "straight" | "shuffle" | "bounce";
}

const trackSpecs: readonly DemoTrackSpec[] = [
  {
    filename: "soft-launch.wav",
    bpm: 116,
    rootMidi: 57,
    groove: "bounce",
    progression: [
      [0, 4, 7, 11],
      [5, 9, 12, 16],
      [7, 11, 14, 17],
      [4, 7, 11, 14],
    ],
    bassPattern: [0, null, 0, 7, 5, null, 7, null],
    melodyPattern: [12, 14, 16, null, 19, 16, 14, null, 12, null, 11, 12],
    chordLayers: [
      { semitone: 0, gain: 0.08, waveform: "triangle" },
      { semitone: 12, gain: 0.05, waveform: "sine" },
    ],
  },
  {
    filename: "buffer-bloom.wav",
    bpm: 124,
    rootMidi: 50,
    groove: "straight",
    progression: [
      [0, 3, 7, 10],
      [7, 10, 14, 17],
      [5, 8, 12, 15],
      [10, 14, 17, 21],
    ],
    bassPattern: [0, 0, null, 7, 5, null, 3, 7],
    melodyPattern: [15, null, 17, 19, 22, null, 19, 17, 15, 12, null, 10],
    chordLayers: [
      { semitone: 0, gain: 0.07, waveform: "square" },
      { semitone: 12, gain: 0.045, waveform: "triangle" },
    ],
  },
  {
    filename: "neon-postcard.wav",
    bpm: 104,
    rootMidi: 62,
    groove: "shuffle",
    progression: [
      [0, 4, 7, 12],
      [-2, 2, 5, 9],
      [5, 9, 12, 16],
      [7, 11, 14, 19],
    ],
    bassPattern: [0, null, 7, null, -2, 0, null, 5],
    melodyPattern: [19, 16, 14, null, 12, 14, 16, null, 21, 19, 16, 14],
    chordLayers: [
      { semitone: 0, gain: 0.075, waveform: "triangle" },
      { semitone: 12, gain: 0.05, waveform: "sine" },
    ],
  },
];

function sine(phase: number): number {
  return Math.sin(phase * Math.PI * 2);
}

function triangle(phase: number): number {
  return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
}

function square(phase: number): number {
  return phase % 1 < 0.5 ? 1 : -1;
}

function oscillator(
  waveform: OscillatorLayer["waveform"],
  phase: number,
): number {
  switch (waveform) {
    case "triangle":
      return triangle(phase);
    case "square":
      return square(phase);
    case "sine":
      return sine(phase);
  }
}

function midiToFrequency(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

function pluckEnvelope(
  ageSeconds: number,
  attackSeconds: number,
  decaySeconds: number,
): number {
  if (ageSeconds < 0) {
    return 0;
  }

  if (ageSeconds < attackSeconds) {
    return ageSeconds / attackSeconds;
  }

  return Math.exp(-(ageSeconds - attackSeconds) / decaySeconds);
}

function patternValue<T>(pattern: readonly T[], stepIndex: number): T {
  return pattern[stepIndex % pattern.length]!;
}

function deterministicNoise(sampleIndex: number, seed: number): number {
  const raw =
    Math.sin((sampleIndex + 1) * (12.9898 + seed) + seed * 78.233) *
    43_758.5453;

  return (raw - Math.floor(raw)) * 2 - 1;
}

function noteSample({
  frequency,
  gain,
  waveform,
  timeSeconds,
  ageSeconds,
  attackSeconds,
  decaySeconds,
}: {
  frequency: number;
  gain: number;
  waveform: OscillatorLayer["waveform"];
  timeSeconds: number;
  ageSeconds: number;
  attackSeconds: number;
  decaySeconds: number;
}): number {
  const envelopeValue = pluckEnvelope(ageSeconds, attackSeconds, decaySeconds);
  const phase = (timeSeconds * frequency) % 1;

  return oscillator(waveform, phase) * envelopeValue * gain;
}

function renderChord(
  spec: DemoTrackSpec,
  timeSeconds: number,
  beat: number,
): number {
  const chordStep = Math.floor(beat / 2);
  const chordStartBeat = chordStep * 2;
  const ageSeconds = ((beat - chordStartBeat) * 60) / spec.bpm;
  const chord =
    spec.progression[Math.floor(chordStartBeat / 4) % spec.progression.length]!;
  const accent = spec.groove === "bounce" && chordStep % 2 === 1 ? 0.72 : 1;

  return chord.reduce((sum, semitone) => {
    return (
      sum +
      spec.chordLayers.reduce((layerSum, layer) => {
        const frequency = midiToFrequency(
          spec.rootMidi + semitone + layer.semitone,
        );

        return (
          layerSum +
          noteSample({
            frequency,
            gain: layer.gain * accent,
            waveform: layer.waveform,
            timeSeconds,
            ageSeconds,
            attackSeconds: 0.012,
            decaySeconds: 0.38,
          })
        );
      }, 0)
    );
  }, 0);
}

function renderBass(
  spec: DemoTrackSpec,
  timeSeconds: number,
  beat: number,
): number {
  const step = Math.floor(beat * 2);
  const semitone = patternValue(spec.bassPattern, step);

  if (semitone === null) {
    return 0;
  }

  const ageSeconds = ((beat * 2 - step) * 60) / (spec.bpm * 2);
  const frequency = midiToFrequency(spec.rootMidi + semitone - 24);

  return noteSample({
    frequency,
    gain: 0.28,
    waveform: "triangle",
    timeSeconds,
    ageSeconds,
    attackSeconds: 0.008,
    decaySeconds: 0.18,
  });
}

function renderMelody(
  spec: DemoTrackSpec,
  timeSeconds: number,
  beat: number,
): number {
  const currentStep = Math.floor(beat * 2);
  const swingOffset =
    spec.groove === "shuffle" && currentStep % 2 === 1 ? 0.12 : 0;
  const melodyBeat = beat - swingOffset;
  const step = Math.floor(melodyBeat * 2);
  const semitone = patternValue(spec.melodyPattern, step);

  if (semitone === null) {
    return 0;
  }

  const ageSeconds = ((melodyBeat * 2 - step) * 60) / (spec.bpm * 2);
  const frequency = midiToFrequency(spec.rootMidi + semitone);

  return (
    noteSample({
      frequency,
      gain: 0.12,
      waveform: "sine",
      timeSeconds,
      ageSeconds,
      attackSeconds: 0.018,
      decaySeconds: 0.23,
    }) +
    noteSample({
      frequency: frequency * 2,
      gain: 0.025,
      waveform: "triangle",
      timeSeconds,
      ageSeconds,
      attackSeconds: 0.018,
      decaySeconds: 0.16,
    })
  );
}

function renderDrums(
  spec: DemoTrackSpec,
  timeSeconds: number,
  beat: number,
  sampleIndex: number,
): number {
  const beatStep = Math.floor(beat);
  const beatAge = ((beat - beatStep) * 60) / spec.bpm;
  const halfStep = Math.floor(beat * 2);
  const halfAge = ((beat * 2 - halfStep) * 60) / (spec.bpm * 2);
  const barBeat = beatStep % 4;
  let sample = 0;

  if (
    barBeat === 0 ||
    barBeat === 2 ||
    (spec.groove === "straight" && barBeat === 3)
  ) {
    const kickEnv = pluckEnvelope(beatAge, 0.004, 0.12);
    const kickFrequency = 46 + 72 * Math.exp(-beatAge / 0.045);
    sample += sine(timeSeconds * kickFrequency) * kickEnv * 0.58;
  }

  if (barBeat === 1 || barBeat === 3) {
    const snareEnv = pluckEnvelope(beatAge, 0.003, 0.075);
    const snareNoise = deterministicNoise(sampleIndex, 2.4);
    sample += snareNoise * snareEnv * 0.16;
    sample += sine(timeSeconds * 178) * snareEnv * 0.12;
  }

  const hatEnv = pluckEnvelope(halfAge, 0.002, 0.035);
  sample += deterministicNoise(sampleIndex, 8.8) * hatEnv * 0.055;

  return sample;
}

function masterEnvelope(timeSeconds: number): number {
  const attackSeconds = 0.08;
  const releaseSeconds = 0.35;
  const releaseStart = durationSeconds - releaseSeconds;

  if (timeSeconds < attackSeconds) {
    return timeSeconds / attackSeconds;
  }

  if (timeSeconds > releaseStart) {
    return Math.max(0, (durationSeconds - timeSeconds) / releaseSeconds);
  }

  return 1;
}

function renderSample(spec: DemoTrackSpec, sampleIndex: number): number {
  const timeSeconds = sampleIndex / sampleRate;
  const beat = (timeSeconds * spec.bpm) / 60;
  const mix =
    renderDrums(spec, timeSeconds, beat, sampleIndex) +
    renderBass(spec, timeSeconds, beat) +
    renderChord(spec, timeSeconds, beat) +
    renderMelody(spec, timeSeconds, beat);

  return Math.tanh(mix * 1.4) * masterEnvelope(timeSeconds);
}

function buildWav(spec: DemoTrackSpec): Buffer {
  const dataByteLength = sampleCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataByteLength);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataByteLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataByteLength, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, renderSample(spec, index)));
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }

  return buffer;
}

const outputDir = join(import.meta.dirname, "..", "assets");
mkdirSync(outputDir, { recursive: true });

for (const spec of trackSpecs) {
  writeFileSync(join(outputDir, spec.filename), buildWav(spec));
}
