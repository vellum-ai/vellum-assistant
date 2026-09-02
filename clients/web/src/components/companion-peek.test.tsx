import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { avatarPeekMetrics } from "@/utils/avatar-peek-metrics";

import {
  CompanionPeek,
  PEEK_EDGES,
  PEEK_EXPOSED_MAX,
  PEEK_INTERVAL_SECONDS,
  PEEK_STRETCH,
  bodySpanAt,
  collapsedCollar,
  collarPath,
  peekDelayMs,
  peekGeometry,
  pickEdge,
} from "./companion-peek";

afterEach(() => {
  cleanup();
});

/** The capsule the surface actually draws: 28 by 10. */
const CAPSULE = { width: 28, height: 10 };

/** A clock fast enough to watch in a test, and still a range. */
const FAST = { min: 0.01, max: 0.02 };

const CHARACTER = { bodyShape: "urchin", eyeStyle: "curious", color: "teal" };

const peekOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-peek");

const risen = (container: HTMLElement): string | null =>
  peekOf(container)?.getAttribute("data-risen") ?? null;

describe("how far the creature comes up", () => {
  /**
   * The point of the measurement: the eyes have to clear the rim on every
   * creature, whatever height the body carries its face at.
   */
  test("shows the eyes of every creature in the catalog", () => {
    for (const shape of BUNDLED_COMPONENTS.bodyShapes) {
      for (const eyes of BUNDLED_COMPONENTS.eyeStyles) {
        const metrics = avatarPeekMetrics(BUNDLED_COMPONENTS, {
          bodyShape: shape.id,
          eyeStyle: eyes.id,
          color: "teal",
        });
        expect(metrics).not.toBeNull();
        const geometry = peekGeometry(metrics!, CAPSULE.width);
        const eyeBottom =
          geometry.size * (metrics!.eyeCenterFrac + metrics!.eyeHalfFrac);
        expect(geometry.exposed).toBeGreaterThan(eyeBottom);
        expect(geometry.exposed).toBeLessThanOrEqual(PEEK_EXPOSED_MAX + 1e-9);
      }
    }
  });

  test("draws a high-faced creature at full size", () => {
    const geometry = peekGeometry(
      { eyeCenterFrac: 0.3, eyeHalfFrac: 0.05 },
      CAPSULE.width,
    );
    expect(geometry.size).toBe(CAPSULE.width);
    expect(geometry.exposed).toBeCloseTo(28 * 0.39);
  });

  /** Rather than exposing a tall slab of body to get its eyes over the rim. */
  test("scales a low-faced creature down instead of exposing more of it", () => {
    const geometry = peekGeometry(
      { eyeCenterFrac: 0.7, eyeHalfFrac: 0.05 },
      CAPSULE.width,
    );
    expect(geometry.size).toBeLessThan(CAPSULE.width);
    expect(geometry.exposed).toBeCloseTo(PEEK_EXPOSED_MAX);
  });

  test("hides the whole exposure at rest, with room to breathe up top", () => {
    const geometry = peekGeometry(
      { eyeCenterFrac: 0.4, eyeHalfFrac: 0.05 },
      CAPSULE.width,
    );
    expect(geometry.rest).toBeGreaterThan(geometry.exposed);
    expect(geometry.clip.height).toBeGreaterThan(geometry.exposed);
    expect(geometry.clip.width).toBeGreaterThan(geometry.size);
  });
});

describe("the gap between peeks", () => {
  test("is stated in seconds and is a real range", () => {
    expect(PEEK_INTERVAL_SECONDS.min).toBeLessThan(PEEK_INTERVAL_SECONDS.max);
    expect(PEEK_INTERVAL_SECONDS.min).toBeGreaterThan(0);
  });

  test("runs from the shortest gap to the longest", () => {
    expect(peekDelayMs({ min: 3, max: 10 }, () => 0)).toBe(3000);
    expect(peekDelayMs({ min: 3, max: 10 }, () => 1)).toBe(10000);
    expect(peekDelayMs({ min: 3, max: 10 }, () => 0.5)).toBe(6500);
  });

  test("never lands outside the range", () => {
    for (let i = 0; i < 200; i++) {
      const delay = peekDelayMs({ min: 3, max: 10 });
      expect(delay).toBeGreaterThanOrEqual(3000);
      expect(delay).toBeLessThanOrEqual(10000);
    }
  });
});

describe("which edge the creature comes out of", () => {
  test("is a coin toss between the top and the bottom", () => {
    expect(pickEdge(() => 0)).toBe("top");
    expect(pickEdge(() => 0.49)).toBe("top");
    expect(pickEdge(() => 0.5)).toBe("bottom");
    expect(pickEdge(() => 0.999)).toBe("bottom");
  });

  /** Each draw is its own, so the same edge can come up twice running. */
  test("is never made to alternate", () => {
    const draws = Array.from({ length: 200 }, () => pickEdge());
    expect(draws.some((edge, i) => i > 0 && edge === draws[i - 1])).toBe(true);
    expect(new Set(draws)).toEqual(new Set(PEEK_EDGES));
  });

  /** Each edge turns the frame, so the eyes clear whichever rim they cross. */
  test("turns the frame to face out of the chosen edge", () => {
    const turns: Record<string, string> = {};
    for (const edge of PEEK_EDGES) {
      const { container } = render(
        <CompanionPeek
          character={CHARACTER}
          accentHex="#4C9B50"
          capsule={CAPSULE}
          enabled
          held
          edge={edge}
        />,
      );
      expect(peekOf(container)?.getAttribute("data-edge")).toBe(edge);
      const clip =
        peekOf(container)?.querySelector<HTMLElement>(".overflow-hidden");
      turns[edge] = clip?.style.transform ?? "";
      cleanup();
    }
    expect(turns.top).toBe("rotate(0deg)");
    expect(turns.bottom).toBe("rotate(180deg)");
  });
});

describe("the collar between the capsule and the creature", () => {
  /** Read off the artwork, so a narrow neck and a wide body come out as such. */
  test("finds every catalog body where the cut lands", () => {
    for (const shape of BUNDLED_COMPONENTS.bodyShapes) {
      const metrics = avatarPeekMetrics(BUNDLED_COMPONENTS, {
        bodyShape: shape.id,
        eyeStyle: "curious",
        color: "teal",
      })!;
      const geometry = peekGeometry(metrics, CAPSULE.width);
      const span = bodySpanAt(shape.id, geometry.size, geometry.exposed);
      expect(span).not.toBeNull();
      expect(span!.left).toBeGreaterThanOrEqual(0);
      expect(span!.right).toBeLessThanOrEqual(geometry.size);
      expect(span!.right - span!.left).toBeGreaterThan(geometry.size / 4);
    }
  });

  test("is nothing for a shape the catalog does not have", () => {
    expect(bodySpanAt("teapot", 28, 10)).toBeNull();
  });

  test("runs from the capsule's cross-section to the creature's span", () => {
    const d = collarPath(36, 28, { left: 8, right: 26 }, 5, PEEK_STRETCH + 1);
    // Base corners on the bottom line, centred: 18 plus or minus 14.
    expect(d.startsWith("M4 12")).toBe(true);
    expect(d).toContain("L26 0");
    expect(d.endsWith("32 12 Z")).toBe(true);
  });

  /** So the browser can tween the one into the other. */
  test("collapses into the capsule with the same points", () => {
    const flat = collapsedCollar(36, 28, 5);
    const full = collarPath(36, 28, { left: 8, right: 26 }, 5, PEEK_STRETCH);
    expect(flat.replace(/[\d.-]+/g, "#")).toBe(full.replace(/[\d.-]+/g, "#"));
    // Every point on the base line, and none wider than the cross-section.
    expect(flat).toContain("L32 12");
    expect(flat.startsWith("M4 12")).toBe(true);
    for (const y of flat.match(/ (-?[\d.]+)(?= [CLZ]|$)/g) ?? []) {
      expect(Number(y)).toBe(12);
    }
  });

  /** In the capsule's colour, so it is more of the same shape. */
  test("is drawn in the accent", () => {
    const { container } = render(
      <CompanionPeek
        character={CHARACTER}
        accentHex="#E9642F"
        capsule={CAPSULE}
        enabled
        held
        edge="bottom"
      />,
    );
    const collar = peekOf(container)?.querySelector(
      ".companion-peek-collar path",
    );
    expect(collar?.getAttribute("fill")).toBe("#E9642F");
  });
});

describe("the peek on screen", () => {
  test("is down until the first peek, then up, then down again", async () => {
    const props = {
      character: CHARACTER,
      accentHex: "#4C9B50",
      capsule: CAPSULE,
      interval: FAST,
    };
    const { container, rerender } = render(
      <CompanionPeek {...props} enabled />,
    );
    expect(peekOf(container)).not.toBeNull();
    expect(risen(container)).toBe("false");
    await waitFor(() => {
      expect(risen(container)).toBe("true");
    });
    // The clock here is far faster than the hold, so stop it: disabling
    // stops the next peek from being scheduled and lets this one finish,
    // which is also what happens when the creature comes out mid-peek.
    rerender(<CompanionPeek {...props} enabled={false} />);
    await waitFor(
      () => {
        expect(risen(container)).toBe("false");
      },
      { timeout: 3000 },
    );
  });

  test("draws the creature's own artwork, which blinks and breathes", () => {
    const { container } = render(
      <CompanionPeek
        character={CHARACTER}
        accentHex="#4C9B50"
        capsule={CAPSULE}
        enabled
        held
      />,
    );
    // The composed creature is an inline SVG with the body and the eyes.
    expect(peekOf(container)?.querySelector("svg path")).not.toBeNull();
  });

  /** For the stories: the creature up, with no clock at all. */
  test("held, stays up and schedules nothing", async () => {
    const { container } = render(
      <CompanionPeek
        character={CHARACTER}
        accentHex="#4C9B50"
        capsule={CAPSULE}
        enabled
        held
        interval={FAST}
      />,
    );
    expect(risen(container)).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(risen(container)).toBe("true");
  });

  test("does not rise while disabled", async () => {
    const { container } = render(
      <CompanionPeek
        character={CHARACTER}
        accentHex="#4C9B50"
        capsule={CAPSULE}
        enabled={false}
        interval={FAST}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(risen(container)).toBe("false");
  });

  test("draws nothing for traits the catalog does not have", async () => {
    const { container } = render(
      <CompanionPeek
        character={{ bodyShape: "teapot", eyeStyle: "curious", color: "teal" }}
        accentHex="#4C9B50"
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(peekOf(container)).toBeNull();
  });
});
