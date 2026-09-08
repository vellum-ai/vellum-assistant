import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsProfileInputModalities,
} from "@/lib/backwards-compat/profile-input-modalities";
import { versionSupports } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsProfileInputModalities());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsProfileInputModalities", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("excludes the 0.11.9 stable release", () => {
    expect(check("0.11.9")).toBe(false);
    expect(versionSupports("0.11.9", MIN_VERSION)).toBe(false);
  });

  test("returns true at exactly MIN_VERSION", () => {
    expect(check(MIN_VERSION)).toBe(true);
  });

  test("returns true for later 0.11.9-dev builds", () => {
    expect(check("0.11.9-dev.202609080000.abcdef0")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.11.10")).toBe(true);
    expect(check("0.12.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.11.8")).toBe(false);
    expect(check("0.11.9-dev.202609071658.0000000")).toBe(false);
  });

  test("the floor is a whole build version, timestamp and sha", () => {
    expect(MIN_VERSION).toMatch(/^\d+\.\d+\.\d+-dev\.\d{12}\.[0-9a-f]+$/);
  });
});
