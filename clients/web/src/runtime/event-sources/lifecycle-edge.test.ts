/**
 * Pins the lifecycle-edge dedup contract:
 *   - the iOS visibility + app_state pair collapses into one publish;
 *   - whichever source reaches the edge first keeps its `signal` label;
 *   - an opposite edge is never swallowed, so a hidden between two resumes
 *     still reaches the SSE teardown policy;
 *   - a repeat of the same edge past the window is a real edge again.
 *
 * The module reads `Date.now`, so the clock is driven with bun:test's
 * `setSystemTime` and restored in `afterEach`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import * as eventBus from "@/lib/event-bus";
import {
  __resetLifecycleEdgeForTests,
  publishLifecycleEdge,
} from "@/runtime/event-sources/lifecycle-edge";

const publishSpy = spyOn(eventBus, "publish");

const START = new Date("2026-01-01T00:00:00.000Z").getTime();

/** Move the clock to `offsetMs` past the start of the current test. */
const setClock = (offsetMs: number): void => {
  setSystemTime(new Date(START + offsetMs));
};

beforeEach(() => {
  setClock(0);
  __resetLifecycleEdgeForTests();
  publishSpy.mockClear();
});

afterEach(() => {
  setSystemTime();
  publishSpy.mockClear();
});

describe("publishLifecycleEdge", () => {
  test("collapses the visibility + app_state resume pair into one publish", () => {
    publishLifecycleEdge("resume", "visibility");
    setClock(5);
    publishLifecycleEdge("resume", "app_state");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "visibility",
    });
  });

  test("keeps the label of whichever source reached the resume edge first", () => {
    publishLifecycleEdge("resume", "app_state");
    setClock(5);
    publishLifecycleEdge("resume", "visibility");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "app_state",
    });
  });

  test("collapses the hidden pair the same way", () => {
    publishLifecycleEdge("hidden", "visibility");
    setClock(5);
    publishLifecycleEdge("hidden", "app_state");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "visibility",
    });
  });

  test("never swallows a hidden edge between two resumes inside the window", () => {
    publishLifecycleEdge("resume", "visibility");
    setClock(100);
    publishLifecycleEdge("hidden", "visibility");
    setClock(200);
    publishLifecycleEdge("resume", "visibility");

    expect(publishSpy.mock.calls).toEqual([
      ["app.resume", { signal: "visibility" }],
      ["app.hidden", { signal: "visibility" }],
      ["app.resume", { signal: "visibility" }],
    ]);
  });

  test("publishes a repeat of the same edge once the window has elapsed", () => {
    publishLifecycleEdge("resume", "visibility");
    setClock(1_500);
    publishLifecycleEdge("resume", "app_state");

    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenLastCalledWith("app.resume", {
      signal: "app_state",
    });
  });

  test("the reset seam clears the recorded edge", () => {
    publishLifecycleEdge("resume", "visibility");
    __resetLifecycleEdgeForTests();
    setClock(5);
    publishLifecycleEdge("resume", "app_state");

    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenLastCalledWith("app.resume", {
      signal: "app_state",
    });
  });
});
