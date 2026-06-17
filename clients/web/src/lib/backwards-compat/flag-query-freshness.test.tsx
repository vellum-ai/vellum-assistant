import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying gate lives in
// `utils.test.ts`. Here we verify the React-Query option shape on
// each side of the 0.8.5 boundary + that the hook re-renders when
// the active assistant's version changes.
describe("useFlagQueryFreshness", () => {
  test("returns poll options when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 5_000,
      refetchInterval: 5_000,
    });
  });

  test("returns poll options for assistants on 0.8.4", () => {
    setVersion("0.8.4");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 5_000,
      refetchInterval: 5_000,
    });
  });

  test("returns push options for assistants on 0.8.5+", () => {
    setVersion("0.8.5");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 60_000,
      refetchInterval: false,
    });
  });

  test("re-renders when version flips poll → push", () => {
    setVersion("0.8.4");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current.refetchInterval).toBe(5_000);
    act(() => setVersion("0.8.5"));
    expect(result.current.refetchInterval).toBe(false);
    expect(result.current.staleTime).toBe(60_000);
  });
});
