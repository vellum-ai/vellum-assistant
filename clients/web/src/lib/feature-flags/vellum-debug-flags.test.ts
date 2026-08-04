/**
 * Tests for the `window._vellumDebug.flags` namespace itself: that both
 * flags land on it, that installing merges into (rather than replaces)
 * whatever the chat page already attached, and that a repeat install is
 * harmless.
 *
 * Per-flag semantics live with their own suites — `impersonateVersion` in
 * `backwards-compat/impersonate-version-flag`, `disableIframeSandbox` in
 * `lib/app-sandbox-debug-flag.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { isAppIframeSandboxDisabled } from "@/lib/app-sandbox-debug-flag";
import { installVellumDebugFlags } from "@/lib/feature-flags/vellum-debug-flags";

type DebugWindow = Omit<Window, "_vellumDebug"> & {
  _vellumDebug?: Record<string, unknown>;
};

function root(): Record<string, unknown> | undefined {
  return (window as DebugWindow)._vellumDebug;
}

function flags(): Record<string, unknown> {
  return root()?.flags as Record<string, unknown>;
}

spyOn(console, "warn").mockImplementation(() => {});
spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  delete (window as DebugWindow)._vellumDebug;
  installVellumDebugFlags();
});

afterEach(() => {
  flags().disableIframeSandbox = false;
  delete (window as DebugWindow)._vellumDebug;
});

describe("installVellumDebugFlags", () => {
  test("attaches every flag under the one namespace", () => {
    expect(typeof flags().impersonateVersion).toBe("function");
    expect(flags().disableIframeSandbox).toBe(false);
  });

  test("lists both flags enumerably so DevTools shows the surface", () => {
    expect(Object.keys(flags()).sort()).toEqual([
      "disableIframeSandbox",
      "impersonateVersion",
    ]);
  });

  test("merges into a root the chat page already populated", () => {
    delete (window as DebugWindow)._vellumDebug;
    (window as DebugWindow)._vellumDebug = { chat: "chat-api", events: "sse" };

    installVellumDebugFlags();

    expect(root()?.chat).toBe("chat-api");
    expect(root()?.events).toBe("sse");
    expect(typeof flags().impersonateVersion).toBe("function");
  });

  test("keeps flags a developer already set across a repeat install", () => {
    flags().disableIframeSandbox = true;

    installVellumDebugFlags();

    expect(flags().disableIframeSandbox).toBe(true);
    expect(isAppIframeSandboxDisabled()).toBe(true);
  });

  test("is a no-op when there is no window", () => {
    const saved = globalThis.window;
    // @ts-expect-error — simulating the server, where `window` is absent.
    delete globalThis.window;
    try {
      expect(() => installVellumDebugFlags()).not.toThrow();
    } finally {
      globalThis.window = saved;
    }
  });
});
