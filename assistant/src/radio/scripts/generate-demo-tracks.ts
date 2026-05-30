import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sampleRate = 22_050;
const durationSeconds = 18;
const sampleCount = sampleRate * durationSeconds;
const channelCount = 1;
const bytesPerSample = 2;
const bitsPerSample = 16;

interface OscillatorLayer {
  frequency: number;
  gain: number;
  waveform: "sine" | "triangle";
  detune?: number;
}

interface DemoTrackSpec {
  filename: string;
  layers: readonly OscillatorLayer[];
  pulseHz: number;
  warmth: number;
}

const trackSpecs: readonly DemoTrackSpec[] = [
  {
    filename: "soft-launch.wav",
    pulseHz: 0.4,
    warmth: 0.08,
    layers: [
      { frequency: 220, gain: 0.22, waveform: "sine" },
      { frequency: 329.63, gain: 0.16, waveform: "triangle" },
      { frequency: 440, gain: 0.12, waveform: "sine", detune: 0.6 },
    ],
  },
  {
    filename: "buffer-bloom.wav",
    pulseHz: 0.55,
    warmth: 0.11,
    layers: [
      { frequency: 196, gain: 0.2, waveform: "triangle" },
      { frequency: 293.66, gain: 0.18, waveform: "sine" },
      { frequency: 392, gain: 0.13, waveform: "sine", detune: -0.8 },
    ],
  },
  {
    filename: "neon-postcard.wav",
    pulseHz: 0.7,
    warmth: 0.06,
    layers: [
      { frequency: 246.94, gain: 0.18, waveform: "sine" },
      { frequency: 369.99, gain: 0.16, waveform: "triangle" },
      { frequency: 493.88, gain: 0.14, waveform: "sine", detune: 1.1 },
    ],
  },
];

function sine(phase: number): number {
  return Math.sin(phase * Math.PI * 2);
}

function triangle(phase: number): number {
  return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
}

function envelope(timeSeconds: number): number {
  const attackSeconds = 1.2;
  const releaseSeconds = 2.0;
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
  const slowPulse = 0.78 + 0.22 * sine(timeSeconds * spec.pulseHz);
  const shimmer = spec.warmth * sine(timeSeconds * 0.125);
  const layeredSample = spec.layers.reduce((sum, layer) => {
    const frequency = layer.frequency + (layer.detune ?? 0);
    const phase = (timeSeconds * frequency) % 1;
    const wave = layer.waveform === "triangle" ? triangle(phase) : sine(phase);

    return sum + wave * layer.gain;
  }, 0);

  return layeredSample * slowPulse * envelope(timeSeconds) + shimmer;
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
