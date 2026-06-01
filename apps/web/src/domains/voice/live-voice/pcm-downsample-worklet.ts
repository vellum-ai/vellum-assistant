/// <reference lib="webworker" />

/**
 * AudioWorklet processor: downsamples the AudioContext's native sample rate to
 * 16 kHz mono and converts Float32 samples to little-endian Int16 PCM, posting
 * each chunk to the main thread.
 *
 * The output contract — `audio/pcm`, 16000 Hz, mono, signed 16-bit LE — matches
 * what the live-voice runtime `start` frame declares.
 *
 * This file runs on the audio render thread, so it only references the
 * `AudioWorkletProcessor` globals available there — no DOM, no app imports.
 * That isolation is why `TARGET_SAMPLE_RATE` is hardcoded here rather than
 * imported: it MUST stay in sync with the canonical `LIVE_VOICE_AUDIO_FORMAT`
 * in `protocol.ts` (`sampleRate: 16000`).
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
 */

// Mirror of LIVE_VOICE_AUDIO_FORMAT.sampleRate in protocol.ts (see docblock).
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
 * The decimation loop + Float32 -> Int16 conversion lives only here (it carries
 * the fractional read position across render quanta, which a stateless helper
 * cannot, and the audio thread can't import app code). Its output is exercised
 * directly by the cross-quantum tests in `pcm-capture.test.ts`.
 */
class PcmDownsampleProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / TARGET_SAMPLE_RATE;
  // The next fractional sample position to read, expressed relative to the
  // start of the *current* render quantum. After each block we subtract the
  // block length so the offset carries forward into the next block. It stays
  // in [0, ratio) — never negative — so we never read before the buffer start
  // (which would inject artificial zeros) and never skip boundary samples.
  private readOffset = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    // No input (node not yet connected, or upstream ended): keep the
    // processor alive but emit nothing. The pending read offset is preserved.
    if (!channel || channel.length === 0) return true;

    // How many output samples this block can produce: the count of read
    // positions `readOffset, readOffset + ratio, ...` that land within
    // `[0, channel.length)`.
    const outLength = Math.ceil((channel.length - this.readOffset) / this.ratio);
    if (outLength <= 0) {
      // The next read position is past the end of this block; carry the
      // offset forward (it will still be >= 0 since outLength <= 0 implies
      // readOffset >= channel.length).
      this.readOffset -= channel.length;
      return true;
    }

    const pcm = new Int16Array(outLength);
    let pos = this.readOffset;
    for (let i = 0; i < outLength; i++) {
      const sample = channel[Math.floor(pos)] ?? 0;
      // Clamp to [-1, 1] then scale to signed 16-bit range.
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      pos += this.ratio;
    }
    // `pos` is now the next read position relative to this block's start.
    // Rebase it onto the next block so the fractional cursor is continuous and
    // no boundary samples are dropped or re-read.
    this.readOffset = pos - channel.length;

    // Transfer the underlying buffer to avoid a copy on the main thread.
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-downsample", PcmDownsampleProcessor);

export {};
