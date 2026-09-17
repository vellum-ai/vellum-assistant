import { describe, expect, test } from "bun:test";

import {
  VoiceInputDiagnostics,
  type VoiceInputSample,
} from "../voice-input-diagnostics.js";

function sample(
  receivedAtMs: number,
  overrides: Partial<VoiceInputSample> = {},
): VoiceInputSample {
  return {
    receivedAtMs,
    chunkMs: 50,
    meanAmplitude: 100,
    baseThreshold: 800,
    roomNoiseFloor: null,
    echoEnergy: 0,
    echoOnsetLapsed: false,
    echoWindowMs: 0,
    echoGuardCarryover: false,
    echoReferenceMs: 0,
    echoProbeMs: 0,
    echoCorrelation: null,
    playbackRemainingMs: 0,
    playbackEchoPossible: false,
    speechMs: 0,
    silenceMs: 50,
    echoMs: 0,
    ...overrides,
  };
}

describe("voice input diagnostics", () => {
  test("distinguishes arriving audio from gaps in submission to STT", () => {
    const diagnostics = new VoiceInputDiagnostics();
    diagnostics.observe(sample(0));
    diagnostics.recordSttSubmission(0, 50);
    diagnostics.observe(sample(50));
    diagnostics.observe(sample(100));
    diagnostics.recordSttSubmission(100, 50);
    expect(diagnostics.flush()).toMatchObject({
      chunks: 3,
      audioMs: 150,
      maxArrivalGapMs: 50,
      sttSubmittedChunks: 2,
      sttSubmittedAudioMs: 100,
      sttMaxSubmissionGapMs: 100,
    });
    diagnostics.observe(sample(150));
    diagnostics.recordSttSubmission(150, 50);
    expect(diagnostics.flush()).toMatchObject({
      sttSubmittedChunks: 1,
      sttSubmittedAudioMs: 50,
      sttMaxSubmissionGapMs: 50,
    });
  });
  test("bounds traces by count and age, including burst arrivals", () => {
    const diagnostics = new VoiceInputDiagnostics();
    for (let index = 0; index < 100; index++) {
      diagnostics.observe(sample(index));
    }
    const trace = diagnostics.snapshot(100);
    expect(trace).toHaveLength(40);
    expect(trace[0]?.receivedAtMs).toBe(60);
    trace[0]!.meanAmplitude = 999;
    expect(diagnostics.snapshot(100)[0]?.meanAmplitude).toBe(100);
    expect(diagnostics.snapshot(2_100)).toEqual([]);
  });

  test("weights levels by audio duration and distinguishes silence from missing audio", () => {
    const diagnostics = new VoiceInputDiagnostics();
    expect(diagnostics.observe(sample(0, { meanAmplitude: 0 }))).toBeNull();
    const summary = diagnostics.observe(
      sample(5_000, {
        chunkMs: 150,
        meanAmplitude: 2_000,
        speechMs: 150,
        silenceMs: 0,
      }),
    );
    expect(summary).toMatchObject({
      firstAtMs: 0,
      lastAtMs: 5_000,
      audioMs: 200,
      chunks: 2,
      meanAmplitude: 1_500,
      minAmplitude: 0,
      maxAmplitude: 2_000,
      zeroAudioMs: 50,
      maxArrivalGapMs: 5_000,
      speechMs: 150,
      silenceMs: 50,
    });
    expect(diagnostics.flush()).toBeNull();
    diagnostics.observe(sample(5_050));
    expect(diagnostics.flush()).toMatchObject({
      chunks: 1,
      audioMs: 50,
      maxArrivalGapMs: 50,
    });
  });

  test("keeps buffered echo-probe decisions distinct from newly received audio", () => {
    const diagnostics = new VoiceInputDiagnostics();
    diagnostics.observe(sample(0, { silenceMs: 0, echoProbeMs: 50 }));
    diagnostics.observe(
      sample(50, { silenceMs: 0, echoMs: 100, echoCorrelation: 0.9 }),
    );
    expect(diagnostics.flush()).toMatchObject({
      audioMs: 100,
      echoMs: 100,
      silenceMs: 0,
    });
    expect(diagnostics.snapshot(50)[1]?.echoCorrelation).toBe(0.9);
  });
});
