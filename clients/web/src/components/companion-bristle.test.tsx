import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  BRISTLE_INTERVAL_SECONDS,
  BRISTLE_REACH,
  BRISTLES,
  bristleBox,
  bristleDelayMs,
  bristleFor,
  CompanionBristle,
  featurePath,
} from "./companion-bristle";

afterEach(() => {
  cleanup();
});

/** The capsule the surface actually draws: 28 by 10 with a 2 point rim. */
const CAPSULE = { width: 28, height: 10, rim: 2 };

/** A clock fast enough to watch in a test, and still a range. */
const FAST = { min: 0.01, max: 0.02 };

/** The features on screen: one path each, all inside the one keyed group. */
const featuresOf = (container: HTMLElement): SVGPathElement[] =>
  Array.from(
    container.querySelectorAll<SVGPathElement>(".companion-bristle-feature"),
  );

const bristleOf = (container: HTMLElement): SVGSVGElement | null =>
  container.querySelector<SVGSVGElement>("svg.companion-bristle");

describe("what each creature bristles with", () => {
  /**
   * The catalog is the list of shapes a user can have, so a shape added there
   * without a vocabulary here would be a capsule that never stirs, and nobody
   * would notice until a user with that shape wondered why.
   */
  test("covers every body shape in the catalog", () => {
    for (const shape of BUNDLED_COMPONENTS.bodyShapes) {
      expect(bristleFor(shape.id)).toBeDefined();
      expect(bristleFor(shape.id)?.length).toBeGreaterThan(0);
    }
  });

  test("has nothing for a shape it does not know", () => {
    expect(bristleFor("teapot")).toBeUndefined();
  });

  /**
   * The reach is what sizes the canvas and what keeps every feature inside the
   * box the host hit-tests, so a feature past it would be clipped at best and
   * would move the surface's geometry at worst.
   */
  test("keeps every feature inside the stated reach and on the capsule", () => {
    for (const features of Object.values(BRISTLES)) {
      for (const feature of features) {
        expect(feature.reach).toBeGreaterThan(0);
        expect(feature.reach).toBeLessThanOrEqual(BRISTLE_REACH);
        expect(feature.at).toBeGreaterThanOrEqual(0);
        expect(feature.at).toBeLessThanOrEqual(1);
        expect(feature.width).toBeGreaterThan(0);
      }
    }
  });

  /** The words the design was asked for, on the shapes that are made of them. */
  test("gives the urchin spikes, the flower ovals and the ninja crescents", () => {
    expect(new Set(bristleFor("urchin")?.map((f) => f.kind))).toEqual(
      new Set(["spike"]),
    );
    expect(new Set(bristleFor("flower")?.map((f) => f.kind))).toEqual(
      new Set(["oval"]),
    );
    expect(new Set(bristleFor("ninja")?.map((f) => f.kind))).toEqual(
      new Set(["crescent"]),
    );
  });

  test("draws each kind as one closed path growing upward from its base", () => {
    for (const kind of ["spike", "oval", "puff", "crescent"] as const) {
      const d = featurePath({ kind, at: 0.5, side: "top", reach: 6, width: 4 });
      expect(d.startsWith("M-2 3")).toBe(true);
      expect(d.endsWith("L2 3 Z")).toBe(true);
      // Nothing runs below the inset: the seam is the lowest thing drawn.
      const ys = d
        .split(/[MLCZ]/)
        .flatMap((segment) => segment.trim().split(/\s+/))
        .filter((token) => token !== "")
        .map(Number)
        .filter((_, index) => index % 2 === 1);
      expect(ys.length).toBeGreaterThan(0);
      expect(Math.max(...ys)).toBe(3);
    }
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
  test("sizes its canvas to the capsule plus the reach on both sides", () => {
    expect(bristleBox(CAPSULE)).toEqual({
      width: 32,
      height: 14 + 2 * BRISTLE_REACH,
    });
  });

  test("draws nothing until the first bristle, then one path per feature", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="urchin"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    expect(bristleOf(container)).not.toBeNull();
    expect(featuresOf(container)).toHaveLength(0);
    await waitFor(() => {
      expect(featuresOf(container)).toHaveLength(bristleFor("urchin")!.length);
    });
  });

  test("wears the assistant's colour and the capsule's rim", async () => {
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
    await waitFor(() => {
      expect(featuresOf(container).length).toBeGreaterThan(0);
    });
    const feature = featuresOf(container)[0]!;
    expect(feature.getAttribute("fill")).toBe("#E9642F");
    expect(feature.getAttribute("stroke")).toBe("#17181b");
    expect(feature.getAttribute("stroke-width")).toBe(String(CAPSULE.rim));
  });

  /**
   * A feature is placed on the capsule's edge and grows away from it, which for
   * the ones underneath means turning the whole frame over.
   */
  test("stands top features on the top edge and bottom features underneath", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="stack"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await waitFor(() => {
      expect(featuresOf(container)).toHaveLength(2);
    });
    const placements = featuresOf(container).map(
      (path) => path.parentElement?.getAttribute("transform") ?? "",
    );
    // The top layer sits at the reach, which is where the rim's outer edge is.
    expect(placements[0]).toBe(`translate(16 ${BRISTLE_REACH}) rotate(0)`);
    // The bottom one sits the capsule's box lower and is turned over.
    expect(placements[1]).toBe(
      `translate(16 ${BRISTLE_REACH + 14}) rotate(180)`,
    );
  });

  test("staggers the features so they do not all move as one", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="flower"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await waitFor(() => {
      expect(featuresOf(container).length).toBeGreaterThan(1);
    });
    const delays = featuresOf(container).map(
      (path) => path.style.animationDelay,
    );
    expect(new Set(delays).size).toBe(delays.length);
    expect(delays[0]).toBe("0ms");
  });

  /**
   * Each bristle is a one-shot animation, and the way to replay one is to
   * remount the node carrying it. The group is keyed by the count, so the
   * second bristle is a different element from the first.
   */
  test("remounts the features on each bristle so the travel replays", async () => {
    const { container } = render(
      <CompanionBristle
        bodyShape="blob"
        accentHex="#4C9B50"
        rimHex="#17181b"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await waitFor(() => {
      expect(featuresOf(container).length).toBeGreaterThan(0);
    });
    const first = featuresOf(container)[0]!;
    await waitFor(() => {
      expect(featuresOf(container)[0]).not.toBe(first);
    });
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
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bristleOf(container)).not.toBeNull();
    expect(featuresOf(container)).toHaveLength(0);
  });

  test("draws nothing at all for a shape it has no vocabulary for", async () => {
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
