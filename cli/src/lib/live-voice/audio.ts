export const LIVE_VOICE_PCM_SAMPLE_RATE = 16_000;
export const LIVE_VOICE_PCM_CHANNELS = 1;
export const LIVE_VOICE_PCM_BYTES_PER_SAMPLE = 2;
export const LIVE_VOICE_PCM_FRAME_DURATION_MS = 50;
export const LIVE_VOICE_PCM_FRAME_BYTES =
  (LIVE_VOICE_PCM_SAMPLE_RATE *
    LIVE_VOICE_PCM_CHANNELS *
    LIVE_VOICE_PCM_BYTES_PER_SAMPLE *
    LIVE_VOICE_PCM_FRAME_DURATION_MS) /
  1_000;
export const LIVE_VOICE_PCM_MIME_TYPE = "audio/pcm";

export type LiveVoiceAudioDirection = "input" | "output";

export interface LiveVoiceAudioDevice {
  direction: LiveVoiceAudioDirection;
  nodeName: string;
  objectSerial: string;
  description: string;
  mediaClass: string;
  objectId?: number;
  moduleId?: number;
}

export interface LiveVoiceAudioDevices {
  inputs: LiveVoiceAudioDevice[];
  outputs: LiveVoiceAudioDevice[];
}

export interface LiveVoiceAudioDeviceDiscovery {
  discoverDevices(): Promise<LiveVoiceAudioDevices>;
}

export type LiveVoiceAudioDoctorStatus = "pass" | "warning" | "fail" | "skip";

export interface LiveVoiceAudioDoctorCheck {
  id: string;
  status: LiveVoiceAudioDoctorStatus;
  message: string;
}

export interface LiveVoiceAudioDoctorOptions {
  inputDevice?: string;
  outputDevice?: string;
  probeDurationMs?: number;
}

export interface LiveVoiceAudioDoctorReport {
  ok: boolean;
  checks: LiveVoiceAudioDoctorCheck[];
  devices: LiveVoiceAudioDevices;
}

export interface LiveVoiceAudioDiagnostics {
  doctor(
    options?: LiveVoiceAudioDoctorOptions,
  ): Promise<LiveVoiceAudioDoctorReport>;
}

export interface LiveVoicePcmCaptureOptions {
  target?: string;
  onFrame(frame: Buffer, rmsAmplitude: number): void;
}

export interface LiveVoicePcmCaptureSession {
  readonly closed: Promise<void>;
  setMuted(muted: boolean): void;
  stop(): Promise<Buffer | null>;
}

export interface LiveVoicePcmCapture {
  startCapture(
    options: LiveVoicePcmCaptureOptions,
  ): Promise<LiveVoicePcmCaptureSession>;
}

export interface LiveVoicePlaybackChunk {
  audio: Buffer;
  mimeType: string;
  sampleRate: number;
  provider?: string;
}

export interface LiveVoicePcmPlayback {
  write(chunk: LiveVoicePlaybackChunk): Promise<void>;
  drain(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LiveVoicePcmPlaybackFactory {
  createPlayback(target?: string): LiveVoicePcmPlayback;
}

export class PcmFrameRechunker {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array, muted = false): Buffer[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    const incoming = Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    );
    const combined =
      this.pending.length === 0
        ? Buffer.from(incoming)
        : Buffer.concat([this.pending, incoming]);
    const completeFrameBytes =
      Math.floor(combined.length / LIVE_VOICE_PCM_FRAME_BYTES) *
      LIVE_VOICE_PCM_FRAME_BYTES;
    const frames: Buffer[] = [];

    for (
      let offset = 0;
      offset < completeFrameBytes;
      offset += LIVE_VOICE_PCM_FRAME_BYTES
    ) {
      frames.push(
        muted
          ? Buffer.alloc(LIVE_VOICE_PCM_FRAME_BYTES)
          : Buffer.from(
              combined.subarray(offset, offset + LIVE_VOICE_PCM_FRAME_BYTES),
            ),
      );
    }

    this.pending = Buffer.from(combined.subarray(completeFrameBytes));
    return frames;
  }

  flush(muted = false): Buffer | null {
    const alignedBytes =
      this.pending.length -
      (this.pending.length % LIVE_VOICE_PCM_BYTES_PER_SAMPLE);
    const tail =
      alignedBytes === 0
        ? null
        : muted
          ? Buffer.alloc(alignedBytes)
          : Buffer.from(this.pending.subarray(0, alignedBytes));
    this.pending = Buffer.alloc(0);
    return tail;
  }
}

export function pcm16Rms(pcm: Uint8Array): number {
  const sampleCount = Math.floor(
    pcm.byteLength / LIVE_VOICE_PCM_BYTES_PER_SAMPLE,
  );
  if (sampleCount === 0) {
    return 0;
  }

  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = bytes.readInt16LE(index * LIVE_VOICE_PCM_BYTES_PER_SAMPLE);
    const normalized = sample / 32_768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export interface EchoAmplitudeSample {
  microphone: number;
  playback: number;
}

export interface EchoMeasurementSummary {
  sampleCount: number;
  microphoneFloor: number | null;
  meanMicrophoneDuringPlayback: number;
  peakMicrophoneDuringPlayback: number;
  decibelsAboveFloor: number | null;
  playbackMicrophoneCorrelation: number | null;
}

export interface EchoMeasurementOptions {
  audibleThreshold?: number;
}

export class EchoMeasurement {
  private readonly audibleThreshold: number;
  private floorCount = 0;
  private floorSum = 0;
  private active = false;
  private sampleCount = 0;
  private microphoneSum = 0;
  private microphonePeak = 0;
  private playbackSum = 0;
  private playbackSquares = 0;
  private microphoneSquares = 0;
  private productSum = 0;
  private utteranceFloor: number | null = null;

  constructor(options: EchoMeasurementOptions = {}) {
    this.audibleThreshold = options.audibleThreshold ?? 1e-6;
  }

  addSample(sample: EchoAmplitudeSample): EchoMeasurementSummary | null {
    const microphone = sanitizeAmplitude(sample.microphone);
    const playback = sanitizeAmplitude(sample.playback);
    const audible = playback > this.audibleThreshold;

    if (!audible) {
      if (this.active) {
        const summary = this.finishUtterance();
        this.addFloorSample(microphone);
        return summary;
      }
      this.addFloorSample(microphone);
      return null;
    }

    if (!this.active) {
      this.active = true;
      this.utteranceFloor =
        this.floorCount === 0 ? null : this.floorSum / this.floorCount;
    }

    this.sampleCount += 1;
    this.microphoneSum += microphone;
    this.microphonePeak = Math.max(this.microphonePeak, microphone);
    this.playbackSum += playback;
    this.playbackSquares += playback * playback;
    this.microphoneSquares += microphone * microphone;
    this.productSum += playback * microphone;
    return null;
  }

  reset(): void {
    this.floorCount = 0;
    this.floorSum = 0;
    this.resetUtterance();
  }

  private addFloorSample(microphone: number): void {
    this.floorCount += 1;
    this.floorSum += microphone;
  }

  private finishUtterance(): EchoMeasurementSummary {
    const meanMicrophone =
      this.sampleCount === 0 ? 0 : this.microphoneSum / this.sampleCount;
    const floor = this.utteranceFloor;
    const decibelsAboveFloor =
      floor === null
        ? null
        : 20 *
          Math.log10(
            Math.max(meanMicrophone, Number.EPSILON) /
              Math.max(floor, Number.EPSILON),
          );
    const correlation = pearsonCorrelationFromSums({
      count: this.sampleCount,
      sumX: this.playbackSum,
      sumY: this.microphoneSum,
      sumXX: this.playbackSquares,
      sumYY: this.microphoneSquares,
      sumXY: this.productSum,
    });
    const summary: EchoMeasurementSummary = {
      sampleCount: this.sampleCount,
      microphoneFloor: floor,
      meanMicrophoneDuringPlayback: meanMicrophone,
      peakMicrophoneDuringPlayback: this.microphonePeak,
      decibelsAboveFloor,
      playbackMicrophoneCorrelation: correlation,
    };
    this.floorCount = 0;
    this.floorSum = 0;
    this.resetUtterance();
    return summary;
  }

  private resetUtterance(): void {
    this.active = false;
    this.sampleCount = 0;
    this.microphoneSum = 0;
    this.microphonePeak = 0;
    this.playbackSum = 0;
    this.playbackSquares = 0;
    this.microphoneSquares = 0;
    this.productSum = 0;
    this.utteranceFloor = null;
  }
}

function sanitizeAmplitude(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

interface CorrelationSums {
  count: number;
  sumX: number;
  sumY: number;
  sumXX: number;
  sumYY: number;
  sumXY: number;
}

function pearsonCorrelationFromSums(sums: CorrelationSums): number | null {
  if (sums.count < 2) {
    return null;
  }

  const numerator = sums.count * sums.sumXY - sums.sumX * sums.sumY;
  const xVariance = sums.count * sums.sumXX - sums.sumX * sums.sumX;
  const yVariance = sums.count * sums.sumYY - sums.sumY * sums.sumY;
  const denominator = Math.sqrt(xVariance * yVariance);
  if (denominator <= Number.EPSILON) {
    return null;
  }
  return Math.max(-1, Math.min(1, numerator / denominator));
}
