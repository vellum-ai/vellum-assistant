import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsGroupFilter } from "@/lib/backwards-compat/use-supports-group-filter";
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
  return renderHook(() => useSupportsGroupFilter(OWNER_ASSISTANT_ID)).result
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
// (`useAssistantSupports` / `useAssistantScopedSupports`). Here we verify the
// two properties the dev floor exists for: every later release satisfies it
// without naming one, and dev builds cut after the server filter landed get
// the feature. Plus the conservative-on-unknown policy and that a version
// fetched for a DIFFERENT assistant cannot authorize this one. `false` means
// the section query stays idle and the section falls back to the
// conversations it is handed, rather than rendering an older assistant's
// unfiltered 200 as one section.
describe("useSupportsGroupFilter", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants that ignore the groupId parameter", () => {
    expect(readGate("0.11.2")).toBe(false);
    expect(readGate("0.11.1")).toBe(false);
    expect(readGate("0.10.12")).toBe(false);
  });

  // The point of the dev floor: no release number is predicted, so whichever
  // number the next cut takes, it satisfies the gate.
  test("true for every release after 0.11.2", () => {
    expect(readGate("0.11.3")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("true for RC builds of the next cut", () => {
    expect(readGate("0.11.3-rc.1")).toBe(true);
  });

  test("true for dev builds cut after the server filter landed", () => {
    expect(readGate("0.11.2-dev.202608052200.abc1234")).toBe(true);
    expect(readGate("0.11.2-dev.202609011200.def5678")).toBe(true);
  });

  test("false for dev builds that predate the server filter", () => {
    // v0.11.2 was tagged 2026-08-04; the filter landed 2026-08-05T21:36Z, so
    // dev builds in between must stay on the old path.
    expect(readGate("0.11.2-dev.202608050900.aaa1111")).toBe(false);
    expect(readGate("0.11.2-dev.202608041600.bbb2222")).toBe(false);
  });

  test("false for unparseable versions", () => {
    expect(readGate("not-a-version")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });

  test("false when the identity version belongs to a different assistant", () => {
    expect(readGate("0.11.3", "asst-other")).toBe(false);
  });

  test("false when the identity version has no recorded owner", () => {
    expect(readGate("0.11.3", null)).toBe(false);
  });

  test("false when no owner is provided even on a supported version", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.11.3", OWNER_ASSISTANT_ID);
    expect(renderHook(() => useSupportsGroupFilter(null)).result.current).toBe(
      false,
    );
  });
});
