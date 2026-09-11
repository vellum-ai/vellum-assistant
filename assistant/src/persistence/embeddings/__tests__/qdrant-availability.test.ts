import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetQdrantAvailability,
  getQdrantAvailability,
  markQdrantAvailable,
  markQdrantUnavailable,
} from "../qdrant-availability.js";

describe("qdrant availability", () => {
  beforeEach(() => {
    _resetQdrantAvailability();
  });

  test("defaults to available so an unreached startup path behaves as before", () => {
    // A daemon that never runs the memory startup (memory plugin disabled,
    // a worker process) publishes no verdict. Defaulting to unavailable would
    // silently switch message-content search off on those processes.
    expect(getQdrantAvailability()).toEqual({ available: true });
  });

  test("carries the reason a read site can report", () => {
    markQdrantUnavailable("start_failed");

    expect(getQdrantAvailability()).toEqual({
      available: false,
      reason: "start_failed",
    });
  });

  test("clears the reason when the store comes back", () => {
    markQdrantUnavailable("start_failed");
    markQdrantAvailable();

    // A stale reason alongside `available: true` would let a caller render a
    // failure explanation for a healthy store.
    expect(getQdrantAvailability()).toEqual({ available: true });
  });
});
