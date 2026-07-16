import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsAcpConnect } from "@/lib/backwards-compat/use-supports-acp-connect";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  // setIdentity(name, version, assistantId) — the scoped gate compares the
  // rendered transcript's owner against the identity store's `assistantId`, so
  // that (not the name) is what must be "test-asst" for the gate to resolve.
  useAssistantIdentityStore.getState().setIdentity("Test", version, "test-asst");
}

// The identity store hydrates for "test-asst"; pass the same id as the rendered
// transcript's owner so the scoped gate resolves (mismatch is exercised below).
function check(
  version: string | null,
  transcriptAssistantId: string | null | undefined = "test-asst",
): boolean {
  setVersion(version);
  const { result } = renderHook(() =>
    useSupportsAcpConnect(transcriptAssistantId),
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

describe("useSupportsAcpConnect", () => {
  test("returns false when the version is unknown (conservative)", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.10.10)", () => {
    expect(check("0.10.10")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.10.10-dev.202607151252.abc1234")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.10.11")).toBe(true);
    expect(check("0.11.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.10.9")).toBe(false);
    expect(check("0.9.0")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.10")).toBe(false);
  });

  test("returns false when the supported version belongs to a DIFFERENT assistant (version-skew scope)", () => {
    // The identity store is hydrated for "test-asst" at a supported version,
    // but the rendered transcript is owned by another assistant — whose daemon
    // may be older and 404 the Connect routes. The scoped gate must not light
    // the CTA off the stale global identity.
    expect(check("0.10.10", "other-asst")).toBe(false);
  });

  test("returns false when no transcript assistant id is provided", () => {
    // Render directly rather than via `check` — passing `undefined` to a
    // defaulted param would resolve to the default id, masking the guard.
    setVersion("0.10.10");
    expect(renderHook(() => useSupportsAcpConnect(null)).result.current).toBe(
      false,
    );
    expect(
      renderHook(() => useSupportsAcpConnect(undefined)).result.current,
    ).toBe(false);
  });
});
