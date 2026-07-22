/**
 * Tests for `VoiceTimelineWaveform`.
 *
 * happy-dom's `canvas.getContext("2d")` returns `null`, so a minimal fake 2D
 * context is installed on `HTMLCanvasElement.prototype` to let the draw loop
 * run. Frames are driven manually with controlled timestamps through the
 * shared rAF harness (`raf.test-helper.ts`).
 *
 * The reduced-motion branch is verified by stubbing `motion/react` so
 * `useReducedMotion()` returns `true` and asserting the animation loop never
 * starts — mirroring the reduced-motion pattern in
 * `website-carousel.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import {
  installRafTestHarness,
  type RafTestHarness,
} from "@/domains/chat/voice/raf.test-helper";
import { VoiceTimelineWaveform } from "@/domains/chat/voice/voice-timeline-waveform";

let raf: RafTestHarness;

// ---------------------------------------------------------------------------
// Fake 2D context — happy-dom has no canvas implementation.
// ---------------------------------------------------------------------------

function makeFakeContext() {
  return {
    fillStyle: "",
    setTransform: mock(() => {}),
    clearRect: mock(() => {}),
    beginPath: mock(() => {}),
    roundRect: mock(() => {}),
    fill: mock(() => {}),
  };
}

let fakeCtx: ReturnType<typeof makeFakeContext>;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  raf = installRafTestHarness();

  fakeCtx = makeFakeContext();
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((type: string) =>
    type === "2d" ? fakeCtx : null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  raf.restore();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoiceTimelineWaveform — rendering", () => {
  test("renders an aria-hidden canvas", () => {
    const { container } = render(<VoiceTimelineWaveform active getAmplitude={() => 0.5} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas!.getAttribute("aria-hidden")).toBe("true");
  });

  test("default sizing uses the full-height canvas class", () => {
    const { container } = render(
      <VoiceTimelineWaveform active getAmplitude={() => 0} />,
    );
    const canvas = container.querySelector("canvas")!;
    expect(canvas.className).toContain("h-6");
    expect(canvas.className).toContain("w-full");
  });

  test("compact sizing uses the shorter canvas class", () => {
    const { container } = render(
      <VoiceTimelineWaveform active compact getAmplitude={() => 0} />,
    );
    const canvas = container.querySelector("canvas")!;
    expect(canvas.className).toContain("h-4");
    expect(canvas.className).not.toContain("h-6");
  });

  test("merges a caller-supplied className", () => {
    const { container } = render(
      <VoiceTimelineWaveform active className="flex-1" getAmplitude={() => 0} />,
    );
    expect(container.querySelector("canvas")!.className).toContain("flex-1");
  });
});

describe("VoiceTimelineWaveform — animation loop", () => {
  test("starts the rAF loop and reschedules each frame", () => {
    render(<VoiceTimelineWaveform active getAmplitude={() => 0.5} />);
    expect(raf.requestCount()).toBe(1);
    raf.fireFrame(100);
    expect(raf.requestCount()).toBe(2);
    raf.fireFrame(200);
    expect(raf.requestCount()).toBe(3);
  });

  test("polls getAmplitude while active", () => {
    const getAmplitude = mock(() => 0.5);
    render(<VoiceTimelineWaveform active getAmplitude={getAmplitude} />);
    raf.fireFrame(100);
    raf.fireFrame(200);
    expect(getAmplitude.mock.calls.length).toBe(2);
  });

  test("stops sampling (but keeps drawing) when not active", () => {
    const getAmplitude = mock(() => 0.5);
    render(<VoiceTimelineWaveform active={false} getAmplitude={getAmplitude} />);
    raf.fireFrame(100);
    raf.fireFrame(200);
    expect(getAmplitude.mock.calls.length).toBe(0);
    expect(fakeCtx.clearRect.mock.calls.length).toBe(2);
  });

  test("cancels the pending frame on unmount and a late frame does not throw", () => {
    const { unmount } = render(<VoiceTimelineWaveform active getAmplitude={() => 0.5} />);
    // Capture the pending callback before unmount cancels it, simulating a
    // frame already dispatched when cleanup runs.
    const pending = raf.pendingCallbacks();
    expect(pending).toHaveLength(1);
    unmount();
    expect(raf.canceledIds()).toHaveLength(1);
    expect(raf.pendingCallbacks()).toHaveLength(0);
    expect(() => pending[0]!(300)).not.toThrow();
  });

  test("does not start a loop when the 2d context is unavailable", () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const { unmount } = render(
      <VoiceTimelineWaveform active getAmplitude={() => 0} />,
    );
    expect(raf.requestCount()).toBe(0);
    expect(() => unmount()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion path — verified by stubbing `motion/react`.
// ---------------------------------------------------------------------------

describe("VoiceTimelineWaveform — reduced motion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("renders a static frame without starting the animation loop", async () => {
    mock.module("motion/react", () => ({
      useReducedMotion: () => true,
    }));

    const { VoiceTimelineWaveform: ReducedWaveform } = await import(
      "./voice-timeline-waveform"
    );
    const { container, unmount } = render(
      <ReducedWaveform active getAmplitude={() => 0.5} />,
    );

    expect(container.querySelector("canvas")).toBeTruthy();
    // No animation loop — the static branch draws once, synchronously.
    expect(raf.requestCount()).toBe(0);
    expect(fakeCtx.clearRect.mock.calls.length).toBe(1);
    expect(() => unmount()).not.toThrow();
  });
});
