/**
 * Tests for the rolling amplitude history.
 *
 * This is the substrate that makes the reactive voice visuals reactive: the
 * ring buffer whose contents *are* the rendered terrain. Its two contracts are
 * that samples come back oldest-first (so the terrain scrolls the right way)
 * and that the buffer advances on wall-clock time rather than per call (so the
 * scroll rate does not change with the display's refresh rate).
 */

import { describe, expect, test } from "bun:test";

import { createAmplitudeHistory } from "./voice-amplitude-history";

/** Read the whole buffer with no smoothing. */
function snapshot(
  history: ReturnType<typeof createAmplitudeHistory>,
): number[] {
  const out = new Float32Array(history.size);
  history.read(out);
  return Array.from(out);
}

describe("createAmplitudeHistory", () => {
  test("starts silent", () => {
    const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
    expect(snapshot(history)).toEqual([0, 0, 0, 0]);
  });

  test("appends one sample per elapsed period, oldest first", () => {
    const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
    history.push(1, 10);
    history.push(0.5, 10);
    // Newest sample lands at the right edge, which is where new energy enters.
    expect(snapshot(history)).toEqual([0, 0, 1, 0.5]);
  });

  test("does not advance until a full period has elapsed", () => {
    const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
    history.push(1, 4);
    expect(snapshot(history)).toEqual([0, 0, 0, 0]);
    history.push(1, 4);
    expect(snapshot(history)).toEqual([0, 0, 0, 0]);
    // 4 + 4 + 4 = 12 ms crosses the 10 ms boundary; the remainder carries over.
    history.push(1, 4);
    expect(snapshot(history)).toEqual([0, 0, 0, 1]);
  });

  test("a long frame gap advances by the time actually elapsed", () => {
    const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
    history.push(1, 10);
    // A dropped frame worth 3 periods must not scroll only one step, or the
    // terrain would lag behind the audio it is supposed to be a record of.
    history.push(0.25, 30);
    expect(snapshot(history)).toEqual([1, 0.25, 0.25, 0.25]);
  });

  test("caps catch-up at one full buffer", () => {
    const history = createAmplitudeHistory({ size: 4, periodMs: 10 });
    // A backgrounded tab resuming after a minute: the whole window is the same
    // value either way, so this must stay O(size), not O(elapsed).
    history.push(0.5, 60_000);
    expect(snapshot(history)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  test("overwrites oldest samples once full", () => {
    const history = createAmplitudeHistory({ size: 3, periodMs: 10 });
    for (const amp of [1, 2, 3, 4]) {
      history.push(amp, 10);
    }
    expect(snapshot(history)).toEqual([2, 3, 4]);
  });

  test("ignores negative deltas", () => {
    const history = createAmplitudeHistory({ size: 3, periodMs: 10 });
    history.push(1, -50);
    expect(snapshot(history)).toEqual([0, 0, 0]);
  });

  test("smoothing averages over a centred window, clamped at the edges", () => {
    const history = createAmplitudeHistory({ size: 5, periodMs: 10 });
    for (const amp of [0, 0, 1, 0, 0]) {
      history.push(amp, 10);
    }
    const out = new Float32Array(5);
    history.read(out, 3);
    // The spike spreads into its neighbours; the ends average over what exists.
    expect(Array.from(out).map((n) => Number(n.toFixed(4)))).toEqual([
      0, 0.3333, 0.3333, 0.3333, 0,
    ]);
  });

  test("smooth = 1 is a raw read", () => {
    const history = createAmplitudeHistory({ size: 3, periodMs: 10 });
    for (const amp of [0, 1, 0]) {
      history.push(amp, 10);
    }
    const out = new Float32Array(3);
    history.read(out, 1);
    expect(Array.from(out)).toEqual([0, 1, 0]);
  });
});
