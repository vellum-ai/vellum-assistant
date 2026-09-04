import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  CAPTION_BUDGET_PX,
  CAPTION_MAX_WIDTH,
  CompanionCoachmarks,
  captionOffset,
  captionPlacement,
} from "./companion-coachmarks";

afterEach(cleanup);

/**
 * A window with room to spare on either side of a mark, which is the case the
 * placement rules are about. The short window that has none is its own case.
 */
const TALL = 1000;

const INK = "#5eead4";

const markOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>("[data-testid='companion-coachmark']");

const captionOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(
    "[data-testid='companion-coachmark-caption']",
  );

/**
 * The mark itself. Its coordinates are fractions of the shared surface and
 * the window is that surface exactly, so what these pin is that a fraction
 * reaches CSS as the same fraction of the window.
 */
describe("a mark on the shared surface", () => {
  test("is placed as fractions of the window", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.25, y: 0.5, width: 0.1, height: 0.2 }]}
        ink={INK}
      />,
    );
    const mark = markOf(container);
    expect(mark?.style.left).toBe("25%");
    expect(mark?.style.top).toBe("50%");
    expect(mark?.style.width).toBe("10%");
    expect(mark?.style.height).toBe("20%");
  });

  test("takes no mouse events, so the press lands on the app underneath", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]}
        ink={INK}
      />,
    );
    const layer = container.querySelector<HTMLElement>(
      "[data-testid='companion-coachmarks']",
    );
    expect(layer?.className).toContain("pointer-events-none");
  });

  test("draws in the accent it is handed", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]}
        ink="#ff8800"
      />,
    );
    const layer = container.querySelector<HTMLElement>(
      "[data-testid='companion-coachmarks']",
    );
    expect(layer?.style.getPropertyValue("--companion-ring-accent")).toBe(
      "#ff8800",
    );
  });

  /**
   * A mark whose far edge sits past the surface is a control against the side
   * of a window, which is a real answer. What must not happen is a negative
   * offset, which would hang the caption off the far edge instead.
   */
  test("holds a mark that runs past the edge inside the surface", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.9, y: 0.1, width: 0.3, height: 0.1, caption: "Here" }]}
        ink={INK}
      />,
    );
    expect(captionOf(container)?.style.right).toBe("0%");
  });

  /**
   * Each mark is its own element rather than a position in a list, so a mark
   * replacing another plays the entrance that says a new place to look.
   */
  test("replaces the element when the mark it draws changes", () => {
    const { container, rerender } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]}
        ink={INK}
      />,
    );
    const first = markOf(container);
    rerender(
      <CompanionCoachmarks
        marks={[{ x: 0.4, y: 0.1, width: 0.1, height: 0.1 }]}
        ink={INK}
      />,
    );
    expect(markOf(container)).not.toBe(first);
  });
});

/**
 * The caption, which hangs off a corner of its mark. A mark can sit anywhere
 * on the surface, so the corner is what keeps the caption on it.
 */
describe("the caption on a mark", () => {
  test("is absent when the ring is the whole message", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]}
        ink={INK}
      />,
    );
    expect(captionOf(container)).toBeNull();
  });

  test("hangs below and leading for a mark near the top left", () => {
    expect(
      captionPlacement({ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, TALL),
    ).toEqual({ above: false, trailing: false });
  });

  test("runs back from the right edge for a mark near it", () => {
    expect(
      captionPlacement({ x: 0.8, y: 0.1, width: 0.1, height: 0.1 }, TALL),
    ).toEqual({ above: false, trailing: true });
  });

  test("sits above a mark near the bottom", () => {
    expect(
      captionPlacement({ x: 0.1, y: 0.95, width: 0.1, height: 0.04 }, TALL),
    ).toEqual({ above: true, trailing: false });
  });

  /**
   * The room a caption needs is a number of pixels, not a fraction of the
   * surface: the same mark leaves room to spare on a display and none at the
   * foot of a short window.
   */
  test("reads the room below in pixels rather than in fractions", () => {
    const mark = { x: 0.1, y: 0.6, width: 0.1, height: 0.2 };
    expect(captionPlacement(mark, TALL).above).toBe(false);
    expect(captionPlacement(mark, 120).above).toBe(true);
  });

  /**
   * A window too short for a caption on either side still has to draw one
   * somewhere, and the side with more room is where it is least covered.
   */
  test("takes the roomier side when neither side has enough", () => {
    expect(
      captionPlacement({ x: 0.1, y: 0.7, width: 0.1, height: 0.1 }, 80).above,
    ).toBe(true);
    expect(
      captionPlacement({ x: 0.1, y: 0.2, width: 0.1, height: 0.1 }, 80).above,
    ).toBe(false);
  });

  test("holds a caption off the edge of a window too short for it", () => {
    const mark = { x: 0.1, y: 0.8, width: 0.1, height: 0.15 };
    expect(captionOffset(mark, 120, false)).toBe(120 - CAPTION_BUDGET_PX);
  });

  test("leaves a caption at its mark when the window has the room", () => {
    const mark = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
    expect(captionOffset(mark, TALL, false)).toBe(0.2 * TALL + 10);
  });

  /**
   * The flip and the width the caption may take are one decision: a caption
   * that starts at the flip and runs its full width ends exactly at the far
   * edge, which is what makes the two thresholds enough on their own.
   */
  test("cannot run off the surface it flipped to stay on", () => {
    const flipped = captionPlacement(
      { x: 0.6, y: 0.1, width: 0.001, height: 0.1 },
      TALL,
    );
    expect(flipped.trailing).toBe(true);
    expect(0.6 + CAPTION_MAX_WIDTH).toBeLessThanOrEqual(1);
  });

  test("is anchored to the corner it was placed at", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ x: 0.7, y: 0.9, width: 0.1, height: 0.05, caption: "Press" }]}
        ink={INK}
      />,
    );
    const caption = captionOf(container);
    expect(caption?.textContent).toBe("Press");
    expect(caption?.style.right).toBe("20%");
    expect(caption?.style.bottom).toBe(
      `${captionOffset({ x: 0.7, y: 0.9, width: 0.1, height: 0.05 }, window.innerHeight, true)}px`,
    );
    expect(caption?.dataset.above).toBe("");
    expect(caption?.dataset.trailing).toBe("");
  });
});
