import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsInferenceProfiles } from "@/lib/backwards-compat/use-supports-inference-profiles";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsInferenceProfiles());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsInferenceProfiles", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.11.0)", () => {
    expect(check("0.11.0")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.11.0-dev.202607281600.abc1234")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.11.1")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.10.12")).toBe(false);
    expect(check("0.10.12-rc.1")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
