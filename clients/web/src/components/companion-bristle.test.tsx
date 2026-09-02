import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  BRISTLE_INTERVAL_SECONDS,
  BRISTLE_REACH,
  bristleBox,
  bristleDelayMs,
  bristleOutline,
  CompanionBristle,
  flattenPath,
  radialProfile,
  silhouetteFor,
  silhouetteOf,
  stretchFor,
} from "./companion-bristle";

afterEach(() => {
  cleanup();
});

/** The capsule the surface actually draws: 28 by 10 with a 2 point rim. */
const CAPSULE = { width: 28, height: 10, rim: 2 };

/** A clock fast enough to watch in a test, and still a range. */
const FAST = { min: 0.01, max: 0.02 };

const outlineOf = (container: HTMLElement): SVGPathElement | null =>
  container.querySelector<SVGPathElement>(".companion-bristle-outline");

const bristleOf = (container: HTMLElement): SVGSVGElement | null =>
  container.querySelector<SVGSVGElement>("svg.companion-bristle");

/** The y coordinates in a path, for asking how far up or down it goes. */
const pointsOf = (d: string): { x: number; y: number }[] =>
  Array.from(d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)).map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));

/** A square, the size of a body shape, as absolute moves and lines. */
const SQUARE = "M0 0 L100 0 L100 100 L0 100 Z";

describe("reading the artwork", () => {
  test("flattens lines as they are", () => {
    expect(flattenPath(SQUARE)).toEqual([
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    ]);
  });

  test("cuts a curve into straight pieces that end where it ends", () => {
    const [line] = flattenPath("M0 0 C0 50 100 50 100 0 Z", 4);
    expect(line).toHaveLength(5);
    expect(line?.[4]).toEqual({ x: 100, y: 0 });
    // The middle of a symmetric cubic is three quarters of the way to the
    // control points' height.
    expect(line?.[2]).toEqual({ x: 50, y: 37.5 });
  });

  test("reads relative moves, horizontal and vertical lines", () => {
    expect(flattenPath("m10 10 h20 v20 l-20 0 z")).toEqual([
      [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 30 },
        { x: 10, y: 30 },
      ],
    ]);
  });

  test("keeps subpaths apart", () => {
    expect(flattenPath(`${SQUARE} M40 40 L60 40 L60 60 Z`)).toHaveLength(2);
  });

  /**
   * The catalog is the list of shapes a user can have, so every one of them
   * has to come out as a silhouette or its capsule would never stir.
   */
  test("reads every body shape in the catalog into a silhouette", () => {
    for (const shape of BUNDLED_COMPONENTS.bodyShapes) {
      const silhouette = silhouetteOf(shape.svgPath, 90);
      expect(silhouette).toBeDefined();
      expect(silhouette?.relief).toHaveLength(90);
      expect(Math.max(...(silhouette?.relief ?? []))).toBe(1);
      expect(Math.min(...(silhouette?.relief ?? []))).toBe(0);
    }
  });
});

describe("the silhouette", () => {
  test("of a square peaks at the corners and dips at the sides", () => {
    const profile = radialProfile(flattenPath(SQUARE), 8);
    // Straight right, then clockwise on screen: right, corner, down, corner...
    expect(profile[0]).toBeCloseTo(50);
    expect(profile[1]).toBeCloseTo(Math.SQRT2 * 50);
    expect(profile[2]).toBeCloseTo(50);
    expect(profile[3]).toBeCloseTo(Math.SQRT2 * 50);
  });

  test("is the farthest edge, so an inner subpath never pulls it in", () => {
    const withHole = `${SQUARE} M40 40 L60 40 L60 60 L40 60 Z`;
    expect(radialProfile(flattenPath(withHole), 4)).toEqual(
      radialProfile(flattenPath(SQUARE), 4),
    );
  });

  test("is spikier for an urchin than for a blob", () => {
    const urchin = silhouetteFor("urchin")!;
    const blob = silhouetteFor("blob")!;
    expect(urchin.spikiness).toBeGreaterThan(blob.spikiness);
    expect(stretchFor(urchin.spikiness)).toBe(1);
    expect(stretchFor(blob.spikiness)).toBeLessThan(1);
  });

  test("gets some stretch however round the shape is", () => {
    expect(stretchFor(0)).toBeGreaterThan(0);
    expect(stretchFor(1)).toBe(1);
  });

  test("is unknown for a shape the catalog does not have", () => {
    expect(silhouetteFor("teapot")).toBeUndefined();
  });
});

describe("the outline around the capsule", () => {
  const flat = { relief: new Array<number>(40).fill(0), spikiness: 1 };
  const full = { relief: new Array<number>(40).fill(1), spikiness: 1 };

  test("sizes its canvas to the capsule plus the reach on every side", () => {
    expect(bristleBox(CAPSULE)).toEqual({
      width: 32 + 2 * BRISTLE_REACH,
      height: 14 + 2 * BRISTLE_REACH,
    });
  });

  test("at no stretch is the accent's own edge, hidden under the rim", () => {
    const points = pointsOf(bristleOutline(CAPSULE, full, 0));
    const box = bristleBox(CAPSULE);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(CAPSULE.width, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(CAPSULE.height, 1);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(box.width / 2);
  });

  test("at full stretch stands the reach past the rim, all the way round", () => {
    const points = pointsOf(bristleOutline(CAPSULE, full, 1));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const box = bristleBox(CAPSULE);
    // Every side of the canvas is touched: it grew left and right as much as
    // up and down.
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo(box.width, 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 1);
    expect(Math.max(...ys)).toBeCloseTo(box.height, 1);
  });

  test("with no relief anywhere never leaves the edge", () => {
    expect(bristleOutline(CAPSULE, flat, 1)).toBe(
      bristleOutline(CAPSULE, flat, 0),
    );
  });

  /**
   * The browser interpolates between the flat and stretched paths, which it
   * can only do when they are the same commands in the same order.
   */
  test("keeps the same points in the same order at every stretch", () => {
    const silhouette = silhouetteFor("star")!;
    const a = bristleOutline(CAPSULE, silhouette, 0);
    const b = bristleOutline(CAPSULE, silhouette, 1);
    expect(pointsOf(a)).toHaveLength(pointsOf(b).length);
    expect(a.replace(/[\d.-]+/g, "#")).toBe(b.replace(/[\d.-]+/g, "#"));
    expect(a.endsWith(" Z")).toBe(true);
  });

  /**
   * The creature's top lands on the pill's top and its right on the right end,
   * which is what makes the silhouette recognisably the creature's rather than
   * a random lumpy ring.
   */
  test("lays the creature round the pill the way it stands", () => {
    // A silhouette that is all on the right: only the first samples raised.
    const relief = new Array<number>(40).fill(0);
    relief[0] = 1;
    relief[39] = 1;
    const points = pointsOf(
      bristleOutline(CAPSULE, { relief, spikiness: 1 }, 1),
    );
    const box = bristleBox(CAPSULE);
    const farthest = points.reduce((a, b) => (b.x > a.x ? b : a));
    expect(farthest.x).toBeCloseTo(box.width, 1);
    expect(Math.min(...points.map((p) => p.x))).toBeGreaterThan(1);
  });
});

describe("the gap between bristles", () => {
  test("is stated in seconds and is a real range", () => {
    expect(BRISTLE_INTERVAL_SECONDS.min).toBeLessThan(
      BRISTLE_INTERVAL_SECONDS.max,
    );
    expect(BRISTLE_INTERVAL_SECONDS.min).toBeGreaterThan(0);
  });

  test("runs from the shortest gap to the longest", () => {
    expect(bristleDelayMs({ min: 3, max: 10 }, () => 0)).toBe(3000);
    expect(bristleDelayMs({ min: 3, max: 10 }, () => 1)).toBe(10000);
    expect(bristleDelayMs({ min: 3, max: 10 }, () => 0.5)).toBe(6500);
  });

  test("never lands outside the range", () => {
    for (let i = 0; i < 200; i++) {
      const delay = bristleDelayMs({ min: 3, max: 10 });
      expect(delay).toBeGreaterThanOrEqual(3000);
      expect(delay).toBeLessThanOrEqual(10000);
    }
  });
});

describe("the bristle on screen", () => {
  test("starts flat, grows out on the first bristle, and settles back", async () => {
    const props = {
      bodyShape: "urchin",
      accentHex: "#4C9B50",
      rimHex: "#17181b",
      capsule: CAPSULE,
      interval: FAST,
    };
    const { container, rerender } = render(
      <CompanionBristle {...props} enabled />,
    );
    const silhouette = silhouetteFor("urchin")!;
    const flat = bristleOutline(CAPSULE, silhouette, 0);
    const stretched = bristleOutline(CAPSULE, silhouette, 1);
    expect(bristleOf(container)).not.toBeNull();
    expect(outlineOf(container)?.getAttribute("d")).toBe(flat);
    await waitFor(() => {
      expect(outlineOf(container)?.getAttribute("d")).toBe(stretched);
    });
    expect(outlineOf(container)?.style.transition).toContain("d 320ms");
    // The clock here is far faster than the settle, so stop it: disabling
    // stops the next bristle from being scheduled and lets this one finish,
    // which is also what happens when the creature comes out mid-bristle.
    rerender(<CompanionBristle {...props} enabled={false} />);
    await waitFor(
      () => {
        expect(outlineOf(container)?.getAttribute("d")).toBe(flat);
      },
      { timeout: 2000 },
    );
    expect(outlineOf(container)?.style.transition).toContain("d 480ms");
  });

  test("wears the assistant's colour and the capsule's rim", () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="star"
        accentHex="#E9642F"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    const outline = outlineOf(container)!;
    expect(outline.getAttribute("fill")).toBe("#E9642F");
    expect(outline.getAttribute("stroke")).toBe("#17181b");
    expect(outline.getAttribute("stroke-width")).toBe(String(CAPSULE.rim));
  });

  /** For the stories: the silhouette at full stretch, with no clock at all. */
  test("held, stands at full stretch and schedules nothing", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="ninja"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        held
        interval={FAST}
      />,
    );
    const stretched = bristleOutline(CAPSULE, silhouetteFor("ninja")!, 1);
    expect(outlineOf(container)?.getAttribute("d")).toBe(stretched);
    expect(outlineOf(container)?.style.transition).toBe("none");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(outlineOf(container)?.getAttribute("d")).toBe(stretched);
  });

  test("does not fire while disabled", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="urchin"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled={false}
        interval={FAST}
      />,
    );
    const flat = bristleOutline(CAPSULE, silhouetteFor("urchin")!, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(outlineOf(container)?.getAttribute("d")).toBe(flat);
  });

  test("draws nothing at all for a shape the catalog does not have", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="teapot"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bristleOf(container)).toBeNull();
  });
});
