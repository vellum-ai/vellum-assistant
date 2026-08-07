import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { MIN_VERSION as GROUP_FILTER_MIN_VERSION } from "@/lib/backwards-compat/use-supports-group-filter";
import {
  MIN_VERSION,
  useSupportsNativeOriginFilter,
} from "@/lib/backwards-compat/use-supports-native-origin-filter";
import { versionSupports } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

/** Read the gate synchronously, scoped to OWNER_ASSISTANT_ID. */
function readGate(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() => useSupportsNativeOriginFilter(OWNER_ASSISTANT_ID))
    .result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// The exhaustive semver and owner-scoping truth table lives in `utils.test.ts`.
// What matters here is the dev floor's two properties, the conservative
// default, and the ordering relationship with the group-filter gate that the
// call site depends on. `false` means the Chats section stays on the rows it
// is handed rather than asking for `vellum` and receiving only the explicitly
// stamped fraction of itself.
describe("useSupportsNativeOriginFilter", () => {
  test("false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants whose vellum filter is a strict equality", () => {
    expect(readGate("0.11.2")).toBe(false);
    expect(readGate("0.11.1")).toBe(false);
    expect(readGate("0.10.12")).toBe(false);
  });

  // A dev build cut from main before the predicate landed does not carry it,
  // which is why the floor is the commit timestamp rather than `dev.0`.
  test("false for dev builds cut before the predicate landed", () => {
    expect(readGate("0.11.2-dev.202608070000.abc1234")).toBe(false);
    expect(readGate("0.11.2-dev.202608062136.dce970c")).toBe(false);
  });

  test("true for dev builds cut after it landed", () => {
    expect(readGate(MIN_VERSION)).toBe(true);
    expect(readGate("0.11.2-dev.202608071200.fedcba9")).toBe(true);
  });

  // The point of a dev floor: no release number is predicted, so whichever
  // number the next cut takes satisfies it.
  test("true for every later release, whatever it is numbered", () => {
    expect(readGate("0.11.3")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("false when the version belongs to a different assistant", () => {
    expect(readGate(MIN_VERSION, "asst-other")).toBe(false);
    expect(readGate(MIN_VERSION, null)).toBe(false);
  });

  /* The call site relies on this ordering: Chats sends `groupId` AND
     `originChannel`, and only consults this gate. If this floor were ever
     moved below the group-filter floor, an assistant could pass here and
     still ignore `groupId`, which would answer 200 with the entire list and
     render it inside Chats. */
  test("passing this gate implies passing the group-filter gate", () => {
    expect(versionSupports(MIN_VERSION, GROUP_FILTER_MIN_VERSION)).toBe(true);
  });
});
