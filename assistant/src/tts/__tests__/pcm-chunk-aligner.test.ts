import { describe, expect, test } from "bun:test";

import { createPcmChunkAligner } from "../pcm-chunk-aligner.js";

describe("createPcmChunkAligner", () => {
  test("passes whole-block chunks through unchanged", () => {
    const aligner = createPcmChunkAligner(2);
    const chunk = Buffer.from([1, 2, 3, 4]);
    expect(aligner.align(chunk)).toEqual(chunk);
    expect(aligner.carryLength()).toBe(0);
  });

  test("re-joins a sample split across two chunks", () => {
    const aligner = createPcmChunkAligner(2);
    expect(aligner.align(Buffer.from([1, 2, 3]))).toEqual(Buffer.from([1, 2]));
    expect(aligner.carryLength()).toBe(1);
    expect(aligner.align(Buffer.from([4, 5, 6]))).toEqual(
      Buffer.from([3, 4, 5, 6]),
    );
    expect(aligner.carryLength()).toBe(0);
  });

  test("returns empty and carries a sub-block first chunk", () => {
    const aligner = createPcmChunkAligner(2);
    expect(aligner.align(Buffer.from([7])).byteLength).toBe(0);
    expect(aligner.carryLength()).toBe(1);
    expect(aligner.align(Buffer.from([8]))).toEqual(Buffer.from([7, 8]));
    expect(aligner.carryLength()).toBe(0);
  });

  test("aligns 4-byte decimation pairs", () => {
    const aligner = createPcmChunkAligner(4);
    expect(aligner.align(Buffer.from([1, 2, 3, 4, 5]))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(aligner.carryLength()).toBe(1);
    expect(aligner.align(Buffer.from([6, 7, 8, 9, 10]))).toEqual(
      Buffer.from([5, 6, 7, 8]),
    );
    expect(aligner.carryLength()).toBe(2);
  });

  test("keeps a dangling final byte in carry", () => {
    const aligner = createPcmChunkAligner(2);
    aligner.align(Buffer.from([1, 2, 3, 4, 5]));
    expect(aligner.carryLength()).toBe(1);
  });
});
