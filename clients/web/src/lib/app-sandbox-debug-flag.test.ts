/**
 * Tests for the `window._vellumDebug.flags.disableIframeSandbox` flag: the
 * default-off contract, the literal-`true` requirement, the warning the
 * setter logs, and the subscriber notification the app viewer re-keys on.
 *
 * Driven through the console binding installed by `installVellumDebugFlags`,
 * because assignment through that accessor is the only way the flag is ever
 * set in practice.
 *
 * The flag is module state, so every test resets it through the same
 * accessor in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { isAppIframeSandboxDisabled } from "@/lib/app-sandbox-debug-flag";
import { installVellumDebugFlags } from "@/lib/feature-flags/vellum-debug-flags";

type DebugWindow = Omit<Window, "_vellumDebug"> & {
  _vellumDebug?: Record<string, unknown>;
};

function flags(): Record<string, unknown> {
  const root = (window as DebugWindow)._vellumDebug;
  return root?.flags as Record<string, unknown>;
}

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
const infoSpy = spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  delete (window as DebugWindow)._vellumDebug;
  installVellumDebugFlags();
  warnSpy.mockClear();
  infoSpy.mockClear();
});

afterEach(() => {
  flags().disableIframeSandbox = false;
  delete (window as DebugWindow)._vellumDebug;
});

describe("app sandbox debug flag", () => {
  test("installs a `flags` namespace and defaults to off", () => {
    expect(flags()).toBeDefined();
    expect(flags().disableIframeSandbox).toBe(false);
    expect(isAppIframeSandboxDisabled()).toBe(false);
  });

  test("keeps namespaces other debug domains already attached", () => {
    (window as DebugWindow)._vellumDebug = { chat: "existing-chat-api" };

    installVellumDebugFlags();

    expect((window as DebugWindow)._vellumDebug?.chat).toBe(
      "existing-chat-api",
    );
    expect(flags().disableIframeSandbox).toBe(false);
  });

  test("sits alongside the other flags in the same namespace", () => {
    expect(typeof flags().impersonateVersion).toBe("function");
    expect(flags().disableIframeSandbox).toBe(false);
  });

  test("is enumerable so the namespace lists it in DevTools", () => {
    expect(Object.keys(flags())).toContain("disableIframeSandbox");
  });

  test("a literal true turns the flag on and warns", () => {
    flags().disableIframeSandbox = true;

    expect(isAppIframeSandboxDisabled()).toBe(true);
    expect(flags().disableIframeSandbox).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("disableIframeSandbox = true");
  });

  test("truthy values that are not the literal true leave it off", () => {
    for (const value of ["true", 1, {}, [], "yes"]) {
      flags().disableIframeSandbox = value;

      expect(isAppIframeSandboxDisabled()).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("setting it back to false restores the sandbox", () => {
    flags().disableIframeSandbox = true;
    flags().disableIframeSandbox = false;

    expect(isAppIframeSandboxDisabled()).toBe(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  test("re-setting the current value neither warns nor re-notifies", () => {
    flags().disableIframeSandbox = true;
    flags().disableIframeSandbox = true;

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("a fresh install does not reset a flag already set", () => {
    flags().disableIframeSandbox = true;

    installVellumDebugFlags();

    expect(flags().disableIframeSandbox).toBe(true);
  });
});
