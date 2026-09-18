import { Buffer } from "node:buffer";

const IDLE_TIMEOUT_MS = 1_000;
const PRE_ROLL_MS = 200;

/** Gates PCM16 mono room audio while preserving the provider's audio clock. */
export class MicrophoneIdleGate {
  private readonly tailBytes: number;
  private readonly preRollBytes: number;
  private quietBytes = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(sampleRate: number) {
    this.tailBytes = Math.round((sampleRate * IDLE_TIMEOUT_MS) / 1_000) * 2;
    this.preRollBytes = Math.round((sampleRate * PRE_ROLL_MS) / 1_000) * 2;
  }

  get closed(): boolean {
    return this.quietBytes >= this.tailBytes;
  }

  process(chunk: Buffer, hasSpeech: boolean): Buffer {
    if (hasSpeech) {
      this.quietBytes = 0;
      const pending = this.pending;
      this.pending = Buffer.alloc(0);
      return pending.byteLength > 0 ? Buffer.concat([pending, chunk]) : chunk;
    }

    const passBytes = Math.min(
      chunk.byteLength,
      this.tailBytes - this.quietBytes,
    );
    this.quietBytes = Math.min(
      this.tailBytes,
      this.quietBytes + chunk.byteLength,
    );
    if (passBytes === chunk.byteLength) {
      return chunk;
    }

    // Hold only the newest onset audio. Older samples become silence before
    // submission, so reopening never replays an already-sent time interval.
    const buffered = Buffer.concat([this.pending, chunk.subarray(passBytes)]);
    const silenceBytes = Math.max(0, buffered.byteLength - this.preRollBytes);
    this.pending = Buffer.from(buffered.subarray(silenceBytes));
    const output = Buffer.alloc(passBytes + silenceBytes);
    chunk.copy(output, 0, 0, passBytes);
    return output;
  }

  reset(): void {
    this.quietBytes = 0;
    this.pending = Buffer.alloc(0);
  }
}
