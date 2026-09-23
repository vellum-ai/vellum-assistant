import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import { useSupportsAutoProfilePreview } from "@/lib/backwards-compat/auto-profile-preview";
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

describe("useSupportsAutoProfilePreview", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsAutoProfilePreview());
    expect(result.current).toBe(false);
  });

  test("false for a dev build stamped before the route landed", () => {
    setVersion("0.12.3-dev.202609220900.0000000");
    const { result } = renderHook(() => useSupportsAutoProfilePreview());
    expect(result.current).toBe(false);
  });

  test("true for a dev build stamped after the route landed", () => {
    setVersion("0.12.3-dev.202609231200.abcdef0");
    const { result } = renderHook(() => useSupportsAutoProfilePreview());
    expect(result.current).toBe(true);
  });

  test("true for the next stable release", () => {
    setVersion("0.12.4");
    const { result } = renderHook(() => useSupportsAutoProfilePreview());
    expect(result.current).toBe(true);
  });
});
