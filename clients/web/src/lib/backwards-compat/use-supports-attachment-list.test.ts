import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsAttachmentList } from "@/lib/backwards-compat/use-supports-attachment-list";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsAttachmentList()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver truth-table lives in `utils.test.ts`. Here we verify the
// boundary on each side of MIN_VERSION (0.11.11, the lowest assistant version
// whose attachment listing route this gate relies on) plus the
// conservative-on-unknown policy, exercised through the public hook.
describe("useSupportsAttachmentList", () => {
  test("reads false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.11.11", () => {
    expect(readGate("0.11.10")).toBe(false);
    expect(readGate("0.11.9")).toBe(false);
    expect(readGate("0.10.10")).toBe(false);
  });

  test("reads false for a dev build of a base below 0.11.11", () => {
    expect(readGate("0.11.10-dev.202609090000.abcdef0")).toBe(false);
  });

  test("reads true at 0.11.11 and for its dev builds", () => {
    expect(readGate("0.11.11")).toBe(true);
    expect(readGate("0.11.11-dev.202609100000.abcdef0")).toBe(true);
  });

  test("reads true for later releases", () => {
    expect(readGate("0.11.12")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });
});
