/**
 * Block-aligning carry buffer for streamed PCM chunks. Chunk boundaries can
 * split a sample (or a decimation pair) across chunks; `align` returns the
 * largest prefix of carry+chunk that is a whole number of blocks and retains
 * the remainder for the next call.
 */
interface PcmChunkAligner {
  /** Aligned prefix of carry+chunk; empty when too few bytes have arrived. */
  align(chunk: Buffer): Buffer;
  /** Bytes held as carry (non-zero at end-of-stream means a torn tail). */
  carryLength(): number;
}

export function createPcmChunkAligner(blockBytes: number): PcmChunkAligner {
  let carry: Buffer | undefined;
  return {
    align(chunk) {
      const combined = carry ? Buffer.concat([carry, chunk]) : chunk;
      const alignedLength =
        combined.byteLength - (combined.byteLength % blockBytes);
      carry =
        alignedLength < combined.byteLength
          ? combined.subarray(alignedLength)
          : undefined;
      return combined.subarray(0, alignedLength);
    },
    carryLength: () => carry?.byteLength ?? 0,
  };
}
