import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsActiveProfileRoute } from "@/lib/backwards-compat/use-supports-active-profile-route";
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
  return renderHook(() => useSupportsActiveProfileRoute(OWNER_ASSISTANT_ID))
    .result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver + owner-scoping truth-table lives in `utils.test.ts`.
// Here we verify each side of the 0.10.8 boundary (the first release carrying
// `PUT /v1/inference/active-profile`), the conservative-on-unknown policy, and
// owner scoping. `false` means the default-profile save falls back to the raw
// config PATCH every assistant serves.
describe("useSupportsActiveProfileRoute", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants on 0.10.7 and older", () => {
    expect(readGate("0.10.7")).toBe(false);
  });

  test("true for assistants on 0.10.8+", () => {
    expect(readGate("0.10.8")).toBe(true);
    expect(readGate("0.11.0")).toBe(true);
  });

  test("false when the identity version belongs to a different assistant", () => {
    expect(readGate("0.10.8", "asst-other")).toBe(false);
  });
});
