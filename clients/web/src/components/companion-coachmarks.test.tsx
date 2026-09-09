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

const pointerOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(
    "[data-testid='companion-coachmark-pointer']",
  );

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
        marks={[
          { kind: "region" as const, x: 0.25, y: 0.5, width: 0.1, height: 0.2 },
        ]}
        ink={INK}
      />,
    );
    // The loop is a stroke rather than a box, so it is placed and sized in the
    // window's own pixels: what a fraction has to reach is the same fraction
    // of the window, with the room the stroke needs added around it on every
    // side. The room cancels out, which is what this pins.
    const mark = markOf(container);
    const room =
      (Number(mark?.getAttribute("width")) - 0.1 * window.innerWidth) / 2;
    expect(room).toBeGreaterThan(0);
    expect(mark?.style.left).toBe(
      `${Math.round(0.25 * window.innerWidth - room)}px`,
    );
    expect(mark?.style.top).toBe(
      `${Math.round(0.5 * window.innerHeight - room)}px`,
    );
    expect(Number(mark?.getAttribute("height"))).toBe(
      0.2 * window.innerHeight + room * 2,
    );
  });

  test("takes no mouse events, so the press lands on the app underneath", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[
          { kind: "region" as const, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        ]}
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
        marks={[
          { kind: "region" as const, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        ]}
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
        marks={[
          {
            kind: "region" as const,
            x: 0.9,
            y: 0.1,
            width: 0.3,
            height: 0.1,
            caption: "Here",
          },
        ]}
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
        marks={[
          { kind: "region" as const, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        ]}
        ink={INK}
      />,
    );
    const first = markOf(container);
    rerender(
      <CompanionCoachmarks
        marks={[
          { kind: "region" as const, x: 0.4, y: 0.1, width: 0.1, height: 0.1 },
        ]}
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
        marks={[
          { kind: "region" as const, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        ]}
        ink={INK}
      />,
    );
    expect(captionOf(container)).toBeNull();
  });

  test("hangs below and leading for a mark near the top left", () => {
    expect(
      captionPlacement(
        { kind: "region" as const, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        TALL,
      ),
    ).toEqual({ above: false, trailing: false });
  });

  test("runs back from the right edge for a mark near it", () => {
    expect(
      captionPlacement(
        { kind: "region" as const, x: 0.8, y: 0.1, width: 0.1, height: 0.1 },
        TALL,
      ),
    ).toEqual({ above: false, trailing: true });
  });

  test("sits above a mark near the bottom", () => {
    expect(
      captionPlacement(
        { kind: "region" as const, x: 0.1, y: 0.95, width: 0.1, height: 0.04 },
        TALL,
      ),
    ).toEqual({ above: true, trailing: false });
  });

  /**
   * The room a caption needs is a number of pixels, not a fraction of the
   * surface: the same mark leaves room to spare on a display and none at the
   * foot of a short window.
   */
  test("reads the room below in pixels rather than in fractions", () => {
    const mark = {
      kind: "region" as const,
      x: 0.1,
      y: 0.6,
      width: 0.1,
      height: 0.2,
    };
    expect(captionPlacement(mark, TALL).above).toBe(false);
    expect(captionPlacement(mark, 120).above).toBe(true);
  });

  /**
   * A window too short for a caption on either side still has to draw one
   * somewhere, and the side with more room is where it is least covered.
   */
  test("takes the roomier side when neither side has enough", () => {
    expect(
      captionPlacement(
        { kind: "region" as const, x: 0.1, y: 0.7, width: 0.1, height: 0.1 },
        80,
      ).above,
    ).toBe(true);
    expect(
      captionPlacement(
        { kind: "region" as const, x: 0.1, y: 0.2, width: 0.1, height: 0.1 },
        80,
      ).above,
    ).toBe(false);
  });

  test("holds a caption off the edge of a window too short for it", () => {
    const mark = {
      kind: "region" as const,
      x: 0.1,
      y: 0.8,
      width: 0.1,
      height: 0.15,
    };
    expect(captionOffset(mark, 120, false)).toBe(120 - CAPTION_BUDGET_PX);
  });

  test("leaves a caption at its mark when the window has the room", () => {
    const mark = {
      kind: "region" as const,
      x: 0.1,
      y: 0.1,
      width: 0.1,
      height: 0.1,
    };
    expect(captionOffset(mark, TALL, false)).toBe(0.2 * TALL + 10);
  });

  /**
   * The flip and the width the caption may take are one decision: a caption
   * that starts at the flip and runs its full width ends exactly at the far
   * edge, which is what makes the two thresholds enough on their own.
   */
  test("cannot run off the surface it flipped to stay on", () => {
    const flipped = captionPlacement(
      { kind: "region" as const, x: 0.6, y: 0.1, width: 0.001, height: 0.1 },
      TALL,
    );
    expect(flipped.trailing).toBe(true);
    expect(0.6 + CAPTION_MAX_WIDTH).toBeLessThanOrEqual(1);
  });

  test("is anchored to the corner it was placed at", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[
          {
            kind: "region" as const,
            x: 0.7,
            y: 0.9,
            width: 0.1,
            height: 0.05,
            caption: "Press",
          },
        ]}
        ink={INK}
      />,
    );
    const caption = captionOf(container);
    expect(caption?.textContent).toBe("Press");
    expect(caption?.style.right).toBe("20%");
    expect(caption?.style.bottom).toBe(
      `${captionOffset({ kind: "region" as const, x: 0.7, y: 0.9, width: 0.1, height: 0.05 }, window.innerHeight, true)}px`,
    );
    expect(caption?.dataset.above).toBe("");
    expect(caption?.dataset.trailing).toBe("");
  });
});

/**
 * The arrow, which is what a named control gets.
 *
 * A ring says where a thing ends as well as where it is; an arrow only says
 * which thing. These pin the part that has to be exact: the tip lands on the
 * point, on whichever side the caption is not.
 */
describe("an arrow at a place on the shared surface", () => {
  test("a point draws an arrow rather than a ring", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ kind: "point" as const, x: 0.5, y: 0.5 }]}
        ink={INK}
      />,
    );
    expect(pointerOf(container)).not.toBeNull();
    expect(markOf(container)).toBeNull();
  });

  test("a region still draws a ring rather than an arrow", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[
          { kind: "region" as const, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        ]}
        ink={INK}
      />,
    );
    expect(markOf(container)).not.toBeNull();
    expect(pointerOf(container)).toBeNull();
  });

  /**
   * The arrow hangs below the point with room under it, so it comes up at the
   * control from the same side its caption is on and neither covers it.
   */
  test("the arrow hangs on the caption's side", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[
          { kind: "point" as const, x: 0.5, y: 0.2, caption: "Click it" },
        ]}
        ink={INK}
      />,
    );
    const pointer = pointerOf(container);
    expect(pointer?.dataset.above).toBeUndefined();
    expect(captionOf(container)?.dataset.above).toBeUndefined();
  });

  /**
   * A point with a whole window above it and nothing below has to turn over,
   * or its arrow and its words would both be drawn off the surface.
   */
  test("the arrow turns over when the room is above", () => {
    const placement = captionPlacement(
      { kind: "point", x: 0.5, y: 0.99 },
      TALL,
    );
    expect(placement.above).toBe(true);
  });

  /**
   * And it turns through the variable the entrance composes with, not through
   * a transform of its own.
   *
   * The keyframe declares only a `from`, so an element's own transform is the
   * animation's end state: an arrow that set `rotate(180deg)` directly would
   * spend its whole entrance rotating into place rather than arriving turned.
   * The static result looks identical, which is why this is pinned here
   * rather than left to the eye.
   */
  test("the turned arrow rotates through the entrance's own variable", () => {
    const { container } = render(
      <CompanionCoachmarks
        marks={[{ kind: "point" as const, x: 0.5, y: 0.99 }]}
        ink={INK}
      />,
    );
    const pointer = pointerOf(container);
    expect(pointer?.dataset.above).toBe("");
    expect(pointer?.style.getPropertyValue("--companion-coachmark-turn")).toBe(
      "rotate(180deg)",
    );
    expect(pointer?.style.transform).toBe("");
  });

  /** A point keeps clear of its own arrow when its caption is placed. */
  test("the caption clears the arrow rather than sitting on it", () => {
    const point = { kind: "point" as const, x: 0.5, y: 0.5 };
    const region = {
      kind: "region" as const,
      x: 0.5,
      y: 0.5,
      width: 0,
      height: 0,
    };
    expect(captionOffset(point, TALL, false)).toBeGreaterThan(
      captionOffset(region, TALL, false),
    );
  });
});
