import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsDebugDatabase,
} from "@/lib/backwards-compat/use-supports-debug-database";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsDebugDatabase());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsDebugDatabase", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns false for release lines without the route", () => {
    expect(check("0.11.9")).toBe(false);
    expect(check("0.11.9-staging.3")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  test("returns false for dev builds below the release floor", () => {
    expect(check("0.11.9-dev.202609090000.abcdef1")).toBe(false);
  });

  test("returns true at the floor and beyond", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.11.10-dev.202609090000.abcdef1")).toBe(true);
    expect(check("0.11.11")).toBe(true);
    expect(check("0.12.0")).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
