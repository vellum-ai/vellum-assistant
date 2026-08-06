import { describe, expect, test } from "bun:test";

import { assertDaemonAutostartAllowed } from "../lib/local.js";

describe("assertDaemonAutostartAllowed", () => {
  test("no-ops off a pod", () => {
    expect(() => assertDaemonAutostartAllowed({})).not.toThrow();
    expect(() =>
      assertDaemonAutostartAllowed({ IS_CONTAINERIZED: "false" }),
    ).not.toThrow();
    expect(() =>
      assertDaemonAutostartAllowed({ IS_PLATFORM: "0" }),
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

  test("errors when platform-managed so no rival is spawned", () => {
    expect(() => assertDaemonAutostartAllowed({ IS_PLATFORM: "true" })).toThrow(
      /unreachable/i,
    );
    expect(() => assertDaemonAutostartAllowed({ IS_PLATFORM: "1" })).toThrow(
      /unreachable/i,
    );
  });
});
