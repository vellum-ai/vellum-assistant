import { describe, expect, test } from "bun:test";

import { assertDaemonAutostartAllowed } from "../lib/local.js";

describe("assertDaemonAutostartAllowed", () => {
  test("no-ops off a container", () => {
    expect(() => assertDaemonAutostartAllowed({})).not.toThrow();
    expect(() =>
      assertDaemonAutostartAllowed({ IS_CONTAINERIZED: "false" }),
    ).not.toThrow();
  });

  test("errors when containerized so no rival is spawned", () => {
    expect(() =>
      assertDaemonAutostartAllowed({ IS_CONTAINERIZED: "true" }),
    ).toThrow(/unreachable/i);
    expect(() =>
      assertDaemonAutostartAllowed({ IS_CONTAINERIZED: "1" }),
    ).toThrow(/unreachable/i);
  });

  // Platform pods are always containerized, so IS_CONTAINERIZED is the
  // load-bearing flag. IS_PLATFORM alone (a state that does not occur in
  // practice) is intentionally not treated as a container.
  test("does not rely on IS_PLATFORM alone", () => {
    expect(() =>
      assertDaemonAutostartAllowed({ IS_PLATFORM: "true" }),
    ).not.toThrow();
  });
});
