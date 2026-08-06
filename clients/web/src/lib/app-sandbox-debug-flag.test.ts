/**
 * Tests for the app-sandbox flag surfaced as
 * `window._vellumDebug.flags.toggleAppsSandboxDisabled`: the default-off
 * contract, flip vs. explicit set, the warning it logs, and the return
 * value the console reads back.
 *
 * The flag is module state, so every test resets it in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  isAppIframeSandboxDisabled,
  toggleAppIframeSandboxDisabled,
} from "@/lib/app-sandbox-debug-flag";

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
const infoSpy = spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  warnSpy.mockClear();
  infoSpy.mockClear();
});

afterEach(() => {
  toggleAppIframeSandboxDisabled(false);
});

describe("app sandbox debug flag", () => {
  test("defaults to off", () => {
    expect(isAppIframeSandboxDisabled()).toBe(false);
  });

  test("an explicit true drops the sandbox and warns", () => {
    expect(toggleAppIframeSandboxDisabled(true)).toBe(true);

    expect(isAppIframeSandboxDisabled()).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "toggleAppsSandboxDisabled = true",
    );
  });

  test("a bare call flips the current value", () => {
    expect(toggleAppIframeSandboxDisabled()).toBe(true);
    expect(isAppIframeSandboxDisabled()).toBe(true);

    expect(toggleAppIframeSandboxDisabled()).toBe(false);
    expect(isAppIframeSandboxDisabled()).toBe(false);
  });

  test("an explicit false restores the sandbox", () => {
    toggleAppIframeSandboxDisabled(true);
    infoSpy.mockClear();

    expect(toggleAppIframeSandboxDisabled(false)).toBe(false);
    expect(isAppIframeSandboxDisabled()).toBe(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  test("re-setting the current value neither warns nor re-notifies", () => {
    toggleAppIframeSandboxDisabled(true);
    toggleAppIframeSandboxDisabled(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(isAppIframeSandboxDisabled()).toBe(true);
  });
});
