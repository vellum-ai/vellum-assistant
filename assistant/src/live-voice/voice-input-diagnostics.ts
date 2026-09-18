export interface VoiceInputSample {
  receivedAtMs: number;
  chunkMs: number;
  meanAmplitude: number;
  baseThreshold: number;
  roomNoiseFloor: number | null;
  echoEnergy: number;
  echoOnsetLapsed: boolean;
  echoWindowMs: number;
  echoGuardCarryover: boolean;
  echoReferenceMs: number;
  echoProbeMs: number;
  echoCorrelation: number | null;
  playbackRemainingMs: number;
  playbackEchoPossible: boolean;
  speechMs: number;
  silenceMs: number;
  echoMs: number;
}

const SUMMARY_INTERVAL_MS = 5_000;
const TRACE_WINDOW_MS = 2_000;
const MAX_TRACE_SAMPLES = 40;

/** Bounded signal measurements only. Never retains PCM or transcript text. */
export class VoiceInputDiagnostics {
  private recent: VoiceInputSample[] = [];
  private lastArrivalAtMs: number | null = null;
  private lastSttSubmissionAtMs: number | null = null;
  private window = this.emptyWindow();

  recordSttSubmission(atMs: number, audioMs: number): void {
    this.window.sttSubmittedChunks += 1;
    this.window.sttSubmittedAudioMs += audioMs;
    if (this.lastSttSubmissionAtMs !== null) {
      this.window.sttMaxSubmissionGapMs = Math.max(
        this.window.sttMaxSubmissionGapMs,
        atMs - this.lastSttSubmissionAtMs,
      );
    }
    this.lastSttSubmissionAtMs = atMs;
  }

  observe(sample: VoiceInputSample): Record<string, number> | null {
    this.recent.push(sample);
    while (
      this.recent.length > MAX_TRACE_SAMPLES ||
      (this.recent[0] &&
        sample.receivedAtMs - this.recent[0].receivedAtMs > TRACE_WINDOW_MS)
    ) {
      this.recent.shift();
    }
    const window = this.window;
    window.firstAtMs ??= sample.receivedAtMs;
    window.lastAtMs = sample.receivedAtMs;
    window.chunks += 1;
    window.audioMs += sample.chunkMs;
    window.weightedAmplitude += sample.meanAmplitude * sample.chunkMs;
    window.minAmplitude = Math.min(window.minAmplitude, sample.meanAmplitude);
    window.maxAmplitude = Math.max(window.maxAmplitude, sample.meanAmplitude);
    window.zeroAudioMs += sample.meanAmplitude === 0 ? sample.chunkMs : 0;
    window.speechMs += sample.speechMs;
    window.silenceMs += sample.silenceMs;
    window.echoMs += sample.echoMs;
    if (this.lastArrivalAtMs !== null) {
      window.maxArrivalGapMs = Math.max(
        window.maxArrivalGapMs,
        sample.receivedAtMs - this.lastArrivalAtMs,
      );
    }
    this.lastArrivalAtMs = sample.receivedAtMs;
    return sample.receivedAtMs - window.firstAtMs >= SUMMARY_INTERVAL_MS
      ? this.flush()
      : null;
  }

  snapshot(nowMs: number): VoiceInputSample[] {
    return this.recent
      .filter((entry) => nowMs - entry.receivedAtMs <= TRACE_WINDOW_MS)
      .map((entry) => ({ ...entry }));
  }

  flush(): Record<string, number> | null {
    const window = this.window;
    if (window.chunks === 0) {
      return null;
    }
    this.window = this.emptyWindow();
    const { weightedAmplitude, firstAtMs, ...summary } = window;
    return {
      ...summary,
      firstAtMs: firstAtMs!,
      meanAmplitude:
        window.audioMs > 0 ? weightedAmplitude / window.audioMs : 0,
    };
  }

  private emptyWindow() {
    return {
      firstAtMs: null as number | null,
      lastAtMs: 0,
      chunks: 0,
      audioMs: 0,
      weightedAmplitude: 0,
      minAmplitude: Infinity,
      maxAmplitude: 0,
      zeroAudioMs: 0,
      speechMs: 0,
      silenceMs: 0,
      echoMs: 0,
      maxArrivalGapMs: 0,
      sttSubmittedChunks: 0,
      sttSubmittedAudioMs: 0,
      sttMaxSubmissionGapMs: 0,
    };
  }
}
