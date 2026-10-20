import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsActivationProgress,
} from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ACTIVE_ASSISTANT_ID = "asst-owner";

function check(
  version: string | null,
  identityAssistantId: string | null = ACTIVE_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  const { result } = renderHook(() => useSupportsActivationProgress());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  useResolvedAssistantsStore.setState({
    activeAssistantId: ACTIVE_ASSISTANT_ID,
  });
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

  // 0.12.0 was cut before the routes reached `main` and 0.12.1 was patched
  // from that branch, and a non-build pre-release of a release is that same
  // release, so none of them may light the surface up.
  test("returns false for release lines without the routes", () => {
    expect(check("0.12.1")).toBe(false);
    expect(check("0.12.1-staging.2")).toBe(false);
    expect(check("0.12.0")).toBe(false);
    expect(check("0.11.10")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  // The floor names a minute rather than `dev.0`, so builds stamped before
  // it stay dark, earlier bases included.
  test("returns false for builds stamped before the floor", () => {
    expect(check("0.12.0-dev.202609120000.d77d014")).toBe(false);
    expect(check("0.12.1-dev.202609141910.aaaaaaa")).toBe(false);
    expect(check("0.12.1-local.20260914191000.aaaaaaa")).toBe(false);
  });

  // Dogfood and same-source builds are the whole point of a dev floor: they
  // carry the routes while `assistant/package.json` still reads 0.12.1.
  test("returns true for builds carrying the routes on the 0.12.1 base", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.12.1-dev.202609150700.abcdef1")).toBe(true);
    expect(check("0.12.1-local.20260915120000.abcdef1")).toBe(true);
  });

  test("returns true for every later release", () => {
    expect(check("0.12.2")).toBe(true);
    expect(check("0.12.2-dev.202609170000.fedcba9")).toBe(true);
    expect(check("0.13.0")).toBe(true);
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

  test("returns false without an active assistant to scope to", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", MIN_VERSION, ACTIVE_ASSISTANT_ID);
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    expect(
      renderHook(() => useSupportsActivationProgress()).result.current,
    ).toBe(false);
  });
});
