import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsActivationProgress,
} from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

function check(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  const { result } = renderHook(() =>
    useSupportsActivationProgress(OWNER_ASSISTANT_ID),
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

// `false` means no activation surface ever mounts, so a daemon without the
// routes is never asked for progress and never linked to a conversation.
describe("useSupportsActivationProgress", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns false for release lines without the routes", () => {
    expect(check("0.11.8")).toBe(false);
    expect(check("0.11.8-staging.2")).toBe(false);
    expect(check("0.11.5")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  // Pre-0.11.9 dev builds are excluded even when cut after the routes landed:
  // the floor trades them away for zero 404 noise against the 0.11.8 line.
  test("returns false for dev builds below the release floor", () => {
    expect(check("0.11.8-dev.202609010000.d77d014")).toBe(false);
  });

  test("returns true at the floor and beyond", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.11.9-dev.202609020000.fedcba9")).toBe(true);
    expect(check("0.11.10")).toBe(true);
    expect(check("0.12.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });

  // The switch window: the active assistant flips to an older one a render
  // before the identity fetch replaces the version. An unscoped gate would
  // still answer `true` and let the progress read 404 against it.
  test("returns false while the version belongs to another assistant", () => {
    expect(check(MIN_VERSION, "asst-other")).toBe(false);
    expect(check(MIN_VERSION, null)).toBe(false);
  });

  test("returns false without an owner to scope to", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", MIN_VERSION, OWNER_ASSISTANT_ID);
    expect(
      renderHook(() => useSupportsActivationProgress(null)).result.current,
    ).toBe(false);
    expect(
      renderHook(() => useSupportsActivationProgress(undefined)).result.current,
    ).toBe(false);
  });
});
