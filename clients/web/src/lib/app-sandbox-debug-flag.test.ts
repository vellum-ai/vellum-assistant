/**
 * Tests for the `window._vellumDebug.apps.disableIframeSandbox` flag: the
 * default-off contract, the literal-`true` requirement, the warning the
 * setter logs, and the subscriber notification the app viewer re-keys on.
 *
 * The flag is module state, so every test resets it through the public
 * setter (the window accessor) in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  installAppSandboxDebugFlag,
  isAppIframeSandboxDisabled,
} from "@/lib/app-sandbox-debug-flag";

type DebugWindow = Omit<Window, "_vellumDebug"> & {
  _vellumDebug?: Record<string, unknown>;
};

function apps(): Record<string, unknown> {
  const root = (window as DebugWindow)._vellumDebug;
  return root?.apps as Record<string, unknown>;
}

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
const infoSpy = spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  delete (window as DebugWindow)._vellumDebug;
  installAppSandboxDebugFlag();
  warnSpy.mockClear();
  infoSpy.mockClear();
});

afterEach(() => {
  apps().disableIframeSandbox = false;
  delete (window as DebugWindow)._vellumDebug;
});

describe("app sandbox debug flag", () => {
  test("installs an `apps` namespace and defaults to off", () => {
    expect(apps()).toBeDefined();
    expect(apps().disableIframeSandbox).toBe(false);
    expect(isAppIframeSandboxDisabled()).toBe(false);
  });

  test("keeps namespaces other debug domains already attached", () => {
    (window as DebugWindow)._vellumDebug = { chat: "existing-chat-api" };

    installAppSandboxDebugFlag();

    expect((window as DebugWindow)._vellumDebug?.chat).toBe(
      "existing-chat-api",
    );
    expect(apps().disableIframeSandbox).toBe(false);
  });

  test("a literal true turns the flag on and warns", () => {
    apps().disableIframeSandbox = true;

    expect(isAppIframeSandboxDisabled()).toBe(true);
    expect(apps().disableIframeSandbox).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("disableIframeSandbox = true");
  });

  test("truthy values that are not the literal true leave it off", () => {
    for (const value of ["true", 1, {}, [], "yes"]) {
      apps().disableIframeSandbox = value;

      expect(isAppIframeSandboxDisabled()).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("setting it back to false restores the sandbox", () => {
    apps().disableIframeSandbox = true;
    apps().disableIframeSandbox = false;

    expect(isAppIframeSandboxDisabled()).toBe(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  test("re-setting the current value neither warns nor re-notifies", () => {
    apps().disableIframeSandbox = true;
    apps().disableIframeSandbox = true;

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("a fresh install does not reset a flag already set", () => {
    apps().disableIframeSandbox = true;

    installAppSandboxDebugFlag();

    expect(apps().disableIframeSandbox).toBe(true);
  });
});
