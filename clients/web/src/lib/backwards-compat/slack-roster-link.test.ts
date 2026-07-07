import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsSlackRosterLink } from "@/lib/backwards-compat/slack-roster-link";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function check(version: string | null): boolean {
  setVersion(version);
  const { result } = renderHook(() => useSupportsSlackRosterLink());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsSlackRosterLink", () => {
  test("returns false when version is unknown (conservative fallback)", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns false for assistants predating the roster route", () => {
    expect(check("0.10.6")).toBe(false);
    expect(check("0.9.0")).toBe(false);
  });

  test("returns false for 0.10.6 dev builds older than the pin", () => {
    expect(check("0.10.6-dev.202607011200.abcdef")).toBe(false);
  });

  test("returns true for 0.10.6 dev builds at/after the pin", () => {
    expect(check("0.10.6-dev.202607080900.abcdef")).toBe(true);
  });

  test("returns true for 0.10.7 and newer", () => {
    expect(check("0.10.7")).toBe(true);
    expect(check("0.11.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for unparseable versions (conservative fallback)", () => {
    expect(check("not-a-version")).toBe(false);
  });
});
