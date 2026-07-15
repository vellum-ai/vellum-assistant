import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsRedactedCredentialChips } from "@/lib/backwards-compat/use-supports-redacted-credential-chips";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ID = "asst-owner";

function setIdentity(version: string | null, assistantId: string | null) {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, assistantId);
}

function check(
  version: string | null,
  transcriptAssistantId: string | null | undefined = OWNER_ID,
  identityAssistantId: string | null = OWNER_ID,
): boolean {
  setIdentity(version, identityAssistantId);
  const { result } = renderHook(() =>
    useSupportsRedactedCredentialChips(transcriptAssistantId),
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

describe("useSupportsRedactedCredentialChips", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.10.10) for the identity owner's transcript", () => {
    expect(check("0.10.10")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.10.10-dev.202607131200.abc1234")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.10.11")).toBe(true);
    expect(check("0.11.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    // 0.10.9 is the last release without daemon-side sentinel support, so it is
    // the boundary the gate actually has to hold.
    expect(check("0.10.9")).toBe(false);
    expect(check("0.10.8")).toBe(false);
    expect(check("0.9.0")).toBe(false);
  });

  test("returns false for dev builds based below MIN_VERSION", () => {
    expect(check("0.10.9-dev.202607131200.abc1234")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });

  test("returns false when the identity version belongs to a different assistant", () => {
    // The assistant-switch race: the previous assistant's supported
    // version is still hydrated while the transcript now belongs to a
    // new assistant whose identity hasn't loaded. The version must not
    // validate the new owner's transcript.
    expect(check("0.10.10", "asst-new-owner", "asst-previous")).toBe(false);
  });

  test("returns false when the transcript owner is null or undefined", () => {
    expect(check("0.10.10", null)).toBe(false);
    // Passed explicitly (a default parameter would swallow `undefined`).
    setIdentity("0.10.10", OWNER_ID);
    const { result } = renderHook(() =>
      useSupportsRedactedCredentialChips(undefined),
    );
    expect(result.current).toBe(false);
  });

  test("returns false when the identity store has no owner recorded", () => {
    expect(check("0.10.10", OWNER_ID, null)).toBe(false);
  });

  test("flips off the moment the identity is cleared for an assistant switch", () => {
    setIdentity("0.10.10", OWNER_ID);
    const { result, rerender } = renderHook(() =>
      useSupportsRedactedCredentialChips(OWNER_ID),
    );
    expect(result.current).toBe(true);
    useAssistantIdentityStore.getState().clearIdentity();
    rerender();
    expect(result.current).toBe(false);
  });
});
