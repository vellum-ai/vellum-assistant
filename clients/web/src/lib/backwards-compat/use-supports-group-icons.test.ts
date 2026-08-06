import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsGroupIcons } from "@/lib/backwards-compat/use-supports-group-icons";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsGroupIcons());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsGroupIcons", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.11.1)", () => {
    expect(check("0.11.1")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.11.1-dev.202607281200.abc1234")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.11.2")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.11.0")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
