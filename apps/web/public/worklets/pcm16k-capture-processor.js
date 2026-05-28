/**
 * AudioWorklet processor that captures microphone audio at the input
 * AudioContext sample rate (typically 48 kHz), downmixes to mono,
 * decimates to 16 kHz, batches into ~20 ms PCM16 LE chunks (320 samples),
 * and posts each chunk to the main thread.
 *
 * This is the web port of the macOS `LiveVoicePCM16kMonoConverter`
 * (see clients/macos/vellum-assistant/Features/Voice/LiveVoiceAudioCapture.swift).
 *
 * Loaded at runtime by `LiveVoicePcmCapture` via
 * `audioContext.audioWorklet.addModule("/worklets/pcm16k-capture-processor.js")`.
 *
 * Plain JS (no TypeScript compile) because it runs in the audio-rendering
 * worklet global scope, which has its own module loader.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TARGET_SAMPLE_RATE = 16000;
/** 20 ms at 16 kHz = 320 samples. */
const CHUNK_SAMPLES = 320;
/** Post amplitude updates at ~20 Hz (every 50 ms of input audio). */
const AMPLITUDE_INTERVAL_SECONDS = 0.05;

class Pcm16kCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Decimation ratio from the AudioContext sample rate (set by the host,
    // usually 48000) down to 16 kHz. Fractional positions are accumulated
    // across `process()` calls so we don't drift.
    this.decimationRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.nextSourcePosition = 0;

    // Ring/append buffer of decimated mono samples. We flush 320-sample
    // chunks as PCM16 LE.
    this.pendingSamples = new Float32Array(CHUNK_SAMPLES * 4);
    this.pendingCount = 0;

    // Amplitude meter: peak absolute value over a ~50 ms window.
    this.amplitudePeak = 0;
    this.amplitudeFramesAccumulated = 0;
    this.amplitudeWindowFrames = Math.max(
      1,
      Math.round(sampleRate * AMPLITUDE_INTERVAL_SECONDS),
    );
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    const frameCount = input[0]?.length ?? 0;
    if (frameCount === 0) {
      return true;
    }

    // Track peak amplitude on the input (pre-decimation) signal so the
    // meter responds to the raw mic loudness.
    for (let i = 0; i < frameCount; i++) {
      let monoSample = 0;
      for (let c = 0; c < channelCount; c++) {
        monoSample += input[c][i];
      }
      monoSample /= channelCount;

      const abs = monoSample >= 0 ? monoSample : -monoSample;
      if (abs > this.amplitudePeak) {
        this.amplitudePeak = abs;
      }
    }

    this.amplitudeFramesAccumulated += frameCount;
    if (this.amplitudeFramesAccumulated >= this.amplitudeWindowFrames) {
      const amplitude = this.amplitudePeak > 1 ? 1 : this.amplitudePeak;
      this.port.postMessage({ type: "amplitude", amplitude });
      this.amplitudePeak = 0;
      this.amplitudeFramesAccumulated = 0;
    }

    // Decimate by linear interpolation between adjacent mono samples.
    // `nextSourcePosition` is a fractional index into the current input
    // buffer; after the loop we subtract `frameCount` so the remainder
    // carries into the next callback.
    while (this.nextSourcePosition < frameCount) {
      const lowerFrame = Math.min(
        Math.floor(this.nextSourcePosition),
        frameCount - 1,
      );
      const upperFrame = Math.min(lowerFrame + 1, frameCount - 1);
      const fraction = this.nextSourcePosition - lowerFrame;

      const lowerSample = monoAt(input, lowerFrame, channelCount);
      const upperSample = monoAt(input, upperFrame, channelCount);
      const sample = lowerSample + (upperSample - lowerSample) * fraction;

      this.appendSample(sample);
      this.nextSourcePosition += this.decimationRatio;
    }
    this.nextSourcePosition -= frameCount;
    if (this.nextSourcePosition < 0) {
      this.nextSourcePosition = 0;
    }

    // Flush full 320-sample chunks. Multiple may be ready if the
    // sample rate is low enough relative to the input quantum.
    while (this.pendingCount >= CHUNK_SAMPLES) {
      const pcm16 = new Int16Array(CHUNK_SAMPLES);
      let peakAbs = 0;
      for (let i = 0; i < CHUNK_SAMPLES; i++) {
        const f = this.pendingSamples[i];
        const clamped = f < -1 ? -1 : f > 1 ? 1 : f;
        const abs = clamped >= 0 ? clamped : -clamped;
        if (abs > peakAbs) peakAbs = abs;
        const scale = clamped < 0 ? 32768 : 32767;
        pcm16[i] = Math.trunc(clamped * scale);
      }

      this.port.postMessage(
        { type: "chunk", pcm16, frameCount: CHUNK_SAMPLES, amplitude: peakAbs },
        [pcm16.buffer],
      );

      // Shift remaining samples down.
      const remaining = this.pendingCount - CHUNK_SAMPLES;
      this.pendingSamples.copyWithin(0, CHUNK_SAMPLES, this.pendingCount);
      this.pendingCount = remaining;
    }

    return true;
  }

  appendSample(sample) {
    if (this.pendingCount >= this.pendingSamples.length) {
      // Grow the buffer in chunks to avoid frequent reallocations. This
      // shouldn't normally happen at the input rates we expect, but it
      // keeps the worklet correct under bursty schedulers.
      const grown = new Float32Array(this.pendingSamples.length * 2);
      grown.set(this.pendingSamples);
      this.pendingSamples = grown;
    }
    this.pendingSamples[this.pendingCount++] = sample;
  }
}

function monoAt(input, frame, channelCount) {
  let sum = 0;
  for (let c = 0; c < channelCount; c++) {
    sum += input[c][frame];
  }
  return sum / channelCount;
}

registerProcessor("pcm16k-capture-processor", Pcm16kCaptureProcessor);
