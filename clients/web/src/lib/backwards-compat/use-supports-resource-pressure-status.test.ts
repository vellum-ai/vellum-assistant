import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsResourcePressureStatus,
} from "@/lib/backwards-compat/use-supports-resource-pressure-status";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsResourcePressureStatus());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// `false` means the monitor never mounts its poll loop, so a daemon
// without the route is never asked for it.
describe("useSupportsResourcePressureStatus", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  // The route landed after the 0.11.3 tag, so the released 0.11.3
  // (and every stable before it) must stay dark.
  test("returns false for releases without the route", () => {
    expect(check("0.11.3")).toBe(false);
    expect(check("0.11.2")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  // A dev build cut from main before the route landed does not carry
  // it, which is why the floor is the commit timestamp, not `dev.0`.
  test("returns false for dev builds cut before the route landed", () => {
    expect(check("0.11.3-dev.202608181000.abc1234")).toBe(false);
  });

  test("returns true at the floor and for later dev builds", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.11.3-dev.202608190000.fedcba9")).toBe(true);
  });

  // The point of a dev floor: no release number is predicted, so
  // whichever number the next cut takes satisfies it.
  test("returns true for every later release, whatever it is numbered", () => {
    expect(check("0.11.4")).toBe(true);
    expect(check("0.12.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
