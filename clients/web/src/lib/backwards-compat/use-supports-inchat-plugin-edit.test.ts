import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsInchatPluginEdit } from "@/lib/backwards-compat/use-supports-inchat-plugin-edit";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsInchatPluginEdit()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver truth-table lives in `utils.test.ts`. Here we verify the
// boundary on each side of the current MIN_VERSION (0.10.4 — a pre-release
// placeholder, see the gate's TODO) plus the conservative-on-unknown policy,
// exercised through the public hook.
describe("useSupportsInchatPluginEdit", () => {
  test("reads false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.10.4", () => {
    expect(readGate("0.10.3")).toBe(false);
    expect(readGate("0.9.0")).toBe(false);
  });

  test("reads true for assistants on 0.10.4+", () => {
    expect(readGate("0.10.4")).toBe(true);
    expect(readGate("0.10.5")).toBe(true);
    expect(readGate("0.11.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.10")).toBe(false);
  });
});
