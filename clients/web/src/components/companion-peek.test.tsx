import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { avatarPeekMetrics } from "@/utils/avatar-peek-metrics";

import {
  CompanionPeek,
  PEEK_EDGES,
  PEEK_EXPOSED_MAX,
  PEEK_INTERVAL_SECONDS,
  PEEK_SIZE_MAX,
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

  /**
   * The size cap, not the capsule's width: a square as wide as the capsule
   * puts a full-width body's sides past the capsule's rounded ends.
   */
  test("draws a high-faced creature at the size cap, inside the capsule", () => {
    const geometry = peekGeometry(
      { eyeCenterFrac: 0.3, eyeHalfFrac: 0.05 },
      CAPSULE.width,
    );
    expect(PEEK_SIZE_MAX).toBeLessThan(CAPSULE.width);
    expect(geometry.size).toBe(PEEK_SIZE_MAX);
    expect(geometry.exposed).toBeCloseTo(PEEK_SIZE_MAX * 0.39);
  });

  /**
   * The ghost is the catalog creature the cap constrains: its face sits high
   * enough that exposure alone would draw it at the capsule's full width.
   */
  test("never draws any creature in the catalog wider than the cap", () => {
    for (const shape of BUNDLED_COMPONENTS.bodyShapes) {
      for (const eyes of BUNDLED_COMPONENTS.eyeStyles) {
        const metrics = avatarPeekMetrics(BUNDLED_COMPONENTS, {
          bodyShape: shape.id,
          eyeStyle: eyes.id,
          color: "teal",
        });
        const geometry = peekGeometry(metrics!, CAPSULE.width);
        expect(geometry.size).toBeLessThanOrEqual(PEEK_SIZE_MAX);
      }
    }
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

describe("the peek on screen", () => {
  test("is down until the first peek, then up, then down again", async () => {
    const props = {
      character: CHARACTER,
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
      <CompanionPeek character={CHARACTER} capsule={CAPSULE} enabled held />,
    );
    // The composed creature is an inline SVG with the body and the eyes.
    expect(peekOf(container)?.querySelector("svg path")).not.toBeNull();
  });

  /** For the stories: the creature up, with no clock at all. */
  test("held, stays up and schedules nothing", async () => {
    const { container } = render(
      <CompanionPeek
        character={CHARACTER}
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
        capsule={CAPSULE}
        enabled
        interval={FAST}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(peekOf(container)).toBeNull();
  });
});
