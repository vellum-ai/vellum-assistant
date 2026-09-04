import { describe, expect, test } from "bun:test";
import type { CompanionAnnotationStroke } from "@vellumai/ipc-contract";

import { annotateSharedFrame, draw } from "./annotate-shared-frame";

/** Every call the drawing makes, in order, so a test can read the path back. */
type Call = { op: string; args: number[] };

function recorder() {
  const calls: Call[] = [];
  const context = {
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    lineWidth: 0,
    strokeStyle: "" as string | CanvasGradient | CanvasPattern,
    fillStyle: "" as string | CanvasGradient | CanvasPattern,
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    moveTo: (x: number, y: number) =>
      calls.push({ op: "moveTo", args: [x, y] }),
    lineTo: (x: number, y: number) =>
      calls.push({ op: "lineTo", args: [x, y] }),
    arc: (x: number, y: number, r: number) =>
      calls.push({ op: "arc", args: [x, y, r] }),
    stroke: () => calls.push({ op: "stroke", args: [] }),
    fill: () => calls.push({ op: "fill", args: [] }),
  };
  return { calls, context };
}

const stroke = (...points: [number, number][]): CompanionAnnotationStroke => ({
  points: points.map(([x, y]) => ({ x, y })),
});

/**
 * Drawing the user's marks onto the frame that goes to the call.
 *
 * The arithmetic is the whole of what can be wrong here: the marks are
 * fractions of the shared surface and the frame is a JPEG at whatever size
 * the helper encoded it, so a mark that landed in the wrong place would point
 * the call at the wrong thing without anything failing.
 */
describe("drawing the marks onto a shared frame", () => {
  test("places a fraction of the surface at that fraction of the frame", () => {
    const { calls, context } = recorder();
    draw(context, [stroke([0.25, 0.5], [0.75, 0.5])], 800, 400);
    expect(calls.filter((call) => call.op === "moveTo")[0]?.args).toEqual([
      200, 200,
    ]);
    expect(calls.filter((call) => call.op === "lineTo")[0]?.args).toEqual([
      600, 200,
    ]);
  });

  /**
   * The mark has to read over whatever the user happens to be showing, and a
   * single-colour line disappears against a surface of its own colour. Two
   * complete passes rather than a halo and an ink per mark: drawn mark by
   * mark, one halo would cut a dark line through the mark before it wherever
   * two crossed.
   */
  test("lays a halo under every mark before drawing any ink", () => {
    const { calls, context } = recorder();
    draw(context, [stroke([0, 0], [1, 1]), stroke([1, 0], [0, 1])], 100, 100);
    expect(calls.filter((call) => call.op === "stroke")).toHaveLength(4);
  });

  test("draws the ink thinner than the halo under it", () => {
    const widths: number[] = [];
    const { context } = recorder();
    const watched = {
      ...context,
      stroke: () => widths.push(watched.lineWidth),
    };
    draw(watched, [stroke([0, 0], [1, 1])], 100, 100);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(widths[1]!);
  });

  /** The weight is a fraction of the smaller side, so a mark on a wide frame
   * and the same mark on a tall one carry the same weight. */
  test("weighs the line against the smaller side", () => {
    const wide = recorder();
    draw(wide.context, [stroke([0, 0], [1, 1])], 1600, 400);
    const tall = recorder();
    draw(tall.context, [stroke([0, 0], [1, 1])], 400, 1600);
    expect(wide.context.lineWidth).toBe(tall.context.lineWidth);
  });

  test("a press that never moved is a dot rather than nothing", () => {
    const { calls, context } = recorder();
    draw(context, [stroke([0.5, 0.5])], 200, 200);
    expect(
      calls.filter((call) => call.op === "arc")[0]?.args.slice(0, 2),
    ).toEqual([100, 100]);
    expect(calls.some((call) => call.op === "fill")).toBe(true);
    expect(calls.some((call) => call.op === "stroke")).toBe(false);
  });

  test("draws nothing for a mark with no points at all", () => {
    const { calls, context } = recorder();
    draw(context, [{ points: [] }], 200, 200);
    expect(calls.filter((call) => call.op === "stroke")).toHaveLength(0);
  });

  /**
   * A frame with the marks is better than one without, and one without is far
   * better than none: the user pointed at something on a screen the call can
   * still see.
   */
  test("hands back the plain frame when there is nothing to draw", async () => {
    const frame = new File([new Uint8Array([1, 2, 3])], "frame.jpg", {
      type: "image/jpeg",
    });
    expect(await annotateSharedFrame(frame, [])).toBe(frame);
  });

  test("hands back the plain frame when the drawing cannot be done", async () => {
    const frame = new File([new Uint8Array([1, 2, 3])], "frame.jpg", {
      type: "image/jpeg",
    });
    // jsdom decodes nothing and paints nothing, which is the same shape as a
    // host that refuses a 2D context or an image that will not decode.
    expect(await annotateSharedFrame(frame, [stroke([0, 0], [1, 1])])).toBe(
      frame,
    );
  });
});
