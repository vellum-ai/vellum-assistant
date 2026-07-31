import { describe, expect, test } from "bun:test";

import { EchoMarginProbe } from "@/domains/chat/voice/live-voice/live-voice-diagnostics";

/** Feed n samples of a constant mic/speaker pair. */
function feed(
  probe: EchoMarginProbe,
  count: number,
  mic: number,
  output: number,
): ReturnType<EchoMarginProbe["sample"]> {
  let closed: ReturnType<EchoMarginProbe["sample"]> = null;
  for (let i = 0; i < count; i++) {
    closed = probe.sample(mic, output) ?? closed;
  }
  return closed;
}

describe("EchoMarginProbe", () => {
  test("reports a near-zero margin when the mic stays at the noise floor", () => {
    const probe = new EchoMarginProbe();
    // Quiet room, then the assistant speaks while the mic hears nothing extra:
    // this is what working echo cancellation looks like.
    feed(probe, 20, 0.01, 0);
    feed(probe, 20, 0.01, 0.8);

    const summary = probe.summarize();

    expect(summary).not.toBeNull();
    expect(summary!.micDuringTts).toBeCloseTo(0.01, 4);
    expect(summary!.micFloor).toBeCloseTo(0.01, 4);
    expect(summary!.marginDb).toBeCloseTo(0, 1);
  });

  test("reports a large positive margin when the mic tracks the speaker", () => {
    const probe = new EchoMarginProbe();
    feed(probe, 20, 0.01, 0);
    // Mic rises tenfold exactly while the assistant is audible: echo.
    feed(probe, 20, 0.1, 0.8);

    const summary = probe.summarize();

    expect(summary!.marginDb).toBeCloseTo(20, 0);
    expect(summary!.micPeakDuringTts).toBeCloseTo(0.1, 4);
  });

  test("correlates the mic against the speaker envelope", () => {
    const echoing = new EchoMarginProbe();
    const clean = new EchoMarginProbe();
    // Same speaker envelope for both. The echoing mic follows it; the clean mic
    // has room noise of its own on an unrelated period, which is what a real
    // quiet room looks like (a perfectly constant mic has no variance at all,
    // and correlation against it is undefined rather than zero).
    for (let i = 0; i < 42; i++) {
      const output = i % 2 === 0 ? 0.9 : 0.06;
      echoing.sample(output * 0.2, output);
      clean.sample(0.01 + 0.004 * (i % 3), output);
    }

    expect(echoing.summarize()!.correlation).toBeGreaterThan(0.9);
    const cleanCorrelation = clean.summarize()!.correlation;
    expect(cleanCorrelation).not.toBeNull();
    expect(Math.abs(cleanCorrelation!)).toBeLessThan(0.2);
  });

  test("closes an utterance after a run of silence and starts a fresh one", () => {
    const probe = new EchoMarginProbe();
    feed(probe, 5, 0.02, 0);
    feed(probe, 10, 0.2, 0.8);
    // Nine silent samples are a gap between sentences, not an ending.
    const early = feed(probe, 9, 0.02, 0);
    expect(early).toBeNull();

    const closed = probe.sample(0.02, 0);
    expect(closed).not.toBeNull();
    expect(closed!.audibleSamples).toBe(10);

    // The next reply is measured on its own, not folded into the last one.
    feed(probe, 4, 0.3, 0.8);
    const second = probe.summarize();
    expect(second!.audibleSamples).toBe(4);
  });

  test("yields nothing when the assistant never became audible", () => {
    const probe = new EchoMarginProbe();
    feed(probe, 30, 0.05, 0);

    expect(probe.summarize()).toBeNull();
  });

  test("keeps the user's own speech out of the noise floor", () => {
    const probe = new EchoMarginProbe();
    // Quiet room first, so the floor is established.
    feed(probe, 40, 0.01, 0);
    // The user talks. The assistant is silent throughout, so every one of these
    // samples is a candidate floor reading, and averaging them in would raise
    // the baseline until the echoing reply below looked clean.
    feed(probe, 30, 0.35, 0);
    // The assistant replies and the mic hears it.
    feed(probe, 20, 0.1, 0.8);

    const summary = probe.summarize();

    expect(summary!.micFloor!).toBeLessThan(0.02);
    expect(summary!.marginDb!).toBeGreaterThan(15);
  });

  test("still follows a genuinely noisier room upward", () => {
    const probe = new EchoMarginProbe();
    feed(probe, 20, 0.01, 0);
    // Sustained background noise, not a burst: the floor has to reach it or
    // every reply in a noisy room reads as echo.
    feed(probe, 600, 0.08, 0);
    feed(probe, 20, 0.08, 0.8);

    const summary = probe.summarize();

    expect(summary!.micFloor!).toBeGreaterThan(0.06);
    expect(Math.abs(summary!.marginDb!)).toBeLessThan(3);
  });

  test("reports an unknown floor rather than a fabricated margin", () => {
    const probe = new EchoMarginProbe();
    // Session that was speaking from the first sample: there is no silent
    // stretch to measure a floor against, and inventing one would turn an
    // unmeasured session into a clean bill of health.
    feed(probe, 10, 0.2, 0.8);

    const summary = probe.summarize();

    expect(summary!.micFloor).toBeNull();
    expect(summary!.marginDb).toBeNull();
  });
});
