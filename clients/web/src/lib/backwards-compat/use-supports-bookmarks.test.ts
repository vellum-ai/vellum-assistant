import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsBookmarks } from "@/lib/backwards-compat/use-supports-bookmarks";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

/** Read the gate synchronously through the exported hook, scoped to OWNER_ASSISTANT_ID. */
function readGate(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() => useSupportsBookmarks(OWNER_ASSISTANT_ID)).result
    .current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver + owner-scoping truth-table lives in `utils.test.ts`
// (`useAssistantSupports` / `useAssistantScopedSupports`). Here we verify each
// side of the 0.8.1 boundary (the first release carrying the
// `/v1/assistants/{id}/bookmarks` routes and `bookmark.*` SSE events), the
// conservative-on-unknown policy, and that a version fetched for a DIFFERENT
// assistant cannot authorize this one. `false` means every bookmark affordance
// is hidden and the list query stays idle.
describe("useSupportsBookmarks", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants on 0.8.0 and older", () => {
    expect(readGate("0.8.0")).toBe(false);
  });

  test("true for assistants on 0.8.1+", () => {
    expect(readGate("0.8.1")).toBe(true);
    expect(readGate("0.10.9")).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    expect(readGate("0.8.1-rc.1")).toBe(true);
  });

  test("true when the identity version was fetched for this assistant", () => {
    expect(readGate("0.8.1", OWNER_ASSISTANT_ID)).toBe(true);
  });

  test("false when the identity version belongs to a different assistant", () => {
    expect(readGate("0.8.1", "asst-other")).toBe(false);
  });

  test("false when no owner is provided even on a supported version", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.8.1", OWNER_ASSISTANT_ID);
    expect(
      renderHook(() => useSupportsBookmarks(null)).result.current,
    ).toBe(false);
  });
});
