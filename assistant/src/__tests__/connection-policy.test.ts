import { describe, expect, test } from "bun:test";

import {
  hasNoAuthOverride,
  shouldAutoStartDaemon,
} from "../daemon/connection-policy.js";

describe("hasNoAuthOverride", () => {
  test("returns false when VELLUM_DAEMON_NOAUTH is not set", () => {
    expect(hasNoAuthOverride({})).toBe(false);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is empty", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "" })).toBe(false);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is whitespace", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "   " })).toBe(false);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is 0", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "0" })).toBe(false);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is false", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "false" })).toBe(false);
  });

  test("returns true when VELLUM_DAEMON_NOAUTH is 1 with safety gate", () => {
    expect(
      hasNoAuthOverride({
        VELLUM_DAEMON_NOAUTH: "1",
        VELLUM_UNSAFE_AUTH_BYPASS: "1",
      }),
    ).toBe(true);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is 1 without safety gate", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "1" })).toBe(false);
  });

  test("returns true when VELLUM_DAEMON_NOAUTH is true with safety gate", () => {
    expect(
      hasNoAuthOverride({
        VELLUM_DAEMON_NOAUTH: "true",
        VELLUM_UNSAFE_AUTH_BYPASS: "1",
      }),
    ).toBe(true);
  });

  test("returns false when VELLUM_DAEMON_NOAUTH is true without safety gate", () => {
    expect(hasNoAuthOverride({ VELLUM_DAEMON_NOAUTH: "true" })).toBe(false);
  });
});

describe("shouldAutoStartDaemon", () => {
  test("returns true by default (no env vars set)", () => {
    expect(shouldAutoStartDaemon({})).toBe(true);
  });

  test("returns true when VELLUM_DAEMON_AUTOSTART=1", () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: "1" })).toBe(true);
  });

  test("returns true when VELLUM_DAEMON_AUTOSTART=true", () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: "true" })).toBe(
      true,
    );
  });

  test("returns false when VELLUM_DAEMON_AUTOSTART=0", () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: "0" })).toBe(false);
  });

  test("returns false when VELLUM_DAEMON_AUTOSTART=false", () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: "false" })).toBe(
      false,
    );
  });
});
