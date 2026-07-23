import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import { useSupportsBookmarks } from "@/lib/backwards-compat/use-supports-bookmarks";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify each side of the 0.8.1 boundary (the first
// release carrying the `/v1/assistants/{id}/bookmarks` routes and
// `bookmark.*` SSE events) plus the conservative-on-unknown policy. `false`
// means every bookmark affordance is hidden and the list query stays idle.
describe("useSupportsBookmarks", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsBookmarks());
    expect(result.current).toBe(false);
  });

  test("false for assistants on 0.8.0 and older", () => {
    setVersion("0.8.0");
    const { result } = renderHook(() => useSupportsBookmarks());
    expect(result.current).toBe(false);
  });

  test("true for assistants on 0.8.1+", () => {
    setVersion("0.8.1");
    const { result } = renderHook(() => useSupportsBookmarks());
    expect(result.current).toBe(true);
  });

  test("true for much newer assistants", () => {
    setVersion("0.10.9");
    const { result } = renderHook(() => useSupportsBookmarks());
    expect(result.current).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    setVersion("0.8.1-rc.1");
    const { result } = renderHook(() => useSupportsBookmarks());
    expect(result.current).toBe(true);
  });
});
