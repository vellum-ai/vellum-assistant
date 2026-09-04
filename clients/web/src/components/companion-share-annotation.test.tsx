import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { CompanionAnnotationStroke } from "@vellumai/ipc-contract";

const sent: {
  phase: string;
  strokes: readonly CompanionAnnotationStroke[];
}[] = [];

mock.module("@/runtime/companion-surface", () => ({
  annotateCompanionShare: (
    phase: string,
    strokes: readonly CompanionAnnotationStroke[],
  ) => {
    sent.push({ phase, strokes });
  },
}));

const {
  CompanionShareAnnotation,
  COMPANION_INK_FADE_MS,
  COMPANION_INK_HOLD_MS,
} = await import("./companion-share-annotation");

/**
 * The window is 1000x1000 in these tests, so a client coordinate is a
 * thousandth of the shared surface and a fraction reads straight off it.
 */
const SIDE = 1000;

/** The assistant accent the frame resolved, which the marks are drawn in. */
const INK = "#a78bfa";

beforeEach(() => {
  sent.length = 0;
  // The window is what the shell sizes to the shared surface, and what the
  // marks are measured against.
  Object.defineProperty(window, "innerWidth", { value: SIDE, writable: true });
  Object.defineProperty(window, "innerHeight", { value: SIDE, writable: true });
});

afterEach(() => {
  cleanup();
});

const layerOf = (container: HTMLElement): Element => {
  const layer = container.querySelector(
    "[data-testid='companion-share-annotation']",
  );
  if (layer === null) {
    throw new Error("the drawing layer is not on the page");
  }
  // jsdom does not implement pointer capture, and the component asks for it on
  // every press.
  Object.assign(layer, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => false,
  });
  return layer;
};

const down = (layer: Element, x: number, y: number): void => {
  fireEvent.pointerDown(layer, { pointerId: 1, clientX: x, clientY: y });
};
const move = (layer: Element, x: number, y: number): void => {
  fireEvent.pointerMove(layer, { pointerId: 1, clientX: x, clientY: y });
};
const up = (layer: Element, x: number, y: number): void => {
  fireEvent.pointerUp(layer, { pointerId: 1, clientX: x, clientY: y });
};

/**
 * Drawing on the surface a call is being shown. What these pin is the bargain
 * the feature is: nothing leaves while the hand is down, everything leaves the
 * moment it comes off, and what leaves describes the surface rather than this
 * window's pixels.
 */
describe("drawing on what the call is shown", () => {
  test("says the hand is down before anything has been drawn", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    down(layerOf(container), 100, 100);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.phase).toBe("drawing");
  });

  /**
   * The half of this feature that is not about drawing. A frame taken while
   * the mark is half made is a circle around nothing, and the user is usually
   * talking as they draw, which is exactly what the cadence takes frames on.
   */
  test("sends nothing more for as long as the hand stays down", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    move(layer, 200, 200);
    move(layer, 300, 300);
    move(layer, 400, 400);
    expect(sent.filter((one) => one.phase === "released")).toHaveLength(0);
  });

  test("sends the mark the moment the hand comes off", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    move(layer, 500, 500);
    up(layer, 500, 500);
    const released = sent.filter((one) => one.phase === "released");
    expect(released).toHaveLength(1);
    expect(released[0]?.strokes).toHaveLength(1);
  });

  /**
   * Fractions of the shared surface, not pixels of this window. The window is
   * sized to the surface and the frame comes back scaled to fit a bound, so a
   * fraction is the one description both ends agree on.
   */
  test("describes the mark in fractions of the surface", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 250, 500);
    move(layer, 750, 500);
    up(layer, 750, 500);
    const points = sent.at(-1)?.strokes[0]?.points ?? [];
    expect(points[0]).toEqual({ x: 0.25, y: 0.5 });
    expect(points.at(-1)).toEqual({ x: 0.75, y: 0.5 });
  });

  /**
   * A pointer move lands on the same pixel whenever the hand pauses, and they
   * arrive at the display's rate. Thinning is what keeps a deliberate circle
   * at tens of points rather than hundreds.
   */
  test("drops a move that went nowhere", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 500, 500);
    move(layer, 500, 500);
    move(layer, 501, 500);
    up(layer, 501, 500);
    expect(sent.at(-1)?.strokes[0]?.points).toHaveLength(1);
  });

  test("keeps a move that went somewhere", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 500, 500);
    move(layer, 600, 500);
    up(layer, 600, 500);
    expect(sent.at(-1)?.strokes[0]?.points).toHaveLength(2);
  });

  /**
   * The frame that goes with a release is a picture of the shared surface at
   * that moment, and a mark the user can still see is part of what they are
   * pointing at.
   */
  test("sends every mark still on the overlay, not only the last", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    up(layer, 100, 100);
    down(layer, 800, 800);
    up(layer, 800, 800);
    expect(sent.at(-1)?.strokes).toHaveLength(2);
  });

  test("a press that never moved is a dot rather than nothing", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 400, 400);
    up(layer, 400, 400);
    expect(container.querySelector("circle")).not.toBeNull();
    expect(container.querySelector("polyline")).toBeNull();
  });

  test("a press that moved is a line", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    move(layer, 900, 900);
    up(layer, 900, 900);
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  /**
   * The mark is a gesture rather than an annotation layer: it has been sent,
   * and a circle still sitting on the user's screen a minute later is one
   * they have to clear up themselves.
   */
  test("the mark fades and is taken away once it has been sent", async () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    move(layer, 900, 900);
    up(layer, 900, 900);
    expect(
      container.querySelector(".companion-share-ink-spent"),
    ).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, COMPANION_INK_HOLD_MS + COMPANION_INK_FADE_MS + 20),
      );
    });
    expect(container.querySelector("polyline")).toBeNull();
  });

  /**
   * The pointer capture taken on the press deliberately keeps the drag alive
   * once the hand leaves the shared surface, so a mark drawn off the edge
   * arrives as a fraction outside the surface. The wire refuses those, and it
   * refuses the whole command: the marks would be lost *and* the session
   * would go on holding its frames, since the `drawing` that stopped them had
   * already gone.
   */
  test("holds a mark drawn off the edge inside the surface", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 500, 500);
    move(layer, -400, 500);
    move(layer, 500, SIDE + 900);
    up(layer, 500, SIDE + 900);
    const points = sent.at(-1)?.strokes[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(1);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The layer goes away when the mode is turned off or the share ends, either
   * of which can land mid-stroke. Only a release lifts the hold on the
   * session's frames, so one has to go even though the mark never finished.
   */
  test("lets go of the hand when it goes away mid-stroke", () => {
    const { container, unmount } = render(
      <CompanionShareAnnotation ink={INK} />,
    );
    down(layerOf(container), 300, 300);
    unmount();
    const released = sent.filter((one) => one.phase === "released");
    expect(released).toHaveLength(1);
    // Carrying nothing, so the window holding the session reads it as the
    // hand being let go of rather than as a drawing worth a frame.
    expect(released[0]?.strokes).toHaveLength(0);
  });

  test("says nothing on the way out when no mark was in flight", () => {
    const { container, unmount } = render(
      <CompanionShareAnnotation ink={INK} />,
    );
    const layer = layerOf(container);
    down(layer, 100, 100);
    up(layer, 100, 100);
    sent.length = 0;
    unmount();
    expect(sent).toHaveLength(0);
  });

  /**
   * The pointer can leave the shared surface mid-drag, and the release then
   * arrives as a cancel. A stroke that never ended would hold the session's
   * frames for a hand that is no longer on the mouse.
   */
  test("a cancelled press ends the mark the way letting go does", () => {
    const { container } = render(<CompanionShareAnnotation ink={INK} />);
    const layer = layerOf(container);
    down(layer, 100, 100);
    move(layer, 500, 500);
    fireEvent.pointerCancel(layer, {
      pointerId: 1,
      clientX: 500,
      clientY: 500,
    });
    expect(sent.filter((one) => one.phase === "released")).toHaveLength(1);
  });
});
