/// <reference lib="webworker" />

/**
 * AudioWorklet processor: downsamples the AudioContext's native sample rate to
 * 16 kHz mono and converts Float32 samples to little-endian Int16 PCM, posting
 * each chunk to the main thread.
 *
 * The output contract — `audio/pcm`, 16000 Hz, mono, signed 16-bit LE — matches
 * what the live-voice runtime `start` frame declares. Keep it in sync with the
 * `TARGET_SAMPLE_RATE` consumed by `pcm-capture.ts`.
 *
 * This file is loaded as a classic AudioWorklet module (not bundled with the
 * app graph). It runs on the audio render thread, so it only references the
 * `AudioWorkletProcessor` globals available there — no DOM, no app imports.
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
 */

const TARGET_SAMPLE_RATE = 16000;

// AudioWorkletGlobalScope globals. They are not in the default DOM lib, so
// declare the minimal surface this processor relies on. `sampleRate` is the
// render-thread context rate; `registerProcessor` registers the node.
declare const sampleRate: number;
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessorLike,
): void;

interface AudioWorkletProcessorLike {
  readonly port: MessagePort;
  process(inputs: Float32Array[][]): boolean;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorLike;
  new (): AudioWorkletProcessorLike;
};

/**
 * Linear-decimation downsampler. The context rate is typically 48000 or 44100,
 * so we resample to 16000 by walking the input at a fractional step and picking
 * the nearest source sample. Good enough for speech; the runtime STT is robust
 * to mild aliasing and this avoids an FIR filter on the audio thread.
 *
 * The per-sample Float32 -> Int16 conversion math is mirrored by the pure,
 * unit-tested `downsampleToInt16` helper in `pcm-capture.ts`. This processor
 * keeps its own copy because it must also carry the fractional read position
 * (`readPos`) across render quanta — which a stateless helper cannot — and
 * because it cannot import DOM-coupled main-thread code onto the audio thread.
 * Keep the two in sync.
 */
class PcmDownsampleProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / TARGET_SAMPLE_RATE;
  // Carries the fractional read position across render quanta so chunk
  // boundaries don't drop or duplicate samples.
  private readPos = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    // No input (node not yet connected, or upstream ended): keep the
    // processor alive but emit nothing.
    if (!channel || channel.length === 0) return true;

    const outLength = Math.floor((channel.length - this.readPos) / this.ratio);
    if (outLength <= 0) {
      this.readPos -= channel.length;
      return true;
    }

    const pcm = new Int16Array(outLength);
    let pos = this.readPos;
    for (let i = 0; i < outLength; i++) {
      const sample = channel[Math.floor(pos)] ?? 0;
      // Clamp to [-1, 1] then scale to signed 16-bit range.
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      pos += this.ratio;
    }
    // Preserve the leftover fractional offset relative to the next buffer.
    this.readPos = pos - channel.length;

    // Transfer the underlying buffer to avoid a copy on the main thread.
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-downsample", PcmDownsampleProcessor);

export {};
