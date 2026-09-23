import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsDebugExportProfile,
} from "@/lib/backwards-compat/use-supports-debug-export-profile";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsDebugExportProfile());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsDebugExportProfile", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns false for daemons that would strip the profile and ship credentials", () => {
    expect(check("0.12.2")).toBe(false);
    expect(check("0.12.2-staging.8")).toBe(false);
    expect(check("0.12.2-dev.202609190000.abcdef1")).toBe(false);
  });

  test("returns true at the floor and beyond", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.12.3-dev.202609220000.abcdef1")).toBe(true);
    expect(check("0.12.4")).toBe(true);
    expect(check("0.13.0")).toBe(true);
  });
});
