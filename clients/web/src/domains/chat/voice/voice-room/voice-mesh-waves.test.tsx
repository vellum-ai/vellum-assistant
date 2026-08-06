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

import {
  DEFAULT_MESH_TUNING,
  VoiceMeshWaves,
  meshDisplacement,
} from "./voice-mesh-waves";

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

  test("dark ink composites normally, light ink additively", async () => {
    // Not a style preference. `lighter` is additive, so a black stroke
    // contributes zero and the whole sheet renders invisible — the room's
    // assistant band is black. Getting this wrong does not look worse, it
    // looks like nothing, which is why the mode follows luminance rather than
    // being a caller's choice.
    render(<VoiceMeshWaves getAmplitude={() => 0.5} color="#000000" />);
    await waitFor(() => {
      expect(recorder.strokes).toBeGreaterThan(30);
    });
    expect(recorder.composite).toBe("source-over");
    cleanup();

    recorder = { ys: [], strokes: 0, strokeStyles: [], composite: null };
    render(<VoiceMeshWaves getAmplitude={() => 0.5} color="#FFFFFF" />);
    await waitFor(() => {
      expect(recorder.strokes).toBeGreaterThan(30);
    });
    expect(recorder.composite).toBe("lighter");
  });

  test("explicit ink overrides the palette, and is what gets stroked", async () => {
    render(
      <VoiceMeshWaves
        getAmplitude={() => 0.5}
        palette="aurora"
        color="#000000"
      />,
    );
    await waitFor(() => {
      expect(recorder.strokeStyles.length).toBeGreaterThan(0);
    });
    // Aurora would be cyan; the explicit ink wins.
    expect(recorder.strokeStyles.every((s) => s.startsWith("rgba(0,0,0,"))).toBe(
      true,
    );
  });

  test("fades out entirely as the voice stops", async () => {
    // Opacity is a ceiling reached at full amplitude, scaled from zero — so
    // silence leaves nothing on screen rather than an idling decoration.
    const { container } = render(
      <VoiceMeshWaves getAmplitude={() => 0} peakOpacity={0.4} />,
    );
    const host = container.querySelector<HTMLElement>(".voice-listening-waves")!;
    expect(host.style.getPropertyValue("--band-peak-opacity")).toBe("0.4");
    await waitFor(() => {
      expect(recorder.strokes).toBeGreaterThan(30);
    });
    // The CSS multiplies the two, so a zero amplitude means a zero band.
    expect(Number(host.style.getPropertyValue("--voice-amp") || "0")).toBe(0);
  });

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

/**
 * The weave's shape, tested through `meshDisplacement` rather than the canvas.
 *
 * The property at issue — that the pinches where depth lines converge into a
 * "twist" travel across the band rather than sitting in fixed spots — only
 * shows up when averaged over ten-odd seconds of motion, which a component
 * test cannot wait for. Against the pure function it is a few milliseconds.
 */
describe("meshDisplacement", () => {
  /**
   * Spread of the sheet across depth at each x: the pinches are its minima.
   * This is the same quantity the canvas draws, minus the pixel scaling.
   */
  function spreadProfile(timeSec: number, samples = 96, lines = 92): number[] {
    const out: number[] = [];
    for (let i = 0; i < samples; i++) {
      const u = i / (samples - 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let line = 0; line < lines; line++) {
        const depth = line / (lines - 1);
        // A flat envelope, so the only thing that can move the pinches is the
        // wave math itself — not the amplitude history scrolling underneath.
        const swirl = u * 0.4 * DEFAULT_MESH_TUNING.swirl;
        const v = meshDisplacement(
          u,
          depth,
          timeSec,
          swirl,
          DEFAULT_MESH_TUNING,
        );
        const y = (depth - 0.5) * DEFAULT_MESH_TUNING.spread -
          DEFAULT_MESH_TUNING.displace * v;
        if (y < lo) {lo = y;}
        if (y > hi) {hi = y;}
      }
      out.push(hi - lo);
    }
    return out;
  }

  /**
   * How much persistent structure survives averaging the profile over
   * `seconds` of motion, as a coefficient of variation.
   *
   * Pinned pinches keep their dips through the average, so this stays high;
   * travelling pinches smear the average flat, so it drops.
   */
  function persistentStructure(seconds: number): number {
    const samples = 96;
    const acc = new Array<number>(samples).fill(0);
    let frames = 0;
    for (let t = 0; t < seconds; t += 0.05) {
      const profile = spreadProfile(t, samples);
      for (let i = 0; i < samples; i++) {
        acc[i] += profile[i];
      }
      frames++;
    }
    const avg = acc.map((v) => v / frames);
    const mean = avg.reduce((a, b) => a + b, 0) / samples;
    const variance =
      avg.reduce((a, b) => a + (b - mean) ** 2, 0) / samples;
    return Math.sqrt(variance) / mean;
  }

  test("the twists do not stay in the same place", () => {
    // Measured over the window a viewer actually perceives. The original
    // counter-propagating formula scored ~0.22 here — deep dips at fixed x,
    // which is exactly the "why are the twists always in the same spot"
    // report. Co-propagating the two ripples plus the slow wander takes it
    // to ~0.06. The threshold sits well below the old value and well above
    // the new one, so it fails if either mechanism is removed.
    expect(persistentStructure(12)).toBeLessThan(0.12);
  });

  test("the sheet still has real structure at any instant", () => {
    // The flatness above must come from the pattern *moving*, not from the
    // sheet having been smoothed into a featureless tube.
    const profile = spreadProfile(3.2);
    const mean = profile.reduce((a, b) => a + b, 0) / profile.length;
    const range = Math.max(...profile) - Math.min(...profile);
    expect(range / mean).toBeGreaterThan(0.3);
  });

  test("stays within its normalized range", () => {
    for (let t = 0; t < 6; t += 0.37) {
      for (let i = 0; i <= 10; i++) {
        const v = meshDisplacement(
          i / 10,
          0.5,
          t,
          1.2,
          DEFAULT_MESH_TUNING,
        );
        expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});
