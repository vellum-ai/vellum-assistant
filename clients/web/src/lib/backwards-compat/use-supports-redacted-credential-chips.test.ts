import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsRedactedCredentialChips } from "@/lib/backwards-compat/use-supports-redacted-credential-chips";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ID = "asst-owner";

function check(
  version: string | null,
  identityAssistantId: string | null = OWNER_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  const { result } = renderHook(() =>
    useSupportsRedactedCredentialChips(OWNER_ID),
  );
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Semver semantics and the transcript-owner scoping truth-table live in
// `utils.test.ts` (`useAssistantSupports` / `useAssistantScopedSupports`).
// Here we verify the boundary on each side of MIN_VERSION (0.10.10 — the
// first release with daemon-side sentinel minting and neutralization;
// 0.10.9 is the last without, so it is the boundary the gate has to hold)
// plus one scoping smoke case, exercised through the public hook. `false`
// means sentinel-shaped text renders as plain text.
describe("useSupportsRedactedCredentialChips", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.10.9")).toBe(false);
    expect(check("0.10.9-dev.202607131200.abc1234")).toBe(false);
    expect(check("0.10.8")).toBe(false);
  });

  test("returns true at MIN_VERSION (0.10.10) and above for the identity owner's transcript", () => {
    expect(check("0.10.10")).toBe(true);
    expect(check("0.10.10-dev.202607131200.abc1234")).toBe(true);
    expect(check("0.11.0")).toBe(true);
  });

  test("returns false when the identity version belongs to a different assistant", () => {
    expect(check("0.10.10", "asst-previous")).toBe(false);
  });
});
