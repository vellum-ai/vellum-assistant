/**
 * Tests for `VoiceMeshWaves`.
 *
 * The mesh draws to a canvas, so there is no DOM geometry to inspect the way
 * the SVG band's `d` attribute can be. Instead the canvas context is replaced
 * with a recorder and the assertions are made against the path the component
 * actually walks — which is the same question either way: does the shape the
 * user sees depend on the audio, or not?
 *
 * happy-dom has no real 2D context, so the recorder is required for these to
 * run at all; it doubles as the instrument.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, render, waitFor } from "@testing-library/react";

import { VoiceMeshWaves } from "./voice-mesh-waves";

/** Every y coordinate the component drew, per render pass. */
interface Recorder {
  ys: number[];
  strokes: number;
  strokeStyles: string[];
  composite: string | null;
}

let recorder: Recorder;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalResizeObserver: typeof globalThis.ResizeObserver;
let originalRect: typeof Element.prototype.getBoundingClientRect;

/** A minimal recording stand-in for CanvasRenderingContext2D. */
function createFakeContext(): unknown {
  return {
    setTransform: () => {},
    clearRect: () => {
      // Each frame starts fresh; keep only the latest so assertions read one
      // frame rather than an ever-growing accumulation.
      recorder.ys = [];
      recorder.strokes = 0;
      recorder.strokeStyles = [];
    },
    beginPath: () => {},
    moveTo: (_x: number, y: number) => recorder.ys.push(y),
    lineTo: (_x: number, y: number) => recorder.ys.push(y),
    stroke: () => {
      recorder.strokes += 1;
    },
    set globalCompositeOperation(value: string) {
      recorder.composite = value;
    },
    get globalCompositeOperation() {
      return recorder.composite ?? "";
    },
    set strokeStyle(value: string) {
      recorder.strokeStyles.push(value);
    },
    get strokeStyle() {
      return recorder.strokeStyles.at(-1) ?? "";
    },
    lineWidth: 1,
    lineJoin: "round",
  };
}

beforeEach(() => {
  recorder = { ys: [], strokes: 0, strokeStyles: [], composite: null };

  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return createFakeContext();
  } as typeof HTMLCanvasElement.prototype.getContext;

  // happy-dom lays nothing out, so the component would size itself to a 1×1
  // box and every displacement would collapse. Give it a real band to draw in.
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect() {
    return {
      width: 600,
      height: 200,
      top: 0,
      left: 0,
      right: 600,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  originalResizeObserver = globalThis.ResizeObserver;
  if (!originalResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Element.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalResizeObserver;
});

/**
 * Long enough for the component's amplitude history to fill end to end
 * (96 samples at ~34 ms), plus headroom for a slow CI box.
 */
const HISTORY_FILL_MS = 4_000;

/** Peak-to-peak spread of the drawn sheet — how far it displaced. */
function spread(ys: number[]): number {
  return ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
}

describe("VoiceMeshWaves", () => {
  test("renders a canvas inside the placement-anchored band", () => {
    const { container } = render(
      <VoiceMeshWaves getAmplitude={() => 0} placement="center" />,
    );
    expect(container.querySelector("canvas[data-mesh-canvas]")).not.toBeNull();
    // Positioning is inherited from the shared band CSS, so the placement
    // class has to be on the host or the sheet lands in the wrong zone.
    expect(
      container.querySelector(".voice-listening-waves--center"),
    ).not.toBeNull();
    expect(
      container.querySelector(".voice-listening-waves--mesh"),
    ).not.toBeNull();
  });

  test("draws one stroked line per depth, additively", async () => {
    render(<VoiceMeshWaves getAmplitude={() => 0.5} />);
    await waitFor(() => {
      expect(recorder.strokes).toBeGreaterThan(30);
    });
    // The glow is entirely emergent from overlapping strokes — if this ever
    // reverts to source-over, the woven ridges go flat.
    expect(recorder.composite).toBe("lighter");
    // Each depth line gets its own alpha, so the sheet has a front and back.
    expect(new Set(recorder.strokeStyles).size).toBeGreaterThan(1);
  });

  test(
    "loud audio displaces the sheet further than silence",
    async () => {
      render(<VoiceMeshWaves getAmplitude={() => 1} />);
      await waitFor(() => {
        expect(recorder.strokes).toBeGreaterThan(30);
      });
      // The history spans 96 samples at ~34 ms, so it takes ~3.3 s of sustained
      // audio before the whole width reflects the level. Measuring earlier
      // reads a sheet that is mostly still at rest, and whether the loud region
      // happens to land on a crest or a zero-crossing of the ripple makes the
      // result depend on phase rather than on amplitude.
      await new Promise((resolve) => setTimeout(resolve, HISTORY_FILL_MS));
      const loud = spread(recorder.ys);
      cleanup();

      recorder = { ys: [], strokes: 0, strokeStyles: [], composite: null };
      render(<VoiceMeshWaves getAmplitude={() => 0} />);
      await waitFor(() => {
        expect(recorder.strokes).toBeGreaterThan(30);
      });
      const quiet = spread(recorder.ys);

      // The whole point of the engine: the surface answers the signal.
      expect(loud).toBeGreaterThan(quiet * 1.8);
      // ...but it never flat-lines, so silence still reads as alive, not off.
      expect(quiet).toBeGreaterThan(0);
    },
    HISTORY_FILL_MS + 5_000,
  );

  test("publishes --voice-amp for the shared placement CSS", async () => {
    const { container } = render(<VoiceMeshWaves getAmplitude={() => 0.8} />);
    const host = container.querySelector<HTMLElement>(".voice-listening-waves")!;
    await waitFor(() => {
      expect(
        Number(host.style.getPropertyValue("--voice-amp")),
      ).toBeGreaterThan(0);
    });
  });
});
