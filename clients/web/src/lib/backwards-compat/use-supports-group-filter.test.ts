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
// (`useAssistantSupports` / `useAssistantScopedSupports`). Here we verify each
// side of the 0.11.3 boundary (the next scheduled cut, the first release
// carrying the `groupId` filter on `GET /v1/conversations`), the
// conservative-on-unknown policy, and that a version fetched for a DIFFERENT
// assistant cannot authorize this one. `false` means the section query stays
// idle and the section falls back to the conversations it is handed, rather
// than rendering an older assistant's unfiltered 200 as one section.
describe("useSupportsGroupFilter", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants that ignore the groupId parameter", () => {
    expect(readGate("0.11.2")).toBe(false);
    expect(readGate("0.10.12")).toBe(false);
  });

  test("true for assistants on 0.11.3+", () => {
    expect(readGate("0.11.3")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    expect(readGate("0.11.3-rc.1")).toBe(true);
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
