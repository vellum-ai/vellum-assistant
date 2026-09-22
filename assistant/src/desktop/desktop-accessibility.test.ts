import { describe, expect, mock, test } from "bun:test";

import { DesktopAccessibility } from "./desktop-accessibility.js";
import {
  performDesktopComputerUse,
  planDesktopComputerUse,
} from "./desktop-computer-use.js";

const node = {
  bus: ":1.2",
  path: "/org/a11y/atspi/accessible/7",
  name: "Results",
  role: "scroll pane",
  depth: 2,
  states: ["enabled"],
  bounds: [100, 200, 400, 300],
};
const signal = () => new AbortController().signal;

describe("desktop accessibility", () => {
  test("observations publish IDs and actions resolve current, clipped bounds", async () => {
    const run = mock(async (request: object) =>
      "target" in request
        ? { ...node, bounds: [-20, 300, 200, 300] }
        : { busId: "bus-1", nodes: [node], truncated: false },
    );
    const reader = new DesktopAccessibility(run);
    expect(
      (await reader.observe("unix:abstract=test", signal())).axTree,
    ).toContain('[1] scroll pane "Results"');
    reader.bindObservation("obs-1");
    expect(await reader.resolve(1, "obs-1", signal())).toEqual({
      x: 89,
      y: 449,
    });
    expect(run.mock.calls[1][0]).toMatchObject({
      operation: "resolve",
      busId: "bus-1",
      target: node,
    });
    await expect(
      reader.resolve(1, "old-observation", signal()),
    ).rejects.toThrow("stale");
    await expect(reader.resolve(2, "obs-1", signal())).rejects.toThrow("stale");
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("an unavailable tree preserves screenshot fallback and invalidates old IDs", async () => {
    const run = mock(async () => ({
      busId: "bus-1",
      nodes: [node],
      truncated: false,
    }));
    const reader = new DesktopAccessibility(run);
    await reader.observe("bus", signal());
    reader.bindObservation("obs-1");
    run.mockRejectedValue(new Error("bus disconnected"));
    expect(await reader.observe("bus", signal())).toMatchObject({
      userGuidance: expect.stringContaining("coordinates"),
    });
    await expect(reader.resolve(1, "obs-1", signal())).rejects.toThrow("stale");
  });

  test("cancellation is not hidden by screenshot fallback", async () => {
    const reader = new DesktopAccessibility(async () => {
      throw new Error("aborted");
    });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(reader.observe("bus", abort.signal)).rejects.toThrow(
      "cancelled",
    );
  });

  test("a hidden or removed target sends no input", async () => {
    const reader = new DesktopAccessibility(async (request) => {
      if ("target" in request) {
        throw new Error("Object no longer exists");
      }
      return { busId: "bus-1", nodes: [node], truncated: false };
    });
    await reader.observe("bus", signal());
    reader.bindObservation("obs-1");
    const input = mock(async () => {});
    const result = await performDesktopComputerUse(
      planDesktopComputerUse("computer_use_scroll", {
        element_id: 1,
        direction: "down",
        amount: 2,
      }),
      signal(),
      {
        input,
        resolveElement: reader.resolve.bind(reader),
        capture: async () => ({ screenshot: "image" }),
      },
      "obs-1",
    );
    expect(input).not.toHaveBeenCalled();
    expect(result.executionError).toContain("Observe again");
    expect(result.screenshot).toBe("image");
  });

  test("sequence IDs are resolved immediately before each step using the shared input driver", async () => {
    let top = 200;
    const reader = new DesktopAccessibility(async (request) =>
      "target" in request
        ? { ...node, bounds: [100, top, 400, 100] }
        : { busId: "bus-1", nodes: [node], truncated: false },
    );
    await reader.observe("bus", signal());
    reader.bindObservation("obs-1");
    const input = mock(async (_args: string[], _signal?: AbortSignal) => {
      top += 100;
    });
    const capture = mock(async () => ({ screenshot: "image" }));
    await performDesktopComputerUse(
      planDesktopComputerUse("computer_use_sequence", {
        actions: [
          { action: "click", element_id: 1 },
          { action: "scroll", element_id: 1, direction: "down", amount: 2 },
        ],
      }),
      signal(),
      { input, capture, resolveElement: reader.resolve.bind(reader) },
      "obs-1",
    );
    expect(input.mock.calls).toEqual([
      [
        [
          "mousemove",
          "299",
          "249",
          "click",
          "--repeat",
          "1",
          "--delay",
          "100",
          "1",
        ],
        expect.any(AbortSignal),
      ],
      [
        [
          "mousemove",
          "299",
          "349",
          "click",
          "--repeat",
          "2",
          "--delay",
          "50",
          "5",
        ],
        expect.any(AbortSignal),
      ],
    ]);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
